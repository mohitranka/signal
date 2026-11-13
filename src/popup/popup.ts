import type { FeedbackEntry, PageStats, PopupMessage, PublicSettings, Settings, Stats } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(msg: PopupMessage): Promise<T> => chrome.runtime.sendMessage(msg);

function setStatus(text: string, err = false): void {
  const el = $('llmStatus');
  el.textContent = text;
  el.className = err ? 'err' : '';
}

function fill(s: PublicSettings): void {
  $<HTMLInputElement>('enabled').checked = s.enabled;
  $<HTMLSelectElement>('mode').value = s.mode;
  $<HTMLSelectElement>('sensitivity').value = s.sensitivity;
  $<HTMLInputElement>('highlight').checked = s.highlight;
  $<HTMLInputElement>('endpoint').value = s.endpoint;
  $<HTMLInputElement>('model').value = s.model;
  const key = $<HTMLInputElement>('apiKey');
  key.value = '';
  key.placeholder = s.hasApiKey ? 'saved (leave blank to keep)' : 'sk-…';
  $<HTMLInputElement>('concurrency').value = String(s.concurrency);
  $<HTMLInputElement>('timeoutS').value = String(s.timeoutMs / 1000);
  $<HTMLInputElement>('inputPrice').value = s.inputPricePerM === null ? '' : String(s.inputPricePerM);
  $<HTMLInputElement>('outputPrice').value = s.outputPricePerM === null ? '' : String(s.outputPricePerM);
  const preset = $<HTMLSelectElement>('preset');
  preset.value = [...preset.options].some((o) => o.value === s.endpoint) ? s.endpoint : '';
}

async function patch(p: Partial<Settings>): Promise<void> {
  fill(await send<PublicSettings>({ type: 'saveSettings', patch: p }));
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

async function refreshStats(): Promise<void> {
  const r = await send<{ stats: Stats; cacheSize: number; prices: { input: number | null; output: number | null } }>({ type: 'getStats' });
  const s = r.stats;
  const lines = [
    `LLM calls: ${s.classified} classified, ${s.httpRequests} HTTP requests, ${s.failures} failed`,
    `Cache: ${s.cacheHits} hits this session, ${r.cacheSize} entries stored`,
    `Tokens: ${s.promptTokens.toLocaleString()} in / ${s.completionTokens.toLocaleString()} out`,
  ];
  if (s.classified > 0) lines.push(`Avg latency: ${Math.round(s.totalLatencyMs / s.classified)} ms`);
  if (r.prices.input !== null && r.prices.output !== null) {
    const cost = (s.promptTokens * r.prices.input + s.completionTokens * r.prices.output) / 1e6;
    lines.push(`Estimated cost: $${cost.toFixed(4)} (from your configured prices)`);
  } else if (s.promptTokens + s.completionTokens > 0) {
    lines.push('Enter $/1M token prices under "LLM provider" for a cost estimate.');
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined && tab.url?.startsWith('https://www.linkedin.com/')) {
      const p: PageStats | undefined = await chrome.tabs.sendMessage(tab.id, { type: 'getPageStats' });
      if (p) lines.push(`This tab: ${p.classified} classified, ${p.collapsed} collapsed, ${p.highlighted} highlighted, ${p.failed} failed`);
    }
  } catch {
    /* no content script in the active tab */
  }
  $('stats').textContent = lines.join('\n');
}

async function refreshFeedback(): Promise<void> {
  const all = await send<Record<string, FeedbackEntry>>({ type: 'listFeedback' });
  const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at);
  $('fbCount').textContent = `(${entries.length})`;
  const list = $('fbList');
  list.replaceChildren(
    ...entries.map(([, e]) => {
      const li = document.createElement('li');
      const snippet = e.sample.replace(/\s+/g, ' ').slice(0, 80);
      li.textContent = `${e.verdict === 'keep' ? 'Worth keeping' : 'Low quality'}: ${snippet}${e.sample.length > 80 ? '…' : ''}`;
      return li;
    }),
  );
}

async function exportFeedback(): Promise<void> {
  const all = await send<Record<string, FeedbackEntry>>({ type: 'listFeedback' });
  const lines = Object.entries(all).map(([id, e]) =>
    JSON.stringify({
      id: `user-${id}`,
      source: 'user-feedback',
      label: e.verdict === 'collapse' ? 'collapse' : 'keep',
      text: e.sample,
      model_decision: e.modelDecision,
      model_confidence: e.modelConfidence,
      at: new Date(e.at).toISOString(),
    }),
  );
  const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'signal-feedback.jsonl';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function init(): Promise<void> {
  fill(await send<PublicSettings>({ type: 'getSettings' }));

  $('enabled').addEventListener('change', (e) => void patch({ enabled: (e.target as HTMLInputElement).checked }));
  $('mode').addEventListener('change', (e) => void patch({ mode: (e.target as HTMLSelectElement).value as Settings['mode'] }));
  $('sensitivity').addEventListener('change', (e) => void patch({ sensitivity: (e.target as HTMLSelectElement).value as Settings['sensitivity'] }));
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
    if (r.ok) setStatus(`Connected. Model replied in ${r.latencyMs} ms (test post rated: ${r.decision}).`);
    else setStatus(`${r.kind}: ${r.message}${r.kind === 'network' ? ' (If this persists, check the endpoint URL and that host access was granted when saving.)' : ''}`, true);
    void refreshStats();
  });

  $('fbExport').addEventListener('click', () => void exportFeedback());
  $('fbReset').addEventListener('click', async () => {
    if (confirm('Delete all saved feedback?')) {
      await send({ type: 'clearFeedback' });
      void refreshFeedback();
    }
  });
  $('cacheReset').addEventListener('click', async () => {
    await send({ type: 'clearCache' });
    void refreshStats();
  });

  await Promise.all([refreshStats(), refreshFeedback()]);
}

void init();
