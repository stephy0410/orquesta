import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import test from "node:test";

import { generateEs256KeyPair, verifyEs256Bytes, verifyEs256Jws } from "../src/shared/crypto.js";
import { MetricsEmitter } from "../src/shared/observability.js";
import { KmsQrSigner } from "../src/shared/ports.js";

test("KmsQrSigner.signBytes usa SHA-256 DIGEST para payloads > 4096 bytes y la firma verifica con ES256", async () => {
  const pair = generateEs256KeyPair("kms-test-key");
  const privKey = createPrivateKey(pair.privateKeyPem);
  const pubSpkiDer = createPublicKey(pair.publicKeyPem).export({ type: "spki", format: "der" });
  const commands = [];

  // 10 KB de roster (> 4096 bytes)
  const bigRoster = Buffer.from(
    JSON.stringify({
      event_id: "evt_1",
      invitados: Array.from({ length: 200 }, (_, i) => ({ invitation_id: `inv_${i}`, nombre: `Invitado ${i}` })),
    }),
    "utf8"
  );
  assert.ok(bigRoster.length > 4096);

  const rawByDigestHex = new Map([
    [createHash("sha256").update(bigRoster).digest("hex"), bigRoster],
  ]);

  class FakeGetPublicKeyCommand {
    constructor(input) {
      this.kind = "GetPublicKeyCommand";
      this.input = input;
    }
  }
  class FakeSignCommand {
    constructor(input) {
      this.kind = "SignCommand";
      this.input = input;
    }
  }

  const fakeClient = {
    async send(cmd) {
      commands.push(cmd);
      if (cmd.kind === "GetPublicKeyCommand") {
        return { PublicKey: pubSpkiDer };
      }
      if (cmd.kind === "SignCommand") {
        assert.equal(cmd.input.MessageType, "DIGEST");
        assert.equal(cmd.input.SigningAlgorithm, "ECDSA_SHA_256");
        assert.equal(cmd.input.Message.length, 32);
        const digestHex = Buffer.from(cmd.input.Message).toString("hex");
        const original = rawByDigestHex.get(digestHex);
        assert.ok(original, "KMS recibió el digest SHA-256 exacto del mensaje original");
        const derSig = cryptoSign("sha256", original, { key: privKey, dsaEncoding: "der" });
        return { Signature: derSig };
      }
      throw new Error(`Unexpected command: ${cmd.kind}`);
    },
  };

  const signer = new KmsQrSigner({
    keyId: "kms-test-key",
    client: fakeClient,
    kmsSdk: { GetPublicKeyCommand: FakeGetPublicKeyCommand, SignCommand: FakeSignCommand },
  });

  const sig = await signer.signBytes(bigRoster);
  assert.equal(commands[0].kind, "SignCommand");
  assert.equal(verifyEs256Bytes(bigRoster, sig, pair.publicKeyPem), true);

  // También funciona para JWS (verifyJws usa getPublicKey)
  const payload = { typ: "checkin_qr", invitation_id: "inv_1", key_id: "kms-test-key" };
  const headerB64 = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "kms-test-key" }), "utf8").toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const jwsInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  rawByDigestHex.set(createHash("sha256").update(jwsInput).digest("hex"), jwsInput);

  const jwt = await signer.signJws(payload);
  const verified = await signer.verifyJws(jwt);
  assert.equal(verified.header.alg, "ES256");
  assert.equal(verified.payload.invitation_id, "inv_1");
  assert.equal(verifyEs256Jws(jwt, pair.publicKeyPem).payload.invitation_id, "inv_1");
});

test("MetricsEmitter solo duplica dimension global [] en métricas con alarmas globales", () => {
  const emitter = new MetricsEmitter({ silent: true });
  const lag = emitter.lagFrescura("evt_123", 1450);
  assert.equal(lag.lag_frescura, 1450);
  assert.equal(lag.EventId, "evt_123");
  assert.deepEqual(lag._aws.CloudWatchMetrics[0].Dimensions, [["EventId"], []]);
  assert.deepEqual(lag._aws.CloudWatchMetrics[0].Metrics, [{ Name: "lag_frescura", Unit: "Milliseconds" }]);

  const rate = emitter.checkinRate("evt_123", 5);
  assert.deepEqual(rate._aws.CloudWatchMetrics[0].Dimensions, [["EventId"]]);
});
