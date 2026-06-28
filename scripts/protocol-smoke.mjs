import assert from "node:assert/strict";
import {
  assembleBytes,
  buildByteTransfer,
  buildHelloWorldTransfer,
  decodePayload,
  parsePacket,
  sha256HexBytes
} from "../src/protocol.ts";

async function restore(bundle, passphrase = "") {
  const chunks = new Map(bundle.chunks.map((chunk) => [chunk.seq, chunk.data]));
  const payload = assembleBytes(chunks, bundle.manifest.payload.chunkCount);
  return decodePayload(payload, bundle.manifest, passphrase);
}

const hello = await buildHelloWorldTransfer({ chunkCount: 100, fps: 5, loop: true });
const restoredHello = await restore(hello);
assert.equal(hello.manifest.payload.chunkCount, 100);
assert.equal(new TextDecoder().decode(restoredHello), new TextDecoder().decode(hello.bytes));
assert.equal(await sha256HexBytes(restoredHello), hello.manifest.hash.value);
assert.equal(parsePacket(JSON.stringify(hello.manifest))?.type, "manifest");
assert.equal(parsePacket(JSON.stringify(hello.chunks[0]))?.type, "chunk");

const bytes = new TextEncoder().encode("Hello encrypted gzip world");
const encrypted = await buildByteTransfer({
  name: "smoke.txt",
  mime: "text/plain",
  bytes,
  chunkSize: 12,
  fps: 5,
  loop: true,
  compression: "gzip",
  passphrase: "secret phrase"
});
const restoredEncrypted = await restore(encrypted, "secret phrase");
assert.equal(encrypted.manifest.payload.compression, "gzip");
assert.equal(encrypted.manifest.payload.encryption, "AES-GCM");
assert.ok(encrypted.manifest.crypto);
assert.equal(JSON.stringify(encrypted.manifest).includes("secret phrase"), false);
assert.equal(new TextDecoder().decode(restoredEncrypted), "Hello encrypted gzip world");
assert.equal(await sha256HexBytes(restoredEncrypted), encrypted.manifest.hash.value);

console.log("protocol-smoke ok");
