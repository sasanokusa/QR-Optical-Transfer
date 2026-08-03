import assert from "node:assert/strict";
import {
  acceptReceiverChunk,
  acceptReceiverTransfer,
  applyReceiverManifest,
  completeReceiverTransfer,
  createReceiverTransferState,
  receiverMissingRangeSummary,
  receiverMissingCount,
  receiverTotalCount
} from "../src/receiver-session.ts";
import { buildByteTransfer, buildHelloWorldTransfer } from "../src/protocol.ts";

const hello = await buildHelloWorldTransfer({ chunkCount: 100, fps: 5, loop: true });
const state = createReceiverTransferState();

assert.equal(acceptReceiverChunk(state, hello.chunks[0]).kind, "waiting");
applyReceiverManifest(state, hello.manifest);
assert.equal(receiverTotalCount(state), 100);
assert.equal(receiverMissingCount(state), 100);
assert.equal(receiverMissingRangeSummary(state), "1-100");
assert.equal(acceptReceiverTransfer(state, "").ok, true);

const wrongTransfer = { ...hello.chunks[0], transferId: "wrong-transfer" };
assert.equal(acceptReceiverChunk(state, wrongTransfer).kind, "wrong-id");
assert.equal(state.chunks.size, 0);

assert.equal(acceptReceiverChunk(state, hello.chunks[0]).kind, "accepted");
assert.equal(acceptReceiverChunk(state, hello.chunks[0]).kind, "duplicate");
assert.equal(state.chunks.size, 1);
assert.equal(receiverMissingRangeSummary(state), "2-100");

assert.equal(acceptReceiverChunk(state, hello.chunks[9]).kind, "accepted");
assert.equal(receiverMissingRangeSummary(state), "2-9, 11-100");

for (const chunk of hello.chunks.slice(1)) {
  if (chunk.seq === 9) {
    continue;
  }
  assert.equal(acceptReceiverChunk(state, chunk).kind, "accepted");
}

assert.equal(receiverMissingCount(state), 0);
assert.equal(receiverMissingRangeSummary(state), "none");
const complete = await completeReceiverTransfer(hello.manifest, state.chunks, "");
assert.equal(complete.ok, true);
assert.equal(complete.hashStatus, "valid");
assert.equal(new TextDecoder().decode(complete.bytes), new TextDecoder().decode(hello.bytes));

const encrypted = await buildByteTransfer({
  name: "secret.txt",
  mime: "text/plain",
  bytes: new TextEncoder().encode("secret"),
  chunkSize: 10,
  fps: 5,
  loop: true,
  compression: "gzip",
  passphrase: "secret phrase"
});
const encryptedState = createReceiverTransferState();
applyReceiverManifest(encryptedState, encrypted.manifest);
assert.equal(acceptReceiverTransfer(encryptedState, "").ok, false);
assert.equal(acceptReceiverTransfer(encryptedState, "secret phrase").ok, true);
for (const chunk of encrypted.chunks) {
  acceptReceiverChunk(encryptedState, chunk);
}
assert.equal((await completeReceiverTransfer(encrypted.manifest, encryptedState.chunks, "wrong phrase")).ok, false);
assert.equal((await completeReceiverTransfer(encrypted.manifest, encryptedState.chunks, "wrong phrase")).hashStatus, "invalid");

applyReceiverManifest(encryptedState, encrypted.manifest);
acceptReceiverTransfer(encryptedState, "secret phrase");
for (const chunk of encrypted.chunks) {
  acceptReceiverChunk(encryptedState, chunk);
}
const encryptedComplete = await completeReceiverTransfer(encrypted.manifest, encryptedState.chunks, "secret phrase");
assert.equal(encryptedComplete.ok, true);
assert.equal(new TextDecoder().decode(encryptedComplete.bytes), "secret");

console.log("receiver-smoke ok");
