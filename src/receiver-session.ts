import type { ChunkPacket, Manifest } from "./protocol.ts";
import { assembleBytes, decodePayload, sha256HexBytes } from "./protocol.ts";

export type ReceiverHashStatus = "idle" | "checking" | "valid" | "invalid";

export type ReceiverTransferState = {
  manifest: Manifest | null;
  accepted: boolean;
  chunks: Map<number, string>;
  restoredBytes: Uint8Array | null;
  hashStatus: ReceiverHashStatus;
};

export type ReceiverChunkResult =
  | { kind: "waiting"; label: "Waiting"; message: string }
  | { kind: "wrong-id"; label: "Wrong ID"; message: string }
  | { kind: "wrong-total"; label: "Wrong total"; message: string }
  | { kind: "bad-seq"; label: "Bad seq"; message: string }
  | { kind: "duplicate"; label: string; message: string }
  | { kind: "accepted"; label: string; message: string };

export function createReceiverTransferState(): ReceiverTransferState {
  return {
    manifest: null,
    accepted: false,
    chunks: new Map(),
    restoredBytes: null,
    hashStatus: "idle"
  };
}

export function applyReceiverManifest(
  state: ReceiverTransferState,
  manifest: Manifest
): void {
  state.manifest = manifest;
  state.accepted = false;
  state.chunks.clear();
  state.restoredBytes = null;
  state.hashStatus = "idle";
}

export function resetReceiverTransferState(state: ReceiverTransferState): void {
  state.manifest = null;
  state.accepted = false;
  state.chunks.clear();
  state.restoredBytes = null;
  state.hashStatus = "idle";
}

export function acceptReceiverTransfer(
  state: ReceiverTransferState,
  passphrase: string
): { ok: boolean; message: string } {
  if (!state.manifest) {
    return { ok: false, message: "No manifest" };
  }

  if (state.manifest.payload.encryption === "AES-GCM" && !passphrase.trim()) {
    return { ok: false, message: "Receiver passphrase is required before accepting this transfer." };
  }

  state.accepted = true;
  return { ok: true, message: "Transfer accepted." };
}

export function acceptReceiverChunk(
  state: ReceiverTransferState,
  packet: ChunkPacket
): ReceiverChunkResult {
  if (!state.manifest || !state.accepted) {
    return { kind: "waiting", label: "Waiting", message: "Waiting for manifest acceptance." };
  }

  if (packet.transferId !== state.manifest.transferId) {
    return { kind: "wrong-id", label: "Wrong ID", message: "Ignored chunk from a different transfer ID." };
  }

  if (packet.total !== state.manifest.payload.chunkCount) {
    return {
      kind: "wrong-total",
      label: "Wrong total",
      message: "Ignored chunk with a mismatched total count."
    };
  }

  if (packet.seq < 0 || packet.seq >= state.manifest.payload.chunkCount) {
    return { kind: "bad-seq", label: "Bad seq", message: "Ignored chunk with an invalid sequence number." };
  }

  const label = `${packet.seq + 1}`;
  if (state.chunks.has(packet.seq)) {
    return { kind: "duplicate", label: `${label} dup`, message: `Duplicate chunk ${label} ignored.` };
  }

  state.chunks.set(packet.seq, packet.data);
  return { kind: "accepted", label, message: `Chunk ${label} accepted.` };
}

export async function completeReceiverTransfer(
  manifest: Manifest,
  chunks: Map<number, string>,
  passphrase: string
): Promise<{ ok: boolean; message: string; bytes: Uint8Array | null; hashStatus: ReceiverHashStatus }> {
  const payloadBytes = assembleBytes(chunks, manifest.payload.chunkCount);
  let bytes: Uint8Array;

  try {
    bytes = await decodePayload(payloadBytes, manifest, passphrase);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Decode failed",
      bytes: null,
      hashStatus: "invalid"
    };
  }

  const hash = await sha256HexBytes(bytes);
  const hashStatus: ReceiverHashStatus = hash === manifest.hash.value ? "valid" : "invalid";

  if (hashStatus !== "valid") {
    return {
      ok: false,
      message: "Restored data did not match the manifest SHA-256.",
      bytes,
      hashStatus
    };
  }

  return { ok: true, message: "All chunks restored and SHA-256 verified.", bytes, hashStatus };
}

export function receiverTotalCount(state: ReceiverTransferState): number {
  return state.manifest?.payload.chunkCount ?? 0;
}

export function receiverMissingCount(state: ReceiverTransferState): number {
  const total = receiverTotalCount(state);
  return total ? total - state.chunks.size : 0;
}

export function receiverMissingRangeSummary(
  state: ReceiverTransferState,
  maxRanges = 8
): string {
  const total = receiverTotalCount(state);

  if (!total) {
    return "-";
  }

  const ranges: Array<[number, number]> = [];
  let start: number | null = null;
  let omitted = false;

  for (let seq = 0; seq < total; seq += 1) {
    const missing = !state.chunks.has(seq);

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

  const labels = ranges.map(([startSeq, endSeq]) =>
    startSeq === endSeq ? `${startSeq + 1}` : `${startSeq + 1}-${endSeq + 1}`
  );

  return omitted ? `${labels.join(", ")} ...` : labels.join(", ");
}
