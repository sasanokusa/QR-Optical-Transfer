# QR Optical Transfer

Move a file between two devices with nothing but a screen and a camera: the
sender loops a series of QR codes, the receiver scans them and reconstructs the
file. No network, no pairing, no USB stick.

```
 Sender (any browser)                     Receiver (camera)
 ┌──────────────────────┐                 ┌──────────────────────┐
 │  Q2k3f9d7:…*1aty3ku  │  ── light ──▶   │  camera → decoder    │
 │  Q2k3f9d8:…*1z9k2p   │                 │  chunks + repairs    │
 │  manifest beacon …   │                 │  SHA-256 → file      │
 └──────────────────────┘                 └──────────────────────┘
```

Everything runs locally in the browser. The app is installable (PWA) and works
offline after the first load.

## What it does

* **Send** a file, a pasted snippet, or the built-in 100-line Hello World demo.
* **Manifest beacon** every few seconds, so a receiver can start scanning at any
  moment - not just in the second the transfer was prepared.
* **QROPT/2 framing**: compact ASCII chunk frames with a CRC-32, so a rare
  miscorrected QR is dropped instead of poisoning the file.
* **Self-healing transfer**: interleaved frame order plus XOR repair frames. The
  receiver solves a GF(2) system to rebuild frames the camera missed, instead of
  looping and hoping. Measured on a simulated 85%-capture channel: 2.2 passes
  without repairs → 1.3 passes with 12% repairs.
* **Verified restore**: optional gzip, optional AES-GCM (PBKDF2) with a
  passphrase that never appears in the QR codes, then SHA-256 verification.
* **Receiver comfort**: auto-accept, progress bar with ETA, missing-range list,
  per-chunk heat map, scan diagnostics, retry after a wrong passphrase without
  rescanning, and a "pending transfer" prompt instead of silently wiping
  progress.
* **Presenter mode**: fullscreen QR, keyboard shortcuts, screen wake lock.

## Run

```sh
npm install
npm run dev
```

Open the sender on the source machine, switch to **Receive** on the camera
machine. The Vite base path is `/sandbox/`, so the dev server lives at
<http://localhost:5173/sandbox/>. Camera access requires HTTPS, `localhost`, or
another browser-approved secure context (`npm run dev -- --host` on a phone will
not work over plain HTTP unless the browser allows it).

## Verify

```sh
npm test
```

This builds the app and runs five Node test suites:

| Script | Covers |
| --- | --- |
| `scripts/protocol-smoke.mjs` | byte/base64/CRC helpers, frame parse + CRC rejection, chunking, all-frames roundtrip, gzip, AES-GCM, unicode names, empty file, schedule/beacon properties |
| `scripts/repair-smoke.mjs` | repair solver unit cases, end-to-end loss simulation at 95/85/70% capture, burst loss |
| `scripts/qr-smoke.mjs` | renders real frames to images, decodes them with jsQR, re-parses the result |
| `scripts/receiver-smoke.mjs` | session state machine: auto/manual accept, foreign frames, duplicates, out-of-range, pending manifest, repair completion, encrypted retry, reset |
| `scripts/ui-smoke.mjs` | mounts the real UI in a DOM (linkedom), prepares the demo, starts/pauses/steps the sender, feeds a transfer into the receiver through the `qropt:frame` hook, checks completion, download and encrypted retry |

## Docs

* [`docs/protocol.md`](docs/protocol.md) - QROPT/2 wire format, repair math,
  scheduling, receiver algorithm.
* [`docs/design-notes.md`](docs/design-notes.md) - why the app is built this way,
  measured numbers, limits and non-goals.
* [`docs/implementation_status.md`](docs/implementation_status.md) - requirement
  coverage and the physical verification checklist.
* [`docs/qr_optical_transfer_requirements.md`](docs/qr_optical_transfer_requirements.md)
  - the original Japanese requirements.
