# QR Optical Transfer Implementation Status

This tracks the current implementation against
`docs/qr_optical_transfer_requirements.md`.

## Implemented

- Sender / Receiver mode switch
- File picker and drag-and-drop file input
- File name, size, MIME type, payload size, transform, transfer ID, progress, and loop display
- SHA-256 hashing with Web Crypto
- Optional gzip compression using `fflate`
- Optional AES-GCM encryption using Web Crypto and PBKDF2
- Manifest QR with metadata, file hash, compression, encryption, salt, IV, and KDF settings
- Data QR packets with `transferId`, `seq`, `total`, and base64url payload
- Configurable chunk size, QR size, FPS, and looping
- Start, pause, and stop sender controls
- Camera selection and `getUserMedia()` receiver startup
- QR scanning with `jsQR`
- Manifest recognition, transfer acceptance, transfer ID filtering, seq-based chunk storage, duplicate suppression, missing chunk count/ranges, scan diagnostics, hash verification, decompression, decryption, text preview, and download
- PWA manifest and Service Worker cache with network-first update behavior

## Verified

- `npm test` builds the app and runs protocol/QR smoke tests.
- `scripts/protocol-smoke.mjs` verifies:
  - Hello World 100 chunk transfer restores to the original bytes
  - SHA-256 matches after restoration
  - gzip + AES-GCM payload restores with the correct passphrase
  - encrypted manifests do not contain the passphrase
  - manifest and chunk JSON parse as QROPT/1 packets
- `scripts/qr-smoke.mjs` verifies:
  - generated manifest and chunk QR matrices decode with `jsQR`
  - decoded payloads parse as QROPT/1 packets
- `scripts/receiver-smoke.mjs` verifies:
  - chunks are ignored before manifest acceptance
  - chunks from other transfer IDs are ignored
  - duplicate chunks do not increase received count
  - missing count reaches zero only after every chunk arrives
  - missing ranges identify gaps such as `2-9, 11-100`
  - AES-GCM transfers require a passphrase and reject the wrong passphrase
  - completed transfers restore bytes and pass SHA-256 verification
- Browser verification has confirmed Sender and Receiver UI initialization, Sender start/pause behavior, and rendered Receiver controls.

## User-Run Physical Checklist

The following checks require real sender/receiver hardware and are outside Codex-side
completion scope:

- Windows browser screen to Mac camera optical transfer in real lighting conditions
- Camera focus/exposure behavior at 3, 5, 8, and 10 fps
- Practical chunk size and QR size tuning for the target hardware
- Mac Chrome/Safari camera permission and long-running scan behavior
- Offline/PWA behavior after first load in the target browsers

## Deferred Improvements

- Interleaving, parity chunks, fountain codes, or multiple simultaneous QR codes
- Automatic QR size/FPS tuning based on observed scan success
- Multi-file packaging as zip before transfer
