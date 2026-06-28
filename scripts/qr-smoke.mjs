import assert from "node:assert/strict";
import jsQR from "jsqr";
import QRCode from "qrcode";
import { buildHelloWorldTransfer, parsePacket } from "../src/protocol.ts";

function renderQrImageData(value) {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const moduleCount = qr.modules.size;
  const scale = 8;
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
          const px = (x + quiet) * scale + dx;
          const py = (y + quiet) * scale + dy;
          const offset = (py * size + px) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
          data[offset + 3] = 255;
        }
      }
    }
  }

  return { data, width: size, height: size };
}

const bundle = await buildHelloWorldTransfer({ chunkCount: 100, fps: 5, loop: true });
const packets = [bundle.manifest, bundle.chunks[0], bundle.chunks[99]];

for (const packet of packets) {
  const value = JSON.stringify(packet);
  const image = renderQrImageData(value);
  const decoded = jsQR(image.data, image.width, image.height);

  assert.ok(decoded, `QR did not decode for ${packet.type}`);
  assert.equal(decoded.data, value);
  assert.equal(parsePacket(decoded.data)?.type, packet.type);
}

console.log("qr-smoke ok");
