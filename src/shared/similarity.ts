import type { PostInput } from './types';

/**
 * Local similarity signatures for recognising repeated templates (docs/design-repeats.md §3).
 *
 * A post's text is cleaned up (case, emoji, numbers, URLs), cut into 3-word shingles, each shingle hashed with
 * SipHash-2-4 under a per-install secret key (security S2: without the key nobody can predict a post's signature, so
 * nobody can craft text that leaves it unchanged), and the set is summarised by MinHash:
 * 256 minimums of seeded 32-bit hashes, each kept as its low 16 bits ("b-bit MinHash"; 512 bytes, as 128 × 32 bits
 * took before). The fraction of equal positions between two signatures estimates the Jaccard similarity of their
 * shingle sets: unbiased, with the spread of 256 independent samples (docs/design-finding-c-estimate-noise.md). Two
 * different minimums share their low 16 bits with probability 1/65,536, raising an estimate by at most
 * (1 − J)/65,536: negligible, not corrected. Pure and dependency-free: runs in the service worker and in Node (eval/).
 *
 * Changing any rule here changes what a signature means: bump SIGNATURE_VERSION, so stored signatures are dropped
 * instead of being compared with new ones.
 */

/** Estimated Jaccard similarity at or above which two posts count as the same template. */
export const REPEAT_THRESHOLD = 0.85;
/** Posts whose own text has fewer words than this (after cleanup) get no signature: only exact matches count. */
export const REPEAT_MIN_WORDS = 40;
export const SIGNATURE_HASHES = 256;
export const SHINGLE_WORDS = 3;
/** 1: 128 × 32-bit. 2: 256 × 16-bit (finding C). 3: keyed chunk hash, SipHash-2-4 (security S2). */
export const SIGNATURE_VERSION = 3;

/** A post's similarity signature: SIGNATURE_HASHES values of 16 bits. */
export type Signature = Uint16Array;

/** The secret that keys the chunk hash: 16 bytes (128 bits), one per install, never leaves the service worker. */
export type SignatureKey = Uint8Array;

/** A fixed, PUBLIC key for eval and tests only (reproducible results). The extension uses its install's secret key. */
export const PUBLIC_TEST_KEY: SignatureKey = Uint8Array.from('signal:test:key!', (c) => c.charCodeAt(0));

/** A new random key (once per install). */
export function newSignatureKey(): SignatureKey {
  return crypto.getRandomValues(new Uint8Array(16));
}

const KEY_B64 = /^[A-Za-z0-9+/]{22}==$/;

export function encodeKey(key: SignatureKey): string {
  let bin = '';
  for (const b of key) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Inverse of encodeKey for untrusted stored data: null unless it is exactly one 16-byte key. */
export function decodeKey(s: unknown): SignatureKey | null {
  if (typeof s !== 'string' || !KEY_B64.test(s)) return null;
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    return null;
  }
  return bin.length === 16 ? Uint8Array.from(bin, (c) => c.charCodeAt(0)) : null;
}

/**
 * SipHash-2-4 (Aumasson & Bernstein): a keyed pseudo-random function with a 128-bit key and 64-bit output, returned as
 * two unsigned 32-bit halves. 64-bit words are kept as (hi, lo) pairs of 32-bit numbers: no BigInt on this hot path.
 * Checked against the paper's canonical vectors and 40 oracle vectors (tests/siphash.test.ts).
 */
export function sipHash24(key: SignatureKey, msg: Uint8Array, length = msg.length): { hi: number; lo: number } {
  const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
  const k0l = u32(key, 0);
  const k0h = u32(key, 4);
  const k1l = u32(key, 8);
  const k1h = u32(key, 12);
  let v0h = (k0h ^ 0x736f6d65) >>> 0;
  let v0l = (k0l ^ 0x70736575) >>> 0;
  let v1h = (k1h ^ 0x646f7261) >>> 0;
  let v1l = (k1l ^ 0x6e646f6d) >>> 0;
  let v2h = (k0h ^ 0x6c796765) >>> 0;
  let v2l = (k0l ^ 0x6e657261) >>> 0;
  let v3h = (k1h ^ 0x74656462) >>> 0;
  let v3l = (k1l ^ 0x79746573) >>> 0;
  let t: number;

  const round = () => {
    // v0 += v1; v1 = rotl(v1, 13) ^ v0; v0 = rotl(v0, 32)
    t = (v0l + v1l) >>> 0;
    v0h = (v0h + v1h + (t < v0l ? 1 : 0)) >>> 0;
    v0l = t;
    t = ((v1h << 13) | (v1l >>> 19)) >>> 0;
    v1l = (((v1l << 13) | (v1h >>> 19)) ^ v0l) >>> 0;
    v1h = (t ^ v0h) >>> 0;
    t = v0h;
    v0h = v0l;
    v0l = t;
    // v2 += v3; v3 = rotl(v3, 16) ^ v2
    t = (v2l + v3l) >>> 0;
    v2h = (v2h + v3h + (t < v2l ? 1 : 0)) >>> 0;
    v2l = t;
    t = ((v3h << 16) | (v3l >>> 16)) >>> 0;
    v3l = (((v3l << 16) | (v3h >>> 16)) ^ v2l) >>> 0;
    v3h = (t ^ v2h) >>> 0;
    // v0 += v3; v3 = rotl(v3, 21) ^ v0
    t = (v0l + v3l) >>> 0;
    v0h = (v0h + v3h + (t < v0l ? 1 : 0)) >>> 0;
    v0l = t;
    t = ((v3h << 21) | (v3l >>> 11)) >>> 0;
    v3l = (((v3l << 21) | (v3h >>> 11)) ^ v0l) >>> 0;
    v3h = (t ^ v0h) >>> 0;
    // v2 += v1; v1 = rotl(v1, 17) ^ v2; v2 = rotl(v2, 32)
    t = (v2l + v1l) >>> 0;
    v2h = (v2h + v1h + (t < v2l ? 1 : 0)) >>> 0;
    v2l = t;
    t = ((v1h << 17) | (v1l >>> 15)) >>> 0;
    v1l = (((v1l << 17) | (v1h >>> 15)) ^ v2l) >>> 0;
    v1h = (t ^ v2h) >>> 0;
    t = v2h;
    v2h = v2l;
    v2l = t;
  };
  const absorb = (ml: number, mh: number) => {
    v3l = (v3l ^ ml) >>> 0;
    v3h = (v3h ^ mh) >>> 0;
    round();
    round();
    v0l = (v0l ^ ml) >>> 0;
    v0h = (v0h ^ mh) >>> 0;
  };

  const full = length - (length % 8);
  for (let o = 0; o < full; o += 8) absorb(u32(msg, o), u32(msg, o + 4));
  // Last block: the remaining 0–7 bytes, little-endian, with the length (mod 256) in the top byte.
  let ml = 0;
  let mh = ((length & 0xff) << 24) >>> 0;
  for (let i = 0; i < length - full; i++) {
    const b = msg[full + i]!;
    if (i < 4) ml = (ml | (b << (8 * i))) >>> 0;
    else mh = (mh | (b << (8 * (i - 4)))) >>> 0;
  }
  absorb(ml, mh);
  v2l = (v2l ^ 0xff) >>> 0;
  round();
  round();
  round();
  round();
  return { hi: (v0h ^ v1h ^ v2h ^ v3h) >>> 0, lo: (v0l ^ v1l ^ v2l ^ v3l) >>> 0 };
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/giu;
/** Emoji and the invisible parts of emoji sequences: skin tones, flags, ZWJ, variation selectors, keycaps. */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0e\ufe0f\u20e3]/gu;
/** A run of digits, with the separators that occur inside numbers: 3.5, 10,000, 90%, 9:30. */
const NUMBER_RE = /\p{N}[\p{N}.,:%]*/gu;
const WORD_RE = /[\p{L}\p{N}]+/gu;

/** Cleanup + tokenisation: the words a signature is built from. */
export function words(s: string): string[] {
  const t = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(URL_RE, ' url ')
    .replace(EMOJI_RE, ' ')
    .replace(NUMBER_RE, ' 0 ');
  return t.match(WORD_RE) ?? [];
}

const utf8 = new TextEncoder();
let chunkBuf = new Uint8Array(256);

/** The keyed 32-bit hash of one chunk: the low half of SipHash-2-4 over its UTF-8 bytes (buffer reused). */
function chunkHash(key: SignatureKey, s: string): number {
  if (chunkBuf.length < s.length * 3) chunkBuf = new Uint8Array(s.length * 3);
  const { written } = utf8.encodeInto(s, chunkBuf);
  return sipHash24(key, chunkBuf, written).lo;
}

/** murmur3's 32-bit finaliser: a cheap, well-mixed bijection, used as the 128 "permutations". */
function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Fixed seeds: part of the signature's meaning (see SIGNATURE_VERSION). */
const SEEDS = Uint32Array.from({ length: SIGNATURE_HASHES }, (_, i) => fmix32(Math.imul(i + 1, 0x9e3779b9)));

/** Add a field's shingles, prefixed with the field name so the same words in different fields never coincide. */
function addShingles(into: Set<number>, key: SignatureKey, field: string, ws: string[]): void {
  if (ws.length === 0) return;
  if (ws.length < SHINGLE_WORDS) {
    into.add(chunkHash(key, `${field}:${ws.join(' ')}`));
    return;
  }
  for (let i = 0; i + SHINGLE_WORDS <= ws.length; i++) into.add(chunkHash(key, `${field}:${ws.slice(i, i + SHINGLE_WORDS).join(' ')}`));
}

/**
 * The post's signature under `key` (the install's secret; PUBLIC_TEST_KEY in eval and tests), or null when its own text
 * is too short to be matched by similarity. Signatures made under different keys are unrelated.
 */
export function signature(input: PostInput, key: SignatureKey): Signature | null {
  const own = words(input.text);
  if (own.length < REPEAT_MIN_WORDS) return null;
  const shingles = new Set<number>();
  addShingles(shingles, key, 't', own);
  if (input.quoted) addShingles(shingles, key, 'q', words(input.quoted));
  if (input.linkTitle) addShingles(shingles, key, 'l', words(input.linkTitle));
  if (input.linkDescription) addShingles(shingles, key, 'd', words(input.linkDescription));

  // Minimums over the full 32 bits, THEN truncated: truncating first would change which shingle wins.
  const mins = new Uint32Array(SIGNATURE_HASHES).fill(0xffffffff);
  for (const h of shingles) {
    for (let i = 0; i < SIGNATURE_HASHES; i++) {
      const v = fmix32(h ^ SEEDS[i]!);
      if (v < mins[i]!) mins[i] = v;
    }
  }
  return Uint16Array.from(mins, (v) => v & 0xffff);
}

/** Estimated Jaccard similarity: the fraction of positions where the two signatures agree. 0 if not comparable. */
export function similarity(a: Signature, b: Signature): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

const SIGNATURE_BYTES = SIGNATURE_HASHES * 2;
const ENCODED_LENGTH = Math.ceil(SIGNATURE_BYTES / 3) * 4;

/** Typed arrays use the host's byte order; the stored format is little-endian (every mainstream host is). */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Base64 of the signature's values as little-endian uint16s (684 characters). One fromCharCode over a byte view
 * (performance P2: ~5× faster than per-byte concatenation, same bytes; a golden-value test pins the format).
 */
export function encodeSignature(sig: Signature): string {
  let bytes: Uint8Array;
  if (LITTLE_ENDIAN) {
    bytes = new Uint8Array(sig.buffer, sig.byteOffset, sig.byteLength);
  } else {
    bytes = new Uint8Array(sig.length * 2);
    sig.forEach((v, i) => {
      bytes[i * 2] = v & 0xff;
      bytes[i * 2 + 1] = v >>> 8;
    });
  }
  return btoa(String.fromCharCode.apply(null, bytes as unknown as number[]));
}

/** Inverse of encodeSignature for untrusted stored data: null unless it is exactly one encoded signature. */
export function decodeSignature(s: unknown): Signature | null {
  // Performance P2b: no full-string regex. A canonical encoding of 512 bytes is 683 data characters and one '='. With
  // the length fixed, a final '=', atob succeeding and 512 bytes out accept exactly what /^[A-Za-z0-9+/]+={0,2}$/ did:
  // atob skips whitespace, so any whitespace leaves too few data characters (atob throws or returns under 512 bytes).
  if (typeof s !== 'string' || s.length !== ENCODED_LENGTH || s.charCodeAt(ENCODED_LENGTH - 1) !== 61 /* = */) return null;
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    return null;
  }
  if (bin.length !== SIGNATURE_BYTES) return null;
  // Straight into bytes, read as uint16s (performance P2: ~8× faster than a DataView loop plus a mapping callback).
  const bytes = new Uint8Array(SIGNATURE_BYTES);
  for (let i = 0; i < SIGNATURE_BYTES; i++) bytes[i] = bin.charCodeAt(i);
  if (LITTLE_ENDIAN) return new Uint16Array(bytes.buffer);
  return Uint16Array.from({ length: SIGNATURE_HASHES }, (_, i) => bytes[i * 2]! | (bytes[i * 2 + 1]! << 8));
}
