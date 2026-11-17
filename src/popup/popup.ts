import { PROMPT_VERSION } from '../classifier/prompt';
import { MIN_PER_SIDE, correctionReport, feedbackToInputs, partitionCorrections, type Excluded, type ExclusionReason } from '../corrections';
import { COLLAPSE_CONFIDENCE } from '../policy';
import { MAX_FEEDBACK_ENTRIES, isVerdict } from '../shared/feedback';
import { REPEAT_MIN_WORDS } from '../shared/similarity';
import { LOCAL_HOSTS } from '../shared/settings';
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

// ---- Local CLI bridge (docs/design-bridge.md §8) ------------------------------------------------
const BRIDGE_ENDPOINT = 'http://127.0.0.1:8791/v1';
/** The bridge serves `claude-code/<model>` or `codex/<model>`. */
const BRIDGE_CLI = new Map([['claude-code', { label: 'Claude Code', cli: 'claude' }], ['codex', { label: 'Codex', cli: 'codex' }]]);
const bridgeOf = (model: string | undefined) => BRIDGE_CLI.get(/^([a-z-]+)\//.exec(model ?? '')?.[1] ?? '');
/** The form is set up for the bridge: its preset chosen, or a bridge model id typed (a bridge on another port is "Custom"). */
/** Security B7: the bridge only ever listens on this computer; a bridge-like model id elsewhere is not the bridge. */
function isLocal(endpoint: string | undefined): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(endpoint ?? '').hostname);
  } catch {
    return false;
  }
}
/** The saved settings are the bridge: a bridge model id on a local endpoint (chip, cost tile, Test connection). */
const bridgeSaved = () => (isLocal(settings?.endpoint) ? bridgeOf(settings?.model) : undefined);
/** The form is set up for the bridge: its preset, or a bridge model id with a local endpoint typed. */
const bridgeForm = () =>
  $<HTMLSelectElement>('preset').value === BRIDGE_ENDPOINT ||
  (!!bridgeOf($<HTMLInputElement>('model').value.trim()) && isLocal($<HTMLInputElement>('endpoint').value.trim()));

/** Test-connection problems in the bridge's words (auth and config already carry the bridge's own message). */
function bridgeProblem(kind: string, message: string, cli: string): string {
  if (kind === 'network') {
    let where = '127.0.0.1:8791';
    try {
      where = new URL(settings?.endpoint ?? '').host;
    } catch {
      /* keep the default */
    }
    return `Could not reach the bridge at ${where}. Is it running? npm run bridge -- --cli ${cli}`;
  }
  if (kind === 'rate_limit') return 'The bridge is busy (one post at a time); Signal retries automatically.';
  return message;
}

/** Token label, price fields and help line follow the form (mockups: docs/mockups/bridge/). */
function applyBridgeForm(): void {
  const bridge = bridgeForm();
  $('apiKeyLabel').textContent = bridge ? 'Bridge token' : 'API key';
  $('presetHelp').hidden = $<HTMLSelectElement>('preset').value !== BRIDGE_ENDPOINT;
  for (const [id, stored] of [['inputPrice', settings?.inputPricePerM], ['outputPrice', settings?.outputPricePerM]] as const) {
    const f = $<HTMLInputElement>(id);
    if (bridge && !f.disabled) {
      f.disabled = true;
      f.value = '';
      f.placeholder = 'not used';
    } else if (!bridge && f.disabled) {
      f.disabled = false;
      f.value = stored === null || stored === undefined ? '' : String(stored);
      f.placeholder = 'optional';
    }
  }
}

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
  $<HTMLInputElement>('repeats').checked = s.repeats === true;
  $('repeatsHelp').textContent = `Posts of ${REPEAT_MIN_WORDS}+ words that match one already judged, with a name, number or emoji changed, reuse its verdict instead of calling the model.`;
  const preset = $<HTMLSelectElement>('preset');
  preset.value = [...preset.options].some((o) => o.value === s.endpoint) ? s.endpoint : '';

  const chip = $('llmChip');
  // A bridge model shows which CLI serves it: "claude-code · sonnet" (the last segment alone would hide that).
  chip.textContent = !s.model ? 'Not set up' : bridgeOf(s.model) && isLocal(s.endpoint) ? s.model.replace('/', ' · ') : s.model.split('/').pop() || s.model;
  chip.title = s.model || 'No model configured';
  chip.classList.toggle('warn', !s.model);
  if (!s.model) $<HTMLDetailsElement>('llm').open = true;
  for (const id of ['inputPrice', 'outputPrice']) $<HTMLInputElement>(id).disabled = false; // re-applied below
  applyBridgeForm();

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
  // Bridge models have no per-token price: the stored prices stay as they are (for other providers) rather than being cleared.
  const prices = bridgeForm() ? {} : { inputPricePerM: numOrNull('inputPrice'), outputPricePerM: numOrNull('outputPrice') };
  await patch({
    endpoint,
    model: $<HTMLInputElement>('model').value.trim(),
    apiKey: $<HTMLInputElement>('apiKey').value.trim(),
    concurrency: Number($<HTMLInputElement>('concurrency').value),
    timeoutMs: Number($<HTMLInputElement>('timeoutS').value) * 1000,
    ...prices,
    repeats: $<HTMLInputElement>('repeats').checked,
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

/**
 * A session tile. Its tooltip starts with the shown value, which a narrow tile may show with an ellipsis (finding F).
 * `spoken`: what a screen reader reads instead of the shown value (finding K: "<$0.01" → "under 1 cent"); the tiles are
 * updated in place, so it is set or cleared every time.
 */
function tile(id: string, value: string, title: string, spoken = ''): void {
  const el = $(id);
  el.textContent = value;
  el.parentElement!.title = value === '—' ? title : `${value} · ${title}`;
  const next = el.nextElementSibling;
  const sr = next?.classList.contains('sr') ? next : null;
  if (spoken) {
    el.setAttribute('aria-hidden', 'true');
    if (sr) sr.textContent = spoken;
    else el.after(Object.assign(el.ownerDocument.createElement('span'), { className: 'sr', textContent: spoken }));
  } else {
    el.removeAttribute('aria-hidden');
    sr?.remove();
  }
}

/** Finding J: every tile's detail as a line of text, for keyboard, touch and screen-reader users (the tooltips stay). */
function renderDetails(lines: [label: string, text: string][]): void {
  // Replaced inside the existing list, so the disclosure keeps its open or closed state across refreshes.
  $('statsDetailList').replaceChildren(
    ...lines.map(([label, text]) => {
      const li = el('li');
      li.append(el('b', `${label}: `), text);
      return li;
    }),
  );
}

async function refreshStats(): Promise<void> {
  const r = await send<{ stats: Stats; cacheSize: number; repeatIndexSize?: number; prices: { input: number | null; output: number | null } }>({ type: 'getStats' });
  const s = r.stats;
  const n = (x: number) => x.toLocaleString();
  const latency = s.classified > 0 ? ` · avg latency ${n(Math.round(s.totalLatencyMs / s.classified))} ms` : '';
  const requests = `${plural(s.httpRequests, 'HTTP request', 'HTTP requests')}${latency}`;
  const stored = plural(r.cacheSize, 'entry stored', 'entries stored');
  const repeats = `${n(s.repeatHits ?? 0)} copied from a similar post · no model call · ${n(r.repeatIndexSize ?? 0)} stored`;
  const tokens = `${n(s.promptTokens)} in · ${n(s.completionTokens)} out`;
  tile('stClassified', compact(s.classified), requests);
  tile('stCache', compact(s.cacheHits), stored);
  tile('stRepeats', compact(s.repeatHits ?? 0), `Copied from a similar post · no model call · ${n(r.repeatIndexSize ?? 0)} stored`);
  tile('stTokens', compact(s.promptTokens + s.completionTokens), tokens);
  let costLine: [string, string];
  const bridge = bridgeSaved();
  if (bridge) {
    // Security B4: "Plan" (normally a subscription), but billing is however the CLI itself is set up.
    const how = `through your ${bridge.label} login via the local bridge · no per-token estimate (billed as your CLI is set up)`;
    tile('stCost', 'Plan', how[0]!.toUpperCase() + how.slice(1));
    costLine = ['Plan', how];
  } else if (r.prices.input !== null && r.prices.output !== null) {
    const cost = (s.promptTokens * r.prices.input + s.completionTokens * r.prices.output) / 1e6;
    // Finding K: a tile has room for "<$0.01" but not for "$0.0070"; the exact amount is in the tooltip and the details.
    const exact = cost === 0 ? '$0.00' : `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
    const shown = cost === 0 ? '$0.00' : cost < 0.01 ? '<$0.01' : exact;
    tile('stCost', shown, shown === exact ? 'Estimated from your configured prices' : `${exact} estimated from your configured prices`, shown === '<$0.01' ? 'under 1 cent' : '');
    costLine = ['Estimated cost', `${exact} from your configured prices`];
  } else {
    tile('stCost', '—', 'Add $/1M token prices under Model › Advanced');
    costLine = ['Estimated cost', 'add $/1M token prices under Model › Advanced'];
  }
  renderDetails([
    ['Classified', `${n(s.classified)} posts · ${requests}`],
    ['Cache hits', `${n(s.cacheHits)} · ${stored}`],
    ['Repeats', repeats],
    ['Tokens', tokens],
    costLine,
  ]);

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
  const copiedLine = $('corrCopied');
  notes.replaceChildren();
  copiedLine.hidden = true;
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

  // Corrections on verdicts copied from a similar post, at the current sensitivity (same report, same score()).
  if (r.copiedTotal > 0) {
    const row = r.rows.find((x) => x.sensitivity === settings!.sensitivity)!;
    copiedLine.replaceChildren(
      'On verdicts copied from a similar post: ',
      el('b', String(row.copiedWronglyHidden ?? 0)),
      ' wrongly hidden, ',
      el('b', String(row.copiedMissed ?? 0)),
      ` missed at ${SENS_LABEL[row.sensitivity]} (${r.copiedTotal} correction${r.copiedTotal === 1 ? '' : 's'}).`,
    );
    copiedLine.hidden = false;
  }

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
      // The classification was copied from a similar post: which one, and how similar (eval counts these separately).
      ...(e.classified?.repeatOf ? { repeat_of: e.classified.repeatOf.fp, repeat_similarity: e.classified.repeatOf.similarity } : {}),
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
    if (v === BRIDGE_ENDPOINT) {
      // The bridge runs one CLI call at a time, and a call takes seconds.
      $<HTMLInputElement>('concurrency').value = '1';
      $<HTMLInputElement>('timeoutS').value = '90';
    }
    applyBridgeForm();
  });
  $('model').addEventListener('input', applyBridgeForm);
  $('endpoint').addEventListener('input', applyBridgeForm);

  $('save').addEventListener('click', async () => {
    setStatus('');
    if (await saveLlm()) setStatus('Saved.');
  });
  $('test').addEventListener('click', async () => {
    setStatus('Testing…');
    if (!(await saveLlm())) return;
    const r = await send<{ ok: true; latencyMs: number; decision: string } | { ok: false; kind: string; message: string }>({ type: 'testConnection' });
    const bridge = bridgeSaved();
    if (r.ok) setStatus(`Connected · replied in ${r.latencyMs.toLocaleString('en-US')} ms (test post rated: ${r.decision})${bridge ? ` · via your ${bridge.label} login` : ''}`);
    else setStatus(`${r.kind}: ${bridge ? bridgeProblem(r.kind, r.message, bridge.cli) : r.message}${!bridge && r.kind === 'network' ? ' (If this persists, check the endpoint URL and that host access was granted when saving.)' : ''}`, true);
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
