# QROPT/2 protocol

QROPT/2 is the wire format used by this app. It is deliberately small: a
manifest in readable JSON, and data/repair frames in a compact ASCII envelope
that survives the string-only APIs available to QR decoders in browsers.

Everything here is implemented in `src/core/` and exercised by `npm test`.

## Design constraints

1. **One direction only.** There is no ACK channel, so the sender cannot be told
   what was missed. Recovery has to be precomputed and repeated.
2. **QR decoders hand out strings, not bytes.** `BarcodeDetector.rawValue` and
   `jsQR().data` both decode byte-mode QR content as text, so arbitrary binary
   payloads cannot be transported safely. Payload bytes therefore travel as
   base64url (6 bits per character instead of 8).
3. **A frame must be self-checking.** A QR symbol can be mis-decoded by one
   symbol error; without a checksum a single bad frame would poison the final
   hash and force the receiver to redo the whole transfer.
4. **The first QR must not be a single point of failure.** A receiver that
   starts scanning halfway through a pass must be able to join.

## Frames

### Manifest frame

A manifest is JSON (starts with `{`). It is the only frame that is not
compressed into the binary-ish envelope, because it is sent rarely and is the
most useful thing to read by hand while debugging.

```json
{
  "proto": "QROPT/2",
  "type": "manifest",
  "transferId": "k3f9",
  "file": { "name": "notes.bin", "mime": "application/octet-stream", "size": 5000 },
  "payload": {
    "encoding": "base64url",
    "compression": "none",
    "encryption": "none",
    "chunkSize": 600,
    "chunkCount": 9,
    "repairCount": 1,
    "size": 5000
  },
  "hash": { "alg": "SHA-256", "value": "332e7009…659a" },
  "display": { "fps": 8, "loop": true, "beaconSeconds": 3 }
}
```

| Field | Meaning |
| --- | --- |
| `transferId` | 4 base36 characters. Frames are matched against this. |
| `file.size` | Original file size, before compression/encryption. |
| `payload.size` | Size of the transformed byte stream that was chunked. |
| `payload.chunkSize` | Byte size of every data chunk except the last. |
| `payload.chunkCount` | Number of data chunks (`K`). |
| `payload.repairCount` | Number of repair chunks (`R`). |
| `payload.compression` | `none` or `gzip` (gzip is applied first). |
| `payload.encryption` | `none` or `AES-GCM` (applied after compression). |
| `crypto` | Present only when encrypted: IV, salt, PBKDF2 parameters. |
| `hash.value` | SHA-256 of the **original** file bytes, hex. |
| `display` | Sender hints: frames per second, looping, manifest beacon interval. |

The passphrase is never transmitted. `crypto` carries only the parameters needed
to derive the key from a passphrase the human transfers out of band.

### Data and repair frames

```
Q2<id><kind><seq>:<base64url payload>*<crc32 base36>
```

Example:

```
Q2k3f9d7:aGVsbG8*1aty3ku
Q2k3f9r0:AQID*1tlqu68
```

| Part | Size | Meaning |
| --- | --- | --- |
| `Q2` | 2 | Protocol magic. |
| `<id>` | 4 | Transfer id, same as `manifest.transferId`. |
| `<kind>` | 1 | `d` = data chunk, `r` = repair chunk. |
| `<seq>` | 1–7 | Chunk index, base36, no leading zeros. |
| `:` | 1 | Separator. |
| payload | 0…n | base64url bytes of the chunk. |
| `*` | 1 | Separator. |
| crc | 1–7 | CRC-32 of everything before `*`, base36. |

The envelope costs 16–20 characters for realistic chunk counts. The QROPT/1 JSON
chunk packet cost 94 characters for the same payload (16-character transfer id,
field names, `total`), and every extra character is QR modules.

Total length is bounded by the QR symbol: a version 40 symbol at error
correction M holds 2331 bytes, which caps a chunk at ~1730 payload bytes. The
sender additionally caps by ECC level:

| ECC | Max chunk bytes |
| --- | --- |
| L | 2202 |
| M | 1734 |
| Q | 1233 |
| H | 942 |

## Repair chunks

For a transfer of `K` data chunks and `R` repair chunks, repair chunk `r` is the
XOR of a dense pseudo-random subset of the data chunks. The subset is derived
from `(transferId, r)`, so nothing extra is transmitted.

```
mask(r) = splitmix32( crc32(transferId) XOR (r+1) * 0x9e3779b9 )
bit i of mask(r) selects data chunk i, using the 32 bits of each PRNG output
around i/32, i.e. roughly half of the chunks participate in each mask.
```

Repair chunk bytes are the XOR of the selected chunks, zero-padded to
`chunkSize`.

### Receiver-side reconstruction

Let `D_known` be the chunks already received and `M` the missing indices. For
each received repair chunk `r_i`:

1. `value = repair_i`, then XOR out every selected chunk that is already known.
2. The remaining mask bits are an equation over the unknowns `M`:
   `XOR_{j in mask_i ∩ M} chunk_j = value`.

Feed those equations into a GF(2) Gaussian elimination over `|M|` unknowns. If
the rank reaches `|M|`, every missing chunk is recovered and the transfer is
complete without another loop. If the rank is short (a rare but real possibility
for tiny `M`), the receiver keeps scanning; the missing data frames will arrive
on the next pass, and every newly received frame changes the system.

Costs: `R ≈ 0.12 K` by default, so roughly 12% extra screen time buys the
recovery capability. The solver is capped at 4000 unknowns per attempt.

## Frame scheduling

The sender loops over a unit sequence:

1. Data chunks are emitted through a stride permutation (stride ≈ 0.618·K,
   coprime with K), so consecutive frames are far apart in chunk order. A burst
   of dropped frames (autofocus hunt, glare, a repaint) costs widely separated
   chunks instead of a contiguous block.
2. Repair chunks are spread evenly through the data sequence.
3. A manifest beacon is inserted every `display.beaconSeconds` seconds (default
   3 s). With multi-QR frames the beacon occupies the first cell and the
   remaining cells keep streaming data, so the transfer barely slows down.

Because everything loops, the receiver can start at any time: it waits for the
next beacon, accepts the transfer, and joins the current pass.

## Receiver state machine

```
idle → receiving ─┬→ verifying → complete
                  └→ error (bad passphrase / hash mismatch) → retry
```

* Frames with an unknown `transferId` are counted and ignored.
* CRC failures are counted and dropped before they touch the chunk store.
* A manifest for a *different* transfer never silently wipes progress; it is
  offered as `pending` and the user decides.
* Completion = all `K` data chunks present (received or reconstructed), then
  assemble → decrypt → decompress → SHA-256 compare with `hash.value`.

## Versioning

`proto` is `QROPT/2`. Both sides must run the same protocol version; there is no
negotiation, and an older `QROPT/1` sender's frames do not parse as QROPT/2.
