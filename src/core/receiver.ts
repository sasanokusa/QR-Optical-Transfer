import { concatBytes } from "./bytes.ts";
import { parseFrame, type FrameKind, type Manifest } from "./codec.ts";
import { decodePayload, sha256Hex } from "./crypto.ts";
import { solveMissingChunks } from "./repair.ts";

export type ReceiverStatus =
  | "idle"
  | "awaiting-accept"
  | "receiving"
  | "verifying"
  | "complete"
  | "error";

export type ReceiverStats = {
  frames: number;
  accepted: number;
  duplicates: number;
  corrupt: number;
  foreign: number;
  unknown: number;
  repaired: number;
};

export type ReceiverSession = {
  status: ReceiverStatus;
  manifest: Manifest | null;
  /** A manifest for another transfer seen while this one had progress. */
  pendingManifest: Manifest | null;
  autoAccept: boolean;
  data: Map<number, Uint8Array>;
  repairs: Map<number, Uint8Array>;
  /** Chunks that were reconstructed from repair chunks. */
  recovered: Set<number>;
  restoredBytes: Uint8Array | null;
  error: string | null;
  hashStatus: "idle" | "valid" | "invalid";
  stats: ReceiverStats;
  lastSolveAt: number;
};

export type IngestResult =
  | {
      type: "manifest";
      manifest: Manifest;
      applied: boolean;
      duplicate: boolean;
      pending: boolean;
      awaitingAccept: boolean;
    }
  | {
      type: "chunk";
      kind: FrameKind;
      seq: number;
      accepted: boolean;
      duplicate: boolean;
      reason?: "not-receiving" | "out-of-range";
    }
  | { type: "corrupt" }
  | { type: "foreign" }
  | { type: "unknown" };

export function createReceiverSession(options: { autoAccept?: boolean } = {}): ReceiverSession {
  return {
    status: "idle",
    manifest: null,
    pendingManifest: null,
    autoAccept: options.autoAccept ?? true,
    data: new Map(),
    repairs: new Map(),
    recovered: new Set(),
    restoredBytes: null,
    error: null,
    hashStatus: "idle",
    stats: {
      frames: 0,
      accepted: 0,
      duplicates: 0,
      corrupt: 0,
      foreign: 0,
      unknown: 0,
      repaired: 0
    },
    lastSolveAt: 0
  };
}

export function resetReceiverSession(session: ReceiverSession): void {
  const autoAccept = session.autoAccept;
  Object.assign(session, createReceiverSession({ autoAccept }));
}

export function ingestText(session: ReceiverSession, text: string): IngestResult {
  session.stats.frames += 1;

  const parsed = parseFrame(text);
  if (parsed.status === "corrupt") {
    session.stats.corrupt += 1;
    return { type: "corrupt" };
  }

  if (parsed.status === "unknown") {
    session.stats.unknown += 1;
    return { type: "unknown" };
  }

  const frame = parsed.frame;

  if (frame.kind === "manifest") {
    return ingestManifest(session, frame.manifest);
  }

  const manifest = session.manifest;
  if (!manifest || frame.transferId !== manifest.transferId) {
    session.stats.foreign += 1;
    return { type: "foreign" };
  }

  if (session.status === "awaiting-accept") {
    return {
      type: "chunk",
      kind: frame.kind,
      seq: frame.seq,
      accepted: false,
      duplicate: false,
      reason: "not-receiving"
    };
  }

  const limit =
    frame.kind === "data" ? manifest.payload.chunkCount : manifest.payload.repairCount;

  if (frame.kind === "repair" && limit === 0) {
    return {
      type: "chunk",
      kind: frame.kind,
      seq: frame.seq,
      accepted: false,
      duplicate: false,
      reason: "out-of-range"
    };
  }

  if (frame.seq >= limit) {
    return {
      type: "chunk",
      kind: frame.kind,
      seq: frame.seq,
      accepted: false,
      duplicate: false,
      reason: "out-of-range"
    };
  }

  const store = frame.kind === "data" ? session.data : session.repairs;
  if (store.has(frame.seq)) {
    session.stats.duplicates += 1;
    return {
      type: "chunk",
      kind: frame.kind,
      seq: frame.seq,
      accepted: false,
      duplicate: true
    };
  }

  store.set(frame.seq, frame.payload);
  session.stats.accepted += 1;
  return {
    type: "chunk",
    kind: frame.kind,
    seq: frame.seq,
    accepted: true,
    duplicate: false
  };
}

function ingestManifest(session: ReceiverSession, manifest: Manifest): IngestResult {
  if (session.manifest?.transferId === manifest.transferId) {
    return {
      type: "manifest",
      manifest,
      applied: false,
      duplicate: true,
      pending: false,
      awaitingAccept: session.status === "awaiting-accept"
    };
  }

  // A different transfer while this one already has data: never silently throw
  // the progress away. Surface it and let the user switch.
  if (hasProgress(session)) {
    session.pendingManifest = manifest;
    return {
      type: "manifest",
      manifest,
      applied: false,
      duplicate: false,
      pending: true,
      awaitingAccept: false
    };
  }

  applyManifest(session, manifest);
  return {
    type: "manifest",
    manifest,
    applied: true,
    duplicate: false,
    pending: false,
    awaitingAccept: session.status === "awaiting-accept"
  };
}

export function applyManifest(session: ReceiverSession, manifest: Manifest): void {
  session.manifest = manifest;
  session.pendingManifest = null;
  session.data.clear();
  session.repairs.clear();
  session.recovered.clear();
  session.restoredBytes = null;
  session.error = null;
  session.hashStatus = "idle";
  session.status = session.autoAccept ? "receiving" : "awaiting-accept";
  session.lastSolveAt = 0;
  for (const key of Object.keys(session.stats) as Array<keyof ReceiverStats>) {
    session.stats[key] = 0;
  }
}

export function acceptTransfer(session: ReceiverSession): boolean {
  if (!session.manifest || session.status !== "awaiting-accept") {
    return false;
  }

  session.status = "receiving";
  return true;
}

export function switchToPendingManifest(session: ReceiverSession): boolean {
  if (!session.pendingManifest) {
    return false;
  }

  const manifest = session.pendingManifest;
  applyManifest(session, manifest);
  return true;
}

export function discardPendingManifest(session: ReceiverSession): void {
  session.pendingManifest = null;
}

export function hasProgress(session: ReceiverSession): boolean {
  return session.data.size > 0 || session.repairs.size > 0;
}

export type Progress = {
  dataReceived: number;
  dataTotal: number;
  repairsReceived: number;
  repairTotal: number;
  recovered: number;
  missing: number;
  /** 0..1 based on data chunks (recovered ones count as received). */
  ratio: number;
  /** 0..1 based on all frames, a better estimate of "how much of the air time was captured". */
  frameRatio: number;
  complete: boolean;
};

export function getProgress(session: ReceiverSession): Progress {
  const manifest = session.manifest;
  const dataTotal = manifest?.payload.chunkCount ?? 0;
  const repairTotal = manifest?.payload.repairCount ?? 0;
  const dataReceived = Math.min(session.data.size, dataTotal);
  const repairsReceived = Math.min(session.repairs.size, repairTotal);
  const missing = Math.max(0, dataTotal - dataReceived);
  const totalFrames = dataTotal + repairTotal;

  return {
    dataReceived,
    dataTotal,
    repairsReceived,
    repairTotal,
    recovered: session.recovered.size,
    missing,
    ratio: dataTotal === 0 ? 0 : dataReceived / dataTotal,
    frameRatio: totalFrames === 0 ? 0 : (dataReceived + repairsReceived) / totalFrames,
    complete: dataTotal > 0 && missing === 0
  };
}

export type SolveOutcome = {
  attempted: boolean;
  solved: number;
  rank: number;
  missing: number;
};

/**
 * Try to reconstruct missing chunks from the repair chunks collected so far.
 * Cheap to call after every frame: it bails out until enough repair frames
 * exist to make the system solvable.
 */
export function trySolve(session: ReceiverSession, now = Date.now()): SolveOutcome {
  const manifest = session.manifest;
  const progress = getProgress(session);

  if (
    !manifest ||
    session.status !== "receiving" ||
    progress.missing === 0 ||
    session.repairs.size < progress.missing ||
    now - session.lastSolveAt < 200
  ) {
    return { attempted: false, solved: 0, rank: 0, missing: progress.missing };
  }

  session.lastSolveAt = now;
  const result = solveMissingChunks({
    transferId: manifest.transferId,
    chunkCount: manifest.payload.chunkCount,
    chunkSize: manifest.payload.chunkSize,
    data: session.data,
    repairs: session.repairs
  });

  for (const [seq, bytes] of result.solved) {
    session.data.set(seq, bytes);
    session.recovered.add(seq);
  }

  session.stats.repaired = session.recovered.size;

  return {
    attempted: true,
    solved: result.solved.size,
    rank: result.rank,
    missing: result.missing
  };
}

export type RestoreResult = {
  ok: boolean;
  message: string;
  bytes: Uint8Array | null;
  hashStatus: "idle" | "valid" | "invalid";
};

export async function restoreTransfer(
  session: ReceiverSession,
  passphrase: string
): Promise<RestoreResult> {
  const manifest = session.manifest;

  if (!manifest) {
    return { ok: false, message: "No transfer to restore.", bytes: null, hashStatus: "idle" };
  }

  const progress = getProgress(session);
  if (!progress.complete) {
    return {
      ok: false,
      message: `${progress.missing} chunk(s) still missing.`,
      bytes: null,
      hashStatus: session.hashStatus
    };
  }

  session.status = "verifying";
  session.error = null;
  session.hashStatus = "idle";

  const parts: Uint8Array[] = [];
  for (let seq = 0; seq < manifest.payload.chunkCount; seq += 1) {
    const chunk = session.data.get(seq);
    if (!chunk) {
      session.status = "receiving";
      return {
        ok: false,
        message: `Chunk ${seq + 1} is missing.`,
        bytes: null,
        hashStatus: "idle"
      };
    }
    parts.push(chunk);
  }

  const payload = concatBytes(parts, manifest.payload.size);

  let bytes: Uint8Array;
  try {
    bytes = await decodePayload(payload, {
      compression: manifest.payload.compression,
      encryption: manifest.payload.encryption,
      crypto: manifest.crypto,
      passphrase
    });
  } catch (error) {
    session.status = "error";
    session.error = error instanceof Error ? error.message : "Restore failed.";
    session.hashStatus = "invalid";
    return { ok: false, message: session.error, bytes: null, hashStatus: "invalid" };
  }

  const hash = await sha256Hex(bytes);
  if (hash !== manifest.hash.value) {
    session.status = "error";
    session.error =
      "The restored data does not match the manifest SHA-256. A chunk was probably corrupted in transit.";
    session.hashStatus = "invalid";
    return { ok: false, message: session.error, bytes, hashStatus: "invalid" };
  }

  session.restoredBytes = bytes;
  session.hashStatus = "valid";
  session.status = "complete";
  session.error = null;

  return {
    ok: true,
    message: "All chunks received, hash verified.",
    bytes,
    hashStatus: "valid"
  };
}

export function missingRanges(session: ReceiverSession, maxRanges = 6): string {
  const total = session.manifest?.payload.chunkCount ?? 0;
  if (total === 0) {
    return "-";
  }

  const ranges: Array<[number, number]> = [];
  let start: number | null = null;
  let omitted = false;

  for (let seq = 0; seq < total; seq += 1) {
    const missing = !session.data.has(seq);

    if (missing && start === null) {
      start = seq;
    }

    if ((!missing || seq === total - 1) && start !== null) {
      const end = missing && seq === total - 1 ? seq : seq - 1;

      if (ranges.length < maxRanges) {
        ranges.push([start, end]);
      } else {
        omitted = true;
      }
      start = null;
    }
  }

  if (ranges.length === 0) {
    return "none";
  }

  const labels = ranges.map(([first, last]) =>
    first === last ? `${first + 1}` : `${first + 1}-${last + 1}`
  );

  return omitted ? `${labels.join(", ")} …` : labels.join(", ");
}
