/**
 * Keep the screen awake while a transfer is running. Screens dimming mid
 * transfer is a real failure mode for a system that depends on a lit display.
 */
let sentinel: WakeLockSentinel | null = null;
let wanted = false;

export async function requestWakeLock(): Promise<void> {
  wanted = true;
  await acquire();
}

export async function releaseWakeLock(): Promise<void> {
  wanted = false;
  await sentinel?.release().catch(() => undefined);
  sentinel = null;
}

async function acquire(): Promise<void> {
  if (!wanted || sentinel || document.visibilityState !== "visible") {
    return;
  }

  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => {
      sentinel = null;
    });
  } catch {
    // Wake Lock is optional (unsupported / denied / low battery).
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (wanted && document.visibilityState === "visible") {
      void acquire();
    }
  });
}
