/** Arguments (decision D7, docs/implementation-plan-bridge.md). Every value bounded; model names safe to show and pass. */
export interface BridgeConfig { cli: 'claude' | 'codex'; model: string; port: number; concurrency: number; queue: number; timeoutS: number; newToken: boolean; /** Security B3: accept that the CLI keeps post text the bridge cannot remove. */ keepSessionFiles: boolean }

export const USAGE = [
  'Usage: npm run bridge -- --cli claude|codex [--model <name>]',
  '         [--port 8791] [--concurrency 1] [--queue 8] [--timeout 60]',
  '         [--new-token] [--keep-session-files]',
].join('\n');

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const INTS: Record<string, [min: number, max: number]> = { port: [0, 65535], concurrency: [1, 4], queue: [0, 64], timeout: [5, 300] };
const VALUED = new Set(['cli', 'model', 'port', 'concurrency', 'queue', 'timeout']);

export function parseArgs(argv: string[]): { ok: true; config: BridgeConfig } | { ok: false; error: string } {
  const fail = (problem: string) => ({ ok: false as const, error: `${problem}\n${USAGE}` });
  const seen: Record<string, string> = {};
  let newToken = false;
  let keepSessionFiles = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!m) return fail(`Unexpected argument: ${JSON.stringify(arg).slice(0, 40)}`);
    const name = m[1]!;
    if (name === 'new-token' || name === 'keep-session-files') {
      if (m[2] !== undefined) return fail(`--${name} takes no value.`);
      if (name === 'new-token') newToken = true;
      else keepSessionFiles = true;
      continue;
    }
    if (!VALUED.has(name)) return fail(`Unknown option --${name.slice(0, 30)}.`);
    if (name in seen) return fail(`--${name} given twice.`);
    const value = m[2] ?? argv[++i];
    if (value === undefined) return fail(`--${name} needs a value.`);
    seen[name] = value;
  }

  if (seen.cli !== 'claude' && seen.cli !== 'codex') return fail(seen.cli === undefined ? '--cli is required.' : '--cli must be claude or codex.');
  const cli = seen.cli;
  if (cli === 'codex' && seen.model === undefined) return fail('--model is required for codex (e.g. --model gpt-5).');
  const model = seen.model ?? 'sonnet';
  if (!MODEL_RE.test(model)) return fail('--model: letters, digits and . _ : - [ ] only, at most 64.');
  const ints: Record<string, number> = { port: 8791, concurrency: 1, queue: 8, timeout: 60 };
  for (const [name, [min, max]] of Object.entries(INTS)) {
    const v = seen[name];
    if (v === undefined) continue;
    if (!/^\d{1,6}$/.test(v) || Number(v) < min || Number(v) > max) return fail(`--${name} must be a whole number from ${min} to ${max}.`);
    ints[name] = Number(v);
  }
  return { ok: true, config: { cli, model, port: ints.port!, concurrency: ints.concurrency!, queue: ints.queue!, timeoutS: ints.timeout!, newToken, keepSessionFiles } };
}
