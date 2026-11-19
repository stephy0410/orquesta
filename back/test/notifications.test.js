import assert from "node:assert/strict";
import test from "node:test";

import { createNotifyEmailHandler } from "../src/lambdas/notify-email/index.js";
import { createNotifySmsHandler } from "../src/lambdas/notify-sms/index.js";
import { createAppContext } from "../src/shared/context.js";
import {
  buildRawMimeEmail,
  CaptureEmailAdapter,
  CaptureSmsAdapter,
  MemoryObjectStorage,
  SesEmailAdapter,
} from "../src/shared/ports.js";
import { renderQrPng } from "../src/shared/qr-png.js";

test("buildRawMimeEmail genera MIME con cid:qr.png, adjunto descargable y asunto UTF-8", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  const raw = buildRawMimeEmail({
    from: "Orquesta <no-reply@orquesta.test>",
    to: "ana@example.com",
    subject: "Invitación a Boda de Sofía & José",
    html: '<p>Hola</p><img src="cid:qr.png" alt="QR" />',
    text: "Hola - https://orquesta.test/invitacion/#t=abc",
    attachments: [
      {
        filename: "qr.png",
        contentType: "image/png",
        contentId: "qr.png",
        content: png,
      },
    ],
  });

  const expectedSubject = `Subject: =?UTF-8?B?${Buffer.from("Invitación a Boda de Sofía & José", "utf8").toString("base64")}?=`;
  assert.ok(raw.includes("From: Orquesta <no-reply@orquesta.test>\r\n"));
  assert.ok(raw.includes("To: ana@example.com\r\n"));
  assert.ok(raw.includes(`${expectedSubject}\r\n`));
  assert.ok(raw.includes("Content-Type: multipart/mixed;"));
  assert.ok(raw.includes("Content-Type: multipart/related;"));
  assert.ok(raw.includes("Content-Type: multipart/alternative;"));
  assert.ok(raw.includes("Content-Disposition: inline; filename=\"qr.png\"\r\n"));
  assert.ok(raw.includes("Content-ID: <qr.png>\r\n"));
  assert.ok(raw.includes("Content-Disposition: attachment; filename=\"qr.png\"\r\n"));
  assert.ok(raw.includes(png.toString("base64")));
});

test("SesEmailAdapter usa SendRawEmailCommand cuando hay adjuntos binarios y SendEmailCommand cuando no los hay", async () => {
  const sentCommands = [];
  class FakeSendEmailCommand {
    constructor(input) {
      this.kind = "SendEmailCommand";
      this.input = input;
    }
  }
  class FakeSendRawEmailCommand {
    constructor(input) {
      this.kind = "SendRawEmailCommand";
      this.input = input;
    }
  }

  const fakeClient = {
    async send(command) {
      sentCommands.push(command);
      return { MessageId: `ses_${sentCommands.length}` };
    },
  };

  const adapter = new SesEmailAdapter({
    fromEmail: "Orquesta <demo@orquesta.test>",
    client: fakeClient,
    sesSdk: {
      SendEmailCommand: FakeSendEmailCommand,
      SendRawEmailCommand: FakeSendRawEmailCommand,
    },
  });

  const r1 = await adapter.send({
    to: "ana@example.com",
    subject: "Verifica tu correo",
    html: "<p>Token: 123</p>",
    text: "Token: 123",
  });
  assert.equal(r1.provider_message_id, "ses_1");
  assert.equal(sentCommands[0].kind, "SendEmailCommand");

  const r2 = await adapter.send({
    to: "ana@example.com",
    subject: "Invitación a Boda",
    html: '<img src="cid:qr.png" />',
    text: "Invitación",
    attachments: [
      {
        filename: "qr.png",
        contentType: "image/png",
        contentId: "qr.png",
        content: Buffer.from("fake-png-bytes"),
      },
    ],
  });
  assert.equal(r2.provider_message_id, "ses_2");
  assert.equal(sentCommands[1].kind, "SendRawEmailCommand");
  assert.equal(sentCommands[1].input.Source, "Orquesta <demo@orquesta.test>");
  assert.deepEqual(sentCommands[1].input.Destinations, ["ana@example.com"]);
  const mimeStr = Buffer.from(sentCommands[1].input.RawMessage.Data).toString("utf8");
  assert.ok(mimeStr.includes("Content-ID: <qr.png>"));
  assert.ok(mimeStr.includes(Buffer.from("fake-png-bytes").toString("base64")));
});

test("CaptureEmailAdapter y CaptureSmsAdapter solo emiten logs JSON cuando logToConsole=true", async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const quietEmail = new CaptureEmailAdapter({ logToConsole: false });
    const quietSms = new CaptureSmsAdapter({ logToConsole: false });
    await quietEmail.send({ to: "a@test.com", subject: "Hola", html: "<p>x</p>", text: "x" });
    await quietSms.send({ to: "+525500000000", message: "Hola" });
    assert.equal(logs.length, 0);

    const loudEmail = new CaptureEmailAdapter({ logToConsole: true });
    const loudSms = new CaptureSmsAdapter({ logToConsole: true });
    await loudEmail.send({
      to: "b@test.com",
      subject: "Verifica",
      html: "<p>x</p>",
      text: "x",
      attachments: [{ filename: "qr.png" }],
      metadata: { token: "tok_123" },
    });
    await loudSms.send({
      to: "+525511111111",
      message: "[Orquesta] Tu codigo es 999999",
      metadata: { codigo_otp: "999999" },
    });

    assert.equal(logs.length, 2);
    const emailLog = JSON.parse(logs[0]);
    const smsLog = JSON.parse(logs[1]);
    assert.equal(emailLog.component, "capture_email");
    assert.equal(emailLog.to, "b@test.com");
    assert.equal(emailLog.attachments_count, 1);
    assert.equal(emailLog.metadata.token, "tok_123");
    assert.equal(smsLog.component, "capture_sms");
    assert.equal(smsLog.to, "+525511111111");
    assert.equal(smsLog.metadata.codigo_otp, "999999");
  } finally {
    console.log = origLog;
  }
});

test("notify-email adjunta QR desde objectStorage, hace fallback a renderQrPng si falta en S3 y loguea errores", async () => {
  const sentEmails = [];
  const errors = [];
  const origErr = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    const storage = new MemoryObjectStorage({ publicBaseUrl: "http://assets.test" });
    const precomputedPng = await renderQrPng("jwt.from.s3");
    await storage.putObject({
      bucket: "orquesta-assets",
      key: "qr/inv_1_v1.png",
      body: precomputedPng,
      contentType: "image/png",
    });

    const deliveryRows = {
      del_s3: {
        delivery: { id: "del_s3", event_id: "evt_1", canal: "email", estado: "encolado", plantilla: "invitacion", ventana: "send_1", direccion_plana: "ana@example.com" },
        invitation: { id: "inv_1", qr_s3_key: "qr/inv_1_v1.png", rsvp_token_plano: "rsvp_1", qr_token_plano: "jwt.from.s3", codigo_corto: "ABC123" },
        guest: { id: "g_1", nombre: "Ana" },
        event: { id: "evt_1", nombre: "Boda" },
        reminderJob: null,
      },
      del_fallback: {
        delivery: { id: "del_fallback", event_id: "evt_1", canal: "email", estado: "encolado", plantilla: "invitacion", ventana: "send_1", direccion_plana: "luis@example.com" },
        invitation: { id: "inv_2", qr_s3_key: "qr/missing.png", rsvp_token_plano: "rsvp_2", qr_token_plano: "jwt.fallback", codigo_corto: "XYZ789" },
        guest: { id: "g_2", nombre: "Luis" },
        event: { id: "evt_1", nombre: "Boda" },
        reminderJob: null,
      },
      del_fail: {
        delivery: { id: "del_fail", event_id: "evt_1", canal: "email", estado: "encolado", plantilla: "invitacion", ventana: "send_1", direccion_plana: "err@example.com" },
        invitation: { id: "inv_3", qr_s3_key: "qr/inv_1_v1.png", rsvp_token_plano: "rsvp_3", qr_token_plano: "jwt.err", codigo_corto: "ERR000" },
        guest: { id: "g_3", nombre: "Error" },
        event: { id: "evt_1", nombre: "Boda" },
        reminderJob: null,
      },
    };

    const ctx = await createAppContext({
      silentMetrics: true,
      autoFlushOutbox: false,
      portOverrides: {
        objectStorage: storage,
        emailProvider: {
          async send(payload) {
            if (payload.to === "err@example.com") {
              const e = new Error("Email address is not verified: err@example.com");
              e.name = "MessageRejected";
              throw e;
            }
            sentEmails.push(payload);
            return { provider_message_id: `m_${sentEmails.length}`, status: "sent" };
          },
        },
      },
    });
    ctx.store.getDeliveryContext = async (id) => deliveryRows[id] || null;
    ctx.store.markDeliveryResult = async ({ success }) => ({ retryable: !success, rebotado: false });

    const handler = createNotifyEmailHandler(ctx);
    const out = await handler({
      Records: [
        { messageId: "m1", body: JSON.stringify({ delivery_id: "del_s3" }) },
        { messageId: "m2", body: JSON.stringify({ delivery_id: "del_fallback" }) },
        { messageId: "m3", body: JSON.stringify({ delivery_id: "del_fail" }) },
        { messageId: "m4", body: JSON.stringify({ event_type: "verify_email", to: "err@example.com", token: "v1" }) },
      ],
    });

    assert.equal(sentEmails.length, 2);
    // Caso 1: QR tomado de objectStorage
    assert.ok(sentEmails[0].html.includes('src="cid:qr.png"'));
    assert.equal(sentEmails[0].attachments.length, 1);
    assert.equal(sentEmails[0].attachments[0].contentId, "qr.png");
    assert.deepEqual(sentEmails[0].attachments[0].content, precomputedPng);

    // Caso 2: faltaba en S3 -> fallback regenera PNG válido
    assert.ok(sentEmails[1].html.includes('src="cid:qr.png"'));
    assert.equal(sentEmails[1].attachments.length, 1);
    assert.equal(sentEmails[1].attachments[0].content.subarray(0, 4).toString("hex"), "89504e47");

    // Caso 3 y 4: fallos logueados como JSON y marcados para reintento SQS
    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: "m3" }, { itemIdentifier: "m4" }]);
    assert.equal(errors.length, 2);
    const e1 = JSON.parse(errors[0]);
    const e2 = JSON.parse(errors[1]);
    assert.equal(e1.component, "notify_email");
    assert.equal(e1.delivery_id, "del_fail");
    assert.equal(e1.error_name, "MessageRejected");
    assert.ok(!e1.error.includes("err@example.com"));
    assert.ok(e1.error.includes("[redacted-email]"));
    assert.equal(e2.component, "notify_email");
    assert.equal(e2.event_type, "verify_email");
  } finally {
    console.error = origErr;
  }
});

test("notify-sms loguea errores estructurados al fallar el proveedor", async () => {
  const errors = [];
  const origErr = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    const ctx = await createAppContext({
      silentMetrics: true,
      autoFlushOutbox: false,
      portOverrides: {
        smsProvider: {
          async send() {
            const e = new Error("Phone number not opted in");
            e.name = "InvalidParameterException";
            throw e;
          },
        },
      },
    });
    ctx.store.getDeliveryContext = async () => ({
      delivery: { id: "del_sms_1", event_id: "evt_1", canal: "sms", estado: "encolado", plantilla: "invitacion", ventana: "send_1", direccion_plana: "+525512345678" },
      invitation: { id: "inv_1", rsvp_token_plano: "rsvp_1" },
      guest: { id: "g_1", nombre: "Ana" },
      event: { id: "evt_1", nombre: "Boda" },
      reminderJob: null,
    });
    ctx.store.markDeliveryResult = async () => ({ retryable: true, rebotado: false });

    const handler = createNotifySmsHandler(ctx);
    const out = await handler({
      Records: [
        { messageId: "s1", body: JSON.stringify({ delivery_id: "del_sms_1" }) },
        { messageId: "s2", body: JSON.stringify({ event_type: "otp_verification", to: "+525512345678", codigo_otp: "123456" }) },
      ],
    });

    assert.deepEqual(out.batchItemFailures, [{ itemIdentifier: "s1" }, { itemIdentifier: "s2" }]);
    assert.equal(errors.length, 2);
    const log1 = JSON.parse(errors[0]);
    const log2 = JSON.parse(errors[1]);
    assert.equal(log1.component, "notify_sms");
    assert.equal(log1.delivery_id, "del_sms_1");
    assert.equal(log1.error_name, "InvalidParameterException");
    assert.equal(log2.component, "notify_sms");
    assert.equal(log2.event_type, "otp_verification");
  } finally {
    console.error = origErr;
  }
});
