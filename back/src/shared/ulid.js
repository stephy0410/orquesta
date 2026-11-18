import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRand = new Uint8Array(10);

/**
 * Genera un ULID de 26 caracteres Crockford Base32 ordenado lexicográficamente por tiempo.
 */
export function ulid(nowMs = Date.now()) {
  const chars = new Array(26);
  let t = Math.floor(nowMs);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[t % 32];
    t = Math.floor(t / 32);
  }

  if (nowMs === lastTime) {
    // Incremento monotónico dentro del mismo milisegundo
    for (let i = 9; i >= 0; i--) {
      if (lastRand[i] < 255) {
        lastRand[i]++;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastTime = nowMs;
    lastRand = randomBytes(10);
  }

  // 80 bits -> 16 símbolos Base32
  let bitBuf = 0;
  let bits = 0;
  let idx = 10;
  for (let i = 0; i < 10; i++) {
    bitBuf = (bitBuf << 8) | lastRand[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars[idx++] = CROCKFORD[(bitBuf >> bits) & 31];
    }
  }
  if (bits > 0 && idx < 26) {
    chars[idx++] = CROCKFORD[(bitBuf << (5 - bits)) & 31];
  }

  return chars.join("");
}

export function isValidUlid(value) {
  return typeof value === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
