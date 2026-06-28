import { gunzipSync, gzipSync } from "fflate";

export const PROTOCOL = "QROPT/1";

export type TransferType = "manifest" | "chunk";
export type CompressionMode = "none" | "gzip";
export type EncryptionMode = "none" | "AES-GCM";

export type CryptoMetadata = {
  alg: "AES-GCM";
  iv: string;
  tagLength: 128;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
};

export type Manifest = {
  proto: typeof PROTOCOL;
  type: "manifest";
  transferId: string;
  file: {
    name: string;
    mime: string;
    size: number;
  };
  payload: {
    encoding: "base64url";
    compression: CompressionMode;
    encryption: EncryptionMode;
    chunkSize: number;
    chunkCount: number;
    size: number;
  };
  crypto?: CryptoMetadata;
  hash: {
    alg: "SHA-256";
    value: string;
  };
  display: {
    fps: number;
    loop: boolean;
  };
};

export type ChunkPacket = {
  proto: typeof PROTOCOL;
  type: "chunk";
  transferId: string;
  seq: number;
  total: number;
  data: string;
};

export type TransferBundle = {
  manifest: Manifest;
  chunks: ChunkPacket[];
  bytes: Uint8Array;
  payloadBytes: Uint8Array;
};

export type BuildTransferOptions = {
  name: string;
  mime: string;
  bytes: Uint8Array;
  chunkSize: number;
  fps: number;
  loop: boolean;
  compression: CompressionMode;
  passphrase?: string;
};

const AES_GCM_TAG_LENGTH = 128;
const PBKDF2_ITERATIONS = 250_000;

export function makeTransferId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function sha256Hex(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function makeHelloWorldText(chunkCount: number): string {
  return Array.from({ length: chunkCount }, (_, index) => {
    const seq = String(index + 1).padStart(3, "0");
    return `${seq}: Hello World`;
  }).join("\n");
}

export async function buildHelloWorldTransfer(options: {
  chunkCount: number;
  fps: number;
  loop: boolean;
}): Promise<TransferBundle> {
  const text = makeHelloWorldText(options.chunkCount);
  const bytes = new TextEncoder().encode(text);
  const lines = text.split("\n");
  const encodedChunks = lines.map((line, index) =>
    bytesToBase64Url(new TextEncoder().encode(`${line}${index === lines.length - 1 ? "" : "\n"}`))
  );
  const chunkSize = Math.max(...encodedChunks.map((chunk) => chunk.length));
  const transferId = makeTransferId();
  const hash = await sha256HexBytes(bytes);

  const manifest: Manifest = {
    proto: PROTOCOL,
    type: "manifest",
    transferId,
    file: {
      name: "hello-world.txt",
      mime: "text/plain",
      size: bytes.byteLength
    },
    payload: {
      encoding: "base64url",
      compression: "none",
      encryption: "none",
      chunkSize,
      chunkCount: encodedChunks.length,
      size: bytes.byteLength
    },
    hash: {
      alg: "SHA-256",
      value: hash
    },
    display: {
      fps: options.fps,
      loop: options.loop
    }
  };

  const chunks = encodedChunks.map<ChunkPacket>((data, seq) => ({
    proto: PROTOCOL,
    type: "chunk",
    transferId,
    seq,
    total: encodedChunks.length,
    data
  }));

  return { manifest, chunks, bytes, payloadBytes: bytes };
}

export async function buildByteTransfer(options: BuildTransferOptions): Promise<TransferBundle> {
  const transferId = makeTransferId();
  const chunkSize = Math.max(1, options.chunkSize);
  const compression = options.compression;
  const passphrase = options.passphrase?.trim() ?? "";
  const encryption: EncryptionMode = passphrase ? "AES-GCM" : "none";
  const transform = await encodePayload(options.bytes, {
    compression,
    passphrase
  });
  const encodedChunks: string[] = [];

  for (let offset = 0; offset < transform.bytes.byteLength; offset += chunkSize) {
    encodedChunks.push(bytesToBase64Url(transform.bytes.slice(offset, offset + chunkSize)));
  }

  if (encodedChunks.length === 0) {
    encodedChunks.push("");
  }

  const manifest: Manifest = {
    proto: PROTOCOL,
    type: "manifest",
    transferId,
    file: {
      name: options.name,
      mime: options.mime || "application/octet-stream",
      size: options.bytes.byteLength
    },
    payload: {
      encoding: "base64url",
      compression,
      encryption,
      chunkSize,
      chunkCount: encodedChunks.length,
      size: transform.bytes.byteLength
    },
    crypto: transform.crypto,
    hash: {
      alg: "SHA-256",
      value: await sha256HexBytes(options.bytes)
    },
    display: {
      fps: options.fps,
      loop: options.loop
    }
  };

  const chunks = encodedChunks.map<ChunkPacket>((data, seq) => ({
    proto: PROTOCOL,
    type: "chunk",
    transferId,
    seq,
    total: encodedChunks.length,
    data
  }));

  return { manifest, chunks, bytes: options.bytes, payloadBytes: transform.bytes };
}

export async function decodePayload(
  payloadBytes: Uint8Array,
  manifest: Manifest,
  passphrase: string
): Promise<Uint8Array> {
  let bytes = payloadBytes;

  if (manifest.payload.encryption === "AES-GCM") {
    if (!manifest.crypto) {
      throw new Error("Encrypted manifest is missing crypto metadata.");
    }

    if (!passphrase.trim()) {
      throw new Error("Passphrase is required.");
    }

    bytes = await decryptAesGcm(bytes, passphrase, manifest.crypto);
  }

  if (manifest.payload.compression === "gzip") {
    bytes = await decompressGzip(bytes);
  }

  return bytes;
}

export async function encodePayload(
  originalBytes: Uint8Array,
  options: {
    compression: CompressionMode;
    passphrase?: string;
  }
): Promise<{ bytes: Uint8Array; crypto?: CryptoMetadata }> {
  let bytes = originalBytes;

  if (options.compression === "gzip") {
    bytes = await compressGzip(bytes);
  }

  const passphrase = options.passphrase?.trim() ?? "";
  if (!passphrase) {
    return { bytes };
  }

  return encryptAesGcm(bytes, passphrase);
}

export function parsePacket(value: string): Manifest | ChunkPacket | null {
  try {
    const packet = JSON.parse(value) as Partial<Manifest | ChunkPacket>;

    if (packet.proto !== PROTOCOL) {
      return null;
    }

    if (packet.type === "manifest" && isManifest(packet)) {
      return packet;
    }

    if (packet.type === "chunk" && isChunkPacket(packet)) {
      return packet;
    }

    return null;
  } catch {
    return null;
  }
}

export function assembleText(chunks: Map<number, string>, total: number): string {
  return new TextDecoder().decode(assembleBytes(chunks, total)).replace(/\n$/u, "");
}

export function assembleBytes(chunks: Map<number, string>, total: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let byteLength = 0;

  for (let seq = 0; seq < total; seq += 1) {
    const data = chunks.get(seq);
    if (data === undefined) {
      throw new Error(`Missing chunk ${seq}`);
    }

    const bytes = base64UrlToBytes(data);
    parts.push(bytes);
    byteLength += bytes.byteLength;
  }

  const result = new Uint8Array(byteLength);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result;
}

export async function compressGzip(bytes: Uint8Array): Promise<Uint8Array> {
  return gzipSync(bytes, { level: 9 });
}

export async function decompressGzip(bytes: Uint8Array): Promise<Uint8Array> {
  return gunzipSync(bytes);
}

async function encryptAesGcm(
  bytes: Uint8Array,
  passphrase: string
): Promise<{ bytes: Uint8Array; crypto: CryptoMetadata }> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const metadata: CryptoMetadata = {
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
  const key = await deriveAesKey(passphrase, metadata);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesToArrayBuffer(iv), tagLength: AES_GCM_TAG_LENGTH },
    key,
    bytesToArrayBuffer(bytes)
  );

  return { bytes: new Uint8Array(encrypted), crypto: metadata };
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
    bytesToArrayBuffer(new TextEncoder().encode(passphrase)),
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

function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

function isManifest(packet: Partial<Manifest | ChunkPacket>): packet is Manifest {
  return (
    packet.type === "manifest" &&
    typeof packet.transferId === "string" &&
    typeof packet.file?.name === "string" &&
    typeof packet.file.mime === "string" &&
    typeof packet.file.size === "number" &&
    packet.payload?.encoding === "base64url" &&
    (packet.payload.compression === "none" || packet.payload.compression === "gzip") &&
    (packet.payload.encryption === "none" || packet.payload.encryption === "AES-GCM") &&
    typeof packet.payload.chunkSize === "number" &&
    typeof packet.payload.chunkCount === "number" &&
    typeof packet.payload.size === "number" &&
    hasValidCryptoMetadata(packet) &&
    packet.hash?.alg === "SHA-256" &&
    typeof packet.hash.value === "string" &&
    typeof packet.display?.fps === "number" &&
    typeof packet.display.loop === "boolean"
  );
}

function hasValidCryptoMetadata(packet: Partial<Manifest | ChunkPacket>): boolean {
  if (packet.type !== "manifest" || packet.payload?.encryption === "none") {
    return true;
  }

  if (!packet.payload) {
    return false;
  }

  return (
    packet.payload.encryption === "AES-GCM" &&
    packet.crypto?.alg === "AES-GCM" &&
    typeof packet.crypto.iv === "string" &&
    packet.crypto.tagLength === AES_GCM_TAG_LENGTH &&
    packet.crypto.kdf?.name === "PBKDF2" &&
    packet.crypto.kdf.hash === "SHA-256" &&
    typeof packet.crypto.kdf.iterations === "number" &&
    typeof packet.crypto.kdf.salt === "string"
  );
}

function isChunkPacket(packet: Partial<Manifest | ChunkPacket>): packet is ChunkPacket {
  return (
    packet.type === "chunk" &&
    typeof packet.transferId === "string" &&
    typeof packet.seq === "number" &&
    typeof packet.total === "number" &&
    typeof packet.data === "string"
  );
}
