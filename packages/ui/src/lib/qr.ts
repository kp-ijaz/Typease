/**
 * A small, self-contained QR Code encoder (ISO/IEC 18004, Model 2).
 *
 * Scope: byte mode (UTF-8), versions 1-40, all four error-correction levels,
 * automatic choice of the smallest version and of the best mask. That is
 * everything an `otpauth://` enrolment link or a tracking URL needs; numeric /
 * alphanumeric / kanji compaction and structured append are deliberately left out.
 *
 * Written for the MFA setup screen so that the secret never leaves the browser
 * (no third-party QR service, no extra dependency). Verified against OpenCV's
 * QRCodeDetector when it was written; `qr.test.ts` decodes the matrices again
 * with an independent reader and checks the Reed-Solomon syndromes.
 */

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  version: number;
  /** Modules per side: 17 + 4 * version. */
  size: number;
  errorCorrection: QrErrorCorrection;
  mask: number;
  /** modules[y][x] === true means a dark module. No quiet zone included. */
  modules: boolean[][];
}

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: Record<QrErrorCorrection, number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS: Record<QrErrorCorrection, number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
/** The two format bits of each level (they are not in alphabetical order in the standard). */
const FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };

// ---------------------------------------------------------------- capacity

/** Modules available for data + error correction once all function patterns are placed. */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function dataCodewords(version: number, ecl: QrErrorCorrection): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][version - 1] * NUM_ERROR_CORRECTION_BLOCKS[ecl][version - 1];
}

/** How many bytes of text fit into a version in byte mode. */
export function byteCapacity(version: number, ecl: QrErrorCorrection): number {
  const headerBits = 4 + (version <= 9 ? 8 : 16);
  return Math.floor((dataCodewords(version, ecl) * 8 - headerBits) / 8);
}

export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---------------------------------------------------------------- Reed-Solomon over GF(2^8) / 0x11D

export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMultiply(coef, factor)));
  }
  return result;
}

// ---------------------------------------------------------------- encoding

function utf8(text: string): number[] {
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
  const escaped = unescape(encodeURIComponent(text));
  return Array.from(escaped, (c) => c.charCodeAt(0));
}

function buildCodewords(bytes: number[], version: number, ecl: QrErrorCorrection): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCodewords(version, ecl) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

  // Split into blocks, add error correction to each, then interleave.
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][version - 1];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version - 1];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // Skip the padding cell of the short blocks.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
export const maskAt = (mask: number, x: number, y: number): boolean => MASKS[mask](x, y);

/** The empty symbol of a version: function patterns drawn, and a map of which modules they occupy. */
export function functionPatterns(version: number): { modules: boolean[][]; isFunction: boolean[][] } {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finder patterns with their separators.
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // Alignment patterns (not where the finders are).
  const align = alignmentPositions(version);
  const last = align.length - 1;
  align.forEach((cy, i) =>
    align.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  // Reserve the format areas (filled in later) and draw the version blocks.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      set(8, i, false);
      set(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
  set(8, size - 8, true);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  return { modules, isFunction };
}

export function formatBits(ecl: QrErrorCorrection, mask: number): number {
  const data = (FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(modules: boolean[][], ecl: QrErrorCorrection, mask: number) {
  const size = modules.length;
  const bits = formatBits(ecl, mask);
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = true;
}

/** The order in which codeword bits are laid out: two-module columns from the right, zig-zagging up and down. */
export function dataModuleOrder(isFunction: boolean[][]): Array<[number, number]> {
  const size = isFunction.length;
  const order: Array<[number, number]> = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x]) order.push([x, y]);
      }
    }
  }
  return order;
}

function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let result = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) lines.push(modules[y]);
  for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]));
  for (const line of lines) {
    // Rule 1: runs of five or more modules of one colour.
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) result += 3 + (run - 5);
        run = 1;
      }
    }
    // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules on one side.
    const text = line.map((m) => (m ? '1' : '0')).join('');
    for (const pattern of ['10111010000', '00001011101']) {
      for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) result += 40;
    }
  }
  // Rule 2: 2 x 2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
    }
  }
  // Rule 4: balance of dark and light.
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

export class QrCapacityError extends Error {
  constructor(bytes: number, ecl: QrErrorCorrection) {
    super(`The text is too long for a QR code (${bytes} bytes at error-correction level ${ecl}; the maximum is ${byteCapacity(40, ecl)}).`);
    this.name = 'QrCapacityError';
  }
}

export interface QrOptions {
  /** Default "M" (recovers about 15% damage): a good balance for screens. */
  errorCorrection?: QrErrorCorrection;
  minVersion?: number;
  /** Force a mask (0-7) instead of choosing the one with the lowest penalty. */
  mask?: number;
}

export function encodeQr(text: string, options: QrOptions = {}): QrMatrix {
  const ecl = options.errorCorrection ?? 'M';
  const bytes = utf8(text);
  let version = Math.max(1, Math.min(40, options.minVersion ?? 1));
  while (version <= 40 && byteCapacity(version, ecl) < bytes.length) version++;
  if (version > 40) throw new QrCapacityError(bytes.length, ecl);

  const codewords = buildCodewords(bytes, version, ecl);
  const { modules: base, isFunction } = functionPatterns(version);
  const order = dataModuleOrder(isFunction);
  order.forEach(([x, y], i) => {
    // Remainder bits after the last codeword stay light.
    base[y][x] = i < codewords.length * 8 ? ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0 : false;
  });

  const apply = (mask: number) => {
    const m = base.map((row) => row.slice());
    for (const [x, y] of order) if (maskAt(mask, x, y)) m[y][x] = !m[y][x];
    drawFormat(m, ecl, mask);
    return m;
  };
  let mask = options.mask ?? -1;
  let modules: boolean[][] | null = null;
  if (mask >= 0 && mask <= 7) modules = apply(mask);
  else {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      const m = apply(candidate);
      const score = penalty(m);
      if (score < best) {
        best = score;
        mask = candidate;
        modules = m;
      }
    }
  }
  return { version, size: version * 4 + 17, errorCorrection: ecl, mask, modules: modules as boolean[][] };
}

/** SVG path data for the dark modules, one horizontal run per sub-path, offset by the quiet zone. */
export function qrPath(code: QrMatrix, quietZone = 4): string {
  let d = '';
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      let run = 1;
      while (x + run < code.size && code.modules[y][x + run]) run++;
      d += `M${x + quietZone} ${y + quietZone}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return d;
}

/** A complete SVG document (black on white, with quiet zone) for places without React. */
export function qrSvg(text: string, options: QrOptions & { quietZone?: number } = {}): string {
  const code = encodeQr(text, options);
  const quiet = options.quietZone ?? 4;
  const dim = code.size + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${qrPath(code, quiet)}" fill="#000"/></svg>`;
}
