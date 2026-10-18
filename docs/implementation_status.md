# Implementation status (v0.2.0)

Tracked against `docs/qr_optical_transfer_requirements.md`.

## Sender requirements

| ID | Requirement | Status |
| --- | --- | --- |
| S-01 | File via drag & drop or picker | Done |
| S-02 | File name, size, MIME | Done |
| S-03 | SHA-256 of the source | Done (`src/core/crypto.ts`) |
| S-04 | Optional gzip | Done, with `auto` (compress only if smaller) |
| S-05 | Optional passphrase encryption | Done, AES-256-GCM + PBKDF2-SHA256 (250k) |
| S-06 | Manifest QR | Done, as a repeating beacon |
| S-07 | Chunking by size | Done, plus repair chunks |
| S-08 | Continuous display at a chosen FPS | Done, drift-compensated scheduling |
| S-09 | Pause / resume / stop | Done (+ single-step, manifest hold) |
| S-10 | Change display speed | Done |
| S-11 | Loop after the last chunk | Done (can be disabled) |
| S-12 | Current chunk and progress display | Done (+ pass counter, QR version, pass duration) |

Additional sender features: text source, built-in demo, presets, ECC level,
repair percentage, multi-QR frames (1 / 4 / 9), fullscreen presenter mode,
keyboard shortcuts, screen wake lock.

## Receiver requirements

| ID | Requirement | Status |
| --- | --- | --- |
| R-01 | Start the camera | Done (device picker, environment-facing preference) |
| R-02 | Detect QR codes in the video | Done (`BarcodeDetector`, jsQR fallback) |
| R-03 | Recognise the manifest | Done (repeating beacons) |
| R-04 | Show file info and confirm receipt | Done (auto-accept by default, optional manual accept) |
| R-05 | Continuously read data QRs | Done |
| R-06 | Ignore QR codes with another transfer id | Done, counted as foreign frames |
| R-07 | Manage chunks by sequence number | Done |
| R-08 | Drop duplicates | Done, counted in the diagnostics |
| R-09 | Show missing chunk count | Done (count, ranges, heat map, ETA) |
| R-10 | Join all chunks | Done |
| R-11 | SHA-256 verification | Done |
| R-12 | Decrypt if needed | Done, retryable without rescanning |
| R-13 | Decompress if needed | Done |
| R-14 | Download the finished file | Done (sanitised filename) |

Additional receiver features: repair-based reconstruction, CRC validation per
frame, pending-transfer prompt instead of progress loss, text preview, activity
log, scan diagnostics, wake lock, unload guard.

## Non-functional

| Area | Status |
| --- | --- |
| Compatibility | Chromium `BarcodeDetector` path + jsQR fallback for Safari/Firefox |
| Offline | Service worker: network-first shell, cache-first hashed assets |
| Transfer speed | ~4.7 KB/s at 600 B × 8 fps before loss (optional 2×2/3×3 multi-QR) |
| File size | Practical range a few MB; the UI shows pass duration and throughput |
| Reliability | Interleaving + 12% repair frames + looping |
| Safety | Passphrase never sent in a QR code; AES-GCM + PBKDF2 |
| Usability | Sender start is manual; receiver is automatic by default |
| Visibility | White stage, black modules, quiet zone, fullscreen presenter |

## Verified by `npm test`

* `protocol-smoke`: frame grammar, CRC-32 rejection, chunk/restore roundtrip for
  demo, binary, empty and 1-byte payloads, gzip + AES-GCM with a wrong and a
  right passphrase, unicode file names, manifest validation, interleaved
  schedule coverage, beacon ticks, `auto` compression decision.
* `repair-smoke`: solver recovers 1, 2, 5 and 8 erasures with 12-16 repair
  frames; refuses to invent data when repairs are insufficient; full channel
  simulation at 95/85/70% capture shows fewer passes with repairs than without;
  burst loss completes using repaired chunks.
* `qr-smoke`: real frames render and decode through jsQR (data, repair,
  manifest, unicode manifest, 900-byte chunk), and decode back into QROPT/2
  frames.
* `receiver-smoke`: awaiting-accept gating, auto-accept, foreign ids,
  out-of-range sequences, duplicates, re-sent manifest does not wipe data,
  pending manifest switch/dismiss, repair-based completion (including a
  repaired short tail chunk), encrypted retry, reset.
* `ui-smoke`: mounts the actual views in linkedom, prepares the demo transfer,
  drives start/pause/step/preset changes, feeds a real transfer into the
  receiver via the `qropt:frame` automation hook, and verifies completion,
  preview, download state, reset and the encrypted unlock retry.

## Physical verification checklist (needs two real devices)

- Windows browser screen → Mac camera in real lighting.
- Camera focus/exposure behaviour at 3 / 5 / 8 / 10 fps and chunk sizes
  300 / 600 / 900.
- Practical reliability of 4-up and 9-up multi-QR frames on the target camera.
- Repair benefit on a real channel with glare/refresh artefacts.
- Long-running scan sessions (battery, thermal throttling, wake lock behaviour).
- Offline/PWA behaviour after the first load on the target browsers.
- iOS Safari camera behaviour (jsQR fallback path).

## Deferred

- Adaptive rate control (needs a back channel).
- Multi-file packaging (zip before transfer).
- Fountain codes beyond the current XOR repair scheme, or GF(256) parity.
- Binary QR transport (would need every receiver to expose raw bytes).
