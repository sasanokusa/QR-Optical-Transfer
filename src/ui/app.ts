import { createReceiverView } from "./receiver-view.ts";
import { createSenderView } from "./sender-view.ts";

type Mode = "sender" | "receiver";

const TEMPLATE = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 2h7v7H2zM15 2h7v7h-7zM2 15h7v7H2zM16 16h2v2h-2zM18 18h4v4h-4zM12 12h3v3h-3z" fill="currentColor"/>
        </svg>
        <div>
          <h1>QR Optical Transfer</h1>
          <p class="tagline">Screen to camera file transfer — no network, no pairing.</p>
        </div>
      </div>
      <div class="mode-switch" role="tablist" aria-label="Transfer mode">
        <button class="mode-button is-active" data-mode="sender" role="tab" aria-selected="true" type="button">Send</button>
        <button class="mode-button" data-mode="receiver" role="tab" aria-selected="false" type="button">Receive</button>
      </div>
    </header>

    <main>
      <section class="panel" id="sender-panel" data-panel="sender">
        <div class="panel-head">
          <div>
            <h2>Transmit</h2>
            <p class="subtle" id="sender-subtle">Pick a file, then start the frame loop.</p>
          </div>
          <span class="pill" id="sender-status"><span class="dot"></span><span id="sender-status-text">Booting</span></span>
        </div>

        <div class="workspace">
          <div class="stage" id="qr-stage">
            <div class="stage-surface">
              <div class="qr-grid" id="qr-grid" aria-label="QR output"></div>
              <div class="stage-empty" id="qr-empty">Preparing…</div>
            </div>
            <div class="stage-bar">
              <div class="stage-readout">
                <strong id="sender-frame-label">Manifest</strong>
                <span id="sender-pass-label">pass 1 · frame 0 / 0</span>
              </div>
              <progress id="sender-progress" value="0" max="1"></progress>
              <div class="transport">
                <button id="sender-start" class="btn btn-primary" type="button">Start</button>
                <button id="sender-pause" class="btn" type="button">Pause</button>
                <button id="sender-stop" class="btn" type="button">Stop</button>
                <button id="sender-manifest" class="btn" type="button">Manifest</button>
                <button id="sender-step" class="btn" type="button">Step</button>
                <button id="sender-fullscreen" class="btn" type="button">Fullscreen</button>
              </div>
            </div>
          </div>

          <aside class="inspector">
            <section class="card">
              <div class="card-head">
                <h3>Source</h3>
                <div class="segmented" role="tablist" aria-label="Source">
                  <button type="button" class="segment is-active" data-source="file">File</button>
                  <button type="button" class="segment" data-source="text">Text</button>
                  <button type="button" class="segment" data-source="demo">Demo</button>
                </div>
              </div>

              <div id="source-file">
                <label class="dropzone" id="dropzone">
                  <input id="file-input" type="file" />
                  <span class="dropzone-icon" aria-hidden="true">⇪</span>
                  <span class="dropzone-text">
                    <strong id="dropzone-title">Choose a file or drop it here</strong>
                    <small id="dropzone-detail">Anything up to a few MB works. Nothing leaves this device.</small>
                  </span>
                </label>
              </div>

              <div id="source-text" hidden>
                <label class="field">Text to send
                  <textarea id="text-input" rows="6" placeholder="Paste a snippet, a config, a key…"></textarea>
                </label>
              </div>

              <div id="source-demo" hidden>
                <label class="field">Hello World lines (≈ chunk count)
                  <input id="demo-lines" type="number" min="10" max="400" step="10" value="100" />
                </label>
                <p class="hint">A built-in sample for checking that the optical link works. It is split into roughly one chunk per line, so the demo uses a small chunk size.</p>
              </div>
            </section>

            <section class="card">
              <div class="card-head"><h3>Transfer</h3><span class="pill subtle" id="transform-pill">none</span></div>
              <dl class="specs">
                <div><dt>File</dt><dd id="spec-name">—</dd></div>
                <div><dt>Size</dt><dd id="spec-size">—</dd></div>
                <div><dt>Frames</dt><dd id="spec-frames">—</dd></div>
                <div><dt>QR</dt><dd id="spec-qr">—</dd></div>
                <div><dt>Transfer ID</dt><dd id="spec-id">—</dd></div>
                <div><dt>Pass time</dt><dd id="spec-pass">—</dd></div>
                <div><dt>Throughput</dt><dd id="spec-rate">—</dd></div>
                <div><dt>Payload</dt><dd id="spec-payload">—</dd></div>
              </dl>
            </section>

            <details class="card settings" id="sender-settings">
              <summary>
                <span>Settings</span>
                <span class="pill subtle" id="settings-summary">—</span>
              </summary>
              <div class="settings-grid">
                <label class="field">Preset
                  <select id="preset-select">
                    <option value="reliable">Reliable — small QR, 10 fps</option>
                    <option value="balanced" selected>Balanced — 600 B, 8 fps</option>
                    <option value="dense">Dense — big QR, 5 fps</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                <label class="field">Chunk size (bytes)
                  <input id="chunk-size" type="number" min="32" max="2200" step="50" value="600" />
                </label>
                <label class="field">Frames per second
                  <select id="fps-select">
                    <option value="2">2 fps</option>
                    <option value="3">3 fps</option>
                    <option value="5">5 fps</option>
                    <option value="8" selected>8 fps</option>
                    <option value="10">10 fps</option>
                    <option value="15">15 fps</option>
                    <option value="20">20 fps</option>
                  </select>
                </label>
                <label class="field">Repair frames
                  <select id="repair-select">
                    <option value="0">0 % (fastest, least robust)</option>
                    <option value="8">8 %</option>
                    <option value="12" selected>12 %</option>
                    <option value="20">20 %</option>
                    <option value="30">30 %</option>
                  </select>
                </label>
                <label class="field">Error correction
                  <select id="ecc-select">
                    <option value="L">L — 7 %</option>
                    <option value="M" selected>M — 15 %</option>
                    <option value="Q">Q — 25 %</option>
                    <option value="H">H — 30 %</option>
                  </select>
                </label>
                <label class="field">Compression
                  <select id="compression-select">
                    <option value="auto" selected>Auto (gzip if smaller)</option>
                    <option value="none">Off</option>
                    <option value="gzip">Always gzip</option>
                  </select>
                </label>
                <label class="field">QR per frame
                  <select id="grid-select">
                    <option value="1" selected>1 (single)</option>
                    <option value="4">4 (2×2)</option>
                    <option value="9">9 (3×3)</option>
                  </select>
                </label>
                <label class="field">Manifest beacon
                  <select id="beacon-select">
                    <option value="0.5">Every 0.5 s</option>
                    <option value="2">Every 2 s</option>
                    <option value="3" selected>Every 3 s</option>
                    <option value="5">Every 5 s</option>
                  </select>
                </label>
                <label class="toggle"><input id="loop-toggle" type="checkbox" checked /> Loop frames</label>
                <label class="toggle"><input id="encrypt-toggle" type="checkbox" /> Encrypt (AES-GCM)</label>
                <label class="field passphrase" id="passphrase-row" hidden>Passphrase
                  <span class="inline">
                    <input id="sender-passphrase" type="password" autocomplete="new-password" placeholder="Share it out of band" />
                    <button id="generate-passphrase" class="btn btn-small" type="button">Generate</button>
                  </span>
                </label>
              </div>
              <p class="hint" id="settings-hint"></p>
            </details>
          </aside>
        </div>
      </section>

      <section class="panel is-hidden" id="receiver-panel" data-panel="receiver">
        <div class="panel-head">
          <div>
            <h2>Receive</h2>
            <p class="subtle" id="receiver-subtle">Point the camera at the sender's screen and let it scan.</p>
          </div>
          <span class="pill" id="receiver-status"><span class="dot"></span><span id="receiver-status-text">Camera off</span></span>
        </div>

        <div class="workspace">
          <div class="stage video-stage" id="receiver-stage">
            <video id="camera-video" playsinline muted></video>
            <canvas id="scan-canvas"></canvas>
            <div class="stage-empty" id="camera-empty">
              <span class="empty-icon" aria-hidden="true">◎</span>
              <p>Camera is off</p>
              <span class="hint">Grant camera access, then aim at the sender's QR code.</span>
            </div>
            <div class="scan-hint" id="scan-hint" hidden></div>
            <div class="stage-bar">
              <div class="stage-readout">
                <strong id="receiver-hint">Waiting</strong>
                <span id="receiver-hint-detail">No transfer yet</span>
              </div>
              <div class="transport">
                <select id="camera-select" class="btn select" aria-label="Camera"></select>
                <button id="receiver-start" class="btn btn-primary" type="button">Start camera</button>
                <button id="receiver-stop" class="btn" type="button">Stop camera</button>
              </div>
            </div>
          </div>

          <aside class="inspector">
            <section class="card">
              <div class="card-head">
                <h3>Transfer</h3>
                <span class="pill subtle" id="receiver-state">Idle</span>
              </div>
              <dl class="specs">
                <div><dt>File</dt><dd id="receiver-file">No manifest yet</dd></div>
                <div><dt>Size</dt><dd id="receiver-size">—</dd></div>
                <div><dt>Frames</dt><dd id="receiver-frames">—</dd></div>
                <div><dt>Transform</dt><dd id="receiver-transform">—</dd></div>
                <div><dt>Transfer ID</dt><dd id="receiver-id">—</dd></div>
              </dl>

              <div class="progress-line">
                <progress id="receiver-progress" value="0" max="1"></progress>
                <span id="receiver-percent">0 %</span>
              </div>
              <p class="hint" id="receiver-missing">Waiting for a manifest QR…</p>
              <canvas id="chunk-map" class="chunk-map" width="640" height="96"></canvas>

              <label class="toggle" id="auto-accept-row">
                <input id="receiver-auto" type="checkbox" checked /> Accept transfers automatically
              </label>

              <label class="field passphrase" id="receiver-passphrase-row" hidden>Passphrase
                <input id="receiver-passphrase" type="password" autocomplete="current-password" placeholder="Required to decrypt this transfer" />
              </label>

              <div class="button-row">
                <button id="receiver-accept" class="btn btn-primary" type="button" hidden>Accept transfer</button>
                <button id="receiver-retry" class="btn" type="button" hidden>Unlock / retry</button>
                <button id="receiver-download" class="btn btn-primary" type="button" disabled>Save file</button>
                <button id="receiver-reset" class="btn" type="button">Reset</button>
              </div>

              <div class="notice" id="pending-notice" hidden>
                <span>Another transfer is on screen: <strong id="pending-name">—</strong></span>
                <span class="notice-actions">
                  <button id="pending-switch" class="btn btn-small" type="button">Switch</button>
                  <button id="pending-dismiss" class="btn btn-small" type="button">Keep this</button>
                </span>
              </div>

              <textarea id="restored-preview" class="preview" readonly hidden></textarea>
            </section>

            <section class="card">
              <div class="card-head"><h3>Scanner</h3></div>
              <dl class="specs compact">
                <div><dt>Decoder</dt><dd id="scan-decoder">—</dd></div>
                <div><dt>Resolution</dt><dd id="scan-resolution">—</dd></div>
                <div><dt>Scan rate</dt><dd id="scan-rate">—</dd></div>
                <div><dt>Frames scanned</dt><dd id="scan-frames">0</dd></div>
                <div><dt>Duplicates</dt><dd id="scan-duplicates">0</dd></div>
                <div><dt>Dropped</dt><dd id="scan-dropped">0</dd></div>
              </dl>
            </section>

            <details class="card">
              <summary><span>Activity</span></summary>
              <div class="log" id="receiver-log" aria-live="polite"></div>
            </details>
          </aside>
        </div>
      </section>
    </main>

    <footer class="footer">
      <span>QROPT/2 · all encoding and decoding happens in this tab</span>
      <span id="footer-note">Camera access needs HTTPS or localhost.</span>
    </footer>
  </div>
`;

export function mountApp(root: HTMLElement): void {
  root.innerHTML = TEMPLATE;

  const sender = createSenderView(root);
  const receiver = createReceiverView(root);

  const setMode = (mode: Mode): void => {
    root.querySelectorAll<HTMLButtonElement>(".mode-button").forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });

    root.querySelectorAll<HTMLElement>(".panel").forEach((panel) => {
      panel.classList.toggle("is-hidden", panel.dataset.panel !== mode);
    });

    sender.setActive(mode === "sender");
    receiver.setActive(mode === "receiver");
  };

  root.querySelectorAll<HTMLButtonElement>(".mode-button").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode as Mode));
  });

  setMode("sender");

  window.addEventListener("pagehide", () => {
    sender.dispose();
    receiver.dispose();
  });
}
