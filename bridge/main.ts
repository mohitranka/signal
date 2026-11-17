/**
 * Signal's local CLI bridge: `npm run bridge -- --cli claude|codex [--model …]`. docs/design-bridge.md.
 * Classifies Signal's posts with the user's logged-in Claude Code or Codex CLI. It never passes an API key; billing is
 * whatever the CLI itself is logged in with (normally a subscription; security B4).
 */
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { PostInput } from '../src/shared/types';
import { ADAPTERS } from './adapters';
import { parseArgs } from './config';
import { clock, dotted, fitLine, tilde } from './log';
import { CliRunner, errorCode, identityOf, ignoredMatches, resolveCommand, scrubEnv } from './runner';
import { selfTest, type SelfTestResult } from './selftest';
import { startServer, type RunResult, type Runner } from './server';
import { TokenProblem, loadOrCreateToken, tokenPath } from './token';

export interface BridgeIO {
  env: Record<string, string | undefined>; out: (line: string) => void; platform?: string;
  /** Test hook (security B5): the start-up checks to run (default: the real ones). */
  selfTest?: typeof selfTest;
}
export type Started = { ok: true; port: number; stop(): Promise<void> } | { ok: false; code: number };

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export async function startBridge(argv: string[], io: BridgeIO): Promise<Started> {
  const out = io.out;
  const platform = io.platform ?? process.platform;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    for (const l of parsed.error.split('\n')) out(l);
    return { ok: false, code: 2 };
  }
  const c = parsed.config;
  const adapter = ADAPTERS[c.cli];
  out('Signal bridge · local CLI bridge · classification only');

  const home = io.env.HOME || io.env.USERPROFILE || homedir();
  const path = io.env.PATH ?? io.env.Path ?? '';
  // Security B1: npm folders and relative PATH entries are never searched; a match skipped there is shown.
  const ignored = ignoredMatches(c.cli, path, platform);
  for (const p of ignored) out(fitLine('  note: ignored ', `${tilde(p, home)} (npm folder)`));
  const command = resolveCommand(c.cli, path, platform);
  if (!command) {
    out(dotted(c.cli, 'not found'));
    out(`Not starting. Install ${adapter.label}, or put ${c.cli} on PATH.`);
    if (ignored.length) out("(npm's node_modules/.bin folders are not searched, on purpose.)");
    if (platform === 'win32') out(`On Windows the bridge needs ${c.cli}.exe (a .cmd would need a shell).`);
    return { ok: false, code: 1 };
  }
  if (platform === 'win32') {
    out('Windows: a timeout stops the CLI, not processes it started.');
    out("Windows: the CLI's location is not checked (permissions are ACLs).");
  }

  let token: ReturnType<typeof loadOrCreateToken>;
  try {
    token = loadOrCreateToken(tokenPath(io.env, platform, home), { rotate: c.newToken, home });
  } catch (e) {
    // B6: a token problem is a few lines, each path on its own line; anything else, one sentence.
    const lines = e instanceof TokenProblem ? e.lines : [(e as Error).message];
    out(`Not starting. ${lines[0]}`);
    for (const l of lines.slice(1)) out(l);
    return { ok: false, code: 1 };
  }
  const shown = tilde(token.path, home);

  const inUse = () => out(`Not starting. Port ${c.port} is in use (another bridge running?). Use --port.`);
  if (c.port !== 0 && !(await portFree(c.port))) { // before the self-test spends subscription calls
    inUse();
    return { ok: false, code: 1 };
  }

  const env = scrubEnv(io.env, platform);
  const timeoutMs = c.timeoutS * 1000;
  const runChecks = io.selfTest ?? selfTest;
  /** Security B5: the start-up checks, as a result; an exception becomes a reason (an error code), never a crash. */
  const checks = async (): Promise<SelfTestResult | { ok: false; unexpected: string }> => {
    try {
      return await runChecks({ adapter, command, model: c.model, timeoutMs, env, out, path, home, keepSessionFiles: c.keepSessionFiles });
    } catch (e) {
      const code = errorCode(e);
      return { ok: false, unexpected: code === 'error' ? (e instanceof Error ? e.name : 'error') : code };
    }
  };
  const check = await checks();
  if (!check.ok) {
    if ('unprepared' in check && check.unprepared) out(`Not starting. Could not prepare a temporary folder (${check.unprepared}).`);
    if ('unexpected' in check) out(`Not starting. The start-up check failed unexpectedly (${check.unexpected}).`);
    return { ok: false, code: 1 };
  }

  // Security B2: before each call, the CLI (and its interpreter) must be the files the self-test checked. A change
  // (an update, a replacement) pauses serving and re-runs every start-up check, once, whoever is waiting.
  let current = { cli: new CliRunner(adapter, { command, model: c.model, timeoutMs, help: check.help, env }), files: check.files, identity: check.identity };
  let state: 'serving' | 'rechecking' | 'stopped' = 'serving';
  let recheck: Promise<void> | null = null;
  const recheckNow = (): Promise<void> =>
    (recheck ??= (async () => {
      state = 'rechecking';
      out(`${clock()}  ${c.cli} changed (update?) · pausing, re-checking`);
      const again = await checks();
      if (again.ok) {
        current = { cli: new CliRunner(adapter, { command, model: c.model, timeoutMs, help: again.help, env }), files: again.files, identity: again.identity };
        state = 'serving';
        out(`${clock()}  re-check passed · serving with ${c.cli} ${again.version}`);
      } else {
        state = 'stopped';
        out(`${clock()}  re-check failed · not serving any more`);
        if ('unprepared' in again && again.unprepared) out(`  could not prepare a temporary folder (${again.unprepared})`);
        if ('unexpected' in again) out(`  the check failed unexpectedly (${again.unexpected})`);
        out(`Stopped serving. The new ${c.cli} did not pass the checks above.`);
        out('Requests get 503. Fix the cause, then restart the bridge (Ctrl-C).');
      }
    })().finally(() => {
      recheck = null;
    }));
  const stopped: RunResult = { ok: false, cause: 'stopped', detail: 're-check failed' };

  // Track CLI runs, so stopping waits until each one's process group is killed and its folder removed.
  const inflight = new Set<Promise<RunResult>>();
  const runner: Runner = {
    run: async (post: PostInput, signal: AbortSignal) => {
      if (recheck) await recheck; // queued while a re-check runs: wait for its outcome
      if (state === 'serving' && identityOf(current.files) !== current.identity) await recheckNow();
      if (state !== 'serving') return stopped;
      const p = current.cli.run(post, signal);
      inflight.add(p);
      // B5: both outcomes handled here, so this bookkeeping can never leave a rejected promise unhandled.
      const done = () => inflight.delete(p);
      p.then(done, done);
      return p;
    },
  };
  const model = `${adapter.idPrefix}/${c.model}`;
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ port: c.port, token: token.token, model, runner, concurrency: c.concurrency, queue: c.queue, log: out, state: () => state });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') inUse();
    else out(`Not starting. ${(e as Error).message}`);
    return { ok: false, code: 1 };
  }

  for (const l of adapter.billingNotice) out(l); // security B4: once, at start
  out(`Listening on http://127.0.0.1:${server.port}/v1`);
  out(`  model    ${model}`);
  out(`  limits   ${c.concurrency} at a time · queue ${c.queue} · timeout ${c.timeoutS} s`);
  out('In Signal → Model, choose “Local CLI bridge”, then set:');
  out(`  Model         ${model}`);
  if (token.created) {
    out(`  Bridge token  ${token.token}`);
    out(`  (shown once; kept in ${shown}, only you can read it)`);
  } else {
    out(`  Bridge token  (saved in ${shown})`);
  }
  out('Logs never contain post text. Ctrl-C to stop.');

  return {
    ok: true,
    port: server.port,
    stop: async () => {
      await server.close(); // cancels queued work and aborts running CLIs
      await Promise.allSettled([...inflight]);
    },
  };
}

// Run when executed directly (the npm script runs the bundle), not when imported by tests. Real path: import.meta.url
// has symlinks resolved and argv[1] does not (macOS /var → /private/var, or a project folder reached through a link).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const started = await startBridge(process.argv.slice(2), { env: process.env, out: (l) => console.log(l) });
  if (!started.ok) process.exit(started.code);
  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(1); // a second Ctrl-C: leave now
    stopping = true;
    void started.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
