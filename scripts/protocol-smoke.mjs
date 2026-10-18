import assert from "node:assert/strict";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  crc32Ascii,
  randomBytes,
  utf8Decoder,
  utf8Encoder
} from "../src/core/bytes.ts";
import {
  encodeChunkFrame,
  frameCharsForChunk,
  parseFrame,
  parseManifestText,
  validateManifest
} from "../src/core/codec.ts";
import {
  buildTransfer,
  createSchedule,
  demoSource,
  frameText,
  planTick
} from "../src/core/transfer.ts";
import {
  createReceiverSession,
  getProgress,
  ingestText,
  restoreTransfer,
  trySolve
} from "../src/core/receiver.ts";
import { sha256Hex } from "../src/core/crypto.ts";

// ---------------------------------------------------------------------------
// byte helpers
// ---------------------------------------------------------------------------

const random = new Uint8Array(200_000);
for (let index = 0; index < random.length; index += 1) {
  random[index] = (index * 31 + (index >> 3)) & 0xff;
}

const encoded = bytesToBase64Url(random);
assert.equal(encoded.includes("+"), false);
assert.equal(encoded.includes("/"), false);
assert.equal(encoded.includes("="), false);
assert.deepEqual(base64UrlToBytes(encoded), random);
assert.equal(bytesToBase64Url(new Uint8Array(0)), "");
assert.deepEqual(base64UrlToBytes(""), new Uint8Array(0));
assert.equal(crc32Ascii("123456789"), 0xcbf43926);

// Truncating assembly: a padded (repair rebuilt) chunk at the end is trimmed.
assert.deepEqual(
  concatBytes([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])], 4),
  new Uint8Array([1, 2, 3, 4])
);

// ---------------------------------------------------------------------------
// happy path: demo transfer, all frames decoded
// ---------------------------------------------------------------------------

async function restoreWithoutLoss(bundle, passphrase = "") {
  const session = createReceiverSession();
  const schedule = createSchedule(bundle, { fps: 5, beaconSeconds: 3 });
  let cursor = 0;

  for (let tick = 0; tick < schedule.units.length * 2 + 40; tick += 1) {
    const plan = planTick(bundle, schedule, cursor, tick, 1);
    cursor = plan.cursor;
    for (const cell of plan.cells) {
      ingestText(session, cell);
    }
    trySolve(session);
    if (getProgress(session).complete) {
      break;
    }
  }

  const progress = getProgress(session);
  assert.equal(progress.complete, true, "demo transfer never completed");
  return restoreTransfer(session, passphrase);
}

const demoBytes = utf8Encoder.encode(
  Array.from({ length: 100 }, (_, index) => `${String(index + 1).padStart(3, "0")}: Hello World`).join(
    "\n"
  )
);
const demo = await buildTransfer(demoSource(100), {
  chunkSize: Math.ceil(demoBytes.length / 100),
  repairRatio: 0.12,
  compression: "none",
  fps: 5,
  loop: true,
  beaconSeconds: 3
});

assert.equal(demo.manifest.payload.chunkCount, 100);
assert.equal(demo.manifest.payload.repairCount, 12);
assert.equal(demo.manifest.payload.encryption, "none");
assert.equal(demo.manifest.hash.value, await sha256Hex(demoBytes));

const demoRestore = await restoreWithoutLoss(demo);
assert.equal(demoRestore.ok, true);
assert.equal(demoRestore.hashStatus, "valid");
assert.equal(utf8Decoder.decode(demoRestore.bytes), utf8Decoder.decode(demoBytes));

// Every data/repair frame must be a valid QROPT/2 frame with CRC intact.
for (const [kind, chunks] of [
  ["data", demo.data],
  ["repair", demo.repairs]
]) {
  chunks.forEach((chunk, seq) => {
    const text = encodeChunkFrame(demo.manifest.transferId, kind, seq, chunk);
    assert.ok(text.startsWith("Q2"));
    const parsed = parseFrame(text);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.frame.kind, kind);
    assert.equal(parsed.frame.seq, seq);
    assert.deepEqual(parsed.frame.payload, chunk);
    assert.ok(text.length <= frameCharsForChunk(chunk.byteLength) + 8);
  });
}

// Manifest frame roundtrip and validation.
const manifestText = JSON.stringify(demo.manifest);
const manifestParsed = parseManifestText(manifestText);
assert.ok(manifestParsed);
assert.equal(manifestParsed.transferId, demo.manifest.transferId);

const tampered = structuredClone(demo.manifest);
tampered.hash.value = "0".repeat(64).replace(/^0/, "1");
assert.ok(validateManifest(tampered));
const badHash = structuredClone(demo.manifest);
badHash.hash.value = "not-a-hash";
assert.equal(validateManifest(badHash), null);

// ---------------------------------------------------------------------------
// corruption and foreign frames
// ---------------------------------------------------------------------------

const sample = encodeChunkFrame(demo.manifest.transferId, "data", 7, new Uint8Array([1, 2, 3, 4]));
assert.equal(parseFrame(sample).status, "ok");

const flipped = sample.slice(0, 10) + (sample[10] === "A" ? "B" : "A") + sample.slice(11);
assert.equal(parseFrame(flipped).status, "corrupt");

const badCrc = sample.replace(/\*[0-9a-z]+$/u, "*zzzzzz");
assert.equal(parseFrame(badCrc).status, "corrupt");

assert.equal(parseFrame("https://example.com").status, "unknown");
assert.equal(parseFrame("").status, "unknown");
assert.equal(parseFrame("{not json").status, "corrupt");

const session = createReceiverSession();
ingestText(session, manifestText);
const foreign = ingestText(
  session,
  encodeChunkFrame("zzzz", "data", 0, new Uint8Array([9]))
);
assert.equal(foreign.type, "foreign");
assert.equal(session.data.size, 0);

// Out of range sequences are rejected, valid ones accepted, duplicates flagged.
const outOfRange = ingestText(
  session,
  encodeChunkFrame(demo.manifest.transferId, "data", demo.manifest.payload.chunkCount, new Uint8Array([1]))
);
assert.equal(outOfRange.type, "chunk");
assert.equal(outOfRange.reason, "out-of-range");

const accepted = ingestText(
  session,
  encodeChunkFrame(demo.manifest.transferId, "data", 0, demo.data[0])
);
assert.equal(accepted.accepted, true);
const duplicate = ingestText(
  session,
  encodeChunkFrame(demo.manifest.transferId, "data", 0, demo.data[0])
);
assert.equal(duplicate.duplicate, true);
assert.equal(session.data.size, 1);

// A re-sent manifest must not wipe progress.
const repeated = ingestText(session, manifestText);
assert.equal(repeated.duplicate, true);
assert.equal(session.data.size, 1);

// ---------------------------------------------------------------------------
// gzip + AES-GCM
// ---------------------------------------------------------------------------

const secretBytes = utf8Encoder.encode("key = 0xdeadbeef\n".repeat(200));
const secret = await buildTransfer(
  { name: "secret-鍵.txt", mime: "text/plain", bytes: secretBytes },
  { chunkSize: 120, repairRatio: 0.2, compression: "gzip", passphrase: "correct horse" }
);
assert.equal(secret.manifest.payload.encryption, "AES-GCM");
assert.equal(secret.manifest.payload.compression, "gzip");
assert.ok(secret.manifest.payload.size < secretBytes.length);
assert.equal(JSON.stringify(secret.manifest).includes("correct horse"), false);
assert.equal(secret.manifest.file.name, "secret-鍵.txt");

const wrongPass = await ((session) => restoreTransfer(session, "wrong"))(await (async () => {
  const s = createReceiverSession();
  for (const cell of [secret.manifestText, ...secret.data.map((chunk, seq) =>
    encodeChunkFrame(secret.manifest.transferId, "data", seq, chunk)
  )]) {
    ingestText(s, cell);
  }
  return s;
})());
assert.equal(wrongPass.ok, false);
assert.equal(wrongPass.hashStatus, "invalid");

const rightPass = await restoreWithoutLoss(secret, "correct horse");
assert.equal(rightPass.ok, true);
assert.equal(utf8Decoder.decode(rightPass.bytes), utf8Decoder.decode(secretBytes));

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

const empty = await buildTransfer(
  { name: "empty.bin", mime: "application/octet-stream", bytes: new Uint8Array(0) },
  { chunkSize: 900, compression: "auto", repairRatio: 0.1 }
);
assert.equal(empty.manifest.payload.chunkCount, 1);
assert.equal(empty.manifest.payload.size, 0);
assert.equal(empty.manifest.hash.value, await sha256Hex(new Uint8Array(0)));
const emptyRestore = await restoreWithoutLoss(empty);
assert.equal(emptyRestore.ok, true);
assert.equal(emptyRestore.bytes.byteLength, 0);

const oneByte = await buildTransfer(
  { name: "one.bin", mime: "application/octet-stream", bytes: new Uint8Array([42]) },
  { chunkSize: 900, compression: "gzip", repairRatio: 0.1 }
);
assert.equal(oneByte.manifest.payload.compression, "gzip");
const oneByteRestore = await restoreWithoutLoss(oneByte);
assert.equal(oneByteRestore.ok, true);
assert.deepEqual(oneByteRestore.bytes, new Uint8Array([42]));

// "auto" must not inflate an incompressible payload.
const noise = randomBytes(4096);
const auto = await buildTransfer(
  { name: "noise.bin", mime: "application/octet-stream", bytes: noise },
  { chunkSize: 900, compression: "auto" }
);
assert.equal(auto.manifest.payload.compression, "none");
assert.equal(auto.manifest.payload.size, noise.byteLength);

// Schedules cover every unit exactly once and interleave repairs.
const schedule = createSchedule(demo, { fps: 5, beaconSeconds: 3 });
assert.equal(schedule.units.length, demo.data.length + demo.repairs.length);
const seen = new Set(schedule.units.map((unit) => `${unit.kind}:${unit.seq}`));
assert.equal(seen.size, schedule.units.length);
const firstHalf = schedule.units.slice(0, schedule.units.length / 2);
assert.ok(firstHalf.some((unit) => unit.kind === "repair"), "repairs are not spread out");

// Interleaving really does break up neighbouring chunk ids.
const dataOrder = schedule.units.filter((unit) => unit.kind === "data").map((unit) => unit.seq);
assert.notDeepEqual(dataOrder.slice(0, 8), [0, 1, 2, 3, 4, 5, 6, 7]);

// Beacon ticks reserve the first cell for the manifest.
const beaconPlan = planTick(demo, schedule, 0, 0, 2);
assert.equal(beaconPlan.cells.length, 2);
assert.equal(beaconPlan.beacon, true);
assert.equal(parseFrame(beaconPlan.cells[0]).frame.kind, "manifest");
assert.equal(parseFrame(beaconPlan.cells[1]).frame.kind !== "manifest", true);
assert.equal(frameText(demo, schedule.units[0]), beaconPlan.cells[1]);

console.log("protocol-smoke ok");
