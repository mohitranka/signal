/**
 * Evaluate a classifier against a labeled dataset.
 *
 *   SIGNAL_ENDPOINT=https://openrouter.ai/api/v1 SIGNAL_MODEL=... SIGNAL_API_KEY=... \
 *     npm run eval -- --split test
 *
 * Options: --split dev|test | --file path.jsonl   --mode llm|baseline|stored   --concurrency N
 *          --limit N   --in-price USD/1M   --out-price USD/1M   --rescore results/file.json
 * Raw predictions are written to eval/results/ so thresholds can be re-scored offline (--rescore).
 *
 * --mode stored scores exported feedback (popup "Export JSONL") from the classifications stored with it:
 *   npm run eval -- --file signal-feedback.jsonl --mode stored
 * No API calls and no credentials; rows are grouped by model and prompt version.
 *
 * --mode repeats reports which rows would be treated as the same template (repeated-template matching), offline:
 *   npm run eval -- --file eval/repeats.jsonl --mode repeats
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { baselineClassify } from './baseline';
import { Prediction, formatMetrics, loadDataset, score, toInput, usageSummary, type Row } from './lib';
import { classifyPost } from '../src/classifier/client';
import { printable } from '../src/classifier/parse';
import { TaskQueue } from '../src/classifier/queue';
import { MIN_PER_SIDE, correctionReport, groupCorrections, rowsToInputs } from '../src/corrections';
import { prepareInput } from '../src/shared/post';
import { repeatReport } from './repeats';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

async function main() {
  let preds: Prediction[];
  const mode = opt('mode') ?? 'llm';
  const rescore = opt('rescore');

  if (rescore) {
    preds = JSON.parse(readFileSync(rescore, 'utf8')).predictions;
  } else {
    const file = opt('file') ?? `eval/${opt('split') ?? 'dev'}.jsonl`;
    let rows: Row[] = loadDataset(file);
    const limit = Number(opt('limit') ?? 0);
    if (limit > 0) rows = rows.slice(0, limit);
    console.log(`dataset ${file}: ${rows.length} rows (${rows.filter((r) => r.source === 'synthetic').length} synthetic)`);

    if (mode === 'stored') return reportStored(rows);
    if (mode === 'repeats') return reportRepeats(rows);
    if (mode === 'baseline') {
      preds = rows.map((row) => ({ row, classification: baselineClassify(toInput(row)) }));
    } else {
      const cfg = {
        endpoint: process.env.SIGNAL_ENDPOINT ?? '',
        model: process.env.SIGNAL_MODEL ?? '',
        apiKey: process.env.SIGNAL_API_KEY ?? '',
        timeoutMs: 60_000,
        jsonMode: true,
      };
      if (!cfg.endpoint || !cfg.model) throw new Error('Set SIGNAL_ENDPOINT and SIGNAL_MODEL (and SIGNAL_API_KEY unless local).');
      const queue = new TaskQueue(Number(opt('concurrency') ?? 3));
      preds = await Promise.all(
        rows.map((row) =>
          queue.run(row.id, async (): Promise<Prediction> => {
            try {
              const out = await classifyPost(cfg, prepareInput(toInput(row)));
              return { row, classification: out.classification, latencyMs: out.latencyMs, promptTokens: out.promptTokens, completionTokens: out.completionTokens, httpRequests: out.httpRequests };
            } catch (e) {
              return { row, classification: null, error: (e as Error).message };
            }
          }),
        ),
      );
      mkdirSync('eval/results', { recursive: true });
      const path = `eval/results/${mode}-${cfg.model.replace(/[^\w.-]+/g, '_')}-${Date.now()}.json`;
      writeFileSync(path, JSON.stringify({ model: cfg.model, predictions: preds }, null, 1));
      console.log(`raw predictions saved to ${path} (contain post text; git-ignored)`);
    }
  }

  const inP = opt('in-price') ? Number(opt('in-price')) : undefined;
  const outP = opt('out-price') ? Number(opt('out-price')) : undefined;
  console.log(`\nresults (${preds.length} posts, ${preds.filter((p) => !p.classification).length} classification failures scored as keep):`);
  for (const s of ['relaxed', 'balanced', 'strict'] as const) console.log(formatMetrics(s, score(preds, s)));
  if (mode === 'llm') console.log('\nusage:\n' + usageSummary(preds, inP, outP));

  const firstErr = preds.find((p) => p.error)?.error;
  if (firstErr) console.log(`\nfirst classification error: ${printable(firstErr)}`);

  const bal = score(preds, 'balanced');
  if (bal.falsePositives.length) console.log(`\nbalanced false positives: ${bal.falsePositives.map(printable).join(', ')}`);
  const adv = preds.filter((p) => p.row.adversarial);
  if (adv.length) {
    const a = score(adv, 'balanced');
    const right = adv.filter((p) => {
      const o = p.classification ? score([p], 'balanced') : null;
      return o && (o.confusion[p.row.label][p.row.label] > 0 || (p.row.also_ok ?? []).some((x) => o.confusion[p.row.label][x] > 0));
    }).length;
    console.log(`adversarial subset (${adv.length}): ${right} correct under balanced, FPR=${a.falsePositiveRate === null ? 'n/a' : (a.falsePositiveRate * 100).toFixed(1) + '%'}`);
  }
  console.log('\nNote: labels on synthetic rows were written by the same agent that built the extension; they are not independent ground truth.');
}

/** Score rows by the classifications stored with them (exported feedback): the popup's numbers, offline. */
function reportStored(rows: Row[]): void {
  console.log('mode stored: scoring stored classifications, no API calls');
  const { groups, excluded } = groupCorrections(rowsToInputs(rows));
  if (!groups.length) console.log('\nno rows with stored classifications');
  for (const g of groups) {
    const n = g.included.length;
    console.log(`\ngroup model=${printable(g.model)} prompt=${printable(g.promptVersion)}: ${n} row${n === 1 ? '' : 's'}`);
    for (const s of ['relaxed', 'balanced', 'strict'] as const) console.log(formatMetrics(s, score(g.included, s)));
    const r = correctionReport(g.included);
    console.log(`  corrections: ${r.rows.map((x) => `${x.sensitivity} hidden ${x.wronglyHidden}/${r.keptTotal} missed ${x.missed}/${r.lowQualityTotal}`).join(' | ')}`);
    if (!r.hiddenMeaningful || !r.missedMeaningful) {
      console.log(`  too few to judge: need ${MIN_PER_SIDE}+ worth keeping and ${MIN_PER_SIDE}+ low quality (have ${r.keptTotal} and ${r.lowQualityTotal})`);
    }
    if (r.copiedTotal > 0) {
      const parts = r.rows.map((x) => `${x.sensitivity} hidden ${x.copiedWronglyHidden ?? 0} missed ${x.copiedMissed ?? 0}`);
      console.log(`  copied from a similar post (${r.copiedTotal}): ${parts.join(' | ')}`);
    }
    const fp = score(g.included, 'balanced').falsePositives;
    if (fp.length) console.log(`  balanced false positives: ${fp.map(printable).join(', ')}`);
  }
  if (excluded.length) console.log(`\nleft out (no stored classification): ${excluded.length} (${excluded.map((x) => printable(x.id)).join(', ')})`);
}

/** Which rows the signature treats as the same template (docs/design-repeats.md), offline. */
function reportRepeats(rows: Row[]): void {
  const r = repeatReport(rows);
  const byId = new Map(rows.map((x) => [x.id, x]));
  const preview = (id: string) => printable((byId.get(id)?.text ?? '').replace(/\s+/g, ' ').slice(0, 120));
  const under = r.unsigned.length;
  console.log('mode repeats: offline, no API calls');
  console.log(`signed ${r.signed} of ${r.rows} rows (${under} under ${r.minWords} words: exact match only)`);
  console.log(`threshold ${r.threshold} · minimum ${r.minWords} words · signature v${r.version}`);

  const different = r.pairs.filter((p) => !p.sameLabel);
  console.log(`\nmatched pairs: ${r.pairs.length}`);
  console.log(`  same label:      ${r.pairs.length - different.length}`);
  console.log(`  different label: ${different.length}`);
  for (const p of different) {
    console.log(`    ${printable(p.a)} ↔ ${printable(p.b)}  ${p.similarity.toFixed(2)}  ${p.labels[0]} ≠ ${p.labels[1]}`);
    console.log(`      ${printable(p.a)}: ${preview(p.a)}`);
    console.log(`      ${printable(p.b)}: ${preview(p.b)}`);
  }

  if (r.families.length) {
    console.log('\ntemplate families (rows sharing a "family" field):');
    for (const f of r.families) {
      const missed = f.missed.map((m) => `${printable(m.id)} (best ${m.best.toFixed(2)})`).join(', ');
      console.log(`  ${printable(f.family)}  ${f.matched}/${f.size} rows matched together${missed ? `  missed: ${missed}` : ''}`);
    }
  } else {
    console.log('\ntemplate families: none in this file');
  }

  const negatives = rows.filter((x) => x.category === 'repeat-negative').length;
  const matchedNegatives = new Set(r.negativesMatched.map((n) => n.id)).size;
  console.log(`hard negatives matched to anything: ${matchedNegatives} of ${negatives}`);
  for (const n of r.negativesMatched) console.log(`  ${printable(n.id)} ~ ${printable(n.with)}  ${n.similarity.toFixed(2)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
