import jsQR from "jsqr";

/**
 * Camera QR scanner.
 *
 * Uses the native `BarcodeDetector` when available (Chrome/Edge, and Safari on
 * recent versions) because it decodes several QR codes per frame in optimized
 * native code. Falls back to jsQR on a downscaled canvas elsewhere.
 */

type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> };

type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
};

type BarcodeDetectorGlobal = { BarcodeDetector?: BarcodeDetectorConstructor };

export type DecoderKind = "native" | "jsqr";

export type ScanStatus = {
  running: boolean;
  decoder: DecoderKind | null;
  frameRate: number;
  frames: number;
  detections: number;
  resolution: string;
};

export type ScannerOptions = {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  onText: (text: string) => void;
  onStatus?: (status: ScanStatus) => void;
  onError?: (message: string) => void;
};

export type Scanner = {
  start(deviceId?: string): Promise<void>;
  stop(): void;
  isRunning(): boolean;
  status(): ScanStatus;
  refreshStatus(): void;
};

const NATIVE_CAP = { width: 1920, height: 1080 };
const FALLBACK_CAP = { width: 1280, height: 720 };
const FALLBACK_MAX_WIDTH = 1280;
const STATS_INTERVAL_MS = 500;

let detectorPromise: Promise<{ decoder: DecoderKind; detector: BarcodeDetectorLike | null }> | null =
  null;

export function createScanner(options: ScannerOptions): Scanner {
  const state: ScanStatus = {
    running: false,
    decoder: null,
    frameRate: 0,
    frames: 0,
    detections: 0,
    resolution: "-"
  };

  let stream: MediaStream | null = null;
  let frameHandle: number | null = null;
  let inFlight = false;
  let lastStatsAt = 0;
  let lastStatsFrames = 0;
  let detector: BarcodeDetectorLike | null = null;

  const emitStatus = (): void => {
    options.onStatus?.({ ...state });
  };

  async function ensureDecoder(): Promise<DecoderKind> {
    if (!detectorPromise) {
      detectorPromise = (async () => {
        const globalScope = window as unknown as BarcodeDetectorGlobal;

        if (!globalScope.BarcodeDetector) {
          return { decoder: "jsqr" as const, detector: null };
        }

        try {
          const formats = await globalScope.BarcodeDetector.getSupportedFormats();
          if (formats.includes("qr_code")) {
            return {
              decoder: "native" as const,
              detector: new globalScope.BarcodeDetector({ formats: ["qr_code"] })
            };
          }
        } catch {
          // Fall through to jsQR.
        }

        return { decoder: "jsqr" as const, detector: null };
      })();
    }

    const resolved = await detectorPromise;
    detector = resolved.detector;
    return resolved.decoder;
  }

  async function start(deviceId?: string): Promise<void> {
    if (state.running) {
      stop();
    }

    const decoder = await ensureDecoder();
    state.decoder = decoder;

    const cap = decoder === "native" ? NATIVE_CAP : FALLBACK_CAP;
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

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    } catch (error) {
      options.onError?.(error instanceof Error ? error.message : "Camera could not be started.");
      state.running = false;
      emitStatus();
      return;
    }

    options.video.srcObject = stream;
    options.video.muted = true;
    options.video.playsInline = true;

    try {
      await options.video.play();
    } catch {
      // Safari can reject play() until the stream has a frame; the loop still works.
    }

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    state.resolution =
      settings?.width && settings?.height
        ? `${settings.width}x${settings.height}${settings.frameRate ? ` @${Math.round(settings.frameRate)}fps` : ""}`
        : "-";

    state.running = true;
    state.frames = 0;
    state.detections = 0;
    state.frameRate = 0;
    lastStatsAt = performance.now();
    lastStatsFrames = 0;
    emitStatus();
    scheduleFrame();
  }

  function stop(): void {
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }

    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    options.video.srcObject = null;
    inFlight = false;
    state.running = false;
    state.frameRate = 0;
    state.resolution = "-";
    emitStatus();
  }

  function scheduleFrame(): void {
    frameHandle = requestAnimationFrame(() => {
      void scanFrame();
    });
  }

  async function scanFrame(): Promise<void> {
    if (!state.running) {
      return;
    }

    state.frames += 1;

    try {
      if (detector) {
        await scanWithDetector(detector);
      } else {
        scanWithJsQr();
      }
    } catch {
      // A single bad frame must never stop the scan loop.
    }

    updateStats();

    if (state.running) {
      scheduleFrame();
    }
  }

  async function scanWithDetector(active: BarcodeDetectorLike): Promise<void> {
    if (inFlight || !options.video.videoWidth) {
      return;
    }

    inFlight = true;
    try {
      const codes = await active.detect(options.video);
      if (!state.running || codes.length === 0) {
        return;
      }

      state.detections += codes.length;
      for (const code of codes) {
        if (code.rawValue) {
          options.onText(code.rawValue);
        }
      }
    } finally {
      inFlight = false;
    }
  }

  function scanWithJsQr(): void {
    const context = options.canvas.getContext("2d", { willReadFrequently: true });
    const video = options.video;

    if (!context || !video.videoWidth || !video.videoHeight) {
      return;
    }

    const scale = Math.min(1, FALLBACK_MAX_WIDTH / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);

    if (options.canvas.width !== width || options.canvas.height !== height) {
      options.canvas.width = width;
      options.canvas.height = height;
    }

    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const result = jsQR(image.data, width, height, { inversionAttempts: "dontInvert" });

    if (result?.data) {
      state.detections += 1;
      options.onText(result.data);
    }
  }

  function updateStats(): void {
    const now = performance.now();
    const elapsed = now - lastStatsAt;

    if (elapsed < STATS_INTERVAL_MS) {
      return;
    }

    const frames = state.frames - lastStatsFrames;
    state.frameRate = Math.round((frames / elapsed) * 1000);
    lastStatsAt = now;
    lastStatsFrames = state.frames;
    emitStatus();
  }

  return {
    start,
    stop,
    isRunning: () => state.running,
    status: () => ({ ...state }),
    refreshStatus: emitStatus
  };
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput");
  } catch {
    return [];
  }
}
