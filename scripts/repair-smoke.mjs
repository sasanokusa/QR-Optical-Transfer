import assert from "node:assert/strict";
import { randomBytes, splitmix32, utf8Decoder, utf8Encoder } from "../src/core/bytes.ts";
import { buildRepairChunks, solveMissingChunks } from "../src/core/repair.ts";
import { buildTransfer, createSchedule, planTick } from "../src/core/transfer.ts";
import {
  createReceiverSession,
  getProgress,
  ingestText,
  restoreTransfer,
  trySolve
} from "../src/core/receiver.ts";

// ---------------------------------------------------------------------------
// solver unit tests
// ---------------------------------------------------------------------------

function makeChunks(count, size, seedText = "chunk") {
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 1) {
      bytes[offset] = (index * 37 + offset * 11 + seedText.length) & 0xff;
    }
    chunks.push(bytes);
  }
  return chunks;
}

function solveWithLoss({ count, size, repairs, dropped, repairCount }) {
  const dataChunks = makeChunks(count, size);
  const transferId = "abcd";
  const repairChunks = buildRepairChunks(dataChunks, transferId, repairCount, size);

  const data = new Map();
  dataChunks.forEach((chunk, index) => {
    if (!dropped.includes(index)) {
      data.set(index, chunk);
    }
  });

  const receivedRepairs = new Map();
  for (let index = 0; index < Math.min(repairs, repairChunks.length); index += 1) {
    receivedRepairs.set(index, repairChunks[index]);
  }

  return {
    dataChunks,
    result: solveMissingChunks({
      transferId,
      chunkCount: count,
      chunkSize: size,
      data,
      repairs: receivedRepairs
    })
  };
}

for (const dropped of [[3], [3, 19], [0, 7, 8, 31, 62], [1, 2, 3, 4, 5, 6, 7, 8]]) {
  const { dataChunks, result } = solveWithLoss({
    count: 64,
    size: 16,
    repairs: 12,
    dropped,
    repairCount: 16
  });
  assert.equal(result.solved.size, dropped.length, `failed to solve ${dropped.length} erasures`);
  for (const index of dropped) {
    assert.deepEqual(result.solved.get(index), dataChunks[index]);
  }
}

// Not enough repair frames: the solver must not invent data.
const insufficient = solveWithLoss({
  count: 64,
  size: 16,
  repairs: 2,
  dropped: [1, 2, 3, 4, 5, 6, 7, 8],
  repairCount: 16
});
assert.equal(insufficient.result.solved.size, 0);

// Degenerate input: zero repair frames.
const noRepairs = solveWithLoss({ count: 8, size: 4, repairs: 0, dropped: [2], repairCount: 0 });
assert.equal(noRepairs.result.solved.size, 0);

// ---------------------------------------------------------------------------
// end-to-end loss simulation over the real frame schedule
// ---------------------------------------------------------------------------

async function simulate(bundle, { captureProbability, seed, maxTicks = 400_000, passphrase = "" }) {
  const session = createReceiverSession();
  const schedule = createSchedule(bundle, { fps: 5, beaconSeconds: 3 });
  const rng = splitmix32(seed);
  const tickDurationMs = 200;
  let cursor = 0;
  let tick = 0;

  for (; tick < maxTicks; tick += 1) {
    const plan = planTick(bundle, schedule, cursor, tick, 1);
    cursor = plan.cursor;

    for (const cell of plan.cells) {
      if (rng() / 0x1_0000_0000 < captureProbability) {
        ingestText(session, cell);
        trySolve(session, (tick + 1) * tickDurationMs);
      }
    }

    if (getProgress(session).complete) {
      break;
    }
  }

  const restore = getProgress(session).complete
    ? await restoreTransfer(session, passphrase)
    : { ok: false, hashStatus: "idle" };

  return { ticks: tick + 1, session, restore, schedule };
}

const payload = utf8Encoder.encode(
  Array.from({ length: 400 }, (_, index) => `row ${index}: ${index * 31} ${"x".repeat(index % 40)}`).join(
    "\n"
  )
);

const baseOptions = {
  chunkSize: 200,
  compression: "none",
  fps: 5,
  loop: true,
  beaconSeconds: 3,
  transferId: "loss"
};

const withoutRepair = await buildTransfer(
  { name: "loss.txt", mime: "text/plain", bytes: payload },
  { ...baseOptions, repairRatio: 0 }
);
const withRepair = await buildTransfer(
  { name: "loss.txt", mime: "text/plain", bytes: payload },
  { ...baseOptions, repairRatio: 0.12 }
);

assert.equal(withoutRepair.manifest.payload.chunkCount, withRepair.manifest.payload.chunkCount);
assert.equal(withRepair.manifest.payload.repairCount > 0, true);

const passLength = (bundle) => {
  const schedule = createSchedule(bundle, { fps: 5, beaconSeconds: 3 });
  const beacons = Math.ceil(schedule.units.length / schedule.manifestEveryTicks);
  return schedule.units.length + beacons;
};

const scenarios = [
  { captureProbability: 0.95, seed: 11 },
  { captureProbability: 0.85, seed: 7 },
  { captureProbability: 0.7, seed: 23 }
];

const summary = [];

for (const scenario of scenarios) {
  const plain = await simulate(withoutRepair, scenario);
  const repaired = await simulate(withRepair, scenario);

  assert.equal(plain.restore.ok, true, "plain transfer never completed");
  assert.equal(repaired.restore.ok, true, "repaired transfer never completed");
  assert.equal(utf8Decoder.decode(repaired.restore.bytes), utf8Decoder.decode(payload));
  assert.ok(
    repaired.restore.bytes.byteLength === payload.byteLength,
    "restored length should match the original"
  );

  summary.push({
    capture: scenario.captureProbability,
    plainPasses: (plain.ticks / passLength(withoutRepair)).toFixed(2),
    repairPasses: (repaired.ticks / passLength(withRepair)).toFixed(2),
    repairedChunks: repaired.session.recovered.size
  });
}

for (const row of summary) {
  assert.ok(
    Number(row.repairPasses) < Number(row.plainPasses),
    `repairs did not help at capture ${row.capture}: ${JSON.stringify(row)}`
  );
}

// ---------------------------------------------------------------------------
// burst loss: repairs should shine when a whole block of frames is missed
// ---------------------------------------------------------------------------

const burstBundle = await buildTransfer(
  { name: "burst.bin", mime: "application/octet-stream", bytes: randomBytes(20_000) },
  {
    chunkSize: 400,
    compression: "none",
    repairRatio: 0.25,
    fps: 5,
    beaconSeconds: 3,
    transferId: "brst"
  }
);

async function simulateBurst(bundle, { burstEvery, burstLength, seed }) {
  const session = createReceiverSession();
  const schedule = createSchedule(bundle, { fps: 5, beaconSeconds: 3 });
  const rng = splitmix32(seed);
  let cursor = 0;
  let tick = 0;

  for (; tick < 400_000; tick += 1) {
    const plan = planTick(bundle, schedule, cursor, tick, 1);
    cursor = plan.cursor;
    const inBurst = tick % burstEvery < burstLength;

    for (const cell of plan.cells) {
      if (!inBurst && rng() / 0x1_0000_0000 > 0.02) {
        ingestText(session, cell);
        trySolve(session, (tick + 1) * 200);
      }
    }

    if (getProgress(session).complete) {
      break;
    }
  }

  return { ticks: tick + 1, session };
}

const burst = await simulateBurst(burstBundle, { burstEvery: 20, burstLength: 8, seed: 5 });
assert.equal(getProgress(burst.session).complete, true, "burst loss never completed");
assert.ok(burst.session.recovered.size > 0, "burst loss should need repair chunks");

console.log("repair-smoke ok");
console.log(
  summary
    .map(
      (row) =>
        `capture ${row.capture}: ${row.plainPasses} passes without repair -> ${row.repairPasses} with repair (${row.repairedChunks} chunks reconstructed)`
    )
    .join("\n")
);
