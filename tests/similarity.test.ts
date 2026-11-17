/**
 * T1: the local similarity signature (docs/design-repeats.md §3). Pure, browser- and Node-safe.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  REPEAT_MIN_WORDS,
  REPEAT_THRESHOLD,
  SHINGLE_WORDS,
  SIGNATURE_HASHES,
  SIGNATURE_VERSION,
  PUBLIC_TEST_KEY,
  decodeKey,
  decodeSignature,
  encodeKey,
  encodeSignature,
  newSignatureKey,
  signature,
  similarity,
  words,
} from '../src/shared/similarity';
import { announce, announceOpenerOnly, commentary, lessons, quotedA, quotedB, short, unrelated } from './fixtures/templates';

const sig = (text: string, extra: { quoted?: string; linkTitle?: string; linkDescription?: string } = {}) => {
  const s = signature({ text, ...extra }, PUBLIC_TEST_KEY);
  expect(s, 'expected a signature').not.toBeNull();
  return s!;
};
/** n distinct plain words. */
const nWords = (n: number, prefix = 'word') => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(' ');

describe('constants', () => {
  it('match the approved design', () => {
    expect(REPEAT_THRESHOLD).toBe(0.85);
    expect(REPEAT_MIN_WORDS).toBe(40);
    expect(SIGNATURE_HASHES).toBe(256); // finding C: 256 × 16-bit, same storage as 128 × 32-bit
    expect(SHINGLE_WORDS).toBe(3);
    expect(SIGNATURE_VERSION).toBe(3); // security S2: keyed chunk hash
  });
});

describe('cleanup (words)', () => {
  it('drops emoji, including skin tones, ZWJ sequences and variation selectors', () => {
    expect(words('🎉 Thrilled!! 👍🏽 Hello 👨‍👩‍👧 world ❤️ ♻️')).toEqual(['thrilled', 'hello', 'world']);
  });

  it('turns every run of digits (with . , : % inside) into one "0" token', () => {
    expect(words('We grew 3.5 times to 10,000 users, 90% in 2027 at 9:30')).toEqual(['we', 'grew', '0', 'times', 'to', '0', 'users', '0', 'in', '0', 'at', '0']);
  });

  it('replaces URLs with "url"', () => {
    expect(words('Read https://example.com/a?b=1 now, and www.example.org/path too')).toEqual(['read', 'url', 'now', 'and', 'url', 'too']);
  });

  it('applies NFKC and folds case', () => {
    expect(words('Ｈｅｌｌｏ ＷＯＲＬＤ Café')).toEqual(['hello', 'world', 'café']);
  });

  it('keeps hashtag words without the #, and keeps non-Latin scripts', () => {
    expect(words('#Leadership #AI Привет мир')).toEqual(['leadership', 'ai', 'привет', 'мир']);
  });

  it('returns nothing for empty or emoji-only text', () => {
    expect(words('')).toEqual([]);
    expect(words('🚀🔥 💯')).toEqual([]);
  });
});

describe('minimum length: only the post\'s own text counts', () => {
  it('39 words get no signature, 40 words do', () => {
    expect(signature({ text: nWords(39) }, PUBLIC_TEST_KEY)).toBeNull();
    const s = signature({ text: nWords(40) }, PUBLIC_TEST_KEY);
    expect(s).toBeInstanceOf(Uint16Array);
    expect(s!.length).toBe(SIGNATURE_HASHES);
  });

  it('counts words after cleanup: emoji do not count', () => {
    expect(signature({ text: `${nWords(39)} 🚀 🔥 💯 🎉 ♻️` }, PUBLIC_TEST_KEY)).toBeNull();
  });

  it('a long reshared post under a short comment is exact-match only', () => {
    expect(signature({ text: 'So true!', quoted: quotedA() }, PUBLIC_TEST_KEY)).toBeNull();
  });

  it('empty and short posts get no signature', () => {
    expect(signature({ text: '' }, PUBLIC_TEST_KEY)).toBeNull();
    expect(signature({ text: short() }, PUBLIC_TEST_KEY)).toBeNull();
  });
});

describe('signature and similarity', () => {
  it('is deterministic across calls', () => {
    const a = sig(announce());
    const b = sig(announce());
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(new Set(a).size).toBeGreaterThan(1);
  });

  it('identical posts are 1', () => {
    expect(similarity(sig(announce()), sig(announce()))).toBe(1);
  });

  it('posts differing only in numbers and emoji are 1', () => {
    expect(similarity(sig(announce('Northwind', 6, '🚀')), sig(announce('Northwind', 12, '🔥')))).toBe(1);
    expect(similarity(sig(lessons(12, 7, '👇')), sig(lessons(40, 10, '🧵')))).toBe(1);
  });

  it('a one-word name swapped (plus numbers and emoji) stays at or above the threshold', () => {
    const s = similarity(sig(announce('Northwind', 6, '🚀')), sig(announce('Contoso', 3, '💯')));
    expect(s).toBeGreaterThanOrEqual(REPEAT_THRESHOLD);
    expect(s).toBeLessThan(1);
  });

  it('a shared 20-word opening with a different rest is below the threshold', () => {
    expect(similarity(sig(announce()), sig(announceOpenerOnly()))).toBeLessThan(REPEAT_THRESHOLD);
  });

  it('unrelated posts are far below the threshold', () => {
    expect(similarity(sig(announce()), sig(unrelated[0]!))).toBeLessThan(0.3);
    expect(similarity(sig(unrelated[0]!), sig(unrelated[1]!))).toBeLessThan(0.3);
  });

  it('the same comment over different reshared posts is below the threshold (fields are kept apart)', () => {
    const a = sig(commentary(), { quoted: quotedA() });
    const b = sig(commentary(), { quoted: quotedB() });
    expect(similarity(a, b)).toBeLessThan(REPEAT_THRESHOLD);
    expect(similarity(a, sig(commentary(), { quoted: quotedA() }))).toBe(1);
  });

  it('moving text between fields changes the signature (quoted text is not the post text)', () => {
    const asText = sig(`${commentary()} ${quotedA()}`);
    const asQuote = sig(commentary(), { quoted: quotedA() });
    expect(similarity(asText, asQuote)).toBeLessThan(1);
  });

  it('signatures of different lengths compare as 0', () => {
    const a = sig(announce());
    expect(similarity(a, a.subarray(0, 64))).toBe(0);
  });
});

describe('encoding', () => {
  it('round-trips through base64 (684 characters for 512 bytes)', () => {
    const a = sig(announce());
    const enc = encodeSignature(a);
    expect(typeof enc).toBe('string');
    expect(enc).toHaveLength(684);
    const back = decodeSignature(enc)!;
    expect(back).toBeInstanceOf(Uint16Array);
    expect(Array.from(back)).toEqual(Array.from(a));
  });

  it('rejects anything that is not exactly one encoded signature', () => {
    const enc = encodeSignature(sig(announce()));
    for (const bad of [undefined, null, 42, {}, [], '', 'abc', '!!!!not base64!!!!', enc.slice(8), enc + 'AAAA']) {
      expect(decodeSignature(bad), String(bad).slice(0, 20)).toBeNull();
    }
  });
});

describe('estimate noise at the threshold (finding C)', () => {
  /**
   * Seeded synthetic pairs whose EXACT similarity (same cleanup, 3-word chunks) lies in [lo, hi]. The estimator is
   * unbiased and binomial (docs/design-finding-c-estimate-noise.md), so these counts follow from the number of hashes.
   */
  function pairs(lo: number, hi: number, count: number, seed0: number) {
    let seed = seed0;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    // Letters only: the cleanup leaves these words untouched (digits would be split off into "0" tokens).
    const letters = (i: number) => {
      let s = '';
      do {
        s += String.fromCharCode(97 + (i % 26));
        i = Math.floor(i / 26);
      } while (i > 0);
      return s;
    };
    const vocab = Array.from({ length: 5000 }, (_, i) => 'w' + letters(i));
    const chunks = (w: string[]) => {
      const s = new Set<string>();
      for (let i = 0; i + 3 <= w.length; i++) s.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
      return s;
    };
    const exact = (a: Set<string>, b: Set<string>) => {
      let n = 0;
      for (const x of a) if (b.has(x)) n++;
      return n / (a.size + b.size - n);
    };
    const out: { a: string; b: string }[] = [];
    while (out.length < count) {
      const n = 40 + Math.floor(rnd() * 120);
      const a = Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]!);
      const b = a.slice();
      // Aim the number of swapped words at the target range (each isolated swap changes 3 chunks), then jitter it.
      const mid = (lo + hi) / 2;
      const aim = ((n - 2) * (1 - mid)) / (3 * (1 + mid));
      const swaps = Math.max(1, Math.round(aim + (rnd() - 0.5) * 2));
      for (let k = 0; k < swaps; k++) b[Math.floor(rnd() * n)] = vocab[Math.floor(rnd() * vocab.length)]!;
      const j = exact(chunks(a), chunks(b));
      if (j >= lo && j <= hi) out.push({ a: a.join(' '), b: b.join(' ') });
    }
    // The exact similarity above is over the same words the signature uses:
    expect(words(out[0]!.a)).toEqual(out[0]!.a.split(' '));
    return out;
  }
  const matched = (ps: { a: string; b: string }[]) => ps.filter((p) => similarity(sig(p.a), sig(p.b)) >= REPEAT_THRESHOLD).length;

  it('posts just below the threshold (exact 0.79–0.81) are rarely treated as the same template: at most 5%', () => {
    // 128 hashes: 95 of 1000 on this seed; 256 hashes: about 24 expected.
    expect(matched(pairs(0.79, 0.81, 1000, 4242))).toBeLessThanOrEqual(50);
  });

  it('clear repeats (exact 0.89–0.91) are almost never missed: at least 98.5% matched', () => {
    // 128 hashes: 957 of 1000 on this seed; 256 hashes: about 992 expected.
    expect(matched(pairs(0.89, 0.91, 1000, 9191))).toBeGreaterThanOrEqual(985);
  });
});

describe('keyed signatures (security S2)', () => {
  const KEY_A = Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 1);
  const KEY_B = Uint8Array.from({ length: 16 }, (_, i) => 255 - i * 3);

  it('the same post under two different keys gives unrelated signatures; under one key it is deterministic', () => {
    const a = signature({ text: announce() }, KEY_A)!;
    const b = signature({ text: announce() }, KEY_B)!;
    expect(similarity(a, b)).toBeLessThan(0.1);
    expect(Array.from(signature({ text: announce() }, KEY_A)!)).toEqual(Array.from(a));
  });

  it('the step-8 crafting attack no longer works: a payload built from the public algorithm now changes the signature', () => {
    // What an attacker could compute from the public source before S2: FNV-1a chunk hashes, public seeds, full minima.
    const fnv = (s: string) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    };
    const fmix = (x: number) => {
      let h = x >>> 0;
      h ^= h >>> 16;
      h = Math.imul(h, 0x85ebca6b);
      h ^= h >>> 13;
      h = Math.imul(h, 0xc2b2ae35);
      h ^= h >>> 16;
      return h >>> 0;
    };
    const seeds = Array.from({ length: 256 }, (_, i) => fmix(Math.imul(i + 1, 0x9e3779b9)));
    const target = lessons();
    const tw = words(target);
    const mins = seeds.map((s) => Math.min(...Array.from({ length: tw.length - 2 }, (_, i) => fmix(fnv(`t:${tw.slice(i, i + 3).join(' ')}`) ^ s))));
    const harmless = (a: string, b: string, c: string) => {
      const h = fnv(`t:${a} ${b} ${c}`);
      return seeds.every((s, i) => fmix(h ^ s) > mins[i]!);
    };
    // 40 payload words (so the honest similarity, about 0.71, is far from 0.85: the key, not noise, decides).
    const want = ('limited offer claim your free crypto bonus now dm me the word profit and send your wallet details today ' +
      'this deal ends at midnight so act fast and tell your friends to join before the price goes up again soon').split(' ');
    let ctx = tw.slice(-2);
    const payload: string[] = [];
    for (const w of want) {
      const tries = Array.from({ length: 26 * 26 }, (_, k) => w + String.fromCharCode(97 + (k % 26)) + String.fromCharCode(97 + Math.floor(k / 26)));
      const pick = [w, ...tries].find((v) => harmless(ctx[0]!, ctx[1]!, v))!;
      payload.push(pick);
      ctx = [ctx[1]!, pick];
    }
    expect(payload).toHaveLength(40);
    const crafted = `${target} ${payload.join(' ')}`;
    const secret = Uint8Array.from({ length: 16 }, (_, i) => (i * 29 + 11) & 0xff); // not known to the attacker
    expect(similarity(signature({ text: target }, secret)!, signature({ text: crafted }, secret)!)).toBeLessThan(REPEAT_THRESHOLD);
  });

  it('keys: 16 bytes, random per install, base64 round trip, junk rejected', () => {
    expect(PUBLIC_TEST_KEY).toBeInstanceOf(Uint8Array);
    expect(PUBLIC_TEST_KEY).toHaveLength(16);
    const k1 = newSignatureKey();
    const k2 = newSignatureKey();
    expect(k1).toHaveLength(16);
    expect(Array.from(k1)).not.toEqual(Array.from(k2));
    expect(Array.from(decodeKey(encodeKey(k1))!)).toEqual(Array.from(k1));
    const enc = encodeKey(k1);
    for (const bad of [undefined, null, 7, {}, '', 'abc', enc.slice(2), enc + 'AAAA', '!!!!!!!!!!!!!!!!!!!!!!!!']) {
      expect(decodeKey(bad), String(bad)).toBeNull();
    }
  });
});

describe('signature encoding format (performance P2: faster codec, same bytes)', () => {
  /** Recorded from the code before the P2 codec change (commit 850b8e7). Stored indexes depend on this exact format. */
  const GOLDEN = '6x9k4Z157oxpb82T+KjYAk3/q47pF2LjO8LPupq/oXEGznRZK9y0ZUwb7sX2/rp1d/AECihpziFVq0J2Pq70vgm0bOqzsauwOthZolI7+5DKOzeG4Q5zJaQH/d44fBbj9OPsWHEDRSL2zoKFxe3KHa80yuhpdqqhQh58qtPF779Jgbr6vCsmx+WR3YGQugKTScrlAPHSu9dos9jEQ0uDJCQHkV3rkvwYRg9u+BTrCk1qv/oPJed38HsHKkswziH+TXg+F6lOhNjnW7LntPkq9sWpHbyYP5ogpiiZcr6W4Q13mu6cyQ0Xjw1/HwSPmtP16fQfRHs56+UWhXUnSerLrUEQGynP6fO7B3pWPnLTPxwVq178PPFXck00ceCCOBIcpUmYPWVSe1MOj4XqP+ZR7XF8qJ/3cNfHfIX2MU7lSghyELpCQ6OUrCFvR0uEyVz1+uzfozfC5NqDt9ARBip7m9QIKArCKL46b8iguSz+ulRjqi+COyiqJ739jetez4X/HJFOPCArzCKPFdOFfWDsbWZhm6OttYBbCVU3oqnmovEesj9eFJEZSkFFC8nM9qxh0hpAmC+L6f8mnA/E88d3ansbW3W70IRizYrwx9kZ02Md0zjJ1abPBcs+wnHkFJEcu4uBI1Onni5oWRuMVorYzGf3SQTRIOLQiO770K3Cw9A=';

  it('the encoding of a fixed signature is byte-identical to the recorded value, and decodes back', () => {
    const s = signature({ text: announce() }, PUBLIC_TEST_KEY)!;
    expect(encodeSignature(s)).toBe(GOLDEN);
    expect(Array.from(decodeSignature(GOLDEN)!)).toEqual(Array.from(s));
  });

  it('round-trips extreme values and subarray views (the byte view must respect byteOffset)', () => {
    const make = (f: (i: number) => number) => Uint16Array.from({ length: SIGNATURE_HASHES }, (_, i) => f(i));
    for (const s of [make(() => 0), make(() => 0xffff), make((i) => (i % 2 ? 0xffff : 0)), make((i) => (i * 2654435761) & 0xffff)]) {
      expect(Array.from(decodeSignature(encodeSignature(s))!)).toEqual(Array.from(s));
    }
    const big = make((i) => (i * 40503) & 0xffff);
    const padded = new Uint16Array(SIGNATURE_HASHES + 8);
    padded.set(big, 5);
    const view = padded.subarray(5, 5 + SIGNATURE_HASHES);
    expect(encodeSignature(view)).toBe(encodeSignature(big));
  });
});

describe('module boundaries', () => {
  it('uses no Node built-ins (it ships in the service worker)', () => {
    const src = readFileSync('src/shared/similarity.ts', 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:|require\(/);
  });
});

describe('decoding stored signatures without a full-string regex (performance P2b)', () => {
  /** The acceptance rule before P2b, kept here as the reference: exact length, base64 alphabet regex, atob, 512 bytes. */
  const REFERENCE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
  const reference = (s: string): boolean => {
    if (s.length !== 684 || !REFERENCE_RE.test(s)) return false;
    try {
      return atob(s).length === 512;
    } catch {
      return false;
    }
  };

  it('runs no regular expression over the 684-character string (the regex was 12.5 ms of a 26 ms first load)', () => {
    const enc = encodeSignature(sig(announce()));
    const test = vi.spyOn(RegExp.prototype, 'test');
    const exec = vi.spyOn(RegExp.prototype, 'exec');
    let decoded: unknown;
    let calls: number;
    try {
      decoded = decodeSignature(enc);
      calls = test.mock.calls.length + exec.mock.calls.length; // read before expect(), which uses regexes itself
    } finally {
      test.mockRestore();
      exec.mockRestore();
    }
    expect(decoded).not.toBeNull();
    expect(calls).toBe(0);
  });

  it('still rejects 683 base64 characters plus whitespace, which atob alone would accept as 512 bytes', () => {
    const enc = encodeSignature(sig(announce()));
    for (const ws of [' ', '\t', '\n', '\r', '\f']) {
      for (const variant of [enc.slice(0, 683) + ws, ws + enc.slice(0, 683), enc.slice(0, 300) + ws + enc.slice(300, 683)]) {
        expect(atob(variant).length).toBe(512); // what removing the check outright would have let through
        expect(decodeSignature(variant)).toBeNull();
      }
    }
  });

  it('accepts exactly what the previous rule accepted (seeded fuzz, 40,000 mutated strings)', () => {
    const chars = [...'AZaz09+/=-_ \t\n\r\f\v\u00a0\u0000é€', '\uD83D'];
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const bases = [announce(), lessons(), ...unrelated.slice(0, 3)].map((t) => encodeSignature(sig(t)));
    let compared = 0;
    const disagreements: string[] = [];
    for (let t = 0; t < 40_000; t++) {
      const s = bases[rnd(bases.length)]!.split('');
      for (let e = 1 + rnd(3); e > 0; e--) {
        const pos = rnd(2) ? rnd(s.length) : s.length - 1 - rnd(4);
        const c = chars[rnd(chars.length)]!;
        const op = rnd(3);
        if (op === 0) s[pos] = c;
        else if (op === 1) {
          s.splice(pos, 0, c);
          s.splice(rnd(2) ? s.length - 1 : rnd(s.length), 1);
        } else {
          s.splice(pos, 1);
          s.splice(rnd(s.length + 1), 0, c);
        }
      }
      const str = s.join('');
      if (str.length !== 684) continue;
      compared++;
      const decoded = decodeSignature(str);
      if ((decoded !== null) !== reference(str)) disagreements.push(JSON.stringify(str.replace(/[A-Za-z0-9+/]/g, '')));
      else if (decoded) expect(Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength).toString('base64')).toBe(Buffer.from(atob(str), 'latin1').toString('base64'));
    }
    expect(compared).toBeGreaterThan(30_000);
    expect(disagreements.slice(0, 5)).toEqual([]);
  });
});
