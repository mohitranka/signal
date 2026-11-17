/**
 * Offline report for repeated-template matching (`npm run eval -- --mode repeats`): which rows the signature treats as
 * the same template, whether any such pair has different labels (a copied verdict would then be wrong for one of them),
 * how well template families hold together, and whether hard negatives stay apart. No API calls.
 */
import { PUBLIC_TEST_KEY, REPEAT_MIN_WORDS, REPEAT_THRESHOLD, SIGNATURE_VERSION, signature, similarity } from '../src/shared/similarity';
import type { Decision } from '../src/shared/types';
import { toInput, type Row } from './lib';

export interface RepeatPair {
  a: string;
  b: string;
  similarity: number;
  sameLabel: boolean;
  labels: [Decision, Decision];
}

export interface FamilyCoverage {
  family: string;
  size: number;
  /** Members that match at least one other member of their family. */
  matched: number;
  /** Members that match no other member, with their best estimate against the family. */
  missed: { id: string; best: number }[];
}

export interface RepeatReport {
  threshold: number;
  minWords: number;
  version: number;
  rows: number;
  signed: number;
  /** Rows under the minimum length: exact match only. */
  unsigned: string[];
  /** Pairs at or above the threshold: different labels first, then most similar first. */
  pairs: RepeatPair[];
  families: FamilyCoverage[];
  /** Hard negatives (category "repeat-negative") that matched another row. */
  negativesMatched: { id: string; with: string; similarity: number }[];
}

export function repeatReport(rows: Row[]): RepeatReport {
  // A fixed public key: reproducible offline results (the extension uses its install's secret key).
  const sigs = rows.map((r) => signature(toInput(r), PUBLIC_TEST_KEY));
  const sim = (i: number, j: number) => (sigs[i] && sigs[j] ? similarity(sigs[i]!, sigs[j]!) : 0);

  const pairs: RepeatPair[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const s = sim(i, j);
      if (s < REPEAT_THRESHOLD) continue;
      const [a, b] = [rows[i]!, rows[j]!];
      pairs.push({ a: a.id, b: b.id, similarity: s, sameLabel: a.label === b.label, labels: [a.label, b.label] });
    }
  }
  pairs.sort((x, y) => Number(x.sameLabel) - Number(y.sameLabel) || y.similarity - x.similarity);

  const byFamily = new Map<string, number[]>();
  rows.forEach((r, i) => {
    if (r.family) byFamily.set(r.family, [...(byFamily.get(r.family) ?? []), i]);
  });
  const families = [...byFamily].map(([family, members]): FamilyCoverage => {
    const missed: { id: string; best: number }[] = [];
    for (const i of members) {
      const best = Math.max(0, ...members.filter((j) => j !== i).map((j) => sim(i, j)));
      if (best < REPEAT_THRESHOLD) missed.push({ id: rows[i]!.id, best });
    }
    return { family, size: members.length, matched: members.length - missed.length, missed };
  });

  const negativesMatched: RepeatReport['negativesMatched'] = [];
  rows.forEach((r, i) => {
    if (r.category !== 'repeat-negative') return;
    rows.forEach((o, j) => {
      if (j === i) return;
      const s = sim(i, j);
      if (s >= REPEAT_THRESHOLD) negativesMatched.push({ id: r.id, with: o.id, similarity: s });
    });
  });

  return {
    threshold: REPEAT_THRESHOLD,
    minWords: REPEAT_MIN_WORDS,
    version: SIGNATURE_VERSION,
    rows: rows.length,
    signed: sigs.filter(Boolean).length,
    unsigned: rows.filter((_, i) => !sigs[i]).map((r) => r.id),
    pairs,
    families,
    negativesMatched,
  };
}
