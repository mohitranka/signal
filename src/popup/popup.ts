import { PROMPT_VERSION } from '../classifier/prompt';
import { MIN_PER_SIDE, correctionReport, feedbackToInputs, partitionCorrections, type Excluded, type ExclusionReason } from '../corrections';
import { COLLAPSE_CONFIDENCE } from '../policy';
import { MAX_FEEDBACK_ENTRIES, isVerdict } from '../shared/feedback';
import type { FeedbackEntry, Mode, PageStats, PopupMessage, PublicSettings, Sensitivity, Settings, Stats } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(msg: PopupMessage): Promise<T> => chrome.runtime.sendMessage(msg);

/** Create an element with text content only: nothing in the popup is ever parsed as HTML. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  if (className) n.className = className;
  return n;
}

const SENS_LABEL: Record<Sensitivity, string> = { relaxed: 'Relaxed', balanced: 'Balanced', strict: 'Strict' };
const MODE_HELP: Record<Mode, string> = {
  review: 'Annotates posts. Nothing is hidden.',
  active: 'Collapses confident low-quality posts.',
};
const atLeast = (s: Sensitivity) => `≥${Math.round(COLLAPSE_CONFIDENCE[s] * 100)}% confident`;
const SENS_HELP: Record<Sensitivity, string> = {
  relaxed: `Only the clearest noise · ${atLeast('relaxed')}`,
  balanced: `Confident noise only · ${atLeast('balanced')}`,
  strict: `More aggressive, more mistakes · ${atLeast('strict')}`,
};

let settings: PublicSettings | null = null;
let feedback: Record<string, FeedbackEntry> = {};

function setStatus(text: string, err = false): void {
  const s = $('llmStatus');
  s.textContent = text;
  s.className = err ? 'err' : '';
}

const radios = (name: string) => Array.from(document.querySelectorAll<HTMLInputElement>(`input[name=${name}]`));

function renderHeader(s: PublicSettings): void {
  const line = $('statusLine');
  line.classList.remove('warn');
  if (!s.enabled) line.textContent = 'Paused';
  else if (!s.model) {
    line.textContent = 'Set up a model to start';
    line.classList.add('warn');
  } else line.textContent = `${s.mode === 'review' ? 'Reviewing' : 'Filtering'} · ${SENS_LABEL[s.sensitivity]}`;
}

function fill(s: PublicSettings): void {
  settings = s;
  $<HTMLInputElement>('enabled').checked = s.enabled;
  for (const r of radios('mode')) r.checked = r.value === s.mode;
  for (const r of radios('sensitivity')) r.checked = r.value === s.sensitivity;
  $('modeHelp').textContent = MODE_HELP[s.mode];
  $('sensHelp').textContent = SENS_HELP[s.sensitivity];
  $<HTMLInputElement>('highlight').checked = s.highlight;
  $<HTMLInputElement>('endpoint').value = s.endpoint;
  $<HTMLInputElement>('model').value = s.model;
  const key = $<HTMLInputElement>('apiKey');
  key.value = '';
  key.placeholder = s.hasApiKey ? 'Saved · leave blank to keep' : 'sk-…';
  $<HTMLInputElement>('concurrency').value = String(s.concurrency);
  $<HTMLInputElement>('timeoutS').value = String(s.timeoutMs / 1000);
  $<HTMLInputElement>('inputPrice').value = s.inputPricePerM === null ? '' : String(s.inputPricePerM);
  $<HTMLInputElement>('outputPrice').value = s.outputPricePerM === null ? '' : String(s.outputPricePerM);
  const preset = $<HTMLSelectElement>('preset');
  preset.value = [...preset.options].some((o) => o.value === s.endpoint) ? s.endpoint : '';

  const chip = $('llmChip');
  chip.textContent = s.model ? (s.model.split('/').pop() || s.model) : 'Not set up';
  chip.title = s.model || 'No model configured';
  chip.classList.toggle('warn', !s.model);
  if (!s.model) $<HTMLDetailsElement>('llm').open = true;

  renderHeader(s);
}

async function patch(p: Partial<Settings>): Promise<void> {
  fill(await send<PublicSettings>({ type: 'saveSettings', patch: p }));
  // Sensitivity marks the current row; a new model changes what can be scored.
  renderCorrections();
}

const numOrNull = (id: string): number | null => {
  const v = $<HTMLInputElement>(id).value.trim();
  return v === '' ? null : Number(v);
};

/** Ask for access to the configured LLM host. Must run directly inside the click handler (user gesture). */
async function requestHostAccess(endpoint: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    setStatus('Endpoint is not a valid URL.', true);
    return false;
  }
  const origin = `${url.protocol}//${url.hostname}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) setStatus(`Permission to contact ${url.hostname} was not granted.`, true);
  return granted;
}

async function saveLlm(): Promise<boolean> {
  const endpoint = $<HTMLInputElement>('endpoint').value.trim();
  if (!(await requestHostAccess(endpoint))) return false;
  await patch({
    endpoint,
    model: $<HTMLInputElement>('model').value.trim(),
    apiKey: $<HTMLInputElement>('apiKey').value.trim(),
    concurrency: Number($<HTMLInputElement>('concurrency').value),
    timeoutMs: Number($<HTMLInputElement>('timeoutS').value) * 1000,
    inputPricePerM: numOrNull('inputPrice'),
    outputPricePerM: numOrNull('outputPrice'),
  });
  return true;
}

// ---- Session ------------------------------------------------------------------------------------

const trimZero = (s: string) => s.replace(/\.0$/, '');
/** 999, 1.5k, 218k, 2.5M */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${trimZero((n / 1000).toFixed(1))}k`;
  const k = Math.round(n / 1000);
  if (k < 1000) return `${k}k`;
  return `${trimZero((n / 1e6).toFixed(1))}M`;
}
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function tile(id: string, value: string, title: string): void {
  $(id).textContent = value;
  $(id).parentElement!.title = title;
}

async function refreshStats(): Promise<void> {
  const r = await send<{ stats: Stats; cacheSize: number; prices: { input: number | null; output: number | null } }>({ type: 'getStats' });
  const s = r.stats;
  const latency = s.classified > 0 ? ` · avg latency ${Math.round(s.totalLatencyMs / s.classified)} ms` : '';
  tile('stClassified', compact(s.classified), `${plural(s.httpRequests, 'HTTP request', 'HTTP requests')}${latency}`);
  tile('stCache', compact(s.cacheHits), plural(r.cacheSize, 'entry stored', 'entries stored'));
  tile('stTokens', compact(s.promptTokens + s.completionTokens), `${s.promptTokens.toLocaleString()} in · ${s.completionTokens.toLocaleString()} out`);
  if (r.prices.input !== null && r.prices.output !== null) {
    const cost = (s.promptTokens * r.prices.input + s.completionTokens * r.prices.output) / 1e6;
    tile('stCost', `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`, 'Estimated from your configured prices');
  } else {
    tile('stCost', '—', 'Add $/1M token prices under Model › Advanced');
  }

  const parts: (string | HTMLElement)[] = [];
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined && tab.url?.startsWith('https://www.linkedin.com/')) {
      const p: PageStats | undefined = await chrome.tabs.sendMessage(tab.id, { type: 'getPageStats' });
      if (p) parts.push(`This tab: ${p.collapsed} collapsed, ${p.highlighted} highlighted`);
    }
  } catch {
    /* no content script in the active tab */
  }
  if (s.failures > 0) {
    if (parts.length) parts.push(' · ');
    parts.push(el('span', `${s.failures.toLocaleString()} failed`, 'bad'));
  }
  $('stats').replaceChildren(...parts);
}

// ---- Feedback -----------------------------------------------------------------------------------

const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const newestFirst = (entries: [string, FeedbackEntry][]) => entries.sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0));

function renderFeedbackList(): void {
  const entries = newestFirst(Object.entries(feedback));
  $('fbCount').textContent = entries.length ? String(entries.length) : '';
  const full = $('fbFull');
  full.hidden = entries.length < MAX_FEEDBACK_ENTRIES;
  full.textContent = full.hidden ? '' : `Feedback is full (${MAX_FEEDBACK_ENTRIES.toLocaleString('en-US')} corrections). Export it, then Reset, to keep adding.`;
  const list = $('fbList');
  if (!entries.length) {
    list.replaceChildren(el('li', 'No feedback yet.', 'empty'));
    return;
  }
  list.replaceChildren(
    ...entries.map(([, e]) => {
      const keep = e.verdict === 'keep';
      const li = el('li');
      li.title = String(e.sample ?? '');
      li.append(el('span', keep ? 'Keep' : 'Low', `pill ${keep ? 'keep' : 'low'}`), el('span', oneLine(e.sample), 'text'));
      return li;
    }),
  );
}

/** Feedback from the background, keeping only entries with a valid verdict (defence in depth: the store filters too). */
async function loadFeedback(): Promise<Record<string, FeedbackEntry>> {
  const all = await send<Record<string, FeedbackEntry>>({ type: 'listFeedback' });
  if (!all || typeof all !== 'object') return {};
  return Object.fromEntries(Object.entries(all).filter(([, e]) => e && typeof e === 'object' && isVerdict(e.verdict)));
}

async function refreshFeedback(): Promise<void> {
  feedback = await loadFeedback();
  renderFeedbackList();
  renderCorrections();
}

// ---- Your corrections ---------------------------------------------------------------------------

const REASON_ORDER: readonly ExclusionReason[] = ['no-classification', 'different-model', 'different-prompt'];
const REASON_LABEL: Record<ExclusionReason, string> = {
  'no-classification': 'no classification',
  'different-model': 'other model',
  'different-prompt': 'older prompt',
};

function renderLeftOut(excluded: Excluded[]): void {
  const box = $<HTMLDetailsElement>('corrLeftOut');
  box.hidden = excluded.length === 0;
  if (!excluded.length) return;
  const count = (r: ExclusionReason) => excluded.filter((x) => x.reason === r).length;
  const parts = REASON_ORDER.filter((r) => count(r) > 0).map((r) => `${count(r)} ${REASON_LABEL[r]}`);
  $('corrLeftOutSummary').textContent = `${excluded.length} left out · ${parts.join(', ')}`;
  const at = (x: Excluded) => Number(feedback[x.id]?.at) || 0;
  const sorted = [...excluded].sort((a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) || at(b) - at(a));
  $('corrLeftOutList').replaceChildren(
    ...sorted.map((x) => {
      const sample = String(feedback[x.id]?.sample ?? '');
      const li = el('li');
      li.title = x.model ? `${sample}\n\n${x.model} · prompt ${x.promptVersion}` : sample;
      li.append(el('span', REASON_LABEL[x.reason], 'pill neutral'), el('span', oneLine(sample), 'text'));
      return li;
    }),
  );
}

function renderCorrections(): void {
  if (!settings) return;
  const table = $('corrTable');
  const empty = $('corrEmpty');
  const notes = $('corrNotes');
  const target = $('corrTarget');
  notes.replaceChildren();
  const showEmpty = (text: string) => {
    table.hidden = true;
    empty.hidden = false;
    empty.textContent = text;
  };

  const model = settings.model;
  if (!model) {
    $('corrCount').textContent = '';
    target.hidden = true;
    $('corrLeftOut').hidden = true;
    return showEmpty('Set up a model to compare your corrections against it.');
  }

  const { included, excluded } = partitionCorrections(feedbackToInputs(feedback), { model, promptVersion: PROMPT_VERSION });
  target.hidden = false;
  target.textContent = `Against ${model} · prompt ${PROMPT_VERSION}`;
  $('corrCount').textContent = included.length ? `${included.length} scored` : '';
  renderLeftOut(excluded);

  if (!included.length) {
    return showEmpty(
      Object.keys(feedback).length
        ? 'None of your corrections were classified by this model and prompt yet. New ones will be.'
        : 'No corrections yet. Mark posts in the feed to see how each sensitivity would have done.',
    );
  }

  empty.hidden = true;
  table.hidden = false;
  const r = correctionReport(included);
  $('corrHidSub').textContent = `of ${r.keptTotal} kept`;
  $('corrMisSub').textContent = `of ${r.lowQualityTotal} low quality`;
  const cell = (n: number, total: number, meaningful: boolean, redWhenAny: boolean) => {
    const td = el('td', total === 0 ? '—' : String(n));
    if (!meaningful) td.className = 'weak';
    else if (redWhenAny && n > 0) td.className = 'bad';
    td.setAttribute('aria-label', `${n} of ${total}`);
    return td;
  };
  $('corrRows').replaceChildren(
    ...r.rows.map((row) => {
      const tr = el('tr', '', row.sensitivity === settings!.sensitivity ? 'current' : '');
      const th = el('th', SENS_LABEL[row.sensitivity]);
      th.scope = 'row';
      tr.append(th, cell(row.wronglyHidden, r.keptTotal, r.hiddenMeaningful, true), cell(row.missed, r.lowQualityTotal, r.missedMeaningful, false));
      return tr;
    }),
  );

  const note = (t: string) => notes.append(el('li', t));
  if (!r.hiddenMeaningful && !r.missedMeaningful) {
    note(`Too few to judge yet: ${MIN_PER_SIDE}+ of each needed (you have ${r.keptTotal} kept, ${r.lowQualityTotal} low quality).`);
  } else if (!r.hiddenMeaningful) {
    note(`Too few to judge “wrongly hidden” yet: ${r.keptTotal} of ${MIN_PER_SIDE} “worth keeping” needed.`);
  } else if (!r.missedMeaningful) {
    note(`Too few to judge “missed” yet: ${r.lowQualityTotal} of ${MIN_PER_SIDE} “low quality” needed.`);
  }
}

async function exportFeedback(): Promise<void> {
  const all = await loadFeedback();
  const lines = Object.entries(all).map(([id, e]) =>
    JSON.stringify({
      id: `user-${id}`,
      source: 'user-feedback',
      label: e.verdict === 'collapse' ? 'collapse' : 'keep',
      text: e.sample,
      model_decision: e.modelDecision,
      model_confidence: e.modelConfidence,
      // The classification this entry corrected, so `npm run eval -- --mode stored` can score it with no API calls.
      ...(e.classified ? { classification: e.classified.classification, model: e.classified.model, prompt_version: e.classified.promptVersion } : {}),
      // A corrupted timestamp must not break the whole export: leave it out.
      ...(Number.isFinite(new Date(e.at).getTime()) ? { at: new Date(e.at).toISOString() } : {}),
    }),
  );
  const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'signal-feedback.jsonl';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Wiring -------------------------------------------------------------------------------------

async function init(): Promise<void> {
  fill(await send<PublicSettings>({ type: 'getSettings' }));

  $('enabled').addEventListener('change', (e) => void patch({ enabled: (e.target as HTMLInputElement).checked }));
  for (const r of radios('mode')) r.addEventListener('change', () => r.checked && void patch({ mode: r.value as Mode }));
  for (const r of radios('sensitivity')) r.addEventListener('change', () => r.checked && void patch({ sensitivity: r.value as Sensitivity }));
  $('highlight').addEventListener('change', (e) => void patch({ highlight: (e.target as HTMLInputElement).checked }));
  $('preset').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) $<HTMLInputElement>('endpoint').value = v;
  });

  $('save').addEventListener('click', async () => {
    setStatus('');
    if (await saveLlm()) setStatus('Saved.');
  });
  $('test').addEventListener('click', async () => {
    setStatus('Testing…');
    if (!(await saveLlm())) return;
    const r = await send<{ ok: true; latencyMs: number; decision: string } | { ok: false; kind: string; message: string }>({ type: 'testConnection' });
    if (r.ok) setStatus(`Connected · replied in ${r.latencyMs} ms (test post rated: ${r.decision})`);
    else setStatus(`${r.kind}: ${r.message}${r.kind === 'network' ? ' (If this persists, check the endpoint URL and that host access was granted when saving.)' : ''}`, true);
    void refreshStats();
  });

  $('fbExport').addEventListener('click', () => void exportFeedback());
  $('fbReset').addEventListener('click', async () => {
    if (confirm('Delete all saved feedback?')) {
      await send({ type: 'clearFeedback' });
      await refreshFeedback();
    }
  });
  $('cacheReset').addEventListener('click', async () => {
    await send({ type: 'clearCache' });
    void refreshStats();
  });

  await Promise.all([refreshStats(), refreshFeedback()]);
}

void init();
