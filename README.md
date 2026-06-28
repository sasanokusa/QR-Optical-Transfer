# QR Optical Transfer

Web MVP for one-way optical transfer with QR codes.

The current implementation covers the first experiment target in
`docs/qr_optical_transfer_requirements.md` and extends it to single-file transfer:

- Sender / Receiver mode switch
- 100 chunk Hello World sample at selectable FPS
- Optional single-file selection or drag and drop
- QROPT/1 JSON manifest and chunk packets
- QR generation with continuous looping
- Camera QR scanning with duplicate chunk suppression
- Transfer ID filtering
- Missing chunk progress display
- SHA-256 verification
- Optional gzip compression
- Optional AES-GCM encryption with a manually entered passphrase
- Restored file download
- PWA manifest and service worker cache for offline reuse after first load

Advanced loss recovery such as parity chunks, fountain codes, and multi-QR display is
intentionally left for later phases.

## Run

```sh
npm install
npm run dev
```

Open the sender on the source machine and the receiver on the camera machine.
Camera access requires HTTPS, localhost, or another browser-approved secure context.

## Build

```sh
npm run build
```

## Verify

```sh
npm test
```

See `docs/implementation_status.md` for the current requirement coverage and the remaining
physical verification checklist.
