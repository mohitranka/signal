/**
 * Security S2 (docs/design-security-s2.md): SipHash-2-4, the keyed chunk hash behind the per-install signature key.
 *
 * Correctness is shown against:
 *  - the two canonical vectors from the SipHash paper (Aumasson & Bernstein), key 00..0f; and
 *  - 40 vectors generated with the `siphash` npm package 1.2.0 (SipHash-2-4, pure JS; it reproduces both canonical
 *    vectors), used only as an oracle to generate this table, not as a dependency. Messages cover every tail length
 *    0–15 bytes, 17–64 bytes, and UTF-8 text (ASCII, accents, €, emoji with ZWJ, Cyrillic), with varied keys.
 */
import { describe, expect, it } from 'vitest';
import { sipHash24 } from '../src/shared/similarity';

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** key: 16 bytes (hex); message: raw bytes (hex) or text (UTF-8); expected 64-bit output as two 32-bit halves. */
const VECTORS: { key: string; bytes?: string; text?: string; hi: number; lo: number }[] = [
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '', hi: 0x726fdb47, lo: 0xdd0e0e31 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '00', hi: 0x74f839c5, lo: 0x93dc67fd },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '0001', hi: 0x0d6c8009, lo: 0xd9a94f5a },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102', hi: 0x85676696, lo: 0xd7fb7e2d },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '00010203', hi: 0xcf2794e0, lo: 0x277187b7 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '0001020304', hi: 0x18765564, lo: 0xcd99a68d },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405', hi: 0xcbc9466e, lo: 0x58fee3ce },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '00010203040506', hi: 0xab0200f5, lo: 0x8b01d137 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '0001020304050607', hi: 0x93f5f579, lo: 0x9a932462 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708', hi: 0x9e0082df, lo: 0x0ba9e4b0 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '00010203040506070809', hi: 0x7a5dbbc5, lo: 0x94ddb9f3 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a', hi: 0xf4b32f46, lo: 0x226bada7 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b', hi: 0x751e8fbc, lo: 0x860ee5fb },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b0c', hi: 0x14ea5627, lo: 0xc0843d90 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b0c0d', hi: 0xf723ca90, lo: 0x8e7af2ee },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b0c0d0e', hi: 0xa129ca61, lo: 0x49be45e5 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b0c0d0e0f10', hi: 0x699ae9f5, lo: 0x2cbe4794 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b0c0d0e0f10111213141516', hi: 0xa80c038c, lo: 0xcd5ccec8 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', hi: 0x7127512f, lo: 0x72f27cce },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e', hi: 0xd06c98cd, lo: 0x5c0975eb },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e', hi: 0x958a324c, lo: 0xeb064572 },
  { key: '000102030405060708090a0b0c0d0e0f', bytes: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f', hi: 0xacd2c40b, lo: 0x8502cad8 },
  { key: 'f243c0f93e9fecb54abbd8311697846d', text: "", hi: 0x8679722d, lo: 0x9129696e },
  { key: 'a233f069ee8f1c25faab08a1c687b4dd', text: "t:thrilled to announce", hi: 0x0f1a57af, lo: 0xbeab49f3 },
  { key: '522320d99e7f4c95aa9b38117677e44d', text: "t:i m thrilled", hi: 0xba5438a8, lo: 0x9664c42a },
  { key: '021350494e6f7c055a8b6881266714bd', text: "q:same comment over", hi: 0x78593c0f, lo: 0x8fb3fcbb },
  { key: 'b20380b9fe5fac750a7b98f1d657442d', text: "l:why postgres is enough", hi: 0x435966a2, lo: 0xceb0fe0c },
  { key: '62f3b029ae4fdce5ba6bc8618647749d', text: "caf\u00e9", hi: 0xc819da84, lo: 0x55025181 },
  { key: '12e3e0995e3f0c556a5bf8d13637a40d', text: "\u20ac", hi: 0xcb0ab403, lo: 0x2b88d377 },
  { key: 'c2d310090e2f3cc51a4b2841e627d47d', text: "\ud83c\udf89 ok", hi: 0xa98d553d, lo: 0x7b0af84b },
  { key: '72c34079be1f6c35ca3b58b1961704ed', text: "fr\u0435\u0435 crypto", hi: 0x8baf5f3e, lo: 0x4b6530a5 },
  { key: '22b370e96e0f9ca57a2b88214607345d', text: "\u043f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440 \u043a\u0430\u043a", hi: 0x6d419ce4, lo: 0x56ca7aab },
  { key: 'd2a3a0591effcc152a1bb891f6f764cd', text: "ab", hi: 0xbf874458, lo: 0x9cb8a8a1 },
  { key: '8293d0c9ceeffc85da0be801a6e7943d', text: "abcdefg", hi: 0xf52a4e80, lo: 0x75e2cc79 },
  { key: '328300397edf2cf58afb187156d7c4ad', text: "abcdefgh", hi: 0x6d3d751f, lo: 0x2342c522 },
  { key: 'e27330a92ecf5c653aeb48e106c7f41d', text: "na\u00efve r\u00e9sum\u00e9", hi: 0x1cb62867, lo: 0x6206c927 },
  { key: '92636019debf8cd5eadb7851b6b7248d', text: "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67", hi: 0x1ef8fc4c, lo: 0x7e1557bf },
  { key: '425390898eafbc459acba8c166a754fd', text: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", hi: 0x43982c79, lo: 0xfe85dc21 },
  { key: 'f243c0f93e9fecb54abbd8311697846d', text: "t:0 lessons nobody", hi: 0xee3688a7, lo: 0x2d166e68 },
  { key: 'a233f069ee8f1c25faab08a1c687b4dd', text: "d:a long read", hi: 0x758e004b, lo: 0x1516e463 },
];

describe('SipHash-2-4', () => {
  it('the canonical vectors from the SipHash paper', () => {
    const key = bytesOf('000102030405060708090a0b0c0d0e0f');
    expect(sipHash24(key, new Uint8Array(0))).toEqual({ hi: 0x726fdb47, lo: 0xdd0e0e31 });
    expect(sipHash24(key, bytesOf('000102030405060708090a0b0c0d0e'))).toEqual({ hi: 0xa129ca61, lo: 0x49be45e5 });
  });

  it(`${VECTORS.length} oracle vectors: every tail length, multi-byte UTF-8, varied keys`, () => {
    for (const v of VECTORS) {
      const msg = v.bytes !== undefined ? bytesOf(v.bytes) : utf8(v.text!);
      expect(sipHash24(bytesOf(v.key), msg), JSON.stringify(v)).toEqual({ hi: v.hi, lo: v.lo });
    }
  });

  it('returns unsigned 32-bit halves', () => {
    const r = sipHash24(bytesOf('ffffffffffffffffffffffffffffffff'), utf8('x'));
    for (const h of [r.hi, r.lo]) {
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });
});
