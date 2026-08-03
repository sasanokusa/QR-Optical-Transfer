import jsQR from "jsqr";
import QRCode from "qrcode";
import "./styles.css";
import {
  acceptReceiverChunk,
  acceptReceiverTransfer,
  applyReceiverManifest,
  completeReceiverTransfer,
  createReceiverTransferState,
  receiverMissingRangeSummary,
  receiverMissingCount,
  receiverTotalCount,
  resetReceiverTransferState,
  type ReceiverTransferState
} from "./receiver-session";
import {
  buildByteTransfer,
  buildHelloWorldTransfer,
  bytesToArrayBuffer,
  makeHelloWorldText,
  type CompressionMode,
  type Manifest,
  parsePacket,
  type TransferBundle
} from "./protocol";

declare global {
  interface DetectedBarcode {
    rawValue: string;
    format: string;
  }
  interface BarcodeDetector {
    detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
  }
  // eslint-disable-next-line no-var
  var BarcodeDetector: {
    new (options?: { formats?: string[] }): BarcodeDetector;
    getSupportedFormats(): Promise<string[]>;
  };
}

type Mode = "sender" | "receiver";

type SenderState = {
  bundle: TransferBundle | null;
  timer: number | null;
  chunkIndex: number;
  loopCount: number;
  isRunning: boolean;
  runId: number;
};

type ReceiverState = ReceiverTransferState & {
  stream: MediaStream | null;
  scanFrame: number | null;
  detector: BarcodeDetector | null;
  detectorChecked: boolean;
  handled: Set<string>;
  scanFrames: number;
  qrDetections: number;
  uniqueQrReads: number;
  lastQrAt: number | null;
  lastStatsAt: number;
  lastStatsFrame: number;
  completingTransferId: string | null;
};

const senderState: SenderState = {
  bundle: null,
  timer: null,
  chunkIndex: 0,
  loopCount: 0,
  isRunning: false,
  runId: 0
};

const receiverState: ReceiverState = {
  stream: null,
  scanFrame: null,
  detector: null,
  detectorChecked: false,
  handled: new Set(),
  scanFrames: 0,
  qrDetections: 0,
  uniqueQrReads: 0,
  lastQrAt: null,
  lastStatsAt: performance.now(),
  lastStatsFrame: 0,
  completingTransferId: null,
  ...createReceiverTransferState()
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

app.innerHTML = `
  <section class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">QROPT/1 MVP</p>
        <h1>QR Optical Transfer</h1>
      </div>
      <div class="mode-switch" role="tablist" aria-label="Transfer mode">
        <button class="mode-button is-active" data-mode="sender" type="button">Sender</button>
        <button class="mode-button" data-mode="receiver" type="button">Receiver</button>
      </div>
    </header>

    <section class="workspace">
      <article class="panel mode-panel" id="sender-panel" data-panel="sender">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Transmit</p>
            <h2>Single file or Hello World transfer</h2>
          </div>
          <span class="status-pill" id="sender-status">Manifest ready</span>
        </div>

        <label class="file-drop" id="file-drop">
          <input id="file-input" type="file" />
          <span>
            <strong id="file-prompt">Choose a file or drop it here</strong>
            <small id="file-detail">No file selected. The built-in 100 chunk Hello World sample will be used.</small>
          </span>
        </label>

        <div class="control-grid">
          <label>
            Sample chunks
            <input id="chunk-count" type="number" min="2" max="400" step="1" value="100" />
          </label>
          <label>
            File chunk bytes
            <input id="chunk-size" type="number" min="200" max="1200" step="50" value="900" />
          </label>
          <label>
            FPS
            <select id="fps-select">
              <option value="3">3 fps</option>
              <option value="5" selected>5 fps</option>
              <option value="8">8 fps</option>
              <option value="10">10 fps</option>
            </select>
          </label>
          <label>
            QR size
            <input id="qr-size" type="range" min="260" max="620" step="20" value="420" />
          </label>
          <label>
            QR per frame
            <select id="grid-select">
              <option value="1" selected>1 (single)</option>
              <option value="4">4 (2x2)</option>
              <option value="9">9 (3x3)</option>
            </select>
          </label>
          <label class="toggle-row">
            <input id="gzip-toggle" type="checkbox" />
            gzip compression
          </label>
          <label class="toggle-row">
            <input id="encrypt-toggle" type="checkbox" />
            AES-GCM encryption
          </label>
          <label class="toggle-row">
            <input id="loop-toggle" type="checkbox" checked />
            Loop after last chunk
          </label>
          <label class="passphrase-row">
            Sender passphrase
            <input id="sender-passphrase" type="password" autocomplete="new-password" placeholder="Used only when encryption is on" />
          </label>
        </div>

        <div class="sender-layout">
          <div class="qr-stage" id="qr-stage">
            <div id="qr-grid" class="qr-grid" aria-label="QR output"></div>
            <div class="qr-jump">
              <label>
                Show single #
                <input id="jump-input" type="number" min="1" value="1" />
              </label>
              <div class="jump-actions">
                <button id="jump-prev" type="button">◀ Prev</button>
                <button id="jump-show" type="button">Show this #</button>
                <button id="jump-next" type="button">Next ▶</button>
                <button id="jump-manifest" type="button">Manifest</button>
              </div>
            </div>
            <div class="present-bar">
              <span id="present-info">Manifest</span>
              <div class="present-actions">
                <button id="present-start" type="button">Start</button>
                <button id="present-pause" type="button">Pause</button>
                <button id="present-stop" type="button">Stop</button>
                <button id="present-exit" type="button">Exit</button>
              </div>
            </div>
          </div>
          <div class="stack">
            <div class="metric-grid">
              <div>
                <span>Source</span>
                <strong id="sender-source">Hello sample</strong>
              </div>
              <div>
                <span>Size</span>
                <strong id="sender-size">-</strong>
              </div>
              <div>
                <span>MIME</span>
                <strong id="sender-mime">-</strong>
              </div>
              <div>
                <span>Transfer ID</span>
                <strong id="sender-transfer-id">-</strong>
              </div>
              <div>
                <span>Current</span>
                <strong id="sender-current">Manifest</strong>
              </div>
              <div>
                <span>Progress</span>
                <strong id="sender-progress">0 / 100</strong>
              </div>
              <div>
                <span>Loops</span>
                <strong id="sender-loops">0</strong>
              </div>
              <div>
                <span>Payload</span>
                <strong id="sender-payload">-</strong>
              </div>
              <div>
                <span>Transform</span>
                <strong id="sender-transform">none</strong>
              </div>
            </div>
            <progress id="sender-progress-bar" value="0" max="100"></progress>
            <div class="button-row">
              <button id="prepare-transfer" type="button">Prepare</button>
              <button id="start-transfer" type="button">Start</button>
              <button id="pause-transfer" type="button">Pause</button>
              <button id="stop-transfer" type="button">Stop</button>
              <button id="present-transfer" type="button">Fullscreen</button>
            </div>
          </div>
        </div>
      </article>

      <article class="panel mode-panel is-hidden" id="receiver-panel" data-panel="receiver">
        <div class="panel-head">
          <div>
            <p class="eyebrow">Receive</p>
            <h2>Camera scanner</h2>
          </div>
          <span class="status-pill" id="receiver-status">Camera idle</span>
        </div>

        <div class="control-grid receiver-controls">
          <label>
            Camera
            <select id="camera-select"></select>
          </label>
          <label class="receiver-passphrase">
            Receiver passphrase
            <input id="receiver-passphrase" type="password" autocomplete="current-password" disabled />
          </label>
          <div class="button-row">
            <button id="refresh-cameras" type="button">Refresh</button>
            <button id="start-camera" type="button">Start camera</button>
            <button id="stop-camera" type="button">Stop camera</button>
          </div>
        </div>

        <div class="receiver-layout">
          <div class="video-stage">
            <video id="camera-preview" playsinline muted></video>
            <canvas id="scan-canvas"></canvas>
          </div>
          <div class="stack">
            <div class="metric-grid">
              <div>
                <span>File</span>
                <strong id="receiver-file">No manifest</strong>
              </div>
              <div>
                <span>Transfer ID</span>
                <strong id="receiver-transfer-id">-</strong>
              </div>
              <div>
                <span>Received</span>
                <strong id="receiver-received">0 / 0</strong>
              </div>
              <div>
                <span>Chunks</span>
                <strong id="receiver-chunks">0</strong>
              </div>
              <div>
                <span>MIME</span>
                <strong id="receiver-mime">-</strong>
              </div>
              <div>
                <span>Missing</span>
                <strong id="receiver-missing">0</strong>
              </div>
              <div>
                <span>Missing ranges</span>
                <strong id="receiver-missing-ranges">-</strong>
              </div>
              <div>
                <span>Hash</span>
                <strong id="receiver-hash">Idle</strong>
              </div>
              <div>
                <span>Transform</span>
                <strong id="receiver-transform">none</strong>
              </div>
              <div>
                <span>Last QR</span>
                <strong id="receiver-last">-</strong>
              </div>
              <div>
                <span>Scan FPS</span>
                <strong id="receiver-scan-rate">0</strong>
              </div>
              <div>
                <span>QR reads</span>
                <strong id="receiver-qr-reads">0 / 0</strong>
              </div>
              <div>
                <span>Resolution</span>
                <strong id="receiver-resolution">-</strong>
              </div>
            </div>
            <progress id="receiver-progress-bar" value="0" max="100"></progress>
            <div class="button-row">
              <button id="accept-transfer" type="button" disabled>Accept</button>
              <button id="reset-receiver" type="button">Reset</button>
              <button id="download-file" type="button" disabled>Download</button>
            </div>
            <textarea id="restored-output" readonly placeholder="Text preview appears here when the restored file is readable text."></textarea>
            <div class="log-list" id="receiver-log" aria-live="polite"></div>
          </div>
        </div>
      </article>
    </section>
  </section>
`;

const qrGrid = getElement<HTMLDivElement>("qr-grid");
const fileDrop = getElement<HTMLLabelElement>("file-drop");
const fileInput = getElement<HTMLInputElement>("file-input");
const filePrompt = getElement("file-prompt");
const fileDetail = getElement("file-detail");
const chunkCountInput = getElement<HTMLInputElement>("chunk-count");
const chunkSizeInput = getElement<HTMLInputElement>("chunk-size");
const fpsSelect = getElement<HTMLSelectElement>("fps-select");
const qrSizeInput = getElement<HTMLInputElement>("qr-size");
const gridSelect = getElement<HTMLSelectElement>("grid-select");
const gzipToggle = getElement<HTMLInputElement>("gzip-toggle");
const encryptToggle = getElement<HTMLInputElement>("encrypt-toggle");
const loopToggle = getElement<HTMLInputElement>("loop-toggle");
const senderPassphrase = getElement<HTMLInputElement>("sender-passphrase");
const senderStatus = getElement("sender-status");
const senderSource = getElement("sender-source");
const senderSize = getElement("sender-size");
const senderMime = getElement("sender-mime");
const senderTransferId = getElement("sender-transfer-id");
const senderCurrent = getElement("sender-current");
const senderProgress = getElement("sender-progress");
const senderLoops = getElement("sender-loops");
const senderPayload = getElement("sender-payload");
const senderTransform = getElement("sender-transform");
const senderProgressBar = getElement<HTMLProgressElement>("sender-progress-bar");
const qrStage = getElement("qr-stage");
const presentInfo = getElement("present-info");
const jumpInput = getElement<HTMLInputElement>("jump-input");

const cameraSelect = getElement<HTMLSelectElement>("camera-select");
const receiverPassphrase = getElement<HTMLInputElement>("receiver-passphrase");
const cameraPreview = getElement<HTMLVideoElement>("camera-preview");
const scanCanvas = getElement<HTMLCanvasElement>("scan-canvas");
const receiverStatus = getElement("receiver-status");
const receiverFile = getElement("receiver-file");
const receiverTransferId = getElement("receiver-transfer-id");
const receiverReceived = getElement("receiver-received");
const receiverChunks = getElement("receiver-chunks");
const receiverMime = getElement("receiver-mime");
const receiverMissing = getElement("receiver-missing");
const receiverMissingRanges = getElement("receiver-missing-ranges");
const receiverHash = getElement("receiver-hash");
const receiverTransform = getElement("receiver-transform");
const receiverLast = getElement("receiver-last");
const receiverScanRate = getElement("receiver-scan-rate");
const receiverQrReads = getElement("receiver-qr-reads");
const receiverResolution = getElement("receiver-resolution");
const receiverProgressBar = getElement<HTMLProgressElement>("receiver-progress-bar");
const acceptTransfer = getElement<HTMLButtonElement>("accept-transfer");
const downloadFile = getElement<HTMLButtonElement>("download-file");
const restoredOutput = getElement<HTMLTextAreaElement>("restored-output");
const receiverLog = getElement("receiver-log");

document.querySelectorAll<HTMLButtonElement>(".mode-button").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode as Mode));
});

fileInput.addEventListener("change", () => {
  renderFileSelection();
  void prepareTransfer();
});
fileDrop.addEventListener("dragover", (event) => {
  event.preventDefault();
  fileDrop.classList.add("is-dragging");
});
fileDrop.addEventListener("dragleave", () => {
  fileDrop.classList.remove("is-dragging");
});
fileDrop.addEventListener("drop", (event) => {
  event.preventDefault();
  fileDrop.classList.remove("is-dragging");

  if (event.dataTransfer?.files.length) {
    fileInput.files = event.dataTransfer.files;
    renderFileSelection();
    void prepareTransfer();
  }
});
getElement("prepare-transfer").addEventListener("click", () => {
  void prepareTransfer();
});
getElement("start-transfer").addEventListener("click", startTransfer);
getElement("pause-transfer").addEventListener("click", pauseTransfer);
getElement("stop-transfer").addEventListener("click", stopTransfer);
getElement("present-transfer").addEventListener("click", () => {
  void enterPresent();
});
getElement("present-start").addEventListener("click", startTransfer);
getElement("present-pause").addEventListener("click", pauseTransfer);
getElement("present-stop").addEventListener("click", stopTransfer);
getElement("present-exit").addEventListener("click", exitPresent);
getElement("jump-show").addEventListener("click", () => {
  holdChunk(Number(jumpInput.value) - 1);
});
getElement("jump-prev").addEventListener("click", () => {
  holdChunk(currentHeldSeq() - 1);
});
getElement("jump-next").addEventListener("click", () => {
  holdChunk(currentHeldSeq() + 1);
});
getElement("jump-manifest").addEventListener("click", () => {
  if (!senderState.bundle) {
    return;
  }
  haltLoop();
  void showManifest();
  senderStatus.textContent = "Holding manifest";
  updatePresentInfo();
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    qrStage.classList.remove("is-present");
  }
});
qrSizeInput.addEventListener("input", () => {
  if (!senderState.isRunning) {
    void showManifest();
  }
});
gridSelect.addEventListener("change", () => {
  if (!senderState.isRunning) {
    void showManifest();
  }
});
gzipToggle.addEventListener("change", () => {
  void prepareTransfer();
});
encryptToggle.addEventListener("change", () => {
  senderPassphrase.disabled = !encryptToggle.checked;
  void prepareTransfer();
});
senderPassphrase.addEventListener("change", () => {
  if (encryptToggle.checked) {
    void prepareTransfer();
  }
});
senderPassphrase.addEventListener("input", () => {
  if (encryptToggle.checked && !senderState.bundle) {
    senderStatus.textContent = senderPassphrase.value.trim() ? "Prepare transfer" : "Enter passphrase";
  }
});
fpsSelect.addEventListener("change", () => {
  if (senderState.isRunning) {
    pauseTransfer();
    startTransfer();
  }
});
chunkCountInput.addEventListener("change", () => {
  void prepareTransfer();
});
chunkSizeInput.addEventListener("change", () => {
  void prepareTransfer();
});
loopToggle.addEventListener("change", () => {
  void prepareTransfer();
});

getElement("refresh-cameras").addEventListener("click", () => {
  void loadCameras();
});
getElement("start-camera").addEventListener("click", () => {
  void startCamera();
});
getElement("stop-camera").addEventListener("click", stopCamera);
acceptTransfer.addEventListener("click", () => {
  const result = acceptReceiverTransfer(receiverState, receiverPassphrase.value);

  if (!result.ok) {
    receiverStatus.textContent = result.message;
    addLog(result.message);
    return;
  }

  receiverStatus.textContent = "Receiving chunks";
  acceptTransfer.disabled = true;
  addLog(result.message);
  renderReceiver();
});
getElement("reset-receiver").addEventListener("click", resetReceiver);
downloadFile.addEventListener("click", downloadRestoredFile);

senderPassphrase.disabled = true;
receiverPassphrase.disabled = true;
renderFileSelection();
void prepareTransfer();
void loadCameras();
void registerServiceWorker();

function setMode(mode: Mode): void {
  document.querySelectorAll<HTMLButtonElement>(".mode-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  document.querySelectorAll<HTMLElement>(".mode-panel").forEach((panel) => {
    panel.classList.toggle("is-hidden", panel.dataset.panel !== mode);
  });
}

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`);
  } catch {
    // Offline support is helpful but should not block optical transfer.
  }
}

async function prepareTransfer(): Promise<void> {
  stopTransfer();
  senderStatus.textContent = "Preparing";
  const chunkCount = clamp(Number(chunkCountInput.value), 2, 400);
  const chunkSize = clamp(Number(chunkSizeInput.value), 200, 1200);
  const compression: CompressionMode = gzipToggle.checked ? "gzip" : "none";
  const passphrase = encryptToggle.checked ? senderPassphrase.value : "";
  chunkCountInput.value = String(chunkCount);
  chunkSizeInput.value = String(chunkSize);

  if (encryptToggle.checked && !passphrase.trim()) {
    senderState.bundle = null;
    clearQrCanvas();
    senderStatus.textContent = "Enter passphrase";
    renderSender();
    return;
  }

  const file = fileInput.files?.[0] ?? null;

  try {
    if (file) {
      senderState.bundle = await buildByteTransfer({
        name: file.name,
        mime: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        chunkSize,
        fps: Number(fpsSelect.value),
        loop: loopToggle.checked,
        compression,
        passphrase
      });
    } else if (compression !== "none" || passphrase) {
      const text = makeHelloWorldText(chunkCount);
      const bytes = new TextEncoder().encode(text);
      senderState.bundle = await buildByteTransfer({
        name: "hello-world.txt",
        mime: "text/plain",
        bytes,
        chunkSize: Math.max(1, Math.ceil(bytes.byteLength / chunkCount)),
        fps: Number(fpsSelect.value),
        loop: loopToggle.checked,
        compression,
        passphrase
      });
    } else {
      senderState.bundle = await buildHelloWorldTransfer({
        chunkCount,
        fps: Number(fpsSelect.value),
        loop: loopToggle.checked
      });
    }
  } catch (error) {
    senderState.bundle = null;
    clearQrCanvas();
    senderStatus.textContent = error instanceof Error ? error.message : "Prepare failed";
    renderSender();
    return;
  }

  senderState.chunkIndex = 0;
  senderState.loopCount = 0;
  await showManifest();
  renderSender();
  senderStatus.textContent = "Manifest ready";
}

function clearQrCanvas(): void {
  qrGrid.replaceChildren();
}

function renderFileSelection(): void {
  const file = fileInput.files?.[0] ?? null;

  if (!file) {
    filePrompt.textContent = "Choose a file or drop it here";
    fileDetail.textContent = "No file selected. The built-in 100 chunk Hello World sample will be used.";
    return;
  }

  filePrompt.textContent = file.name;
  fileDetail.textContent = `${formatBytes(file.size)} / ${file.type || "application/octet-stream"}`;
}

async function showManifest(): Promise<void> {
  if (!senderState.bundle) {
    return;
  }

  await drawQrCells([JSON.stringify(senderState.bundle.manifest)]);
  senderCurrent.textContent = "Manifest";
}

function startTransfer(): void {
  if (!senderState.bundle || senderState.isRunning) {
    return;
  }

  senderState.isRunning = true;
  senderState.runId += 1;
  senderStatus.textContent = "Transmitting";
  updatePresentInfo();
  scheduleTransferTick(0, senderState.runId);
}

function haltLoop(): void {
  if (senderState.timer !== null) {
    window.clearTimeout(senderState.timer);
    senderState.timer = null;
  }
  senderState.isRunning = false;
  senderState.runId += 1;
}

function pauseTransfer(): void {
  haltLoop();
  senderStatus.textContent = "Paused";
  updatePresentInfo();
}

function currentHeldSeq(): number {
  return Number(jumpInput.value) - 1;
}

function holdChunk(seq: number): void {
  if (!senderState.bundle) {
    return;
  }

  const total = senderState.bundle.manifest.payload.chunkCount;
  const clamped = ((Math.round(seq) % total) + total) % total;
  haltLoop();
  jumpInput.value = String(clamped + 1);
  void drawQrCells([JSON.stringify(senderState.bundle.chunks[clamped])]);
  senderState.chunkIndex = clamped;
  senderCurrent.textContent = `${clamped + 1}`;
  senderStatus.textContent = `Holding #${clamped + 1}`;
  renderSender();
}

function stopTransfer(): void {
  if (senderState.timer !== null) {
    window.clearTimeout(senderState.timer);
    senderState.timer = null;
  }
  senderState.isRunning = false;
  senderState.runId += 1;
  senderState.chunkIndex = 0;
  senderState.loopCount = 0;
  senderStatus.textContent = "Stopped";
  renderSender();
}

function scheduleTransferTick(delayMs: number, runId: number): void {
  senderState.timer = window.setTimeout(() => {
    void tickTransfer(runId);
  }, delayMs);
}

async function tickTransfer(runId: number): Promise<void> {
  if (!senderState.bundle) {
    return;
  }

  const { chunks, manifest } = senderState.bundle;
  const total = manifest.payload.chunkCount;
  const count = Math.min(gridCount(), total);
  const start = senderState.chunkIndex % total;
  const values: string[] = [];
  const seqs: number[] = [];

  for (let i = 0; i < count; i += 1) {
    const index = (start + i) % total;
    values.push(JSON.stringify(chunks[index]));
    seqs.push(index);
  }

  await drawQrCells(values, runId);

  if (!senderState.isRunning || senderState.runId !== runId) {
    return;
  }

  senderCurrent.textContent =
    seqs.length > 1 ? `${seqs[0] + 1}-${seqs[seqs.length - 1] + 1}` : `${seqs[0] + 1}`;
  senderState.chunkIndex = start + count;

  if (senderState.chunkIndex >= total) {
    senderState.loopCount += 1;
    if (manifest.display.loop) {
      senderState.chunkIndex %= total;
    } else {
      pauseTransfer();
      senderState.chunkIndex = total;
    }
  }

  renderSender();

  if (senderState.isRunning && senderState.runId === runId) {
    scheduleTransferTick(1000 / Number(fpsSelect.value), runId);
  }
}

function gridCount(): number {
  const value = Number(gridSelect.value);
  return value === 4 || value === 9 ? value : 1;
}

function gridCols(count: number): number {
  return count >= 9 ? 3 : count >= 4 ? 2 : 1;
}

function syncQrCanvases(count: number): HTMLCanvasElement[] {
  while (qrGrid.childElementCount < count) {
    qrGrid.append(document.createElement("canvas"));
  }
  while (qrGrid.childElementCount > count) {
    qrGrid.lastElementChild?.remove();
  }
  qrGrid.style.gridTemplateColumns = `repeat(${gridCols(count)}, 1fr)`;
  return Array.from(qrGrid.querySelectorAll("canvas"));
}

async function drawQrCells(values: string[], runId?: number): Promise<void> {
  const canvases = syncQrCanvases(values.length);
  const cols = gridCols(values.length);
  const cell = Math.max(240, Math.round(Number(qrSizeInput.value) / cols));

  const draw = (value: string, index: number): Promise<void> =>
    QRCode.toCanvas(canvases[index], value, {
      width: cell,
      margin: 3,
      errorCorrectionLevel: "M",
      color: {
        dark: "#050505",
        light: "#ffffff"
      }
    });

  // When runId is provided, treat the drawing as stale if a newer run started
  // while QR generation was in flight. A stale frame must not overwrite the
  // canvas that a newer tick (or manifest/hold view) already painted.
  await Promise.all(
    values.map((value, index) =>
      draw(value, index).then(() => {
        if (runId !== undefined && senderState.runId !== runId) {
          const ctx = canvases[index].getContext("2d");
          ctx?.clearRect(0, 0, canvases[index].width, canvases[index].height);
        }
      })
    )
  );
}

function renderSender(): void {
  const total = senderState.bundle?.manifest.payload.chunkCount ?? Number(chunkCountInput.value);
  const displayed = Math.min(senderState.chunkIndex, total);
  const manifest = senderState.bundle?.manifest;
  senderSource.textContent = manifest?.file.name ?? "Hello sample";
  senderSize.textContent = manifest ? formatBytes(manifest.file.size) : "-";
  senderMime.textContent = manifest?.file.mime || "-";
  senderTransferId.textContent = manifest?.transferId ?? "-";
  senderProgress.textContent = `${displayed} / ${total}`;
  senderLoops.textContent = String(senderState.loopCount);
  senderPayload.textContent = manifest ? `${formatBytes(manifest.payload.size)} / ${manifest.payload.chunkCount}` : "-";
  senderTransform.textContent = manifest ? transformLabel(manifest) : "none";
  senderProgressBar.max = total;
  senderProgressBar.value = displayed;
  jumpInput.max = String(total);
  updatePresentInfo();
}

async function enterPresent(): Promise<void> {
  qrStage.classList.add("is-present");
  updatePresentInfo();
  try {
    await qrStage.requestFullscreen();
  } catch {
    // Fullscreen API may be unavailable or blocked; the CSS overlay still enlarges the QR.
  }
}

function exitPresent(): void {
  qrStage.classList.remove("is-present");
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  }
}

function updatePresentInfo(): void {
  presentInfo.textContent = `${senderStatus.textContent} | ${senderCurrent.textContent} | ${senderProgress.textContent} | loops ${senderState.loopCount}`;
}

async function loadCameras(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    receiverStatus.textContent = "Camera API unavailable";
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");
  cameraSelect.replaceChildren(
    ...cameras.map((camera, index) => {
      const option = document.createElement("option");
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${index + 1}`;
      return option;
    })
  );

  if (cameras.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No camera found";
    cameraSelect.append(option);
  }
}

async function startCamera(): Promise<void> {
  stopCamera();
  receiverStatus.textContent = "Requesting camera";

  // Detect the scanner first so we can size the stream to what it can keep up
  // with. This app's densest QR is v34 (161 modules), which 1080p resolves with
  // room to spare, so going higher only burdens the decoder. The native
  // BarcodeDetector handles 1080p comfortably; the jsQR software fallback runs
  // per-frame getImageData + decode, so we cap it at 720p to stay responsive.
  await ensureDetector();
  const cap = receiverState.detector ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };

  const deviceId = cameraSelect.value;
  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: cap.width, max: cap.width },
    height: { ideal: cap.height, max: cap.height },
    frameRate: { ideal: 30 }
  };
  if (deviceId) {
    videoConstraints.deviceId = { exact: deviceId };
  } else {
    videoConstraints.facingMode = { ideal: "environment" };
  }
  const constraints: MediaStreamConstraints = { video: videoConstraints, audio: false };

  try {
    receiverState.stream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraPreview.srcObject = receiverState.stream;
    await cameraPreview.play();
    addLog(
      receiverState.detector
        ? "Scanner: BarcodeDetector (multi-QR)."
        : "Scanner: jsQR (single QR fallback)."
    );
    reportResolution();
    receiverStatus.textContent = "Scanning";
    void loadCameras();
    scanLoop();
  } catch (error) {
    receiverStatus.textContent = error instanceof Error ? error.message : "Camera failed";
  }
}

function reportResolution(): void {
  const track = receiverState.stream?.getVideoTracks()[0];
  const settings = track?.getSettings?.();

  if (settings?.width && settings?.height) {
    const fps = settings.frameRate ? ` @${Math.round(settings.frameRate)}fps` : "";
    const text = `${settings.width}x${settings.height}${fps}`;
    receiverResolution.textContent = text;
    addLog(`Camera: ${text}`);
  } else {
    receiverResolution.textContent = "-";
  }
}

function stopCamera(): void {
  if (receiverState.scanFrame !== null) {
    cancelAnimationFrame(receiverState.scanFrame);
    receiverState.scanFrame = null;
  }

  receiverState.stream?.getTracks().forEach((track) => track.stop());
  receiverState.stream = null;
  cameraPreview.srcObject = null;
  receiverResolution.textContent = "-";
  receiverStatus.textContent = "Camera stopped";
}

async function ensureDetector(): Promise<void> {
  if (receiverState.detectorChecked) {
    return;
  }

  receiverState.detectorChecked = true;

  if (!("BarcodeDetector" in window)) {
    return;
  }

  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    if (formats.includes("qr_code")) {
      receiverState.detector = new BarcodeDetector({ formats: ["qr_code"] });
    }
  } catch {
    receiverState.detector = null;
  }
}

function scanLoop(): void {
  receiverState.scanFrame = requestAnimationFrame(() => {
    void scanTick();
  });
}

async function scanTick(): Promise<void> {
  if (!receiverState.stream) {
    return;
  }

  receiverState.scanFrames += 1;

  // Wrap each scan path in try/catch so a single decoder exception does not
  // kill the requestAnimationFrame loop (which would silently stop scanning).
  try {
    if (receiverState.detector) {
      await scanWithDetector(receiverState.detector);
    } else {
      scanWithJsQr();
    }
  } catch {
    // Continue scanning on the next frame; the decoder may recover.
  }

  renderScanStats();

  if (receiverState.stream) {
    scanLoop();
  }
}

async function scanWithDetector(detector: BarcodeDetector): Promise<void> {
  if (!cameraPreview.videoWidth || !cameraPreview.videoHeight) {
    return;
  }

  let codes: DetectedBarcode[];
  try {
    codes = await detector.detect(cameraPreview);
  } catch {
    return;
  }

  if (!receiverState.stream || codes.length === 0) {
    return;
  }

  receiverState.qrDetections += codes.length;
  receiverState.lastQrAt = Date.now();

  for (const code of codes) {
    if (code.rawValue) {
      void handleQrData(code.rawValue);
    }
  }
}

function scanWithJsQr(): void {
  const context = scanCanvas.getContext("2d", { willReadFrequently: true });

  if (!context || !cameraPreview.videoWidth || !cameraPreview.videoHeight) {
    return;
  }

  try {
    scanCanvas.width = cameraPreview.videoWidth;
    scanCanvas.height = cameraPreview.videoHeight;
    context.drawImage(cameraPreview, 0, 0, scanCanvas.width, scanCanvas.height);
    const imageData = context.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    const qr = jsQR(imageData.data, imageData.width, imageData.height);

    if (qr?.data) {
      receiverState.qrDetections += 1;
      receiverState.lastQrAt = Date.now();
      void handleQrData(qr.data);
    }
  } catch {
    // A frame that fails to rasterize/decode must not stop the scan loop.
  }
}

function renderScanStats(): void {
  const now = performance.now();

  if (now - receiverState.lastStatsAt < 500) {
    return;
  }

  const frames = receiverState.scanFrames - receiverState.lastStatsFrame;
  const seconds = (now - receiverState.lastStatsAt) / 1000;
  receiverScanRate.textContent = seconds > 0 ? `${Math.round(frames / seconds)}` : "0";
  receiverQrReads.textContent = `${receiverState.uniqueQrReads} / ${receiverState.qrDetections}`;
  receiverState.lastStatsAt = now;
  receiverState.lastStatsFrame = receiverState.scanFrames;
}

async function handleQrData(value: string): Promise<void> {
  const packet = parsePacket(value);

  if (!packet) {
    if (receiverState.handled.has(value)) {
      return;
    }
    receiverState.handled.add(value);
    receiverLast.textContent = "Ignored";
    return;
  }

  if (packet.type === "manifest") {
    // Dedup the manifest by raw value so it is not re-applied every frame it
    // stays in view (re-applying would clear already received chunks).
    if (receiverState.handled.has(value)) {
      return;
    }
    receiverState.handled.clear();
    receiverState.handled.add(value);
    applyReceiverManifest(receiverState, packet);
    // A new manifest invalidates any in-flight completion for the prior
    // transfer. Clear the scoped lock so the new transfer can complete freely.
    receiverState.completingTransferId = null;
    receiverStatus.textContent = "Manifest found";
    acceptTransfer.disabled = false;
    downloadFile.disabled = true;
    receiverPassphrase.disabled = packet.payload.encryption !== "AES-GCM";
    receiverPassphrase.value = "";
    restoredOutput.value = "";
    clearLog();
    addLog(`Manifest found for ${packet.file.name}.`);
    renderReceiver();
    return;
  }

  // Chunks are intentionally NOT deduped by raw value. Re-reading an already
  // captured chunk yields a "NNN dup" label, giving a live heartbeat on the
  // second and later loops; the chunks Map still prevents double storage.
  const result = acceptReceiverChunk(receiverState, packet);
  receiverLast.textContent = result.label;

  if (result.kind === "wrong-id" || result.kind === "wrong-total" || result.kind === "bad-seq") {
    // Log mismatched/invalid chunks once instead of on every frame.
    if (!receiverState.handled.has(value)) {
      receiverState.handled.add(value);
      addLog(result.message);
    }
    return;
  }

  if (result.kind === "accepted") {
    receiverState.uniqueQrReads += 1;
    renderReceiver();

    if (receiverState.manifest && receiverMissingCount(receiverState) === 0) {
      await completeTransfer();
    }
  }
}

async function completeTransfer(): Promise<void> {
  // Guard against concurrent invocations (two scan frames can both observe the
  // "missing count reached 0" condition while a decode is in flight). Only the
  // first caller for the active transfer runs; the others drop out so the scan
  // loop never re-enters. The lock is scoped to the active transferId so that a
  // new manifest scanned mid-decode does not leave a stale lock that suppresses
  // the new transfer's own completion.
  if (!receiverState.manifest) {
    return;
  }
  if (receiverState.completingTransferId === receiverState.manifest.transferId) {
    return;
  }
  receiverState.completingTransferId = receiverState.manifest.transferId;

  try {
    receiverState.hashStatus = "checking";
    renderReceiver();

    const result = await completeReceiverTransfer(receiverState, receiverPassphrase.value);

    // A new manifest may have been scanned while decode/hash was in flight. Do
    // not apply the stale result onto the now-active transfer.
    if (
      !receiverState.manifest ||
      receiverState.manifest.transferId !== receiverState.completingTransferId
    ) {
      return;
    }

    if (receiverState.restoredBytes) {
      restoredOutput.value = makePreview(receiverState.restoredBytes, receiverState.manifest.file.mime);
    }
    downloadFile.disabled = !result.ok;
    receiverStatus.textContent = result.ok ? "Complete" : result.message;
    addLog(result.message);
    renderReceiver();
  } finally {
    receiverState.completingTransferId = null;
  }
}

function renderReceiver(): void {
  const manifest = receiverState.manifest;
  const total = receiverTotalCount(receiverState);
  const received = receiverState.chunks.size;
  const missing = receiverMissingCount(receiverState);

  receiverFile.textContent = manifest
    ? `${manifest.file.name} (${formatBytes(manifest.file.size)})`
    : "No manifest";
  receiverTransferId.textContent = manifest?.transferId ?? "-";
  receiverReceived.textContent = `${received} / ${total}`;
  receiverChunks.textContent = String(total);
  receiverMime.textContent = manifest?.file.mime || "-";
  receiverMissing.textContent = String(missing);
  receiverMissingRanges.textContent = receiverMissingRangeSummary(receiverState);
  receiverHash.textContent = hashLabel(receiverState.hashStatus);
  receiverTransform.textContent = manifest ? transformLabel(manifest) : "none";
  receiverProgressBar.max = total || 1;
  receiverProgressBar.value = received;
}

function resetReceiver(): void {
  resetReceiverTransferState(receiverState);
  receiverState.handled.clear();
  receiverState.scanFrames = 0;
  receiverState.qrDetections = 0;
  receiverState.uniqueQrReads = 0;
  receiverState.lastQrAt = null;
  receiverState.lastStatsAt = performance.now();
  receiverState.lastStatsFrame = 0;
  receiverState.completingTransferId = null;
  receiverScanRate.textContent = "0";
  receiverQrReads.textContent = "0 / 0";
  acceptTransfer.disabled = true;
  downloadFile.disabled = true;
  receiverPassphrase.disabled = true;
  receiverPassphrase.value = "";
  restoredOutput.value = "";
  clearLog();
  receiverStatus.textContent = receiverState.stream ? "Scanning" : "Camera idle";
  renderReceiver();
}

function downloadRestoredFile(): void {
  if (!receiverState.manifest || !receiverState.restoredBytes) {
    return;
  }

  const blob = new Blob([bytesToArrayBuffer(receiverState.restoredBytes)], {
    type: receiverState.manifest.file.mime
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = receiverState.manifest.file.name;
  link.click();
  URL.revokeObjectURL(url);
}

function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function transformLabel(manifest: Manifest): string {
  const parts = [manifest.payload.compression, manifest.payload.encryption].filter(
    (part) => part !== "none"
  );
  return parts.length ? parts.join(" + ") : "none";
}

function addLog(message: string): void {
  const item = document.createElement("div");
  item.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  receiverLog.prepend(item);

  while (receiverLog.childElementCount > 8) {
    receiverLog.lastElementChild?.remove();
  }
}

function clearLog(): void {
  receiverLog.replaceChildren();
}

function makePreview(bytes: Uint8Array, mime: string): string {
  const canPreview = mime.startsWith("text/") || mime === "application/json" || mime === "";

  if (!canPreview) {
    return "Binary file restored. Use Download file to save it.";
  }

  const preview = new TextDecoder().decode(bytes);
  if (preview.length <= 6000) {
    return preview;
  }

  return `${preview.slice(0, 6000)}\n\n[preview truncated]`;
}

function hashLabel(status: ReceiverState["hashStatus"]): string {
  switch (status) {
    case "checking":
      return "Checking";
    case "valid":
      return "Valid";
    case "invalid":
      return "Invalid";
    case "idle":
      return "Idle";
  }
}
