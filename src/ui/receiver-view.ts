import { utf8Decoder } from "../core/bytes.ts";
import {
  acceptTransfer,
  createReceiverSession,
  discardPendingManifest,
  getProgress,
  hasProgress,
  ingestText,
  missingRanges,
  resetReceiverSession,
  restoreTransfer,
  switchToPendingManifest,
  trySolve,
  type ReceiverSession
} from "../core/receiver.ts";
import { createScanner, listCameras, type ScanStatus } from "../io/scanner.ts";
import { releaseWakeLock, requestWakeLock } from "../io/wake-lock.ts";
import {
  byId,
  downloadBytes,
  formatBytes,
  formatDuration,
  isEditableTarget,
  sanitizeFileName,
  show
} from "./dom.ts";

export type ReceiverView = {
  setActive(active: boolean): void;
  dispose(): void;
};

const MAX_LOG_ENTRIES = 12;
const PREVIEW_LIMIT = 8000;

export function createReceiverView(root: HTMLElement): ReceiverView {
  const video = byId<HTMLVideoElement>("camera-video", root);
  const scanCanvas = byId<HTMLCanvasElement>("scan-canvas", root);
  const cameraEmpty = byId<HTMLElement>("camera-empty", root);
  const scanHint = byId<HTMLElement>("scan-hint", root);
  const stage = byId<HTMLElement>("receiver-stage", root);

  const statusEl = byId<HTMLElement>("receiver-status", root);
  const statusText = byId<HTMLElement>("receiver-status-text", root);
  const subtle = byId<HTMLElement>("receiver-subtle", root);
  const hintTitle = byId<HTMLElement>("receiver-hint", root);
  const hintDetail = byId<HTMLElement>("receiver-hint-detail", root);

  const cameraSelect = byId<HTMLSelectElement>("camera-select", root);
  const startButton = byId<HTMLButtonElement>("receiver-start", root);
  const stopButton = byId<HTMLButtonElement>("receiver-stop", root);

  const statePill = byId<HTMLElement>("receiver-state", root);
  const fileEl = byId<HTMLElement>("receiver-file", root);
  const sizeEl = byId<HTMLElement>("receiver-size", root);
  const framesEl = byId<HTMLElement>("receiver-frames", root);
  const transformEl = byId<HTMLElement>("receiver-transform", root);
  const idEl = byId<HTMLElement>("receiver-id", root);

  const progressBar = byId<HTMLProgressElement>("receiver-progress", root);
  const percentEl = byId<HTMLElement>("receiver-percent", root);
  const missingEl = byId<HTMLElement>("receiver-missing", root);
  const chunkMap = byId<HTMLCanvasElement>("chunk-map", root);

  const autoAcceptInput = byId<HTMLInputElement>("receiver-auto", root);
  const passphraseRow = byId<HTMLElement>("receiver-passphrase-row", root);
  const passphraseInput = byId<HTMLInputElement>("receiver-passphrase", root);

  const acceptButton = byId<HTMLButtonElement>("receiver-accept", root);
  const retryButton = byId<HTMLButtonElement>("receiver-retry", root);
  const downloadButton = byId<HTMLButtonElement>("receiver-download", root);
  const resetButton = byId<HTMLButtonElement>("receiver-reset", root);

  const pendingNotice = byId<HTMLElement>("pending-notice", root);
  const pendingName = byId<HTMLElement>("pending-name", root);
  const pendingSwitch = byId<HTMLButtonElement>("pending-switch", root);
  const pendingDismiss = byId<HTMLButtonElement>("pending-dismiss", root);
  const preview = byId<HTMLTextAreaElement>("restored-preview", root);

  const decoderEl = byId<HTMLElement>("scan-decoder", root);
  const resolutionEl = byId<HTMLElement>("scan-resolution", root);
  const rateEl = byId<HTMLElement>("scan-rate", root);
  const scanFramesEl = byId<HTMLElement>("scan-frames", root);
  const duplicatesEl = byId<HTMLElement>("scan-duplicates", root);
  const droppedEl = byId<HTMLElement>("scan-dropped", root);

  const logEl = byId<HTMLElement>("receiver-log", root);

  const session: ReceiverSession = createReceiverSession({ autoAccept: true });
  const scanner = createScanner({
    video,
    canvas: scanCanvas,
    onText: handleText,
    onStatus: renderScanStatus,
    onError: (message) => {
      log(message);
      setStatus("Camera error", "error");
      setOverlay("Camera error", true);
    }
  });

  let isActive = false;
  let finishing = false;
  let renderQueued = false;
  let lastCorruptLogAt = 0;
  let lastMapKey = "";
  let lastKnownData = 0;
  let lastRateAt = 0;
  let observedRate = 0;

  // ------------------------------------------------------------------ ingest

  function handleText(text: string): void {
    const result = ingestText(session, text);

    if (result.type === "manifest") {
      if (result.pending) {
        pendingName.textContent = `${result.manifest.file.name} · ${formatBytes(result.manifest.file.size)}`;
        show(pendingNotice, true);
        return;
      }

      if (result.applied) {
        lastKnownData = 0;
        lastRateAt = 0;
        observedRate = 0;
        pendingNotice.hidden = true;
        preview.hidden = true;
        preview.value = "";
        downloadButton.disabled = true;
        passphraseInput.value = "";
        log(
          `Manifest: ${result.manifest.file.name} · ${formatBytes(result.manifest.file.size)} · ` +
            `${result.manifest.payload.chunkCount} frames + ${result.manifest.payload.repairCount} repair`
        );

        if (result.manifest.payload.encryption !== "none") {
          log("Encrypted transfer — the passphrase is only needed once everything is received.");
        }

        if (result.awaitingAccept) {
          setStatus("Awaiting accept", "warn");
        } else {
          setStatus("Receiving", "live");
          void requestWakeLock();
        }

        subtle.textContent = "Hold steady — repairs will fill any frames the camera misses.";
      }

      queueRender();
      return;
    }

    if (result.type === "chunk") {
      if (result.accepted) {
        queueRender();
        pump();
      } else if (result.reason === "not-receiving") {
        // Waiting for the user to accept the transfer.
      }
      return;
    }

    if (result.type === "corrupt") {
      const now = Date.now();
      if (now - lastCorruptLogAt > 2000) {
        lastCorruptLogAt = now;
        log("Dropped a damaged frame (CRC mismatch).");
      }
      queueRender();
    }
  }

  function pump(): void {
    if (!session.manifest || finishing) {
      return;
    }

    const progress = getProgress(session);
    if (progress.complete) {
      void finish();
      return;
    }

    const outcome = trySolve(session);
    if (outcome.solved > 0) {
      log(`Rebuilt ${outcome.solved} missing frame(s) from repair chunks.`);
      queueRender();
    }

    if (getProgress(session).complete) {
      void finish();
    }
  }

  async function finish(): Promise<void> {
    if (finishing || !session.manifest) {
      return;
    }

    finishing = true;
    const transferId = session.manifest.transferId;
    setStatus("Verifying", "busy");
    hintTitle.textContent = "Verifying…";
    queueRender();

    try {
      const result = await restoreTransfer(session, passphraseInput.value);

      // A reset or a different transfer may have replaced the session while the
      // hash / crypto work was in flight.
      if (session.manifest?.transferId !== transferId) {
        return;
      }

      log(result.message);

      if (result.ok) {
        setStatus("Complete", "ready");
        hintTitle.textContent = "Transfer complete";
        hintDetail.textContent = `${session.manifest.file.name} · ${formatBytes(
          session.restoredBytes?.byteLength ?? 0
        )}`;
        setOverlay("Complete", false);
        void releaseWakeLock();
      } else {
        setStatus(session.status === "error" ? "Needs attention" : "Receiving", "warn");
        hintTitle.textContent = "Not complete yet";
        if (session.status === "error" && session.manifest.payload.encryption !== "none") {
          passphraseInput.focus();
        }
      }
    } finally {
      finishing = false;
      render();
    }
  }

  // ------------------------------------------------------------------ camera

  async function refreshCameras(): Promise<void> {
    const cameras = await listCameras();
    const current = cameraSelect.value;

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

    if (current && cameras.some((camera) => camera.deviceId === current)) {
      cameraSelect.value = current;
    }
  }

  async function startCamera(): Promise<void> {
    setStatus("Starting camera", "busy");
    setOverlay("Starting camera…", false);
    await scanner.start(cameraSelect.value || undefined);
    if (!scanner.isRunning()) {
      return;
    }

    show(cameraEmpty, false);
    stage.classList.add("is-live");
    setStatus("Scanning", "live");
    setOverlay("Point at the sender's screen", false);
    startButton.disabled = true;
    stopButton.disabled = false;
    void requestWakeLock();
    void refreshCameras();
  }

  function stopCamera(): void {
    scanner.stop();
    stage.classList.remove("is-live");
    show(cameraEmpty, true);
    setOverlay("", false);
    startButton.disabled = false;
    stopButton.disabled = true;
    setStatus(session.manifest ? "Paused" : "Camera off", "idle");
    void releaseWakeLock();
  }

  function renderScanStatus(status: ScanStatus): void {
    decoderEl.textContent = status.decoder === "native" ? "BarcodeDetector" : status.decoder === "jsqr" ? "jsQR" : "—";
    resolutionEl.textContent = status.resolution;
    rateEl.textContent = status.running ? `${status.frameRate} fps` : "—";
    scanFramesEl.textContent = String(status.frames);
    duplicatesEl.textContent = String(session.stats.duplicates);
    droppedEl.textContent = String(session.stats.corrupt);
    stage.classList.toggle("is-scanning", status.running);
  }

  // ----------------------------------------------------------------- render

  function queueRender(): void {
    if (renderQueued) {
      return;
    }

    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render(): void {
    const manifest = session.manifest;
    const progress = getProgress(session);

    if (!manifest) {
      statePill.textContent = "Idle";
      fileEl.textContent = "No manifest yet";
      sizeEl.textContent = "—";
      framesEl.textContent = "—";
      transformEl.textContent = "—";
      idEl.textContent = "—";
      progressBar.max = 1;
      progressBar.value = 0;
      percentEl.textContent = "0 %";
      missingEl.textContent =
        session.stats.foreign > 0
          ? "Seeing frames, waiting for their manifest QR…"
          : "Waiting for a manifest QR…";
      show(passphraseRow, false);
      show(acceptButton, false);
      show(retryButton, false);
      downloadButton.disabled = true;
      pendingNotice.hidden = true;
      drawChunkMap(null);
      renderScannerCounters();
      return;
    }

    statePill.textContent = stateLabel(session);
    fileEl.textContent = manifest.file.name;
    sizeEl.textContent = formatBytes(manifest.file.size);
    framesEl.textContent = `${progress.dataReceived} / ${progress.dataTotal} · repair ${progress.repairsReceived}/${progress.repairTotal}`;
    transformEl.textContent =
      [manifest.payload.compression, manifest.payload.encryption]
        .filter((part) => part !== "none")
        .join(" + ") || "none";
    idEl.textContent = manifest.transferId;

    progressBar.max = Math.max(1, progress.dataTotal);
    progressBar.value = progress.dataReceived;
    percentEl.textContent = `${Math.floor(progress.ratio * 100)} %`;

    if (session.status === "complete") {
      missingEl.textContent = `${formatBytes(session.restoredBytes?.byteLength ?? 0)} restored · SHA-256 verified`;
    } else if (progress.missing === 0) {
      missingEl.textContent = "All chunks received.";
    } else {
      const repairNote =
        progress.recovered > 0 ? ` · ${progress.recovered} rebuilt from repair frames` : "";
      missingEl.textContent = `Missing ${progress.missing}: ${missingRanges(session)}${repairNote}`;
    }

    show(passphraseRow, manifest.payload.encryption !== "none");
    show(acceptButton, session.status === "awaiting-accept");
    show(retryButton, session.status === "error");
    downloadButton.disabled = !session.restoredBytes;
    show(pendingNotice, !!session.pendingManifest);

    renderPreview(manifest.file.mime);
    renderScannerCounters();
    drawChunkMap(manifest);
    renderHint(progress);
  }

  function renderHint(progress: ReturnType<typeof getProgress>): void {
    const now = Date.now();

    if (session.status === "complete") {
      hintTitle.textContent = "Complete";
      hintDetail.textContent = `${session.data.size} chunks · verified`;
      setOverlay("", false);
      return;
    }

    if (session.status === "awaiting-accept") {
      hintTitle.textContent = "Manifest found";
      hintDetail.textContent = "Accept the transfer to start collecting frames";
      return;
    }

    if (!session.manifest) {
      hintTitle.textContent = scanner.isRunning() ? "Scanning" : "Camera off";
      hintDetail.textContent =
        session.stats.foreign > 0 ? "Frames detected — waiting for the manifest" : "No transfer yet";
      return;
    }

    if (session.status === "error") {
      hintTitle.textContent = "Needs attention";
      hintDetail.textContent = "Unlock or reset to continue";
      return;
    }

    // Rough ETA from the sustained chunk acquisition rate.
    if (lastKnownData !== progress.dataReceived) {
      if (lastRateAt > 0) {
        const elapsed = (now - lastRateAt) / 1000;
        if (elapsed > 0) {
          const rate = (progress.dataReceived - lastKnownData) / elapsed;
          observedRate = observedRate === 0 ? rate : observedRate * 0.7 + rate * 0.3;
        }
      }
      lastKnownData = progress.dataReceived;
      lastRateAt = now;
    }

    const eta =
      observedRate > 0.05 && progress.missing > 0
        ? ` · ETA ${formatDuration(progress.missing / observedRate)}`
        : "";

    hintTitle.textContent = progress.missing === 0 ? "Finishing" : "Receiving";
    hintDetail.textContent =
      `${progress.dataReceived} / ${progress.dataTotal} chunks · ${Math.floor(progress.ratio * 100)}%` +
      `${progress.repairsReceived > 0 ? ` · ${progress.repairsReceived} repair` : ""}` +
      eta;
    setOverlay(`${Math.floor(progress.ratio * 100)}%`, true);
  }

  function renderPreview(mime: string): void {
    if (!session.restoredBytes) {
      show(preview, false);
      return;
    }

    const textLike =
      mime.startsWith("text/") || mime === "application/json" || mime === "";
    if (!textLike) {
      show(preview, false);
      return;
    }

    const text = utf8Decoder.decode(session.restoredBytes);
    preview.value =
      text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n\n[preview truncated]` : text;
    show(preview, true);
  }

  function renderScannerCounters(): void {
    duplicatesEl.textContent = String(session.stats.duplicates);
    droppedEl.textContent = String(session.stats.corrupt);
    scanFramesEl.textContent = String(scanner.status().frames);
    rateEl.textContent = scanner.status().running ? `${scanner.status().frameRate} fps` : "—";
  }

  function drawChunkMap(manifest: typeof session.manifest): void {
    const context = chunkMap.getContext("2d");
    if (!context) {
      return;
    }

    // Redrawing thousands of cells on every accepted frame is wasteful; the map
    // only changes when a new chunk (or a solved batch) lands.
    const mapKey = manifest
      ? `${manifest.transferId}:${session.data.size}:${session.repairs.size}:${session.recovered.size}:${chunkMap.clientWidth}`
      : "none";
    if (mapKey === lastMapKey && chunkMap.width > 0) {
      return;
    }
    lastMapKey = mapKey;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = chunkMap.clientWidth || 320;
    const cssHeight = Math.max(48, Math.min(140, Math.round(cssWidth / 6)));
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);

    if (chunkMap.width !== width || chunkMap.height !== height) {
      chunkMap.width = width;
      chunkMap.height = height;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);

    if (!manifest) {
      return;
    }

    const total = manifest.payload.chunkCount + manifest.payload.repairCount;
    const columns = Math.max(8, Math.ceil(Math.sqrt(total * 3)));
    const rows = Math.ceil(total / columns);
    const gap = Math.max(1, Math.round(dpr));
    const cellWidth = (width - gap * (columns - 1)) / columns;
    const cellHeight = (height - gap * (rows - 1)) / rows;

    for (let index = 0; index < total; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const isRepair = index >= manifest.payload.chunkCount;
      const seq = isRepair ? index - manifest.payload.chunkCount : index;

      if (isRepair) {
        context.fillStyle = session.repairs.has(seq) ? "#5f7ce0" : "#e6e8ee";
      } else if (session.recovered.has(seq)) {
        context.fillStyle = "#7ac6a8";
      } else if (session.data.has(seq)) {
        context.fillStyle = "#2f9e75";
      } else {
        context.fillStyle = "#e6e8ee";
      }

      context.fillRect(
        Math.round(column * (cellWidth + gap)),
        Math.round(row * (cellHeight + gap)),
        Math.max(1, Math.ceil(cellWidth)),
        Math.max(1, Math.ceil(cellHeight))
      );
    }
  }

  function setOverlay(text: string, visible: boolean): void {
    if (!visible || text.length === 0) {
      show(scanHint, false);
      return;
    }

    scanHint.textContent = text;
    show(scanHint, true);
  }

  function setStatus(text: string, tone: "idle" | "live" | "busy" | "warn" | "ready" | "error"): void {
    statusText.textContent = text;
    statusEl.dataset.tone = tone;
  }

  function stateLabel(target: ReceiverSession): string {
    switch (target.status) {
      case "awaiting-accept":
        return "Awaiting accept";
      case "receiving":
        return "Receiving";
      case "verifying":
        return "Verifying";
      case "complete":
        return "Complete";
      case "error":
        return "Error";
      default:
        return "Idle";
    }
  }

  function log(message: string): void {
    const item = document.createElement("div");
    item.className = "log-entry";
    item.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
    logEl.prepend(item);

    while (logEl.childElementCount > MAX_LOG_ENTRIES) {
      logEl.lastElementChild?.remove();
    }
  }

  // ------------------------------------------------------------------ events

  startButton.addEventListener("click", () => void startCamera());
  stopButton.addEventListener("click", stopCamera);

  cameraSelect.addEventListener("change", () => {
    if (scanner.isRunning()) {
      void startCamera();
    }
  });

  acceptButton.addEventListener("click", () => {
    if (acceptTransfer(session)) {
      log("Transfer accepted.");
      setStatus("Receiving", "live");
      void requestWakeLock();
      queueRender();
    }
  });

  retryButton.addEventListener("click", () => {
    if (getProgress(session).complete || session.status === "error") {
      void finish();
    }
  });

  passphraseInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void finish();
    }
  });

  downloadButton.addEventListener("click", () => {
    const manifest = session.manifest;
    if (!manifest || !session.restoredBytes) {
      return;
    }

    downloadBytes(
      session.restoredBytes,
      sanitizeFileName(manifest.file.name),
      manifest.file.mime
    );
    log(`Saved ${manifest.file.name}.`);
  });

  resetButton.addEventListener("click", () => {
    resetReceiverSession(session);
    finishing = false;
    lastKnownData = 0;
    lastRateAt = 0;
    observedRate = 0;
    pendingNotice.hidden = true;
    preview.value = "";
    preview.hidden = true;
    passphraseInput.value = "";
    downloadButton.disabled = true;
    logEl.replaceChildren();
    setStatus(scanner.isRunning() ? "Scanning" : "Camera off", scanner.isRunning() ? "live" : "idle");
    setOverlay(scanner.isRunning() ? "Point at the sender's screen" : "", scanner.isRunning());
    hintTitle.textContent = "Waiting";
    hintDetail.textContent = "No transfer yet";
    render();
  });

  autoAcceptInput.addEventListener("change", () => {
    session.autoAccept = autoAcceptInput.checked;
    if (session.autoAccept && session.status === "awaiting-accept") {
      acceptTransfer(session);
      log("Auto-accept enabled — transfer accepted.");
      void requestWakeLock();
    }
    queueRender();
  });

  pendingSwitch.addEventListener("click", () => {
    if (switchToPendingManifest(session)) {
      log(`Switched to ${session.manifest?.file.name ?? "the new transfer"}.`);
      pendingNotice.hidden = true;
      render();
    }
  });

  pendingDismiss.addEventListener("click", () => {
    discardPendingManifest(session);
    pendingNotice.hidden = true;
    log("Ignoring the other transfer.");
    render();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isActive || isEditableTarget(event.target)) {
      return;
    }

    if (event.key.toLowerCase() === "s" && !scanner.isRunning()) {
      void startCamera();
    } else if (event.key.toLowerCase() === "x" && scanner.isRunning()) {
      stopCamera();
    } else if (event.key.toLowerCase() === "d" && session.restoredBytes) {
      downloadButton.click();
    }
  };

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (hasProgress(session) && session.status !== "complete") {
      event.preventDefault();
      event.returnValue = "";
    }
  };

  const onDeviceChange = (): void => void refreshCameras();

  // Automation hook: lets tooling (or a browser console) feed decoded frames
  // into the receiver without a camera.
  //   document.dispatchEvent(new CustomEvent("qropt:frame", { detail: text }))
  const onInjectedFrame = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail === "string") {
      handleText(detail);
    }
  };

  document.addEventListener("qropt:frame", onInjectedFrame);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("beforeunload", onBeforeUnload);
  navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

  stopButton.disabled = true;
  void refreshCameras();
  render();

  return {
    setActive(active: boolean): void {
      isActive = active;
      if (!active && scanner.isRunning()) {
        stopCamera();
      }
    },
    dispose(): void {
      scanner.stop();
      document.removeEventListener("qropt:frame", onInjectedFrame);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      void releaseWakeLock();
    }
  };
}
