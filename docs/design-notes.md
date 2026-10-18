# Redesign notes (v0.2)

This document records why the app was rebuilt the way it is. The original
requirements (`docs/qr_optical_transfer_requirements.md`) are still the spec for
*what* the app does; this is about *how* it does it now.

## What changed at a glance

| Area | v0.1 | v0.2 |
| --- | --- | --- |
| Chunk frame | JSON, 94 chars of envelope for a 900 B chunk | Compact ASCII envelope, 16–20 chars (`docs/protocol.md`) |
| Frame integrity | Whole-file SHA-256 only | CRC-32 per frame, checked before storing |
| Loss recovery | Loop everything, hope the tail is short | Interleaved order + XOR repair frames solved by GF(2) elimination |
| Manifest delivery | Shown once when the sender prepares | Repeated beacon every 3 s, receiver can join any time |
| QR rendering | `QRCode.toCanvas` re-encoded the symbol every frame | Frames encoded once into module-resolution canvases and blitted with integer scaling |
| Receiver flow | Manual accept, and a new manifest silently wiped progress | Auto-accept, pending-transfer prompt instead of data loss, unlock/retry without rescanning |
| Progress | Missing count + ranges | Progress bar, missing ranges, recovered-chunk count, ETA, per-chunk heat map |
| Code layout | ~1300-line `main.ts` mixed UI and protocol | `src/core` (pure, testable), `src/io` (browser integration), `src/ui` (views) |
| Offline | Network-first service worker | Network-first shell + cache-first hashed assets |
| Extras | — | Wake lock, beforeunload guard, keyboard shortcuts, text source, QR presets |

## 1. Protocol overhead

The old chunk packet looked like this:

```json
{"proto":"QROPT/1","type":"chunk","transferId":"8f4c2a9d7b1e","seq":42,"total":1372,"data":"…"}
```

For a 900-byte chunk that is 1294 characters, of which 1200 are the base64
payload and 94 are JSON envelope. The new frame for the same payload is 1217
characters (16 characters of envelope), so the QR symbol shrinks from version 30
(137×137 modules) to version 29 (133×133) and payload density rises from 69.6%
to 74.0%. At 400 bytes the drop is version 20 (97
modules) → version 18 (89 modules), which matters a lot for camera decoding.

The bigger win of the compact frame is that it leaves room for a CRC-32 without
making symbols larger, and it makes the per-frame cost of repair chunks small.

Base64 itself is a 33% tax and is kept on purpose: browsers hand QR payloads to
JavaScript as strings, so raw binary is not safe with `BarcodeDetector`
(`jsQR` does expose `binaryData`, but not every receiver is Chrome). An
alphanumeric-mode code (base45) would be about 9% smaller in theory *per QR
module*, but it only applies when the entire frame stays inside the 45-symbol
alphanumeric alphabet, which lower-case base64url does not.

## 2. Recovery: the coupon collector is the real enemy

With a lossless channel, looping is fine. Real optics are not lossless. At 85%
per-frame capture probability over 400 chunks, the expected number of passes
just to catch the last stragglers is ~2.2; the last chunk alone can cost a whole
extra pass.

Repair chunks turn that tail into linear algebra. Measured on a deterministic
channel simulation of the real schedule (`scripts/repair-smoke.mjs`):

| Per-frame capture | Passes without repair | Passes with 12% repair |
| --- | --- | --- |
| 95% | 1.59 | 0.98 |
| 85% | 2.19 | 1.27 |
| 70% | 2.84 | 1.75 |

"0.98 passes" means the transfer finished inside its first pass because the
repair frames filled the gaps. The repair masks are dense, so a repair frame is
useful even when only a couple of chunks are missing - which is exactly the case
that used to be slow.

A dense random GF(2) system is not guaranteed to have full rank for a given
missing set. When it does not, the receiver keeps scanning; it is a delay, not a
dead end. The alternative, an MDS code over GF(2), does not exist for more than
one parity symbol, and GF(256) arithmetic would cost far more code and CPU for
the same practical benefit.

## 3. The manifest had to become a beacon

The previous design displayed the manifest once, when the sender pressed
"Prepare", and then streamed chunks forever. A receiver that had not been
pointed at the screen in that exact second could never start: the manifest was
gone and every chunk was rejected as "wrong transfer id".

Now the schedule interleaves a manifest beacon every 3 seconds. With a single QR
that costs one frame slot per beacon (a few percent of throughput); with 2×2 or
3×3 frames it costs nothing because the manifest occupies one cell while the
others keep streaming.

## 4. Rendering: encode once, blit forever

`QRCode.toCanvas` runs the whole encoder (segmentation, Reed-Solomon, mask
selection) on every painted frame. The new renderer keeps a small LRU of
module-resolution canvases and blits them into the visible canvas with nearest
neighbour scaling, so one QR module always lands on an integer number of device
pixels.

This made higher frame rates and multi-QR layouts practical, and it means the
sender can show 9 QRs per tick without the encoder becoming the bottleneck.

## 5. Receiver UX

The old receiver silently reset its state whenever it saw a new manifest. On a
desk with two senders, or when the sender re-prepares, that is data loss with no
warning. Now:

* a manifest for another transfer is offered as "Switch / Keep this",
* unencrypted transfers are accepted automatically (auto-accept can be turned
  off in the UI),
* an encrypted transfer can be unlocked and retried after a wrong passphrase
  without rescanning anything,
* the chunk heat map makes it obvious whether the camera is seeing the screen
  (green), the repairs are working (teal), or a whole region is being missed,
* the scanner reports which decoder is in use, the camera resolution, the scan
  rate, duplicates and CRC drops.

## 6. Structure and tests

```
src/core   protocol, crypto, repair math, transfer building, receiver session
src/io     QR rendering, camera scanning, wake lock
src/ui     app shell, sender view, receiver view, DOM helpers
```

`src/core` has no DOM dependencies, so the tests run in Node with
`--experimental-strip-types` and cover the parts where bugs are expensive:
frame encoding, CRC rejection, chunking/restore, encryption, the session state
machine, and the repair solver under simulated loss.

## Limits and non-goals

* **Throughput is capped by the optical channel.** A 600-byte chunk at 8 fps is
  ~4.7 KB/s before losses; that is the nature of QR-to-camera links.
* **Practical file size is a few MB.** With 600-byte chunks, 5 MB is ~8738 data
  frames plus 12% repair = ~9787 frames, i.e. ~33 minutes per pass at 5 fps or
  ~20 minutes at 8 fps. The UI shows the pass time so the trade-off is visible
  before starting.
* **No ACK, no adaptive rate.** The sender cannot react to the receiver's
  quality. Presets and ECC levels are the manual answer.
* **One file per transfer.** Multi-file transfers should be zipped first.
* **No authenticity for unencrypted transfers.** SHA-256 detects corruption, not
  a malicious sender. Use the AES-GCM option when the source matters.
* **The passphrase still has to travel out of band.** Never in the manifest.
