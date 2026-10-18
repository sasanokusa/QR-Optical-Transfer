/**
 * Byte plumbing shared by the protocol, the sender and the receiver.
 *
 * Everything here is deliberately dependency free so the same code runs in the
 * browser bundle and in the Node based smoke tests.
 */

export const utf8Encoder = new TextEncoder();
export const utf8Decoder = new TextDecoder();

const BASE64_STRING_CHUNK = 0x8000;

/** Base64url without padding (URL safe, safe inside QR text frames). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    return "";
  }

  // Building one huge binary string with += is O(n^2) for multi-MB files, so
  // convert in fixed size slices and join once.
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_STRING_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_STRING_CHUNK)));
  }

  return btoa(parts.join("")).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (value.length === 0) {
    return new Uint8Array(0);
  }

  const padding = (4 - (value.length % 4)) % 4;
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat(padding));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function concatBytes(parts: readonly Uint8Array[], totalLength?: number): Uint8Array {
  const length = totalLength ?? parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    const remaining = length - offset;
    if (remaining <= 0) {
      break;
    }
    // A chunk that was reconstructed from repair data is padded to chunkSize,
    // so the final part can be longer than the space that is left.
    result.set(part.byteLength > remaining ? part.subarray(0, remaining) : part, offset);
    offset += Math.min(part.byteLength, remaining);
  }

  return result;
}

/**
 * target ^= source, in place. Falls back to byte wise work when the buffers are
 * not 4-byte aligned (the protocol allocates its own, but be defensive).
 */
export function xorInto(target: Uint8Array, source: Uint8Array): void {
  const length = Math.min(target.byteLength, source.byteLength);

  if (
    length >= 4 &&
    target.byteOffset % 4 === 0 &&
    source.byteOffset % 4 === 0
  ) {
    const words = Math.floor(length / 4);
    const targetWords = new Uint32Array(target.buffer, target.byteOffset, words);
    const sourceWords = new Uint32Array(source.buffer, source.byteOffset, words);

    for (let index = 0; index < words; index += 1) {
      targetWords[index] ^= sourceWords[index];
    }

    for (let index = words * 4; index < length; index += 1) {
      target[index] ^= source[index];
    }

    return;
  }

  for (let index = 0; index < length; index += 1) {
    target[index] ^= source[index];
  }
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function toBase36(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }

  let remaining = Math.floor(value);
  let text = "";

  while (remaining > 0) {
    text = BASE36_ALPHABET[remaining % 36] + text;
    remaining = Math.floor(remaining / 36);
  }

  return text;
}

export function fromBase36(value: string): number | null {
  if (!/^[0-9a-z]{1,8}$/u.test(value)) {
    return null;
  }

  return parseInt(value, 36);
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
}

/** CRC-32 over the low byte of each character (all protocol text is ASCII). */
export function crc32Ascii(value: string): number {
  let crc = 0xffffffff;

  for (let index = 0; index < value.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ value.charCodeAt(index)) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/** splitmix32: tiny, fast, good enough for mask / ordering seeds. */
export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
    return (value ^ (value >>> 15)) >>> 0;
  };
}

export function hashStringToSeed(value: string): number {
  return crc32Ascii(value);
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }

  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
}
