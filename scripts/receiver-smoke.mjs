import assert from "node:assert/strict";
import { utf8Encoder } from "../src/core/bytes.ts";
import { encodeChunkFrame } from "../src/core/codec.ts";
import { buildTransfer } from "../src/core/transfer.ts";
import {
  acceptTransfer,
  applyManifest,
  createReceiverSession,
  discardPendingManifest,
  getProgress,
  ingestText,
  missingRanges,
  resetReceiverSession,
  restoreTransfer,
  switchToPendingManifest,
  trySolve
} from "../src/core/receiver.ts";

const bytes = utf8Encoder.encode("receiver session smoke\n".repeat(40));
const transfer = await buildTransfer(
  { name: "session.txt", mime: "text/plain", bytes },
  { chunkSize: 64, repairRatio: 0.4, compression: "none", transferId: "smk1" }
);
assert.ok(transfer.manifest.payload.repairCount >= 5);
const dataFrames = transfer.data.map((chunk, seq) =>
  encodeChunkFrame(transfer.manifest.transferId, "data", seq, chunk)
);
const repairFrames = transfer.repairs.map((chunk, seq) =>
  encodeChunkFrame(transfer.manifest.transferId, "repair", seq, chunk)
);

// --- manual accept ---------------------------------------------------------
const manual = createReceiverSession({ autoAccept: false });
assert.equal(manual.status, "idle");
const seen = ingestText(manual, transfer.manifestText);
assert.equal(seen.type, "manifest");
assert.equal(seen.applied, true);
assert.equal(seen.awaitingAccept, true);
assert.equal(manual.status, "awaiting-accept");
assert.equal(getProgress(manual).dataTotal, transfer.manifest.payload.chunkCount);

const beforeAccept = ingestText(manual, dataFrames[0]);
assert.equal(beforeAccept.accepted, false);
assert.equal(beforeAccept.reason, "not-receiving");
assert.equal(manual.data.size, 0);

assert.equal(acceptTransfer(manual), true);
assert.equal(manual.status, "receiving");
assert.equal(ingestText(manual, dataFrames[0]).accepted, true);

// --- auto accept -----------------------------------------------------------
const auto = createReceiverSession();
ingestText(auto, transfer.manifestText);
assert.equal(auto.status, "receiving");

for (const frame of dataFrames.slice(0, 10)) {
  ingestText(auto, frame);
}
const partial = getProgress(auto);
assert.equal(partial.dataReceived, 10);
assert.ok(partial.ratio > 0 && partial.ratio < 1);
assert.equal(missingRanges(auto).startsWith("11"), true);

// Chunks for another transfer are ignored without touching progress.
const foreign = ingestText(auto, encodeChunkFrame("zzzz", "data", 11, new Uint8Array([1])));
assert.equal(foreign.type, "foreign");
assert.equal(auto.data.size, 10);

// A second manifest while this transfer has progress must not wipe it.
const other = await buildTransfer(
  { name: "other.bin", mime: "application/octet-stream", bytes: new Uint8Array([1, 2, 3]) },
  { chunkSize: 64, repairRatio: 0.1, compression: "none" }
);
const pending = ingestText(auto, other.manifestText);
assert.equal(pending.type, "manifest");
assert.equal(pending.pending, true);
assert.equal(auto.data.size, 10);
assert.ok(auto.pendingManifest);

discardPendingManifest(auto);
assert.equal(auto.pendingManifest, null);
assert.equal(auto.data.size, 10);

ingestText(auto, other.manifestText);
assert.equal(switchToPendingManifest(auto), true);
assert.equal(auto.manifest.file.name, "other.bin");
assert.equal(auto.data.size, 0);
assert.equal(switchToPendingManifest(auto), false);

// --- repair based completion ----------------------------------------------
const repairing = createReceiverSession();
ingestText(repairing, transfer.manifestText);
const dropCount = 4;
for (let seq = 0; seq < transfer.data.length; seq += 1) {
  if (seq < dropCount) {
    continue;
  }
  ingestText(repairing, dataFrames[seq]);
}
assert.equal(getProgress(repairing).missing, dropCount);
assert.equal(getProgress(repairing).complete, false);
assert.equal((await restoreTransfer(repairing, "")).ok, false);

for (const frame of repairFrames) {
  ingestText(repairing, frame);
}
const solve = trySolve(repairing, 10_000);
assert.equal(solve.attempted, true);
assert.equal(solve.solved, dropCount);
const solvedProgress = getProgress(repairing);
assert.equal(solvedProgress.complete, true);
assert.equal(solvedProgress.recovered, dropCount);

const restored = await restoreTransfer(repairing, "");
assert.equal(restored.ok, true);
assert.equal(restored.hashStatus, "valid");

// --- a repaired *last* chunk must not overflow the payload assembly ---------
// The last data chunk is shorter than chunkSize; a chunk rebuilt from repair
// frames is padded to chunkSize. Assembly has to trim it back.
const tailBytes = new TextEncoder().encode("x".repeat(100));
const tail = await buildTransfer(
  { name: "tail.bin", mime: "application/octet-stream", bytes: tailBytes },
  { chunkSize: 64, repairRatio: 0.5, compression: "none", transferId: "tail" }
);
assert.equal(tail.manifest.payload.chunkCount, 2);
assert.equal(tail.manifest.payload.size, 100);

const tailSession = createReceiverSession();
ingestText(tailSession, tail.manifestText);
ingestText(tailSession, encodeChunkFrame(tail.manifest.transferId, "data", 0, tail.data[0]));
for (const [seq, chunk] of tail.repairs.entries()) {
  ingestText(tailSession, encodeChunkFrame(tail.manifest.transferId, "repair", seq, chunk));
}
assert.equal(getProgress(tailSession).complete, false);
trySolve(tailSession, 20_000);
assert.equal(getProgress(tailSession).complete, true, "repair should rebuild the short tail chunk");
assert.equal(getProgress(tailSession).recovered, 1);

const tailRestore = await restoreTransfer(tailSession, "");
assert.equal(tailRestore.ok, true);
assert.equal(tailRestore.bytes.byteLength, 100);
assert.equal(new TextDecoder().decode(tailRestore.bytes), "x".repeat(100));

// --- encrypted retry -------------------------------------------------------
const encrypted = await buildTransfer(
  { name: "locked.txt", mime: "text/plain", bytes },
  { chunkSize: 80, repairRatio: 0.1, compression: "gzip", passphrase: "open sesame" }
);
assert.equal(encrypted.manifest.payload.encryption, "AES-GCM");
const locked = createReceiverSession();
ingestText(locked, encrypted.manifestText);
encrypted.data.forEach((chunk, seq) => {
  ingestText(locked, encodeChunkFrame(encrypted.manifest.transferId, "data", seq, chunk));
});
assert.equal(getProgress(locked).complete, true);

const denied = await restoreTransfer(locked, "");
assert.equal(denied.ok, false);
assert.equal(locked.status, "error");
assert.ok(denied.message.includes("passphrase"));

const deniedAgain = await restoreTransfer(locked, "guess");
assert.equal(deniedAgain.ok, false);

const unlocked = await restoreTransfer(locked, "open sesame");
assert.equal(unlocked.ok, true);
assert.equal(locked.status, "complete");
assert.equal(locked.hashStatus, "valid");

// --- reset -----------------------------------------------------------------
resetReceiverSession(locked);
assert.equal(locked.status, "idle");
assert.equal(locked.manifest, null);
assert.equal(locked.data.size, 0);
assert.equal(getProgress(locked).dataTotal, 0);

// applyManifest is usable directly by the UI.
applyManifest(auto, transfer.manifest);
assert.equal(auto.manifest?.transferId, transfer.manifest.transferId);

console.log("receiver-smoke ok");
