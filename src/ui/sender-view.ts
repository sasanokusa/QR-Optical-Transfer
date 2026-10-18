import type { QRCodeErrorCorrectionLevel } from "qrcode";
import { utf8Encoder } from "../core/bytes.ts";
import { MAX_CHUNK_BYTES } from "../core/codec.ts";
import {
  buildTransfer,
  createSchedule,
  demoSource,
  frameText,
  planTick,
  type Schedule,
  type TransferBundle,
  type TransferOptions,
  type TransferSource
} from "../core/transfer.ts";
import { clearQrCells, qrInfo, renderQrCells } from "../io/qr-render.ts";
import { generatePassphrase } from "../core/crypto.ts";
import { releaseWakeLock, requestWakeLock } from "../io/wake-lock.ts";
import {
  byId,
  formatBytes,
  formatDuration,
  isEditableTarget,
  show
} from "./dom.ts";

type SourceKind = "file" | "text" | "demo";
type StatusTone = "idle" | "ready" | "live" | "warn" | "error";

const PRESETS = {
  reliable: { chunkSize: 300, fps: 10 },
  balanced: { chunkSize: 600, fps: 8 },
  dense: { chunkSize: 900, fps: 5 }
} as const;

type PresetName = keyof typeof PRESETS | "custom";

/** Maximum raw chunk bytes that still fit a QR symbol at a given ECC level. */
const MAX_CHUNK_BYTES_BY_ECC: Record<string, number> = {
  L: 2202,
  M: 1734,
  Q: 1233,
  H: 942
};

export type SenderView = {
  setActive(active: boolean): void;
  dispose(): void;
};

type SenderState = {
  sourceKind: SourceKind;
  file: File | null;
  fileBytes: Uint8Array | null;
  demoLines: number;
  bundle: TransferBundle | null;
  schedule: Schedule | null;
  cursor: number;
  tick: number;
  loops: number;
  running: boolean;
  preparing: boolean;
  prepareId: number;
  runId: number;
  timer: number | null;
  startedAt: number;
  interval: number;
  lastError: string | null;
};

export function createSenderView(root: HTMLElement): SenderView {
  const qrGrid = byId<HTMLDivElement>("qr-grid", root);
  const qrEmpty = byId<HTMLDivElement>("qr-empty", root);
  const stage = byId<HTMLDivElement>("qr-stage", root);
  const statusEl = byId<HTMLSpanElement>("sender-status", root);
  const statusText = byId<HTMLSpanElement>("sender-status-text", root);
  const subtle = byId<HTMLParagraphElement>("sender-subtle", root);

  const dropzone = byId<HTMLLabelElement>("dropzone", root);
  const fileInput = byId<HTMLInputElement>("file-input", root);
  const dropzoneTitle = byId<HTMLElement>("dropzone-title", root);
  const dropzoneDetail = byId<HTMLElement>("dropzone-detail", root);
  const textInput = byId<HTMLTextAreaElement>("text-input", root);
  const demoLinesInput = byId<HTMLInputElement>("demo-lines", root);

  const specName = byId<HTMLElement>("spec-name", root);
  const specSize = byId<HTMLElement>("spec-size", root);
  const specFrames = byId<HTMLElement>("spec-frames", root);
  const specQr = byId<HTMLElement>("spec-qr", root);
  const specId = byId<HTMLElement>("spec-id", root);
  const specPass = byId<HTMLElement>("spec-pass", root);
  const specRate = byId<HTMLElement>("spec-rate", root);
  const specPayload = byId<HTMLElement>("spec-payload", root);
  const transformPill = byId<HTMLElement>("transform-pill", root);
  const settingsSummary = byId<HTMLElement>("settings-summary", root);
  const settingsHint = byId<HTMLElement>("settings-hint", root);

  const frameLabel = byId<HTMLElement>("sender-frame-label", root);
  const passLabel = byId<HTMLElement>("sender-pass-label", root);
  const progressBar = byId<HTMLProgressElement>("sender-progress", root);

  const startButton = byId<HTMLButtonElement>("sender-start", root);
  const pauseButton = byId<HTMLButtonElement>("sender-pause", root);
  const stopButton = byId<HTMLButtonElement>("sender-stop", root);
  const manifestButton = byId<HTMLButtonElement>("sender-manifest", root);
  const stepButton = byId<HTMLButtonElement>("sender-step", root);
  const fullscreenButton = byId<HTMLButtonElement>("sender-fullscreen", root);

  const presetSelect = byId<HTMLSelectElement>("preset-select", root);
  const chunkSizeInput = byId<HTMLInputElement>("chunk-size", root);
  const fpsSelect = byId<HTMLSelectElement>("fps-select", root);
  const repairSelect = byId<HTMLSelectElement>("repair-select", root);
  const eccSelect = byId<HTMLSelectElement>("ecc-select", root);
  const compressionSelect = byId<HTMLSelectElement>("compression-select", root);
  const gridSelect = byId<HTMLSelectElement>("grid-select", root);
  const beaconSelect = byId<HTMLSelectElement>("beacon-select", root);
  const loopToggle = byId<HTMLInputElement>("loop-toggle", root);
  const encryptToggle = byId<HTMLInputElement>("encrypt-toggle", root);
  const passphraseRow = byId<HTMLElement>("passphrase-row", root);
  const passphraseInput = byId<HTMLInputElement>("sender-passphrase", root);
  const generateButton = byId<HTMLButtonElement>("generate-passphrase", root);

  const state: SenderState = {
    sourceKind: "file",
    file: null,
    fileBytes: null,
    demoLines: 100,
    bundle: null,
    schedule: null,
    cursor: 0,
    tick: 0,
    loops: 0,
    running: false,
    preparing: false,
    prepareId: 0,
    runId: 0,
    timer: null,
    startedAt: 0,
    interval: 125,
    lastError: null
  };

  let prepareTimer: number | null = null;

  // ---------------------------------------------------------------- settings

  function eccLevel(): QRCodeErrorCorrectionLevel {
    return eccSelect.value as QRCodeErrorCorrectionLevel;
  }

  function maxChunkBytes(): number {
    return Math.min(MAX_CHUNK_BYTES, MAX_CHUNK_BYTES_BY_ECC[eccLevel()]);
  }

  function readSettings(): TransferOptions & { grid: number; ecc: QRCodeErrorCorrectionLevel } {
    const chunkSize = clamp(Number(chunkSizeInput.value), 32, maxChunkBytes());
    const fps = clamp(Number(fpsSelect.value), 1, 30);
    const compression = compressionSelect.value as TransferOptions["compression"];

    return {
      chunkSize,
      fps,
      repairRatio: clamp(Number(repairSelect.value), 0, 50) / 100,
      compression,
      passphrase: encryptToggle.checked ? passphraseInput.value : "",
      beaconSeconds: Number(beaconSelect.value),
      loop: loopToggle.checked,
      grid: Number(gridSelect.value),
      ecc: eccLevel()
    };
  }

  function applyPreset(name: PresetName): void {
    if (name === "custom") {
      return;
    }

    const preset = PRESETS[name];
    chunkSizeInput.value = String(preset.chunkSize);
    fpsSelect.value = String(preset.fps);
  }

  function markCustom(): void {
    presetSelect.value = "custom";
  }

  function schedulePrepare(delay = 220): void {
    if (prepareTimer !== null) {
      window.clearTimeout(prepareTimer);
    }
    prepareTimer = window.setTimeout(() => {
      prepareTimer = null;
      void prepare();
    }, delay);
  }

  // ----------------------------------------------------------------- source

  function setSourceKind(kind: SourceKind): void {
    state.sourceKind = kind;

    root.querySelectorAll<HTMLButtonElement>(".segment").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.source === kind);
    });

    show(byId("source-file", root), kind === "file");
    show(byId("source-text", root), kind === "text");
    show(byId("source-demo", root), kind === "demo");

    schedulePrepare(0);
  }

  async function readSource(): Promise<{
    source: TransferSource;
    chunkSize?: number;
  } | null> {
    if (state.sourceKind === "text") {
      const text = textInput.value;
      if (text.trim().length === 0) {
        return null;
      }
      return {
        source: {
          name: "note.txt",
          mime: "text/plain",
          bytes: utf8Encoder.encode(text)
        }
      };
    }

    if (state.sourceKind === "demo") {
      const lines = clamp(Number(demoLinesInput.value), 10, 400);
      demoLinesInput.value = String(lines);
      const source = demoSource(lines);
      // Aim for roughly one chunk per demo line.
      return {
        source,
        chunkSize: Math.max(16, Math.ceil(source.bytes.byteLength / lines))
      };
    }

    const file = state.file;
    if (!file) {
      return null;
    }

    if (!state.fileBytes) {
      state.fileBytes = new Uint8Array(await file.arrayBuffer());
    }

    return {
      source: {
        name: file.name,
        mime: file.type || "application/octet-stream",
        bytes: state.fileBytes
      }
    };
  }

  function renderFileSelection(): void {
    const file = state.file;
    if (!file) {
      dropzoneTitle.textContent = "Choose a file or drop it here";
      dropzoneDetail.textContent = "Anything up to a few MB works. Nothing leaves this device.";
      return;
    }

    dropzoneTitle.textContent = file.name;
    dropzoneDetail.textContent = `${formatBytes(file.size)} · ${file.type || "application/octet-stream"}`;
  }

  // ---------------------------------------------------------------- prepare

  async function prepare(): Promise<void> {
    const prepareId = ++state.prepareId;
    const settings = readSettings();
    chunkSizeInput.value = String(settings.chunkSize);
    state.preparing = true;
    state.lastError = null;
    stopLoop();
    setStatus("Preparing", "idle");
    updateTransport();

    if (encryptToggle.checked && (settings.passphrase ?? "").trim().length === 0) {
      state.preparing = false;
      state.bundle = null;
      clearQrCells(qrGrid);
      qrEmpty.textContent = "Enter a passphrase to encrypt";
      show(qrEmpty, true);
      setStatus("Passphrase needed", "warn");
      renderSpecs(null);
      updateTransport();
      return;
    }

    try {
      const picked = await readSource();
      if (prepareId !== state.prepareId) {
        return;
      }

      if (!picked) {
        state.preparing = false;
        state.bundle = null;
        state.schedule = null;
        clearQrCells(qrGrid);
        qrEmpty.textContent = "Choose a file, paste some text, or open the demo";
        show(qrEmpty, true);
        setStatus("No source", "idle");
        subtle.textContent = "Pick a file on the right, then start the frame loop.";
        renderSpecs(null);
        updateTransport();
        return;
      }

      const { source, chunkSize } = picked;

      const bundle = await buildTransfer(source, {
        ...settings,
        chunkSize: chunkSize ?? settings.chunkSize
      });
      if (prepareId !== state.prepareId) {
        return;
      }

      const schedule = createSchedule(bundle, {
        fps: settings.fps,
        beaconSeconds: settings.beaconSeconds
      });

      // Throws when a frame cannot fit the chosen ECC level.
      qrInfo(bundle.manifestText, settings.ecc);

      state.bundle = bundle;
      state.schedule = schedule;
      state.cursor = 0;
      state.tick = 0;
      state.loops = 0;
      state.preparing = false;
      state.interval = 1000 / settings.fps;

      showManifest();
      renderSpecs(bundle);
      setStatus("Ready", "ready");
      subtle.textContent = "Start the loop, then let the receiver scan the screen.";
    } catch (error) {
      if (prepareId !== state.prepareId) {
        return;
      }
      state.preparing = false;
      state.bundle = null;
      state.schedule = null;
      state.lastError = error instanceof Error ? error.message : "Could not prepare this transfer.";
      clearQrCells(qrGrid);
      qrEmpty.textContent = state.lastError;
      show(qrEmpty, true);
      setStatus("Cannot prepare", "error");
      subtle.textContent = state.lastError;
      renderSpecs(null);
    } finally {
      if (prepareId === state.prepareId) {
        updateTransport();
      }
    }
  }

  // ------------------------------------------------------------------- loop

  function showManifest(): void {
    if (!state.bundle) {
      return;
    }

    const settings = readSettings();
    renderQrCells(qrGrid, [state.bundle.manifestText], {
      ecc: settings.ecc,
      cellSize: 620
    });
    show(qrEmpty, false);
    frameLabel.textContent = "Manifest";
    passLabel.textContent = "ready to start";
    progressBar.max = 1;
    progressBar.value = 0;
    state.tick = 0;
    state.cursor = 0;
    state.loops = 0;
  }

  function start(): void {
    if (!state.bundle || !state.schedule || state.running) {
      return;
    }

    state.running = true;
    state.runId += 1;
    state.startedAt = performance.now();
    state.tick = 0;
    state.interval = 1000 / Number(fpsSelect.value);
    state.loops = 0;
    setStatus("Transmitting", "live");
    subtle.textContent = "Keep the QR codes large, bright and steady on the receiver's screen.";
    updateTransport();
    void requestWakeLock();
    void tick(state.runId);
  }

  function pause(): void {
    if (!state.running) {
      return;
    }

    stopLoop();
    setStatus("Paused", "warn");
    updateTransport();
    void releaseWakeLock();
  }

  function stop(): void {
    stopLoop();
    setStatus("Stopped", "ready");
    showManifest();
    updateTransport();
    void releaseWakeLock();
  }

  function stopLoop(): void {
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    state.running = false;
    state.runId += 1;
  }

  function step(): void {
    if (!state.bundle || !state.schedule || state.running) {
      return;
    }

    renderStep(readSettings());
    setStatus("Stepping", "warn");
  }

  function renderStep(settings: ReturnType<typeof readSettings>): void {
    if (!state.bundle || !state.schedule) {
      return;
    }

    const plan = planTick(state.bundle, state.schedule, state.cursor, state.tick, settings.grid);
    state.cursor = plan.cursor;
    state.tick += 1;
    show(qrEmpty, false);
    const info = renderQrCells(qrGrid, plan.cells, { ecc: settings.ecc, cellSize: 620 });
    updateReadout(plan.cells.length, plan.beacon, info?.version ?? null);
  }

  async function tick(runId: number): Promise<void> {
    if (!state.bundle || !state.schedule || !state.running || state.runId !== runId) {
      return;
    }

    const settings = readSettings();

    try {
      renderStep(settings);
    } catch (error) {
      stopLoop();
      state.lastError = error instanceof Error ? error.message : "Rendering failed.";
      setStatus("Render error", "error");
      updateTransport();
      return;
    }

    const units = state.schedule.units.length;
    const loops = Math.floor(state.cursor / units);
    if (loops > state.loops) {
      state.loops = loops;
    }

    if (!state.running || state.runId !== runId) {
      return;
    }

    const due = state.startedAt + state.tick * state.interval;
    const delay = Math.max(0, due - performance.now());
    state.timer = window.setTimeout(() => {
      void tick(runId);
    }, delay);
  }

  function updateReadout(cells: number, beacon: boolean, version: number | null): void {
    if (!state.schedule) {
      return;
    }

    const total = state.schedule.units.length;
    const position = state.cursor % total;
    const loops = Math.floor(state.cursor / total) + 1;

    frameLabel.textContent = beacon
      ? cells > 1
        ? `Manifest + ${cells - 1} frame${cells > 2 ? "s" : ""}`
        : "Manifest"
      : `${cells} frame${cells > 1 ? "s" : ""}${version ? ` · QR v${version}` : ""}`;
    passLabel.textContent = `pass ${loops} · ${position} / ${total}`;
    progressBar.max = total;
    progressBar.value = position;
  }

  // ---------------------------------------------------------------- render

  function renderSpecs(bundle: TransferBundle | null): void {
    const settings = readSettings();

    if (!bundle) {
      specName.textContent = "—";
      specSize.textContent = "—";
      specFrames.textContent = "—";
      specQr.textContent = "—";
      specId.textContent = "—";
      specPass.textContent = "—";
      specRate.textContent = "—";
      specPayload.textContent = "—";
      transformPill.textContent = "none";
      settingsSummary.textContent = "—";
      return;
    }

    const { manifest } = bundle;
    const frames = manifest.payload.chunkCount + manifest.payload.repairCount;
    const fps = manifest.display.fps;
    const beaconEvery = Math.max(2, Math.round(fps * manifest.display.beaconSeconds));
    const beacons = Math.ceil(frames / beaconEvery);
    const passSeconds = (frames + beacons) / fps;
    let version = 0;
    let modules = 0;

    try {
      // The data frames dominate the screen; report their QR size, not the
      // (usually smaller) manifest symbol.
      const info = qrInfo(frameText(bundle, { kind: "data", seq: 0 }), settings.ecc);
      version = info.version;
      modules = info.modules;
    } catch {
      version = 0;
    }

    specName.textContent = manifest.file.name;
    specSize.textContent = formatBytes(manifest.file.size);
    specFrames.textContent = `${manifest.payload.chunkCount} + ${manifest.payload.repairCount} repair`;
    specQr.textContent = version ? `v${version} · ${modules}×${modules} modules` : "—";
    specId.textContent = manifest.transferId;
    specPass.textContent = formatDuration(passSeconds);
    specRate.textContent = `${(
      (manifest.payload.chunkSize * fps * manifest.payload.chunkCount) /
      Math.max(1, frames + beacons) /
      1024
    ).toFixed(1)} KB/s`;
    specPayload.textContent = `${formatBytes(manifest.payload.size)} (${manifest.payload.chunkSize} B × ${manifest.payload.chunkCount})`;
    transformPill.textContent = transformText(manifest.payload.compression, manifest.payload.encryption);
    settingsSummary.textContent = `${manifest.payload.chunkSize} B · ${manifest.display.fps} fps${version ? ` · QR v${version}` : ""}`;

    const maxBytes = maxChunkBytes();
    const longPass =
      passSeconds > 900
        ? ` One pass takes about ${formatDuration(passSeconds)} — this is a large transfer for an optical link.`
        : "";

    settingsHint.textContent =
      manifest.payload.chunkSize > maxBytes
        ? `Chunk size is capped at ${maxBytes} B for ${settings.ecc} error correction.${longPass}`
        : settings.grid > 1
          ? `${settings.grid} QR codes are shown per frame; the camera must resolve all of them at once.${longPass}`
          : `Larger chunks mean bigger QR codes; smaller chunks at a higher frame rate usually scan better.${longPass}`;
  }

  function setStatus(text: string, tone: StatusTone): void {
    statusText.textContent = text;
    statusEl.dataset.tone = tone;
  }

  function updateTransport(): void {
    const hasBundle = !!state.bundle;
    startButton.disabled = !hasBundle || state.running || state.preparing;
    pauseButton.disabled = !state.running;
    stopButton.disabled = !hasBundle;
    manifestButton.disabled = !hasBundle || state.running;
    stepButton.disabled = !hasBundle || state.running;
    fullscreenButton.disabled = !hasBundle;
  }

  // ---------------------------------------------------------------- events

  root.querySelectorAll<HTMLButtonElement>(".segment").forEach((button) => {
    button.addEventListener("click", () => setSourceKind(button.dataset.source as SourceKind));
  });

  fileInput.addEventListener("change", () => {
    state.file = fileInput.files?.[0] ?? null;
    state.fileBytes = null;
    renderFileSelection();
    schedulePrepare(0);
  });

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("is-dragging");
  });

  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      return;
    }
    state.file = file;
    state.fileBytes = null;
    renderFileSelection();
    schedulePrepare(0);
  });

  textInput.addEventListener("input", () => schedulePrepare(400));

  demoLinesInput.addEventListener("change", () => schedulePrepare(0));

  presetSelect.addEventListener("change", () => {
    applyPreset(presetSelect.value as PresetName);
    schedulePrepare(0);
  });

  chunkSizeInput.addEventListener("change", () => {
    markCustom();
    schedulePrepare(0);
  });

  fpsSelect.addEventListener("change", () => {
    markCustom();
    schedulePrepare(0);
  });

  repairSelect.addEventListener("change", () => schedulePrepare(0));
  eccSelect.addEventListener("change", () => {
    const limit = maxChunkBytes();
    if (Number(chunkSizeInput.value) > limit) {
      chunkSizeInput.value = String(limit);
    }
    schedulePrepare(0);
  });
  compressionSelect.addEventListener("change", () => schedulePrepare(0));
  gridSelect.addEventListener("change", () => schedulePrepare(0));
  beaconSelect.addEventListener("change", () => schedulePrepare(0));
  loopToggle.addEventListener("change", () => schedulePrepare(0));

  encryptToggle.addEventListener("change", () => {
    show(passphraseRow, encryptToggle.checked);
    if (encryptToggle.checked && !passphraseInput.value) {
      passphraseInput.focus();
    }
    schedulePrepare(0);
  });

  passphraseInput.addEventListener("change", () => schedulePrepare(0));

  generateButton.addEventListener("click", () => {
    passphraseInput.value = generatePassphrase(5);
    schedulePrepare(0);
  });

  startButton.addEventListener("click", start);
  pauseButton.addEventListener("click", pause);
  stopButton.addEventListener("click", stop);
  manifestButton.addEventListener("click", () => {
    stopLoop();
    showManifest();
    setStatus("Manifest", "ready");
    updateTransport();
  });
  stepButton.addEventListener("click", step);
  fullscreenButton.addEventListener("click", () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    stage.requestFullscreen?.().catch(() => undefined);
  });

  const onFullscreenChange = (): void => {
    stage.classList.toggle("is-present", document.fullscreenElement === stage);
    if (!state.running && state.bundle) {
      showManifest();
    }
  };

  document.addEventListener("fullscreenchange", onFullscreenChange);

  let isActive = true;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target) || !isActive) {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      if (state.running) {
        pause();
      } else {
        start();
      }
    } else if (event.code === "ArrowRight") {
      event.preventDefault();
      step();
    } else if (event.key.toLowerCase() === "f") {
      fullscreenButton.click();
    } else if (event.key.toLowerCase() === "m") {
      manifestButton.click();
    }
  };

  document.addEventListener("keydown", onKeyDown);

  renderFileSelection();
  show(passphraseRow, false);
  updateTransport();
  void prepare();

  return {
    setActive(active: boolean): void {
      isActive = active;
      if (!active && state.running) {
        pause();
      }
    },
    dispose(): void {
      stopLoop();
      if (prepareTimer !== null) {
        window.clearTimeout(prepareTimer);
      }
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      void releaseWakeLock();
    }
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function transformText(compression: string, encryption: string): string {
  const parts = [compression, encryption].filter((part) => part !== "none");
  return parts.length > 0 ? parts.join(" + ") : "none";
}

