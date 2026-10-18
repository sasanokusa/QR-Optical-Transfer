/**
 * Repair chunks: a systematic XOR fountain.
 *
 * The sender ships K data chunks plus R repair chunks. Repair chunk r is the
 * XOR of a dense pseudo-random subset of the data chunks, where the subset is
 * derived deterministically from (transferId, r) - nothing extra is
 * transmitted, the receiver regenerates the same masks.
 *
 * Why this exists: without a back channel the only recovery mechanism is to
 * loop the whole transfer, and the coupon-collector tail makes the last few
 * missing chunks brutally slow (5% per-frame loss over 1000 chunks needs ~3
 * loops, and the final chunk can take a whole extra loop on its own). With
 * repair chunks the receiver can *compute* the gaps: the received repair
 * frames form a random GF(2) linear system over exactly the missing chunks,
 * solved with Gaussian elimination.
 */
import { hashStringToSeed, splitmix32, xorInto } from "./bytes.ts";

/** Number of unknowns we are willing to solve in one elimination pass. */
export const MAX_SOLVE_UNKNOWNS = 4000;

export function repairMask(transferId: string, repairIndex: number, chunkCount: number): Uint8Array {
  const mask = new Uint8Array((chunkCount + 7) >> 3);
  const seed = (hashStringToSeed(transferId) ^ Math.imul(repairIndex + 1, 0x9e3779b9)) >>> 0;
  const random = splitmix32(seed);

  for (let start = 0; start < chunkCount; start += 32) {
    const word = random();
    const limit = Math.min(32, chunkCount - start);

    for (let bit = 0; bit < limit; bit += 1) {
      if (((word >>> bit) & 1) === 1) {
        const index = start + bit;
        mask[index >> 3] |= 1 << (index & 7);
      }
    }
  }

  if (!mask.some((byte) => byte !== 0)) {
    // Degenerate mask (possible only on tiny transfers): always include one.
    const index = repairIndex % chunkCount;
    mask[index >> 3] |= 1 << (index & 7);
  }

  return mask;
}

export function buildRepairChunks(
  dataChunks: readonly Uint8Array[],
  transferId: string,
  repairCount: number,
  chunkSize: number
): Uint8Array[] {
  const repairs: Uint8Array[] = [];

  for (let repairIndex = 0; repairIndex < repairCount; repairIndex += 1) {
    const mask = repairMask(transferId, repairIndex, dataChunks.length);
    const repair = new Uint8Array(chunkSize);

    for (let chunkIndex = 0; chunkIndex < dataChunks.length; chunkIndex += 1) {
      if ((mask[chunkIndex >> 3] & (1 << (chunkIndex & 7))) !== 0) {
        xorInto(repair, dataChunks[chunkIndex]);
      }
    }

    repairs.push(repair);
  }

  return repairs;
}

export type SolveInput = {
  transferId: string;
  chunkCount: number;
  chunkSize: number;
  data: ReadonlyMap<number, Uint8Array>;
  repairs: ReadonlyMap<number, Uint8Array>;
};

export type SolveResult = {
  solved: Map<number, Uint8Array>;
  /** Number of independent equations that were found. */
  rank: number;
  /** Number of missing chunks when the solve started. */
  missing: number;
};

/**
 * Recover as many missing data chunks as the received repair chunks allow.
 * Returns an empty map when the system is under-determined (keep scanning).
 */
export function solveMissingChunks(input: SolveInput): SolveResult {
  const missing: number[] = [];

  for (let index = 0; index < input.chunkCount; index += 1) {
    if (!input.data.has(index)) {
      missing.push(index);
    }
  }

  if (missing.length === 0) {
    return { solved: new Map(), rank: 0, missing: 0 };
  }

  if (missing.length > MAX_SOLVE_UNKNOWNS || input.repairs.size < missing.length) {
    return { solved: new Map(), rank: 0, missing: missing.length };
  }

  const slotOf = new Map<number, number>();
  for (let slot = 0; slot < missing.length; slot += 1) {
    slotOf.set(missing[slot], slot);
  }

  const wordCount = (missing.length + 31) >>> 5;
  const rows: Uint32Array[] = [];
  const values: Uint8Array[] = [];
  const pivotRow = new Map<number, number>();

  const repairIndexes = [...input.repairs.keys()].sort((a, b) => a - b);
  const rowLimit = missing.length + 32;

  for (const repairIndex of repairIndexes) {
    if (rows.length >= rowLimit) {
      break;
    }

    const repairBytes = input.repairs.get(repairIndex);
    if (!repairBytes) {
      continue;
    }

    const mask = repairMask(input.transferId, repairIndex, input.chunkCount);
    const bits = new Uint32Array(wordCount);
    const value = new Uint8Array(input.chunkSize);
    value.set(repairBytes.subarray(0, Math.min(repairBytes.byteLength, input.chunkSize)));

    for (let chunkIndex = 0; chunkIndex < input.chunkCount; chunkIndex += 1) {
      if ((mask[chunkIndex >> 3] & (1 << (chunkIndex & 7))) === 0) {
        continue;
      }

      const known = input.data.get(chunkIndex);
      if (known) {
        xorInto(value, known);
        continue;
      }

      const slot = slotOf.get(chunkIndex);
      if (slot !== undefined) {
        bits[slot >>> 5] |= 1 << (slot & 31);
      }
    }

    // Forward elimination against the pivots collected so far.
    let currentPivot = lowestSetBit(bits);
    while (currentPivot >= 0) {
      const existing = pivotRow.get(currentPivot);

      if (existing === undefined) {
        pivotRow.set(currentPivot, rows.length);
        rows.push(bits);
        values.push(value);
        break;
      }

      xorWords(bits, rows[existing]);
      xorInto(value, values[existing]);
      currentPivot = lowestSetBit(bits);
    }
  }

  // Back substitution, highest pivot first. A row whose pivot is q cannot hold
  // any column below q, so only rows with smaller pivots need the xor.
  const pivotColumns = [...pivotRow.keys()].sort((a, b) => b - a);

  for (const column of pivotColumns) {
    const rowIndex = pivotRow.get(column);
    if (rowIndex === undefined) {
      continue;
    }

    for (const [otherColumn, otherRow] of pivotRow) {
      if (otherColumn >= column) {
        continue;
      }

      if (bitIsSet(rows[otherRow], column)) {
        xorWords(rows[otherRow], rows[rowIndex]);
        xorInto(values[otherRow], values[rowIndex]);
      }
    }
  }

  const solved = new Map<number, Uint8Array>();
  for (const [column, rowIndex] of pivotRow) {
    if (countBits(rows[rowIndex]) === 1) {
      solved.set(missing[column], values[rowIndex]);
    }
  }

  return { solved, rank: pivotRow.size, missing: missing.length };
}

function lowestSetBit(bits: Uint32Array): number {
  for (let wordIndex = 0; wordIndex < bits.length; wordIndex += 1) {
    const word = bits[wordIndex];
    if (word !== 0) {
      return wordIndex * 32 + trailingZeros(word);
    }
  }

  return -1;
}

function trailingZeros(word: number): number {
  return 31 - Math.clz32(word & -word);
}

function bitIsSet(bits: Uint32Array, index: number): boolean {
  return (bits[index >>> 5] & (1 << (index & 31))) !== 0;
}

function countBits(bits: Uint32Array): number {
  let total = 0;
  for (const word of bits) {
    total += popcount(word);
  }
  return total;
}

function popcount(word: number): number {
  let value = word - ((word >>> 1) & 0x55555555);
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function xorWords(target: Uint32Array, source: Uint32Array): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] ^= source[index];
  }
}
