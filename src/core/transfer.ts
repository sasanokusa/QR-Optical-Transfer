import { clampNumber, utf8Encoder } from "./bytes.ts";
import {
  encodeChunkFrame,
  encodeManifestFrame,
  MAX_CHUNK_BYTES,
  MAX_REPAIR_COUNT,
  makeTransferId,
  PROTOCOL,
  type CompressionMode,
  type Manifest
} from "./codec.ts";
import { encodePayload, sha256Hex } from "./crypto.ts";
import { buildRepairChunks } from "./repair.ts";

export type TransferSource = {
  name: string;
  mime: string;
  bytes: Uint8Array;
};

export type TransferOptions = {
  chunkSize: number;
  /** 0..0.5 share of the data chunks emitted as repair chunks. */
  repairRatio: number;
  /** "auto" gzips only when that actually shrinks the payload. */
  compression: CompressionMode | "auto";
  passphrase?: string;
  fps: number;
  loop: boolean;
  beaconSeconds: number;
  /** Deterministic id, used by the smoke tests. Defaults to a random id. */
  transferId?: string;
};

export type TransferBundle = {
  manifest: Manifest;
  manifestText: string;
  /** Transformed payload chunks (K). */
  data: Uint8Array[];
  /** XOR repair chunks (R). */
  repairs: Uint8Array[];
};

export type Unit = { kind: "data" | "repair"; seq: number };

export type Schedule = {
  units: Unit[];
  manifestText: string;
  manifestEveryTicks: number;
  dataCount: number;
  repairCount: number;
};

const DEFAULT_OPTIONS: TransferOptions = {
  chunkSize: 900,
  repairRatio: 0.12,
  compression: "auto",
  fps: 5,
  loop: true,
  beaconSeconds: 3
};

export async function buildTransfer(
  source: TransferSource,
  options: Partial<TransferOptions> = {}
): Promise<TransferBundle> {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const encoded = await encodePayload(source.bytes, {
    compression: settings.compression,
    passphrase: settings.passphrase
  });

  const payloadSize = encoded.bytes.byteLength;
  const chunkSize = Math.min(
    clampNumber(settings.chunkSize, 1, MAX_CHUNK_BYTES),
    Math.max(1, payloadSize)
  );
  const chunkCount = Math.max(1, Math.ceil(payloadSize / chunkSize));
  const transferId =
    settings.transferId && /^[0-9a-z]{4}$/u.test(settings.transferId)
      ? settings.transferId
      : makeTransferId();

  const data: Uint8Array[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    data.push(encoded.bytes.subarray(index * chunkSize, (index + 1) * chunkSize));
  }

  const repairCount = computeRepairCount(chunkCount, settings.repairRatio);
  const repairs = buildRepairChunks(data, transferId, repairCount, chunkSize);

  const manifest: Manifest = {
    proto: PROTOCOL,
    type: "manifest",
    transferId,
    file: {
      name: source.name || "transfer.bin",
      mime: source.mime || "application/octet-stream",
      size: source.bytes.byteLength
    },
    payload: {
      encoding: "base64url",
      compression: encoded.compression,
      encryption: encoded.encryption,
      chunkSize,
      chunkCount,
      repairCount,
      size: payloadSize
    },
    crypto: encoded.crypto,
    hash: {
      alg: "SHA-256",
      value: await sha256Hex(source.bytes)
    },
    display: {
      fps: clampNumber(settings.fps, 1, 30),
      loop: settings.loop,
      beaconSeconds: clampNumber(settings.beaconSeconds, 0, 60)
    }
  };

  return {
    manifest,
    manifestText: encodeManifestFrame(manifest),
    data,
    repairs
  };
}

export function computeRepairCount(chunkCount: number, ratio: number): number {
  if (chunkCount <= 1 || ratio <= 0) {
    return 0;
  }

  const share = clampNumber(ratio * 100, 0, 50) / 100;
  return Math.min(MAX_REPAIR_COUNT, Math.max(1, Math.round(chunkCount * share)));
}

export function createSchedule(
  bundle: TransferBundle,
  options: { fps: number; beaconSeconds: number; interleave?: boolean }
): Schedule {
  const dataCount = bundle.data.length;
  const repairCount = bundle.repairs.length;
  const interleave = options.interleave ?? true;
  const dataOrder = permutedOrder(dataCount, interleave);
  const repairOrder = permutedOrder(repairCount, interleave);
  const units: Unit[] = [];
  let repairsPlaced = 0;

  for (let index = 0; index < dataCount; index += 1) {
    units.push({ kind: "data", seq: dataOrder[index] });

    const targetRepairs =
      repairCount === 0 ? 0 : Math.round(((index + 1) / dataCount) * repairCount);

    while (repairsPlaced < targetRepairs && repairsPlaced < repairCount) {
      units.push({ kind: "repair", seq: repairOrder[repairsPlaced] });
      repairsPlaced += 1;
    }
  }

  while (repairsPlaced < repairCount) {
    units.push({ kind: "repair", seq: repairOrder[repairsPlaced] });
    repairsPlaced += 1;
  }

  return {
    units,
    manifestText: bundle.manifestText,
    manifestEveryTicks: Math.max(2, Math.round(options.fps * options.beaconSeconds)),
    dataCount,
    repairCount
  };
}

/**
 * Interleaving spreads consecutive displayed frames far apart in chunk order,
 * so a burst of dropped frames (autofocus hunt, glare, a page repaint) costs
 * widely separated chunks instead of a contiguous block.
 */
function permutedOrder(count: number, interleave: boolean): number[] {
  const order = Array.from({ length: count }, (_, index) => index);
  if (!interleave || count < 3) {
    return order;
  }

  let stride = Math.min(count - 1, Math.max(1, Math.round(count * 0.618)));
  while (gcd(stride, count) !== 1) {
    stride += 1;
  }

  if (stride >= count) {
    stride = 1;
  }

  return Array.from({ length: count }, (_, index) => (index * stride) % count);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);

  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }

  return x || 1;
}

const frameCache = new WeakMap<TransferBundle, Map<string, string>>();

export function frameText(bundle: TransferBundle, unit: Unit): string {
  let cache = frameCache.get(bundle);
  if (!cache) {
    cache = new Map();
    frameCache.set(bundle, cache);
  }

  const key = `${unit.kind[0]}${unit.seq}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const payload = unit.kind === "data" ? bundle.data[unit.seq] : bundle.repairs[unit.seq];
  if (!payload) {
    throw new Error(`Chunk ${unit.kind}:${unit.seq} is out of range.`);
  }

  const text = encodeChunkFrame(bundle.manifest.transferId, unit.kind, unit.seq, payload);
  cache.set(key, text);
  return text;
}

export function makeDemoText(lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, index) => `${String(index + 1).padStart(3, "0")}: Hello World`
  ).join("\n");
}

export function demoSource(lineCount: number): TransferSource {
  const text = makeDemoText(lineCount);
  return {
    name: "hello-world.txt",
    mime: "text/plain",
    bytes: utf8Encoder.encode(text)
  };
}

/** Frames (data + repair, no beacons) in one full pass. */
export function passFrameCount(bundle: TransferBundle): number {
  return bundle.data.length + bundle.repairs.length;
}

export type TickPlan = {
  cells: string[];
  cursor: number;
  beacon: boolean;
};

/**
 * Work out what the screen shows for one tick. A beacon tick reserves the first
 * cell for the manifest; the remaining cells (multi-QR mode) keep streaming
 * data so the transfer never fully stalls.
 */
export function planTick(
  bundle: TransferBundle,
  schedule: Schedule,
  cursor: number,
  tick: number,
  cellCount = 1
): TickPlan {
  const cells: string[] = [];
  const beacon = tick % schedule.manifestEveryTicks === 0;

  if (beacon) {
    cells.push(schedule.manifestText);
  }

  let nextCursor = cursor;
  while (cells.length < Math.max(1, cellCount)) {
    const unit = schedule.units[nextCursor % schedule.units.length];
    cells.push(frameText(bundle, unit));
    nextCursor += 1;
  }

  return { cells, cursor: nextCursor, beacon };
}
