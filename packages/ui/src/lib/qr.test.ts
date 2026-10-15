import { describe, expect, it } from 'vitest';
import {
  QrCapacityError, alignmentPositions, byteCapacity, dataCodewords, dataModuleOrder, encodeQr, formatBits, functionPatterns, gfMultiply, maskAt,
  qrPath, qrSvg, rawDataModules, type QrMatrix, type QrErrorCorrection,
} from './qr';

// ---- an independent reader (no error correction: it reads a clean matrix and checks the Reed-Solomon syndromes)

const LEVEL_BY_BITS: Record<number, QrErrorCorrection> = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
const BLOCKS: Record<QrErrorCorrection, number[]> = {
  // [ecc per block, number of blocks] for versions 1..10: transcribed from ISO/IEC 18004 table 9 (not from qr.ts).
  L: [7, 1, 10, 1, 15, 1, 20, 1, 26, 1, 18, 2, 20, 2, 24, 2, 30, 2, 18, 4],
  M: [10, 1, 16, 1, 26, 1, 18, 2, 24, 2, 16, 4, 18, 4, 22, 4, 22, 5, 26, 5],
  Q: [13, 1, 22, 1, 18, 2, 26, 2, 18, 4, 24, 4, 18, 6, 22, 6, 20, 8, 24, 8],
  H: [17, 1, 28, 1, 22, 2, 16, 4, 22, 4, 28, 4, 26, 5, 26, 6, 24, 8, 28, 8],
};

/** exp / log tables built by repeated multiplication by 2 with plain shifts (independent of gfMultiply). */
const EXP: number[] = [];
for (let i = 0, x = 1; i < 255; i++) {
  EXP.push(x);
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
function syndromesAreZero(block: number[], eccLen: number): boolean {
  for (let i = 0; i < eccLen; i++) {
    // Evaluate the codeword polynomial at alpha^i (Horner).
    let acc = 0;
    for (const c of block) {
      if (acc !== 0) acc = EXP[(EXP.indexOf(acc) + i) % 255];
      acc ^= c;
    }
    if (acc !== 0) return false;
  }
  return true;
}

function read(code: QrMatrix): { text: string; level: QrErrorCorrection; mask: number; syndromesOk: boolean } {
  const { size, modules } = code;
  const version = (size - 17) / 4;
  // Format information, first copy (around the top-left finder), least significant bit first.
  const positions: Array<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  let format = 0;
  positions.forEach(([x, y], i) => {
    if (modules[y][x]) format |= 1 << i;
  });
  format ^= 0x5412;
  const level = LEVEL_BY_BITS[(format >>> 13) & 3];
  const mask = (format >>> 10) & 7;

  const { isFunction } = functionPatterns(version);
  const bits: number[] = [];
  for (const [x, y] of dataModuleOrder(isFunction)) bits.push((modules[y][x] !== maskAt(mask, x, y) ? 1 : 0) as number);
  const total = Math.floor(rawDataModules(version) / 8);
  const codewords: number[] = [];
  for (let i = 0; i < total; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));

  // De-interleave.
  const eccLen = BLOCKS[level][(version - 1) * 2];
  const numBlocks = BLOCKS[level][(version - 1) * 2 + 1];
  const shortData = Math.floor(total / numBlocks) - eccLen;
  const numLong = total % numBlocks;
  const numShort = numBlocks - numLong;
  const data: number[][] = Array.from({ length: numBlocks }, () => []);
  const ecc: number[][] = Array.from({ length: numBlocks }, () => []);
  let k = 0;
  for (let i = 0; i < shortData + 1; i++) for (let j = 0; j < numBlocks; j++) if (i < shortData || j >= numShort) data[j].push(codewords[k++]);
  for (let i = 0; i < eccLen; i++) for (let j = 0; j < numBlocks; j++) ecc[j].push(codewords[k++]);
  const syndromesOk = data.every((d, j) => syndromesAreZero([...d, ...ecc[j]], eccLen));

  const stream = data.flat().flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  let at = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | stream[at++];
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`unexpected mode ${mode}`);
  const length = take(version <= 9 ? 8 : 16);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = take(8);
  return { text: new TextDecoder().decode(bytes), level, mask, syndromesOk };
}

const OTPAUTH = 'otpauth://totp/TypEase:owner%40alnoor-demo.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&period=30&digits=6&algorithm=SHA1&issuer=TypEase';

describe('QR tables and maths', () => {
  it('multiplies in GF(256) like the log / antilog tables', () => {
    expect(gfMultiply(0, 77)).toBe(0);
    expect(gfMultiply(1, 77)).toBe(77);
    for (const [a, b] of [[2, 128], [3, 7], [87, 19], [255, 255], [29, 200]]) {
      const expected = EXP[(EXP.indexOf(a) + EXP.indexOf(b)) % 255];
      expect(gfMultiply(a, b)).toBe(expected);
    }
  });
  it('knows the published capacities', () => {
    // ISO/IEC 18004 table 7, byte mode.
    expect(byteCapacity(1, 'L')).toBe(17);
    expect(byteCapacity(1, 'M')).toBe(14);
    expect(byteCapacity(1, 'H')).toBe(7);
    expect(byteCapacity(5, 'M')).toBe(84);
    expect(byteCapacity(10, 'M')).toBe(213);
    expect(byteCapacity(10, 'Q')).toBe(151);
    expect(byteCapacity(40, 'L')).toBe(2953);
    expect(byteCapacity(40, 'H')).toBe(1273);
    expect(rawDataModules(1)).toBe(208);
    expect(rawDataModules(7)).toBe(1568);
    expect(dataCodewords(40, 'L')).toBe(2956);
  });
  it('places alignment patterns where the standard says', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(14)).toEqual([6, 26, 46, 66]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
  });
  it('computes the BCH-protected format word', () => {
    // ISO/IEC 18004 annex C: level M, mask 5 -> 100000011001110
    expect(formatBits('M', 5)).toBe(0b100000011001110);
    expect(formatBits('L', 0)).toBe(0b111011111000100);
    expect(formatBits('H', 7)).toBe(0b000100000111011);
  });
});

describe('encodeQr', () => {
  it('produces the right size, finder patterns and dark module', () => {
    const code = encodeQr('TypEase');
    expect(code.version).toBe(1);
    expect(code.size).toBe(21);
    expect(code.modules).toHaveLength(21);
    const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
    const at = (ox: number, oy: number) => finder.map((_, y) => code.modules[oy + y].slice(ox, ox + 7).map((m) => (m ? '1' : '0')).join(''));
    expect(at(0, 0)).toEqual(finder);
    expect(at(14, 0)).toEqual(finder);
    expect(at(0, 14)).toEqual(finder);
    expect(code.modules[code.size - 8][8]).toBe(true);
    // Timing pattern alternates between the finders.
    expect(code.modules[6].slice(8, 13).map(Number)).toEqual([1, 0, 1, 0, 1]);
  });
  it('round-trips text through an independent reader for every level and many versions', () => {
    const samples = ['A', 'TypEase', 'https://portal.example.ae/track?no=TE-000123&code=K7MQP-X2RTD', OTPAUTH, 'مرحبا بكم في مركز النور للطباعة', OTPAUTH + OTPAUTH];
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      for (const text of samples) {
        const code = encodeQr(text, { errorCorrection: level });
        if (code.version > 10) continue; // the reader's block table stops at version 10
        const result = read(code);
        expect(result.text, `${level} v${code.version}`).toBe(text);
        expect(result.level).toBe(level);
        expect(result.mask).toBe(code.mask);
        expect(result.syndromesOk, `syndromes ${level} v${code.version}`).toBe(true);
      }
    }
  });
  it('round-trips with every mask', () => {
    for (let mask = 0; mask < 8; mask++) {
      const code = encodeQr(OTPAUTH, { mask });
      expect(code.mask).toBe(mask);
      expect(read(code).text).toBe(OTPAUTH);
    }
  });
  it('chooses the smallest version that fits and honours minVersion', () => {
    expect(encodeQr('x'.repeat(14)).version).toBe(1);
    expect(encodeQr('x'.repeat(15)).version).toBe(2);
    expect(encodeQr('x'.repeat(213)).version).toBe(10);
    expect(encodeQr('x'.repeat(214)).version).toBe(11);
    expect(encodeQr('x', { minVersion: 5 }).version).toBe(5);
    expect(encodeQr(OTPAUTH).version).toBeLessThanOrEqual(8);
  });
  it('writes version information from version 7 on', () => {
    const code = encodeQr('x'.repeat(100), { errorCorrection: 'M', minVersion: 7 });
    expect(code.version).toBe(7);
    // Version 7 information: 000111110010010100, least significant bit at (size-11, 0).
    let bits = 0;
    for (let i = 0; i < 18; i++) if (code.modules[Math.floor(i / 3)][code.size - 11 + (i % 3)]) bits |= 1 << i;
    expect(bits).toBe(0b000111110010010100);
    expect(read(code).text).toBe('x'.repeat(100));
  });
  it('refuses text that cannot fit', () => {
    expect(() => encodeQr('x'.repeat(3000))).toThrow(QrCapacityError);
  });
  it('is deterministic', () => {
    expect(encodeQr(OTPAUTH).modules).toEqual(encodeQr(OTPAUTH).modules);
  });
});

describe('SVG output', () => {
  it('draws every dark module exactly once, inside the quiet zone', () => {
    const code = encodeQr('TypEase');
    const path = qrPath(code, 4);
    let area = 0;
    for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      area += Number(m[3]);
      expect(Number(m[1])).toBeGreaterThanOrEqual(4);
      expect(Number(m[2])).toBeGreaterThanOrEqual(4);
      expect(Number(m[1]) + Number(m[3])).toBeLessThanOrEqual(4 + code.size);
    }
    expect(area).toBe(code.modules.flat().filter(Boolean).length);
  });
  it('wraps the path in a black-on-white document', () => {
    const svg = qrSvg('TypEase');
    expect(svg).toContain('viewBox="0 0 29 29"');
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('shape-rendering="crispEdges"');
  });
});
