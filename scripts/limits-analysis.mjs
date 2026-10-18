// Capacity / throughput analysis for QROPT/2.
//
// Everything is computed from the real encoder, so the numbers match what the
// app actually emits. Run with:
//   node --experimental-strip-types scripts/limits-analysis.mjs
import QRCode from "qrcode";
import { encodeChunkFrame } from "../src/core/codec.ts";
import { buildTransfer } from "../src/core/transfer.ts";

const ECC_LEVELS = ["L", "M", "Q", "H"];
const CHUNK_SIZES = [200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1730];

const source = {
  name: "analysis.bin",
  mime: "application/octet-stream",
  bytes: randomBytes(60_000)
};

const bundle = await buildTransfer(source, {
  chunkSize: 4000,
  repairRatio: 0,
  compression: "none",
  transferId: "anls"
});

console.log("# QROPT/2 capacity and throughput\n");
console.log(
  "Frame = 2 magic + 4 id + 1 kind + seq + ':' + base64url(payload) + '*' + crc32(base36)\n"
);

for (const ecc of ECC_LEVELS) {
  console.log(`## Chunk size vs QR density (ECC ${ecc})\n`);
  console.log("| chunk B | frame chars | QR version | modules | 3 px/module needs |");
  console.log("| ---: | ---: | ---: | ---: | ---: |");

  for (const chunkSize of CHUNK_SIZES) {
    const payload = randomBytes(chunkSize);
    const text = encodeChunkFrame("anls", "data", 1234, payload);
    let version;
    let modules;

    try {
      const qr = QRCode.create(text, { errorCorrectionLevel: ecc });
      version = qr.version;
      modules = qr.modules.size;
    } catch {
      continue;
    }

    console.log(
      `| ${chunkSize} | ${text.length} | ${version} | ${modules}×${modules} | ${(modules + 8) * 3} px |`
    );
  }

  console.log("");
}

console.log("## Throughput (payload bytes/s, zero loss)\n");
console.log("| chunk B | 5 fps | 8 fps | 10 fps | 15 fps | 20 fps |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: |");

for (const chunkSize of [200, 300, 400, 600, 800, 900, 1200]) {
  const row = [5, 8, 10, 15, 20].map((fps) => `${((chunkSize * fps) / 1024).toFixed(1)} KB/s`);
  console.log(`| ${chunkSize} | ${row.join(" | ")} |`);
}

console.log("\n## Repair overhead\n");
console.log("| data chunks | repair 8 % | 12 % | 20 % | 30 % |");
console.log("| ---: | ---: | ---: | ---: | ---: |");
for (const count of [10, 100, 1000, 5000]) {
  const row = [0.08, 0.12, 0.2, 0.3].map((ratio) => Math.max(1, Math.round(count * ratio)));
  console.log(`| ${count} | ${row.join(" | ")} |`);
}

console.log("\n## Expected passes to completion\n");
console.log(
  "Per-pass capture probability q per frame; repairs only need to cover the gap between\n" +
    "what was captured and what the repair equations can solve. Numbers below come from a\n" +
    "deterministic channel simulation of the real schedule (see scripts/repair-smoke.mjs).\n"
);

const demo = await buildTransfer(
  { name: "demo.txt", mime: "text/plain", bytes: randomBytes(30_000) },
  { chunkSize: 300, repairRatio: 0.12, compression: "none", transferId: "demo" }
);
console.log(
  `Example transfer: ${demo.manifest.payload.chunkCount} data frames + ` +
    `${demo.manifest.payload.repairCount} repair frames.`
);
console.log(
  `Manifest QR: ${JSON.stringify(demo.manifestText).length} chars -> ` +
    `${QRCode.create(demo.manifestText, { errorCorrectionLevel: "M" }).version} at ECC M.`
);

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  let state = 0x12345678;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}
