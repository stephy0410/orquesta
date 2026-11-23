// Firma con KMS (QR y roster offline): el roster de un evento pesa más que el límite de 4096 bytes
// de KMS en modo RAW, así que se firma el digest SHA-256. No usa red ni base de datos.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { derEcdsaToP1363, verifyEs256Bytes } from "../src/shared/crypto.js";
import { kmsSignInput } from "../src/shared/ports.js";

test("la firma con KMS manda el digest SHA-256, sin límite de tamaño del roster", () => {
  const roster = Buffer.from(JSON.stringify({ invitados: Array.from({ length: 600 }, (_, i) => `inv-${i}`) }));
  assert.ok(roster.length > 4096);

  const input = kmsSignInput("alias/qr", roster);
  assert.equal(input.MessageType, "DIGEST");
  assert.equal(input.SigningAlgorithm, "ECDSA_SHA_256");
  assert.equal(input.Message.length, 32);
  assert.deepEqual(input.Message, createHash("sha256").update(roster).digest());
  assert.deepEqual(kmsSignInput("alias/qr", roster.toString("utf8")).Message, input.Message);
});

test("una firma ECDSA_SHA_256 sobre ese digest se verifica contra el mensaje completo", () => {
  // KMS con DIGEST firma el hash recibido; equivale a firmar el mensaje con SHA-256 (DER).
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const roster = Buffer.from("x".repeat(10_000));
  const der = sign("sha256", roster, privateKey);
  const sig = derEcdsaToP1363(der).toString("base64url");
  assert.equal(verifyEs256Bytes(roster, sig, publicKey.export({ type: "spki", format: "pem" })), true);
});
