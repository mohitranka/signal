/**
 * T2: quality check on eval/repeats.jsonl. It guards the cleanup rules and the 0.85 / 40-word constants: if a future
 * change makes template variants stop matching, or unrelated posts start matching, this fails.
 *
 * File conventions:
 *   - `family`: rows that are the same template (names, numbers, emoji swapped). All must match each other and share a label.
 *   - `category: "repeat-negative"`: hard negatives (shared boilerplate, different substance). Must match nothing.
 *   - `category: "repeat-short"`: under 40 words. Must get no signature (exact match only).
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadDataset, toInput, type Row } from '../eval/lib';
import { PUBLIC_TEST_KEY, REPEAT_MIN_WORDS, REPEAT_THRESHOLD, signature, similarity, words } from '../src/shared/similarity';

const FILE = 'eval/repeats.jsonl';
const rows = (): Row[] => loadDataset(FILE);
const fam = (r: Row) => (r as Row & { family?: string }).family;
const sigOf = (r: Row) => signature(toInput(r), PUBLIC_TEST_KEY);

describe('eval/repeats.jsonl', () => {
  it('exists and loads as a normal dataset', () => {
    expect(existsSync(FILE)).toBe(true);
    expect(rows().length).toBeGreaterThanOrEqual(30);
  });

  it('has at least 6 template families of 4+ variants, 6+ hard negatives and 2+ short rows', () => {
    const r = rows();
    const sizes = new Map<string, number>();
    for (const x of r) if (fam(x)) sizes.set(fam(x)!, (sizes.get(fam(x)!) ?? 0) + 1);
    expect([...sizes.values()].filter((n) => n >= 4).length).toBeGreaterThanOrEqual(6);
    expect(r.filter((x) => x.category === 'repeat-negative').length).toBeGreaterThanOrEqual(6);
    expect(r.filter((x) => x.category === 'repeat-short').length).toBeGreaterThanOrEqual(2);
  });

  it('every family member is long enough to be signed, and a family shares one label', () => {
    const byFam = new Map<string, Row[]>();
    for (const x of rows()) if (fam(x)) byFam.set(fam(x)!, [...(byFam.get(fam(x)!) ?? []), x]);
    for (const [f, members] of byFam) {
      for (const m of members) expect(words(m.text).length, `${m.id} in ${f}`).toBeGreaterThanOrEqual(REPEAT_MIN_WORDS);
      expect(new Set(members.map((m) => m.label)).size, `labels in ${f}`).toBe(1);
    }
  });

  it('every pair inside a family matches', () => {
    const byFam = new Map<string, Row[]>();
    for (const x of rows()) if (fam(x)) byFam.set(fam(x)!, [...(byFam.get(fam(x)!) ?? []), x]);
    for (const [f, members] of byFam) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const s = similarity(sigOf(members[i]!)!, sigOf(members[j]!)!);
          expect(s, `${members[i]!.id} ~ ${members[j]!.id} (${f})`).toBeGreaterThanOrEqual(REPEAT_THRESHOLD);
        }
      }
    }
  });

  it('no pair across families, and nothing involving a hard negative, matches', () => {
    const signed = rows().filter((x) => fam(x) || x.category === 'repeat-negative');
    for (let i = 0; i < signed.length; i++) {
      for (let j = i + 1; j < signed.length; j++) {
        const a = signed[i]!;
        const b = signed[j]!;
        if (fam(a) && fam(a) === fam(b)) continue;
        const sa = sigOf(a);
        const sb = sigOf(b);
        if (!sa || !sb) continue;
        expect(similarity(sa, sb), `${a.id} vs ${b.id}`).toBeLessThan(REPEAT_THRESHOLD);
      }
    }
  });

  it('short rows get no signature', () => {
    for (const x of rows().filter((r) => r.category === 'repeat-short')) expect(sigOf(x), x.id).toBeNull();
  });

  it('documents that numbers are erased: an evidence family with different numbers matches, and is labelled highlight', () => {
    // The service never copies a highlight verdict (tests/repeats-service.test.ts), which is what keeps this safe.
    const ev = rows().filter((x) => fam(x) === 'evidence-numbers');
    expect(ev.length).toBeGreaterThanOrEqual(2);
    expect(ev.every((x) => x.label === 'highlight')).toBe(true);
  });
});
