/**
 * Everything CLI-specific, in one place (docs/design-bridge.md §6; docs/implementation-plan-bridge.md §0).
 *
 * UNVERIFIED: the flag names and output formats below come from the CLIs' documentation as known when this was
 * written; neither CLI could be run here. The bridge checks the flags against `--help` at every start and refuses to run
 * if one is missing (bridge/selftest.ts). If your manual check (design §11) shows a difference, this file is the one to
 * change.
 */
import { existsSync, lstatSync, readdirSync, readSync, openSync, closeSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_PROMPT, buildMessages } from '../src/classifier/prompt';
import type { PostInput } from '../src/shared/types';
import type { RunResult } from './server';

export type Parsed = Extract<RunResult, { ok: true }> | { ok: false; cause: 'login' | 'failed'; detail: string };

export interface Adapter {
  cli: 'claude' | 'codex';
  /** Shown to the user: "via your Claude Code login". */
  label: string;
  /** Security B4: printed once at start; the bridge passes no API key, but cannot know how the CLI is logged in. */
  billingNotice: string[];
  /** The model id the bridge serves is `<idPrefix>/<model>` (design §7). */
  idPrefix: string;
  versionArgs: string[];
  helpArgs: string[];
  /** Flags that must appear in the help text, or the bridge refuses to start. */
  requiredFlags: string[];
  /** The API-key variable the CLI would otherwise bill against (removed from its environment, I2). */
  apiKeyVar: string;
  /** How to update the CLI when a flag is missing. */
  updateHint: string;
  argv(model: string, ctx: { cwd: string; help: string }): string[];
  stdin(post: PostInput): string;
  /** A pure function of what the CLI printed and its exit code. Details are short and never quote the output. */
  parse(stdout: string, stderr: string, exitCode: number | null): Parsed;
  /** Security B3: where the CLI keeps its own files (scanned for the start-up marker). */
  stateRoots(env: Record<string, string>): string[];
  /**
   * Security B3: after each call, remove what the CLI kept of it: only entries carrying `unique`, the call's random
   * folder name. Never follows symlinks; never touches anything else. May throw; the caller ignores errors.
   */
  cleanup(ctx: { unique: string; startedAt: number; env: Record<string, string> }): void;
}

/**
 * Performance PB2: the `YYYY/MM/DD` folders a Codex session of one call can be filed under: the dates of the call's
 * start and end, each in local time and in UTC (which one Codex uses is unverified). At most four, no duplicates.
 */
export function sessionDayFolders(startedAt: number, endedAt: number): string[] {
  const two = (n: number) => String(n).padStart(2, '0');
  const days = new Set<string>();
  for (const t of [startedAt, endedAt]) {
    const d = new Date(t);
    days.add(`${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`);
    days.add(`${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}`);
  }
  return [...days];
}

const claudeState = (env: Record<string, string>) => env.CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, '.claude') : '');
const codexState = (env: Record<string, string>) => env.CODEX_HOME || (env.HOME ? join(env.HOME, '.codex') : '');

/** The first `bytes` of a file (session files start with their metadata, which holds the working folder). */
function headOf(path: string, bytes = 64 * 1024): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

/** Whole-flag match in a help text (so "--model" does not match "--model-provider"). */
export function helpHas(help: string, flag: string): boolean {
  return new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}(?=[\\s,=<\\[]|$)`, 'm').test(help);
}

const LOGIN = /\/login|not logged in|logged out|log ?in first|please (run )?\S*\s*login|invalid api key|unauthori[sz]ed|authenticat/i;

function exitFailure(code: number | null, stdout: string, stderr: string): Parsed {
  if (LOGIN.test(stdout) || LOGIN.test(stderr)) return { ok: false, cause: 'login', detail: 'not logged in' };
  return { ok: false, cause: 'failed', detail: code === null ? 'killed by a signal' : `exit code ${code}` };
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const userMessage = (post: PostInput) => buildMessages(post)[1]!.content;

const claude: Adapter = {
  cli: 'claude',
  label: 'Claude Code',
  idPrefix: 'claude-code',
  billingNotice: [
    'Billing: the bridge passes no API key. If claude is set up with one (an',
    'apiKeyHelper or API key in ~/.claude/settings.json), that account is',
    'billed, not your subscription.',
  ],
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  requiredFlags: ['--print', '--output-format', '--model', '--system-prompt', '--tools', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--no-session-persistence'],
  apiKeyVar: 'ANTHROPIC_API_KEY',
  updateHint: 'claude update',
  argv: (model) => [
    '-p', '--output-format', 'json', '--model', model,
    '--system-prompt', SYSTEM_PROMPT,
    // I1: no built-in tools, no MCP servers, no project settings. B3: no session saved (a required flag).
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user',
    '--no-session-persistence',
  ],
  stdin: userMessage,
  parse(stdout, stderr, code) {
    if (code !== 0) return exitFailure(code, stdout, stderr);
    if (!stdout.trim()) return { ok: false, cause: 'failed', detail: 'no output' };
    let o: any;
    try {
      o = JSON.parse(stdout);
    } catch {
      return { ok: false, cause: 'failed', detail: 'unreadable output' };
    }
    if (!o || typeof o !== 'object') return { ok: false, cause: 'failed', detail: 'unreadable output' };
    if (o.is_error === true) {
      return LOGIN.test(String(o.result ?? '')) ? { ok: false, cause: 'login', detail: 'not logged in' } : { ok: false, cause: 'failed', detail: 'the CLI reported an error' };
    }
    if (typeof o.result !== 'string') return { ok: false, cause: 'failed', detail: 'no answer in the output' };
    const u = o.usage;
    const usage = u && typeof u === 'object' && typeof u.input_tokens === 'number'
      ? { input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), output: num(u.output_tokens) }
      : undefined;
    return { ok: true, text: o.result, ...(usage ? { usage } : {}) };
  },
  stateRoots: (env) => [claudeState(env), ...(env.HOME ? [join(env.HOME, '.claude.json')] : [])].filter(Boolean),
  // Sessions live in <state>/projects/<the working folder, with every non-alphanumeric character as "-">/.
  cleanup({ unique, env }) {
    const projects = join(claudeState(env), 'projects');
    if (!claudeState(env) || !existsSync(projects)) return;
    for (const e of readdirSync(projects, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.includes(unique)) rmSync(join(projects, e.name), { recursive: true, force: true });
    }
  },
};

const codex: Adapter = {
  cli: 'codex',
  label: 'Codex',
  idPrefix: 'codex',
  billingNotice: [
    'Billing: the bridge passes no API key. If codex is logged in with an API',
    'key rather than your ChatGPT account, that account is billed, not your',
    'subscription.',
  ],
  versionArgs: ['--version'],
  helpArgs: ['exec', '--help'],
  requiredFlags: ['--json', '--model', '--sandbox', '--skip-git-repo-check', '--cd'],
  apiKeyVar: 'OPENAI_API_KEY',
  updateHint: 'npm install -g @openai/codex',
  // Codex cannot replace its system prompt, so Signal's instructions come first on stdin ("-").
  // B3: no history entries, when this version has config overrides.
  argv: (model, { cwd, help }) => [
    'exec', '--json',
    ...(helpHas(help, '-c') || helpHas(help, '--config') ? ['-c', 'history.persistence="none"'] : []),
    '--model', model, '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', cwd, '-',
  ],
  stdin: (post) => `${SYSTEM_PROMPT}\n\n${userMessage(post)}`,
  parse(stdout, stderr, code) {
    if (code !== 0) return exitFailure(code, stdout, stderr);
    let text: string | undefined;
    let usage: { input: number; output: number } | undefined;
    let events = 0;
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (!ev || typeof ev !== 'object') continue;
      events++;
      const msg = ev.msg && typeof ev.msg === 'object' ? ev.msg : undefined;
      // Current shape: {"type":"item.completed","item":{"type":"agent_message","text":…}}, usage on "turn.completed".
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text;
      if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage.input_tokens === 'number') usage = { input: num(ev.usage.input_tokens), output: num(ev.usage.output_tokens) };
      // Older shape: {"msg":{"type":"agent_message","message":…}}, {"msg":{"type":"token_count",…}}.
      if (msg?.type === 'agent_message' && typeof msg.message === 'string') text = msg.message;
      if (msg?.type === 'token_count') {
        const t = msg.info?.total_token_usage ?? msg;
        if (typeof t.input_tokens === 'number') usage = { input: num(t.input_tokens), output: num(t.output_tokens) };
      }
      if ((ev.type === 'error' || msg?.type === 'error') && LOGIN.test(String(ev.message ?? msg?.message ?? ''))) {
        return { ok: false, cause: 'login', detail: 'not logged in' };
      }
    }
    if (events === 0) return { ok: false, cause: 'failed', detail: stdout.trim() ? 'unreadable output' : 'no output' };
    if (text === undefined) return { ok: false, cause: 'failed', detail: 'no answer in the output' };
    return { ok: true, text, ...(usage ? { usage } : {}) };
  },
  stateRoots: (env) => [codexState(env)].filter(Boolean),
  // Sessions live in <state>/sessions/<year>/<month>/<day>/*.jsonl; the first line records the working folder.
  // PB2: only the call's own day folders are looked at (not every session ever kept).
  cleanup({ unique, startedAt, env }) {
    if (!codexState(env)) return;
    for (const day of sessionDayFolders(startedAt, Date.now())) {
      const dir = join(codexState(env), 'sessions', ...day.split('/'));
      if (!existsSync(dir)) continue;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isFile() && e.name.endsWith('.jsonl') && lstatSync(p).mtimeMs >= startedAt - 2000 && headOf(p).includes(unique)) unlinkSync(p);
      }
    }
  },
};

export const ADAPTERS: Record<'claude' | 'codex', Adapter> = { claude, codex };
