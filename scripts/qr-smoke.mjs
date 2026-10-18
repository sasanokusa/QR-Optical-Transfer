import assert from "node:assert/strict";
import jsQR from "jsqr";
import QRCode from "qrcode";
import { buildTransfer, demoSource } from "../src/core/transfer.ts";
import { encodeChunkFrame, parseFrame } from "../src/core/codec.ts";

// Render a frame the same way the browser renderer does (one pixel per module,
// 4 module quiet zone) and decode it back with jsQR at a realistic scale.
function renderFrame(text, scale = 6) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const moduleCount = qr.modules.size;
  const quiet = 4;
  const size = (moduleCount + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  data.fill(255);

  for (let y = 0; y < moduleCount; y += 1) {
    for (let x = 0; x < moduleCount; x += 1) {
      if (!qr.modules.data[y * moduleCount + x]) {
        continue;
      }

      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const pixel = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          data[pixel] = 0;
          data[pixel + 1] = 0;
          data[pixel + 2] = 0;
        }
      }
    }
  }

  return { data, width: size, height: size, version: qr.version, moduleCount };
}

function decode(text) {
  const image = renderFrame(text);
  const decoded = jsQR(image.data, image.width, image.height);
  assert.ok(decoded, `QR did not decode back (${text.length} chars)`);
  return { text: decoded.data, image, decoded };
}

const bundle = await buildTransfer(demoSource(100), {
  chunkSize: 40,
  repairRatio: 0.1,
  compression: "none",
  fps: 5
});

const chunks = [
  bundle.manifestText,
  encodeChunkFrame(bundle.manifest.transferId, "data", 0, bundle.data[0]),
  encodeChunkFrame(bundle.manifest.transferId, "data", bundle.data.length - 1, bundle.data.at(-1)),
  encodeChunkFrame(bundle.manifest.transferId, "repair", 0, bundle.repairs[0])
];

for (const text of chunks) {
  const { text: decoded, image } = decode(text);
  assert.equal(decoded, text);
  const parsed = parseFrame(decoded);
  assert.equal(parsed.status, "ok");
  assert.ok(image.moduleCount > 20);
}

// The manifest must survive a non-ASCII file name (UTF-8 byte mode).
const unicode = await buildTransfer(
  {
    name: "日本語のファイル名.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("unicode ok")
  },
  { chunkSize: 64, repairRatio: 0 }
);
const unicodeDecoded = decode(unicode.manifestText).text;
const unicodeParsed = parseFrame(unicodeDecoded);
assert.equal(unicodeParsed.status, "ok");
assert.equal(unicodeParsed.frame.manifest.file.name, "日本語のファイル名.txt");

// A realistic 900 byte chunk is still comfortably decodable and reports the QR
// version the UI shows to the user.
const realistic = await buildTransfer(
  { name: "sample.bin", mime: "application/octet-stream", bytes: new Uint8Array(9000).fill(7) },
  { chunkSize: 900, repairRatio: 0.12, compression: "none" }
);
const frame = encodeChunkFrame(
  realistic.manifest.transferId,
  "data",
  0,
  realistic.data[0]
);
const { image } = decode(frame);
assert.equal(parseFrame(decode(frame).text).frame.seq, 0);

console.log(
  `qr-smoke ok (900 B chunk -> QR version ${image.version}, ${image.moduleCount}x${image.moduleCount} modules, ${frame.length} chars)`
);
