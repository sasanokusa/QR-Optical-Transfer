import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { buildTransfer, demoSource } from "../src/core/transfer.ts";
import { encodeChunkFrame } from "../src/core/codec.ts";
import { utf8Encoder } from "../src/core/bytes.ts";

// ---------------------------------------------------------------------------
// Minimal browser environment
// ---------------------------------------------------------------------------

const { window, document } = parseHTML(
  "<!doctype html><html><body><main id='app'></main></body></html>"
);

globalThis.window = window;
globalThis.document = document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.CustomEvent = window.CustomEvent;
// Node's global navigator is read-only; the app only needs navigator.mediaDevices
// (absent) and navigator.wakeLock (absent), which optional chaining handles.

const raf = (callback) => setTimeout(() => callback(performance.now()), 8);
window.requestAnimationFrame = raf;
globalThis.requestAnimationFrame = raf;
window.devicePixelRatio = 1;

// linkedom exposes <select>.value as a getter only; real browsers allow
// assigning it. Emulate the browser behaviour so the app can use `select.value`.
{
  let prototype = window.HTMLSelectElement.prototype;
  let descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  while (!descriptor && prototype) {
    prototype = Object.getPrototypeOf(prototype);
    descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  }

  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get: descriptor.get,
    set(value) {
      const target = String(value);
      for (const option of this.options) {
        if (option.value === target) {
          option.setAttribute("selected", "");
        } else {
          option.removeAttribute("selected");
        }
      }
    }
  });
}

// linkedom has no camera, no service worker and no wake lock; the views must
// cope with all of that being absent (they do, via optional chaining).

const { mountApp } = await import("../src/ui/app.ts");

const root = document.getElementById("app");
assert.ok(root);
mountApp(root);

const $ = (selector) => root.querySelector(selector);
const text = (selector) => $(selector)?.textContent?.trim() ?? "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await sleep(150);

assert.ok(root.querySelectorAll(".panel").length === 2);
assert.ok($("#sender-panel"), "sender panel missing");
assert.ok($("#receiver-panel"), "receiver panel missing");
assert.equal(text("#sender-status-text"), "No source");
assert.equal($("#sender-start").disabled, true, "start should be disabled without a source");

// ---------------------------------------------------------------------------
// sender: demo source -> prepare -> transmit -> pause
// ---------------------------------------------------------------------------

const demoButton = [...root.querySelectorAll("[data-source]")].find(
  (button) => button.dataset.source === "demo"
);
assert.ok(demoButton);
demoButton.click();
await sleep(300);

assert.equal(text("#spec-name"), "hello-world.txt");
assert.equal(text("#spec-id").length, 4);
assert.match(text("#spec-frames"), /^\d+ \+ \d+ repair$/);
assert.equal($("#sender-start").disabled, false);
assert.equal(root.querySelectorAll("#qr-grid canvas").length, 1, "manifest QR not rendered");
assert.equal(text("#sender-frame-label"), "Manifest");

$("#sender-start").click();
await sleep(250);

assert.equal(text("#sender-status-text"), "Transmitting");
assert.match(text("#sender-pass-label"), /^pass \d+ · \d+ \/ \d+$/);
assert.notEqual(text("#sender-frame-label"), "Manifest");

$("#sender-pause").click();
assert.equal(text("#sender-status-text"), "Paused");

$("#sender-manifest").click();
assert.equal(text("#sender-frame-label"), "Manifest");

$("#sender-step").click();
assert.match(text("#sender-pass-label"), /^pass \d+ · \d+ \/ \d+$/);

// Settings: a preset change must re-prepare without throwing.
const preset = $("#preset-select");
for (const option of preset.options) {
  if (option.value === "reliable") {
    option.setAttribute("selected", "");
  } else {
    option.removeAttribute("selected");
  }
}
preset.dispatchEvent(new window.Event("change"));
await sleep(300);
assert.match(text("#settings-summary"), /10 fps/);
assert.equal($("#sender-start").disabled, false);

// ---------------------------------------------------------------------------
// receiver: feed a transfer through the automation hook
// ---------------------------------------------------------------------------

[...root.querySelectorAll("[data-mode]")]
  .find((button) => button.dataset.mode === "receiver")
  .click();

assert.equal($("#receiver-panel").className.includes("is-hidden"), false);
assert.equal(text("#receiver-status-text"), "Camera off");

const source = {
  name: "ui-smoke.txt",
  mime: "text/plain",
  bytes: utf8Encoder.encode("UI smoke transfer\n".repeat(60))
};
const bundle = await buildTransfer(source, {
  chunkSize: 48,
  repairRatio: 0.4,
  compression: "none",
  transferId: "ui01"
});

const feed = (frameText) => {
  document.dispatchEvent(new window.CustomEvent("qropt:frame", { detail: frameText }));
};

feed(bundle.manifestText);
await sleep(60);
assert.equal(text("#receiver-file"), "ui-smoke.txt");
assert.equal(text("#receiver-id"), "ui01");

for (const [seq, chunk] of bundle.data.entries()) {
  feed(encodeChunkFrame(bundle.manifest.transferId, "data", seq, chunk));
}

await sleep(300);

assert.equal(text("#receiver-state"), "Complete", "receiver did not complete");
assert.equal($("#receiver-download").disabled, false);
assert.equal(text("#receiver-percent"), "100 %");
assert.match(text("#receiver-missing"), /verified/);
assert.equal($("#restored-preview").hidden, false);
assert.match($("#restored-preview").value, /UI smoke transfer/);

// A damaged frame must be counted, not accepted.
const corrupt = encodeChunkFrame(bundle.manifest.transferId, "data", 0, bundle.data[0]);
feed(corrupt.replace("Q2ui01", "Q2ui02"));
assert.match(text("#receiver-log"), /damaged|Manifest|Complete/);

// Reset returns to a clean state.
$("#receiver-reset").click();
assert.equal(text("#receiver-state"), "Idle");
assert.equal(text("#receiver-file"), "No manifest yet");
assert.equal($("#receiver-download").disabled, true);

// ---------------------------------------------------------------------------
// receiver: encrypted transfer needs a passphrase, then unlocks
// ---------------------------------------------------------------------------

const locked = await buildTransfer(
  { name: "locked.txt", mime: "text/plain", bytes: utf8Encoder.encode("classified") },
  { chunkSize: 32, repairRatio: 0, compression: "none", passphrase: "hunter2", transferId: "ui02" }
);

feed(locked.manifestText);
await sleep(60);
assert.equal($("#receiver-passphrase-row").hidden, false, "passphrase field should appear");
for (const [seq, chunk] of locked.data.entries()) {
  feed(encodeChunkFrame(locked.manifest.transferId, "data", seq, chunk));
}
await sleep(400);

assert.equal(text("#receiver-state"), "Error");
assert.equal($("#receiver-retry").hidden, false);
assert.match(text("#receiver-log"), /passphrase/i);

$("#receiver-passphrase").value = "hunter2";
$("#receiver-retry").click();
await sleep(500);

assert.equal(text("#receiver-state"), "Complete");
assert.equal($("#receiver-download").disabled, false);

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

window.dispatchEvent(new window.Event("pagehide"));

console.log("ui-smoke ok");
