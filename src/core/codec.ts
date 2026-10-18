/**
 * QROPT/2 wire format.
 *
 * Manifests stay human readable JSON (they are sent rarely and are the most
 * useful thing to inspect by hand). Data and repair frames are a compact ASCII
 * envelope instead, because they make up >99% of the traffic:
 *
 *   Q2<id><kind><seq>:<base64url payload>*<crc32 base36>
 *
 *   Q2k3f9d1a:AAECAwQFBgc*1z9k2p
 *   ^^ ^^^^ ^ ^  ^          ^
 *   |  |    | |  |          +-- CRC-32 of everything before '*'
 *   |  |    | |  +------------- base64url payload bytes
 *   |  |    | +---------------- sequence number (base36)
 *   |  |    +------------------ kind: 'd' data, 'r' repair
 *   |  +----------------------- transfer id (4 chars, base36)
 *   +-------------------------- protocol magic
 *
 * The envelope costs 13-18 characters instead of the ~55 characters the old
 * JSON chunk packet required, and the CRC lets the receiver drop a rare
 * miscorrected QR before it poisons the file hash.
 */
import {
  base64UrlToBytes,
  bytesToBase64Url,
  crc32Ascii,
  fromBase36,
  randomBytes,
  toBase36
} from "./bytes.ts";

export const PROTOCOL = "QROPT/2";
export const MAGIC = "Q2";
export const TRANSFER_ID_LENGTH = 4;
export const MAX_CHUNK_COUNT = 100_000;
export const MAX_REPAIR_COUNT = 20_000;
export const MAX_CHUNK_BYTES = 4096;

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
    repairCount: number;
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
    beaconSeconds: number;
  };
};

export type FrameKind = "data" | "repair";

export type Frame =
  | { kind: "manifest"; manifest: Manifest; text: string }
  | {
      kind: FrameKind;
      transferId: string;
      seq: number;
      payload: Uint8Array;
    };

export type ParseResult =
  | { status: "ok"; frame: Frame }
  | { status: "corrupt" }
  | { status: "unknown" };

const KIND_TO_CHAR: Record<FrameKind, string> = { data: "d", repair: "r" };
const CHAR_TO_KIND: Record<string, FrameKind> = { d: "data", r: "repair" };
const HEADER_LENGTH = MAGIC.length + TRANSFER_ID_LENGTH + 1; // magic + id + kind

export function makeTransferId(): string {
  // 4 base36 characters keeps frames short while still giving ~1.7M ids.
  const [a, b, c, d] = randomBytes(4);
  const value = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return toBase36(value % 36 ** TRANSFER_ID_LENGTH).padStart(TRANSFER_ID_LENGTH, "0");
}

export function encodeChunkFrame(
  transferId: string,
  kind: FrameKind,
  seq: number,
  payload: Uint8Array
): string {
  const body = `${MAGIC}${transferId}${KIND_TO_CHAR[kind]}${toBase36(seq)}:${bytesToBase64Url(
    payload
  )}`;
  return `${body}*${toBase36(crc32Ascii(body))}`;
}

export function encodeManifestFrame(manifest: Manifest): string {
  return JSON.stringify(manifest);
}

export function parseFrame(rawText: string): ParseResult {
  const text = rawText.trim();

  if (text.length === 0) {
    return { status: "unknown" };
  }

  if (text.startsWith("{")) {
    const manifest = parseManifestText(text);
    return manifest ? { status: "ok", frame: { kind: "manifest", manifest, text } } : { status: "corrupt" };
  }

  if (!text.startsWith(MAGIC)) {
    return { status: "unknown" };
  }

  const frame = parseChunkText(text);
  return frame ? { status: "ok", frame } : { status: "corrupt" };
}

export function parseChunkText(text: string): Extract<Frame, { kind: FrameKind }> | null {
  const starIndex = text.lastIndexOf("*");
  if (starIndex <= HEADER_LENGTH) {
    return null;
  }

  const body = text.slice(0, starIndex);
  const checksum = fromBase36(text.slice(starIndex + 1));
  if (checksum === null || checksum !== crc32Ascii(body)) {
    return null;
  }

  const separatorIndex = body.indexOf(":", HEADER_LENGTH);
  if (separatorIndex < 0) {
    return null;
  }

  const transferId = body.slice(MAGIC.length, MAGIC.length + TRANSFER_ID_LENGTH);
  if (!/^[0-9a-z]{4}$/u.test(transferId)) {
    return null;
  }

  const kind = CHAR_TO_KIND[body[MAGIC.length + TRANSFER_ID_LENGTH]];
  if (!kind) {
    return null;
  }

  const seq = fromBase36(body.slice(HEADER_LENGTH, separatorIndex));
  if (seq === null || seq >= MAX_CHUNK_COUNT) {
    return null;
  }

  const encoded = body.slice(separatorIndex + 1);
  if (encoded.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4) {
    return null;
  }

  return {
    kind,
    transferId,
    seq,
    payload: base64UrlToBytes(encoded)
  };
}

export function parseManifestText(text: string): Manifest | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  return validateManifest(value);
}

export function validateManifest(value: unknown): Manifest | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const manifest = value as Partial<Manifest>;
  const file = manifest.file;
  const payload = manifest.payload;
  const display = manifest.display;

  if (
    manifest.proto !== PROTOCOL ||
    manifest.type !== "manifest" ||
    typeof manifest.transferId !== "string" ||
    !/^[0-9a-z]{4}$/u.test(manifest.transferId)
  ) {
    return null;
  }

  if (
    !file ||
    typeof file.name !== "string" ||
    file.name.length === 0 ||
    file.name.length > 512 ||
    typeof file.mime !== "string" ||
    file.mime.length > 200 ||
    !isFiniteNumber(file.size, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }

  if (
    !payload ||
    payload.encoding !== "base64url" ||
    (payload.compression !== "none" && payload.compression !== "gzip") ||
    (payload.encryption !== "none" && payload.encryption !== "AES-GCM") ||
    !isFiniteNumber(payload.chunkSize, 1, MAX_CHUNK_BYTES) ||
    !isFiniteNumber(payload.chunkCount, 1, MAX_CHUNK_COUNT) ||
    !isFiniteNumber(payload.repairCount, 0, MAX_REPAIR_COUNT) ||
    !isFiniteNumber(payload.size, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }

  if (
    !manifest.hash ||
    manifest.hash.alg !== "SHA-256" ||
    !/^[0-9a-f]{64}$/u.test(manifest.hash.value)
  ) {
    return null;
  }

  if (
    !display ||
    !isFiniteNumber(display.fps, 1, 60) ||
    typeof display.loop !== "boolean" ||
    !isFiniteNumber(display.beaconSeconds, 0, 60)
  ) {
    return null;
  }

  if (!hasValidCryptoMetadata(manifest)) {
    return null;
  }

  return manifest as Manifest;
}

function hasValidCryptoMetadata(manifest: Partial<Manifest>): boolean {
  if (manifest.payload?.encryption === "none") {
    return manifest.crypto === undefined;
  }

  const meta = manifest.crypto;
  return (
    !!meta &&
    meta.alg === "AES-GCM" &&
    typeof meta.iv === "string" &&
    meta.tagLength === 128 &&
    !!meta.kdf &&
    meta.kdf.name === "PBKDF2" &&
    meta.kdf.hash === "SHA-256" &&
    isFiniteNumber(meta.kdf.iterations, 1, 10_000_000) &&
    typeof meta.kdf.salt === "string"
  );
}

function isFiniteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function frameCharsForChunk(chunkSize: number): number {
  // 4 header-ish chars + ':' + base64 + '*' + crc (max 7 base36 chars).
  return HEADER_LENGTH + 8 + Math.ceil(chunkSize / 3) * 4 + 1 + 7;
}

export function transformLabel(manifest: Manifest): string {
  const parts = [manifest.payload.compression, manifest.payload.encryption].filter(
    (part) => part !== "none"
  );
  return parts.length > 0 ? parts.join(" + ") : "none";
}
