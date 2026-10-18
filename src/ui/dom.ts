export function byId<T extends HTMLElement>(id: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(`#${id}`);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  if (seconds < 1) {
    return "<1s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  }
  return `${Math.floor(seconds / 3600)}h ${String(Math.round((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

export function formatRate(chunksPerSecond: number): string {
  if (!Number.isFinite(chunksPerSecond) || chunksPerSecond <= 0) {
    return "—";
  }
  return `${chunksPerSecond.toFixed(1)} chunks/s`;
}

export function downloadBytes(bytes: Uint8Array, name: string, mime: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeFileName(name);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Safari aborts the download if the object URL is revoked synchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : "transfer.bin";
}

export function show(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
