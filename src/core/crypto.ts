import { gunzipSync, gzipSync } from "fflate";
import {
  base64UrlToBytes,
  bytesToArrayBuffer,
  bytesToBase64Url,
  randomBytes,
  utf8Encoder
} from "./bytes.ts";
import type { CompressionMode, CryptoMetadata, EncryptionMode } from "./codec.ts";

const AES_GCM_TAG_LENGTH = 128;
const AES_GCM_IV_BYTES = 12;
const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return toHex(new Uint8Array(digest));
}

export async function sha256HexUtf8(text: string): Promise<string> {
  return sha256Hex(utf8Encoder.encode(text));
}

export function gzipBytes(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes, { level: 9 });
}

export function gunzipBytes(bytes: Uint8Array): Uint8Array {
  return gunzipSync(bytes);
}

export type EncodedPayload = {
  bytes: Uint8Array;
  compression: CompressionMode;
  encryption: EncryptionMode;
  crypto?: CryptoMetadata;
};

export type EncodePayloadOptions = {
  /** "auto" keeps gzip only when it actually shrinks the payload. */
  compression: CompressionMode | "auto";
  passphrase?: string;
};

/**
 * Compression happens before encryption; both happen before chunking.
 */
export async function encodePayload(
  originalBytes: Uint8Array,
  options: EncodePayloadOptions
): Promise<EncodedPayload> {
  let bytes = originalBytes;
  let compression: CompressionMode = "none";

  if (options.compression === "gzip" || options.compression === "auto") {
    await yieldToEventLoop();
    const compressed = gzipBytes(originalBytes);
    const worthwhile =
      options.compression === "gzip" ? true : compressed.byteLength < originalBytes.byteLength;

    if (worthwhile) {
      bytes = compressed;
      compression = "gzip";
    }
  }

  const passphrase = options.passphrase?.trim() ?? "";
  if (!passphrase) {
    return { bytes, compression, encryption: "none" };
  }

  const encrypted = await encryptAesGcm(bytes, passphrase);
  return {
    bytes: encrypted.bytes,
    compression,
    encryption: "AES-GCM",
    crypto: encrypted.crypto
  };
}

export async function decodePayload(
  payloadBytes: Uint8Array,
  options: {
    compression: CompressionMode;
    encryption: EncryptionMode;
    crypto?: CryptoMetadata;
    passphrase?: string;
  }
): Promise<Uint8Array> {
  let bytes = payloadBytes;

  if (options.encryption === "AES-GCM") {
    if (!options.crypto) {
      throw new Error("Encrypted transfer is missing its crypto metadata.");
    }

    const passphrase = options.passphrase?.trim() ?? "";
    if (!passphrase) {
      throw new Error("This transfer is encrypted. Enter the passphrase to unlock it.");
    }

    try {
      bytes = await decryptAesGcm(bytes, passphrase, options.crypto);
    } catch {
      throw new Error("That passphrase did not unlock this transfer.");
    }
  }

  if (options.compression === "gzip") {
    try {
      bytes = gunzipBytes(bytes);
    } catch {
      throw new Error("The restored payload could not be decompressed.");
    }
  }

  return bytes;
}

/** Short, human-transferable passphrase (no look-alike characters). */
export function generatePassphrase(words = 4): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(words);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function encryptAesGcm(
  bytes: Uint8Array,
  passphrase: string
): Promise<{ bytes: Uint8Array; crypto: CryptoMetadata }> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const cryptoMetadata: CryptoMetadata = {
    alg: "AES-GCM",
    iv: bytesToBase64Url(iv),
    tagLength: AES_GCM_TAG_LENGTH,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64Url(salt)
    }
  };
  const key = await deriveAesKey(passphrase, cryptoMetadata);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: bytesToArrayBuffer(iv),
      tagLength: AES_GCM_TAG_LENGTH
    },
    key,
    bytesToArrayBuffer(bytes)
  );

  return { bytes: new Uint8Array(encrypted), crypto: cryptoMetadata };
}

async function decryptAesGcm(
  bytes: Uint8Array,
  passphrase: string,
  metadata: CryptoMetadata
): Promise<Uint8Array> {
  const key = await deriveAesKey(passphrase, metadata);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytesToArrayBuffer(base64UrlToBytes(metadata.iv)),
      tagLength: metadata.tagLength
    },
    key,
    bytesToArrayBuffer(bytes)
  );

  return new Uint8Array(decrypted);
}

async function deriveAesKey(passphrase: string, metadata: CryptoMetadata): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(utf8Encoder.encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: metadata.kdf.hash,
      salt: bytesToArrayBuffer(base64UrlToBytes(metadata.kdf.salt)),
      iterations: metadata.kdf.iterations
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
