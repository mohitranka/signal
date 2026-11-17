#!/usr/bin/env node
/*
 * Fake `claude` / `codex` for the bridge tests (no real CLI is installed here). Installed by tests/bridge-helpers.ts as
 * <dir>/claude and <dir>/codex. Behaviour comes from <dir>/behaviour.json, NOT from environment variables: the bridge
 * scrubs the environment, so an env switch would not reach this process. Every call is recorded in <dir>/calls.jsonl
 * (argv, stdin, environment, working folder and its files), so tests can check what the bridge really passed.
 *
 * It mimics the output formats the design lists as UNVERIFIED (docs/design-bridge.md §2, §6).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dir = __dirname;
const name = path.basename(process.argv[1]); // 'claude' or 'codex'
const args = process.argv.slice(2);
let b = {};
try { b = JSON.parse(fs.readFileSync(path.join(dir, 'behaviour.json'), 'utf8')); } catch { /* defaults */ }

const HELP = {
  claude: ['-p, --print', '--output-format <format>', '--model <model>', '--system-prompt <prompt>', '--tools <tools...>',
    '--strict-mcp-config', '--mcp-config <configs...>', '--setting-sources <sources>', '--no-session-persistence'],
  codex: ['--json', '-m, --model <MODEL>', '-s, --sandbox <SANDBOX_MODE>', '--skip-git-repo-check', '-C, --cd <DIR>', '-c, --config <key=value>'],
};

function record(stdin) {
  let files = [];
  try { files = fs.readdirSync(process.cwd()); } catch { /* gone */ }
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ name, argv: args, stdin, env: process.env, cwd: process.cwd(), files, pid: process.pid }) + '\n');
}

/**
 * Security B3: keep what was received, the way each CLI is described to (docs/design-security-b3.md), before the mode's
 * own behaviour, so failing and timing-out calls keep files too. `claude-elsewhere` and `codex-history` are places the
 * bridge's clean-up does not cover.
 */
function persist(stdin) {
  if (!b.persist) return;
  const home = process.env.HOME || '/nonexistent';
  const cwd = process.cwd();
  const two = (n) => String(n).padStart(2, '0');
  if (name === 'claude') {
    const state = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    if (b.persist === 'claude-project') {
      const d = path.join(state, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${process.pid}.jsonl`), JSON.stringify({ type: 'user', cwd, message: stdin }) + '\n');
    }
    if (b.persist === 'claude-elsewhere') {
      fs.mkdirSync(path.join(state, 'debug'), { recursive: true });
      fs.appendFileSync(path.join(state, 'debug', 'latest.log'), stdin + '\n');
    }
  } else {
    const state = process.env.CODEX_HOME || path.join(home, '.codex');
    if (b.persist === 'codex-session') {
      const now = new Date();
      const d = path.join(state, 'sessions', String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate()));
      fs.mkdirSync(d, { recursive: true });
      const file = path.join(d, `rollout-${now.toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n' + JSON.stringify({ type: 'message', text: stdin }) + '\n');
    }
    if (b.persist === 'codex-history') {
      fs.mkdirSync(state, { recursive: true });
      fs.appendFileSync(path.join(state, 'history.jsonl'), JSON.stringify({ ts: Date.now(), text: stdin }) + '\n');
    }
  }
}

function classification(reason) {
  return JSON.stringify({ decision: b.decision || 'keep', confidence: 0.8, reason,
    signals: { originality: 0.5, evidence: 0.5, reasoning: 0.5, usefulness: 0.5, sensationalism: 0.1, engagement_bait: 0.1 } });
}

function out(text, usage) {
  if (name === 'claude') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text,
      usage: { input_tokens: usage.input, output_tokens: usage.output, cache_creation_input_tokens: 10, cache_read_input_tokens: 2 } }));
  } else if (b.codexShape === 'old') {
    process.stdout.write(JSON.stringify({ id: '0', msg: { type: 'task_started' } }) + '\n');
    process.stdout.write(JSON.stringify({ id: '0', msg: { type: 'agent_message', message: text } }) + '\n');
    process.stdout.write(JSON.stringify({ id: '0', msg: { type: 'token_count', input_tokens: usage.input, output_tokens: usage.output } }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: usage.input, cached_input_tokens: 100, output_tokens: usage.output } }) + '\n');
  }
}

if (args[0] === '--version') {
  process.stdout.write(name === 'claude' ? `${b.version || '2.1.4'} (Claude Code)\n` : `codex-cli ${b.version || '0.58.0'}\n`);
  process.exit(0);
}
if (args.includes('--help')) {
  const missing = new Set(b.helpMissing || []);
  const lines = HELP[name].filter((l) => !l.split(/[ ,]+/).some((f) => missing.has(f)));
  process.stdout.write(`Usage: ${name} [options]\n\nOptions:\n` + lines.map((l) => `  ${l}`).join('\n') + '\n');
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  record(stdin);
  persist(stdin);
  const mode = b.mode || 'ok';
  if (b.echoStderr) process.stderr.write(`debug: received ${stdin}\n`);
  if (mode === 'not-logged-in') {
    if (name === 'claude') process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' }));
    else process.stderr.write('Error: Not logged in. Run `codex login` first.\n');
    process.exit(1);
  }
  if (mode === 'exit1') { process.stderr.write('something broke\n'); process.exit(1); }
  if (mode === 'garbage') { process.stdout.write('<<<not json at all>>>'); process.exit(0); }
  if (mode === 'empty') process.exit(0);
  if (mode === 'not-a-classification') { out('Sure! Here is a poem about LinkedIn.', { input: 10, output: 10 }); process.exit(0); }
  if (mode === 'huge-stdout') { const chunk = 'x'.repeat(64 * 1024); for (let i = 0; i < 40; i++) process.stdout.write(chunk); return; }
  if (mode === 'huge-stderr') { const chunk = 'y'.repeat(64 * 1024); for (let i = 0; i < 40; i++) process.stderr.write(chunk); return; }
  if (mode === 'grandchild') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
    fs.appendFileSync(path.join(dir, 'grandchildren.txt'), child.pid + '\n');
    setTimeout(() => {}, 600000);
    return;
  }
  if (mode === 'slow') { setTimeout(() => {}, 600000); return; }

  // Tool behaviour for the canary: only when the post asks for the canary file.
  let reason = b.reason || 'Concrete, firsthand numbers.';
  if (stdin.includes('CANARY.txt')) {
    const cwd = process.cwd();
    if (b.tools === 'read') reason = 'The file says ' + fs.readFileSync(path.join(cwd, 'CANARY.txt'), 'utf8').trim();
    if (b.tools === 'list') reason = 'Files here: ' + fs.readdirSync(cwd).join(', ');
    if (b.tools === 'read-all') reason = fs.readdirSync(cwd).map((f) => fs.readFileSync(path.join(cwd, f), 'utf8').trim()).join(' ');
    if (b.tools === 'write') fs.writeFileSync(path.join(cwd, 'ran.txt'), 'done');
  }
  if (b.marker) reason += ' ' + b.marker;
  const finish = () => { out(classification(reason), { input: 800, output: 70 }); process.exit(0); };
  if (b.delayMs) setTimeout(finish, b.delayMs); else finish();
});
