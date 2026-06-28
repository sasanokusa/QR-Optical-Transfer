// Empirical analysis of QROPT/1 practical limits.
// Measures real JSON-envelope overhead and the QR version/module count that the
// `qrcode` library (same one main.ts uses) selects for representative chunks.
import QRCode from "qrcode";

const ECC = "M"; // matches drawQrCells() errorCorrectionLevel: "M"

function bytesToBase64UrlLen(rawBytes) {
  // base64url of N bytes = ceil(N/3)*4 chars, minus padding stripped (= up to 2 fewer).
  const full = Math.ceil(rawBytes / 3) * 4;
  const rem = rawBytes % 3;
  const pad = rem === 0 ? 0 : 3 - rem; // chars of '=' that get stripped
  return full - pad;
}

function makeChunkJson({ chunkRawBytes, seq, total, transferIdLen = 16 }) {
  const dataLen = bytesToBase64UrlLen(chunkRawBytes);
  const data = "x".repeat(dataLen);
  const transferId = "a".repeat(transferIdLen);
  const obj = {
    proto: "QROPT/1",
    type: "chunk",
    transferId,
    seq,
    total,
    data
  };
  return JSON.stringify(obj);
}

async function qrInfo(text) {
  // qrcode picks the smallest version that fits at the given ECC.
  const qr = QRCode.create(text, { errorCorrectionLevel: ECC });
  const version = qr.version;
  const modules = qr.modules.size; // modules per side (no quiet zone)
  return { version, modules, contentLen: text.length };
}

console.log(`# QROPT/1 capacity analysis (ECC level ${ECC})\n`);

// --- JSON overhead ---
console.log("## JSON envelope overhead (chunk packet)");
for (const raw of [200, 600, 900, 1200]) {
  const json = makeChunkJson({ chunkRawBytes: raw, seq: 1234, total: 5826 });
  const dataLen = bytesToBase64UrlLen(raw);
  const overhead = json.length - dataLen;
  const efficiency = (raw / json.length) * 100;
  console.log(
    `chunkRaw=${raw}B  base64data=${dataLen}ch  QRcontent=${json.length}ch  envelope=${overhead}ch  payload/QRcontent=${efficiency.toFixed(1)}%`
  );
}

// --- QR version & module count for default & extreme chunk sizes ---
console.log("\n## QR version / module count selected by qrcode lib");
for (const raw of [200, 600, 900, 1200]) {
  const json = makeChunkJson({ chunkRawBytes: raw, seq: 9999, total: 9999 });
  const info = await qrInfo(json);
  console.log(
    `chunkRaw=${raw}B  QRcontent=${info.contentLen}ch  -> QR version ${info.version} (${info.modules}x${info.modules} modules)`
  );
}

// Manifest size
const sampleManifest = JSON.stringify({
  proto: "QROPT/1", type: "manifest", transferId: "0123456789abcdef",
  file: { name: "sample-archive.zip", mime: "application/zip", size: 5242880 },
  payload: { encoding: "base64url", compression: "gzip", encryption: "AES-GCM", chunkSize: 900, chunkCount: 5826, size: 5242880 },
  crypto: { alg: "AES-GCM", iv: "aaaaaaaaaaaaaaaa", tagLength: 128, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 250000, salt: "aaaaaaaaaaaaaaaaaaaaaa" } },
  hash: { alg: "SHA-256", value: "a".repeat(64) },
  display: { fps: 5, loop: true }
});
const manInfo = await qrInfo(sampleManifest);
console.log(`manifest         QRcontent=${manInfo.contentLen}ch  -> QR version ${manInfo.version} (${manInfo.modules}x${manInfo.modules} modules)`);

// --- Camera resolution requirement ---
console.log("\n## Camera pixels needed to resolve the QR (single QR, fills 50% of frame width)");
console.log("Rule of thumb: jsQR/BarcodeDetector need ~3 camera px per module for reliable decode (absolute min ~2).");
for (const raw of [200, 900, 1200]) {
  const json = makeChunkJson({ chunkRawBytes: raw, seq: 9999, total: 9999 });
  const info = await qrInfo(json);
  const modulesWithQuiet = info.modules + 8; // 4-module quiet zone each side
  for (const fill of [0.5]) {
    for (const pxPerModule of [2, 3]) {
      const qrWidthPx = modulesWithQuiet * pxPerModule;
      const frameWidthPx = Math.round(qrWidthPx / fill);
      console.log(
        `chunkRaw=${raw}B  v${info.version} ${info.modules}mod(+quiet=${modulesWithQuiet})  @${pxPerModule}px/mod  QR=${qrWidthPx}px  needs frame width >= ${frameWidthPx}px`
      );
    }
  }
}

// --- Throughput & transfer time ---
console.log("\n## Throughput (payload bytes/sec) = chunkSize x fps x gridCount  [zero-loss best case]");
const fpsList = [3, 5, 8, 10];
const grids = [1, 4, 9];
const chunkSize = 900;
console.log(`(chunkSize=${chunkSize}B raw payload per QR)`);
for (const grid of grids) {
  const row = fpsList.map((fps) => {
    const bps = chunkSize * fps * grid;
    return `${fps}fps=${(bps / 1024).toFixed(1)}KB/s`;
  });
  console.log(`grid ${grid}: ${row.join("  ")}`);
}

console.log("\n## Single-pass transfer time (zero loss), chunkSize=900B, grid=1");
for (const sizeMB of [0.1, 1, 5]) {
  const bytes = sizeMB * 1024 * 1024;
  const chunks = Math.ceil(bytes / chunkSize);
  const row = fpsList.map((fps) => {
    const sec = chunks / fps;
    return `${fps}fps=${fmtTime(sec)}`;
  });
  console.log(`${sizeMB}MB (${chunks} chunks): ${row.join("  ")}`);
}

// --- Loss / loop cost (independent per-chunk capture prob q per loop) ---
console.log("\n## Effect of per-loop chunk loss on completion (coupon-collector style)");
console.log("Expected loops to capture ALL N chunks when each chunk is seen with prob q per pass.");
for (const N of [100, 1000, 5826]) {
  const row = [0.99, 0.95, 0.9, 0.8].map((q) => {
    const loops = expectedLoops(N, q);
    return `q=${q}->~${loops.toFixed(1)} loops`;
  });
  console.log(`N=${N}: ${row.join("  ")}`);
}

function expectedLoops(N, q) {
  // E[max of N geometric] approx = sum_{k=1..N} 1/(1-(1-q)^k) ... use harmonic approx:
  // E ~ (1/ -ln(1-q-ish))... Use accurate-ish: E[loops] ~ (ln N + gamma)/(-ln(1-q)) for small loss,
  // but more robust: simulate expectation via 1 + (1/q)*H_N? We'll use the standard result:
  // For each pass each missing chunk independently captured w.p. q. Expected passes to get all =
  // sum over chunks treated as max of N iid Geometric(q): approx (H_N)/(-ln(1-q))?
  // Use exact expectation of max of N Geometric(q):
  const p = 1 - q; // miss prob per pass
  // E[max] = sum_{i=1..inf} (1 - (1 - p^i)^N)
  let e = 0;
  for (let i = 0; i < 100000; i++) {
    const term = 1 - Math.pow(1 - Math.pow(p, i), N);
    e += term;
    if (term < 1e-9 && i > 5) break;
  }
  return e;
}

function fmtTime(sec) {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}min`;
  return `${(sec / 3600).toFixed(2)}h`;
}
