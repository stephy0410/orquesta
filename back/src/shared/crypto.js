import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scryptCb);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function deriveKey32(keyMaterial, domain = "orquesta-pii-v1") {
  if (Buffer.isBuffer(keyMaterial) && keyMaterial.length === 32) {
    return keyMaterial;
  }
  const raw = typeof keyMaterial === "string" ? keyMaterial : String(keyMaterial || "orquesta-dev-key");
  return createHash("sha256").update(`${domain}:${raw}`).digest();
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || typeof storedHash !== "string") return false;
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expectedHex = parts[5];
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expectedHex) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedHex, "hex");
  const derived = await scryptAsync(password, salt, expectedBuf.length, { N, r, p });
  const actualBuf = Buffer.from(derived);
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

export function encryptPii(plaintext, keyMaterial) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = deriveKey32(keyMaterial, "orquesta-aes-gcm");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptPii(ciphertext, keyMaterial) {
  if (ciphertext === null || ciphertext === undefined) return null;
  if (typeof ciphertext !== "string" || !ciphertext.startsWith("enc:v1:")) {
    return ciphertext;
  }
  const parts = ciphertext.split(":");
  if (parts.length !== 5) {
    throw new Error("Malformed encrypted PII payload");
  }
  const key = deriveKey32(keyMaterial, "orquesta-aes-gcm");
  const iv = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  const data = Buffer.from(parts[4], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function hmacLookup(value, keyMaterial) {
  if (value === null || value === undefined) return null;
  const key = deriveKey32(keyMaterial, "orquesta-hmac-lookup");
  return createHmac("sha256", key).update(String(value), "utf8").digest("hex");
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
  return `{${entries.join(",")}}`;
}

export function computeBatchChecksum(events) {
  const ordered = [...events].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  return sha256Hex(canonicalJson(ordered));
}

export function generateOpaqueToken(prefix = "", byteLen = 24) {
  const token = randomBytes(byteLen).toString("base64url");
  return prefix ? `${prefix}${token}` : token;
}

export function generateShortCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function generateOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function generateEs256KeyPair(keyId = "k-local-1") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { keyId, privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export function derEcdsaToP1363(derBuf, partLength = 32) {
  let offset = 0;
  if (derBuf[offset++] !== 0x30) throw new Error("Invalid DER ECDSA signature");
  let seqLen = derBuf[offset++];
  if (seqLen & 0x80) {
    const numBytes = seqLen & 0x7f;
    offset += numBytes;
  }
  if (derBuf[offset++] !== 0x02) throw new Error("Invalid DER integer (r)");
  const rLen = derBuf[offset++];
  const rSlice = derBuf.subarray(offset, offset + rLen);
  offset += rLen;
  if (derBuf[offset++] !== 0x02) throw new Error("Invalid DER integer (s)");
  const sLen = derBuf[offset++];
  const sSlice = derBuf.subarray(offset, offset + sLen);

  const out = Buffer.alloc(partLength * 2);
  const rTrim = rSlice[0] === 0x00 && rSlice.length > partLength ? rSlice.subarray(rSlice.length - partLength) : rSlice;
  const sTrim = sSlice[0] === 0x00 && sSlice.length > partLength ? sSlice.subarray(sSlice.length - partLength) : sSlice;
  rTrim.copy(out, partLength - Math.min(partLength, rTrim.length), Math.max(0, rTrim.length - partLength));
  sTrim.copy(out, partLength * 2 - Math.min(partLength, sTrim.length), Math.max(0, sTrim.length - partLength));
  return out;
}

function encodeBase64UrlJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

export function signEs256Jws(payload, { privateKeyPem, keyId }) {
  const header = { alg: "ES256", typ: "JWT", kid: keyId };
  const signingInput = `${encodeBase64UrlJson(header)}.${encodeBase64UrlJson(payload)}`;
  const sig = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${sig.toString("base64url")}`;
}

export function verifyEs256Jws(token, publicKeyPemOrMap) {
  if (typeof token !== "string") throw new Error("Invalid JWS token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid compact JWS format");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  if (header.alg !== "ES256") throw new Error("Unsupported JWS alg");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));

  let publicKeyPem = publicKeyPemOrMap;
  if (typeof publicKeyPemOrMap === "object" && publicKeyPemOrMap !== null && !(publicKeyPemOrMap instanceof Uint8Array)) {
    publicKeyPem = publicKeyPemOrMap[header.kid] || publicKeyPemOrMap[payload.key_id];
  }
  if (!publicKeyPem) throw new Error("Unknown signing key_id");

  const sig = Buffer.from(sigB64, "base64url");
  if (sig.length !== 64) throw new Error("Invalid ES256 signature length");
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const ok = cryptoVerify("sha256", signingInput, { key: publicKeyPem, dsaEncoding: "ieee-p1363" }, sig);
  if (!ok) throw new Error("Invalid ES256 signature");
  return { header, payload };
}

export function signEs256Bytes(bytes, privateKeyPem) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  return cryptoSign("sha256", buf, {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

export function verifyEs256Bytes(bytes, signatureBase64Url, publicKeyPem) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  const sig = Buffer.from(signatureBase64Url, "base64url");
  if (sig.length !== 64) return false;
  return cryptoVerify("sha256", buf, { key: publicKeyPem, dsaEncoding: "ieee-p1363" }, sig);
}

export function signSessionJwt(payload, secret, ttlSeconds = 86400, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  const fullPayload = {
    ...payload,
    iat: payload.iat ?? nowSec,
    exp: payload.exp ?? nowSec + ttlSeconds,
  };
  const headerB64 = encodeBase64UrlJson({ alg: "HS256", typ: "JWT" });
  const payloadB64 = encodeBase64UrlJson(fullPayload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = createHmac("sha256", String(secret)).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

export function verifySessionJwt(token, secret, nowMs = Date.now()) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const expectedSig = createHmac("sha256", String(secret))
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actualSig = Buffer.from(sigB64, "base64url");
  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
    return null;
  }
  if (typeof payload.exp === "number" && Math.floor(nowMs / 1000) >= payload.exp) {
    return null;
  }
  return payload;
}

export function signWebhookHmac(rawBody, secret) {
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  return createHmac("sha256", String(secret)).update(bodyBuf).digest("hex");
}

export function verifyWebhookHmac(rawBody, providedSig, secret) {
  if (typeof providedSig !== "string" || providedSig.length === 0) return false;
  const normalized = providedSig.startsWith("sha256=") ? providedSig.slice(7) : providedSig;
  const expected = signWebhookHmac(rawBody, secret);
  const a = Buffer.from(normalized, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
