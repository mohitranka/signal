/**
 * Running the CLI (docs/design-bridge.md §6.4; invariants I1, I2, I7, I8; decision D9):
 *  - never through a shell: an absolute command path and an argument array; post text only on stdin;
 *  - an environment built from an allow-list (API keys can never reach the CLI, so it cannot bill the API);
 *  - a fresh, empty temporary folder per call, removed afterwards;
 *  - output capped, a timeout, and cancellation, each killing the CLI's whole process group.
 */
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';
import type { PostInput } from '../src/shared/types';
import type { Adapter } from './adapters';
import type { RunResult, Runner } from './server';

export const MAX_OUTPUT_BYTES = 1024 * 1024;

export const TEMP_PREFIX = 'signal-bridge-';

/** A system error's code (ENOSPC, ENOENT…) and nothing else: safe to show and to log (security B5). */
export function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,20}$/.test(code) ? code : 'error';
}

// ---- What the CLI keeps (security B3: docs/design-security-b3.md) ---------------------------------------------------

export type MarkerScan = { found: string | null } | { incomplete: string };
/** The start-up scan's limits. PB3: 200,000 entries (50,000 refused a long-time user's ~/.claude; 60,100 take ~0.2 s). */
export const SCAN_LIMITS = { maxBytes: 5 * 1024 * 1024, maxFiles: 2000, maxEntries: 200_000 };
class Incomplete extends Error {}

/**
 * Security B3, layer 3: is `marker` in any file under `roots` changed since `since` (minus 2 s for clock granularity)?
 * Roots may be folders or files (followed if they are links); inside them, links are never followed. Bounded: files over
 * `maxBytes` are skipped; more than `maxFiles` changed files or `maxEntries` folder entries → incomplete (fail closed).
 */
export function findMarker(roots: string[], marker: string, since: number, limits = SCAN_LIMITS): MarkerScan {
  const cutoff = since - 2000;
  let files = 0;
  let entries = 0;
  const needle = Buffer.from(marker, 'utf8');
  const visitFile = (p: string, size: number, mtimeMs: number): string | null => {
    if (mtimeMs < cutoff) return null;
    if (++files > limits.maxFiles) throw new Incomplete(`more than ${limits.maxFiles} changed files`);
    if (size > limits.maxBytes) return null;
    return readFileSync(p).includes(needle) ? p : null;
  };
  const walk = (dir: string): string | null => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // PB3: program files (a local install of the CLI) are never session data: not entered, not counted.
      if (e.name === 'node_modules' && e.isDirectory()) continue;
      if (++entries > limits.maxEntries) throw new Incomplete(`more than ${limits.maxEntries} entries`);
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      const hit = e.isDirectory() ? walk(p) : e.isFile() ? (() => { const st = lstatSync(p); return visitFile(p, st.size, st.mtimeMs); })() : null;
      if (hit) return hit;
    }
    return null;
  };
  try {
    for (const root of roots) {
      let st;
      try {
        st = statSync(root);
      } catch {
        continue; // not there: nothing kept
      }
      const hit = st.isDirectory() ? walk(root) : st.isFile() ? visitFile(root, st.size, st.mtimeMs) : null;
      if (hit) return { found: hit };
    }
    return { found: null };
  } catch (e) {
    if (e instanceof Incomplete) return { incomplete: e.message };
    return { incomplete: `could not read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
}

// ---- Which binary runs (security B1 + B2: docs/design-security-b1-b2.md) ------------------------------------------

const runnable = (candidate: string, win: boolean): boolean => {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (!win) accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const isNpmBin = (dir: string, win: boolean): boolean => {
  const segs = dir.split(win ? /[\\/]+/ : /\/+/).filter(Boolean).slice(-2).map((x) => (win ? x.toLowerCase() : x));
  return segs[0] === 'node_modules' && segs[1] === '.bin';
};

/**
 * The PATH folders the bridge may search, and pass on to the CLI: absolute ones only (a relative entry depends on the
 * folder you start from), never a node_modules/.bin (npm adds those of the project and of every parent folder).
 */
export function searchDirs(path: string, platform: string = process.platform): string[] {
  const win = platform === 'win32';
  const P = win ? win32 : posix;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of path.split(win ? ';' : ':')) {
    if (!dir || !P.isAbsolute(dir) || isNpmBin(dir, win)) continue;
    const key = win ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** The CLI's path, resolved once at start. On Windows only a .exe: a .cmd shim would need a shell (I7). */
export function resolveCommand(name: string, path: string, platform: string = process.platform): string | null {
  const win = platform === 'win32';
  for (const dir of searchDirs(path, platform)) {
    const candidate = join(dir, win ? `${name}.exe` : name);
    if (runnable(candidate, win)) return candidate;
  }
  return null;
}

/** Matches the search skipped because they sit in npm folders (reported, so shadowing attempts are visible). */
export function ignoredMatches(name: string, path: string, platform: string = process.platform): string[] {
  const win = platform === 'win32';
  const P = win ? win32 : posix;
  return path.split(win ? ';' : ':')
    .filter((dir) => dir && P.isAbsolute(dir) && isNpmBin(dir, win))
    .map((dir) => join(dir, win ? `${name}.exe` : name))
    .filter((candidate, i, all) => all.indexOf(candidate) === i && runnable(candidate, win));
}

export interface StatLike { mode: number; uid: number; gid: number; isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }
/** The file-system facts the location check needs; injectable, because tests cannot create files owned by others. */
export interface FsView { uid: number; gid: number; lstat(p: string): StatLike; stat(p: string): StatLike; realpath(p: string): string; head(p: string): string; exists(p: string): boolean }
export type LocationResult = { ok: true; checked: boolean; link?: string; real: string; interpreter?: string } | { ok: false; path: string; reason: string };

function realFs(): FsView {
  return {
    uid: process.getuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    lstat: (p) => lstatSync(p),
    stat: (p) => statSync(p),
    realpath: (p) => realpathSync(p),
    head: (p) => {
      const fd = openSync(p, 'r');
      try {
        const buf = Buffer.alloc(256);
        return buf.toString('latin1', 0, readSync(fd, buf, 0, 256, 0));
      } finally {
        closeSync(fd);
      }
    },
    exists: (p) => existsSync(p),
  };
}

class Unsafe extends Error {}

/**
 * The rule for one file or folder (security B1, shared with the token's folders, B6), as OpenSSH checks its own files:
 * owned by you or root; not writable by others, except a sticky folder (like /tmp) that is only a parent (`own` false);
 * group-writable only when the group is your primary group.
 */
export function pathProblem(
  st: { mode: number; uid: number; gid: number; isDirectory(): boolean },
  where: { own: boolean },
  me: { uid: number; gid: number },
): 'owned' | 'others' | 'group' | null {
  if (st.uid !== me.uid && st.uid !== 0) return 'owned';
  const sharedParent = st.isDirectory() && (st.mode & 0o1000) !== 0 && !where.own;
  if ((st.mode & 0o002) !== 0 && !sharedParent) return 'others';
  if ((st.mode & 0o020) !== 0 && st.gid !== me.gid && !sharedParent) return 'group';
  return null;
}

/**
 * Security B1 (design §2), as OpenSSH checks its own files: the CLI (after symlinks), the symlink's folder, the
 * interpreter of a script, and every folder up to "/" must be owned by the user or root and not writable by others.
 * Allowed: a sticky others-writable folder (like /tmp) as a parent, never as the folder holding the file; a
 * group-writable file or folder whose group is the user's primary group. Windows: not checked (ACLs).
 */
export function checkLocation(command: string, opts: { path: string; platform?: string; fs?: FsView }): LocationResult {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return { ok: true, checked: false, real: command };
  const fs = opts.fs ?? realFs();
  const WORDS = { owned: 'is owned by another user', others: 'is writable by other users', group: 'is writable by its group' } as const;
  const rules = (p: string, st: StatLike, own: boolean) => {
    const problem = pathProblem(st, { own }, fs);
    if (problem) throw new Unsafe(`${p} ${WORDS[problem]}`);
  };
  const folders = (dir: string) => {
    for (let d = dir, own = true; ; own = false) {
      rules(d, fs.stat(d), own);
      const up = posix.dirname(d);
      if (up === d) return;
      d = up;
    }
  };
  /** A file: the folder it is reached through, then (after symlinks) the file itself and its folders. */
  const file = (p: string): string => {
    folders(posix.dirname(p));
    const real = fs.realpath(p);
    rules(real, fs.stat(real), true);
    if (real !== p) folders(posix.dirname(real));
    return real;
  };
  try {
    const real = file(command);
    let interpreter: string | undefined;
    const head = fs.head(real);
    if (head.startsWith('#!')) {
      const words = head.slice(2).split('\n')[0]!.trim().split(/\s+/);
      const first = words[0] ?? '';
      if (!posix.isAbsolute(first)) throw new Unsafe(`its interpreter ${first || '(none)'} is not an absolute path`);
      file(first);
      interpreter = first;
      if (posix.basename(first) === 'env') {
        // #!/usr/bin/env [-S] [NAME=value…] program: the program is looked up on the (filtered) PATH.
        const name = words.slice(1).find((w) => !w.startsWith('-') && !w.includes('='));
        if (!name) throw new Unsafe('its interpreter line names no program');
        const found = searchDirs(opts.path, platform)
          .map((d) => posix.join(d, name))
          .find((c) => fs.exists(c) && fs.stat(c).isFile() && (fs.stat(c).mode & 0o111) !== 0);
        if (!found) throw new Unsafe(`its interpreter ${name} was not found`);
        file(found);
        interpreter = found;
      }
    }
    return { ok: true, checked: true, ...(real !== command ? { link: command } : {}), real, ...(interpreter ? { interpreter } : {}) };
  } catch (e) {
    if (e instanceof Unsafe) return { ok: false, path: command, reason: e.message };
    return { ok: false, path: command, reason: `${command} could not be checked (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
}

/** Security B2: what identifies the CLI (and its interpreter) on disk. Never throws: a vanished file is a change too. */
export function identityOf(files: string[]): string {
  return JSON.stringify(
    files.map((f) => {
      try {
        const real = realpathSync(f);
        const st = statSync(real);
        return [real, st.dev, st.ino, st.size, st.mtimeMs];
      } catch (e) {
        return [f, (e as NodeJS.ErrnoException).code ?? 'error'];
      }
    }),
  );
}

const ALLOWED = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'DBUS_SESSION_BUS_ADDRESS', // Linux keyring, where a CLI may keep its login
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
]);
const ALLOWED_PREFIXES = ['LC_', 'XDG_'];
const ALLOWED_WINDOWS = new Set(['PATH', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']);

/** I2, D9: an allow-list, not a block-list (and PATH filtered, B1). Every *_API_KEY, ANTHROPIC_*, OPENAI_*, NODE_OPTIONS… is simply not on it. */
export function scrubEnv(env: Record<string, string | undefined>, platform: string = process.platform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue;
    const ok = platform === 'win32' ? ALLOWED_WINDOWS.has(k.toUpperCase()) : ALLOWED.has(k) || ALLOWED_PREFIXES.some((p) => k.startsWith(p));
    if (!ok) continue;
    // Security B1: the CLI's own PATH has no npm folders or relative entries (for `#!/usr/bin/env node`).
    out[k] = k.toUpperCase() === 'PATH' ? searchDirs(v, platform).join(platform === 'win32' ? ';' : ':') : v;
  }
  return out;
}

export type ProcessResult = { status: 'exit'; code: number | null; stdout: string; stderr: string } | { status: 'timeout' | 'too-large' | 'aborted' | 'spawn-error' };

export function runProcess(opts: {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}): Promise<ProcessResult> {
  const max = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const posix = process.platform !== 'win32';
  return new Promise((resolve) => {
    let ended: ProcessResult['status'] | null = null;
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: posix, // its own process group, so the whole group can be killed
      windowsHide: true,
      shell: false,
    });
    const killGroup = () => {
      try {
        if (posix && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const stop = (status: 'timeout' | 'too-large' | 'aborted') => {
      if (ended) return;
      ended = status;
      killGroup();
    };
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout.on('data', (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > max) stop('too-large');
      else out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      errBytes += c.length;
      if (errBytes > max) stop('too-large');
      else err.push(c);
    });
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    const onAbort = () => stop('aborted');
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.on('error', () => {}); // the CLI may exit before reading all of stdin
    child.stdin.end(opts.stdin);
    const finish = (r: ProcessResult) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      // Whatever the CLI started in the background goes too, even after a normal exit.
      killGroup();
      resolve(r);
    };
    child.on('error', () => {
      if (!ended) ended = 'spawn-error';
      finish({ status: ended as 'spawn-error' });
    });
    child.on('close', (code) => {
      if (ended) finish({ status: ended } as ProcessResult);
      else finish({ status: 'exit', code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

export interface CliRunnerOptions { command: string; model: string; timeoutMs: number; help: string; env: Record<string, string> }
export interface FolderHooks<T> {
  /** Called with the empty folder before the CLI starts (the canary puts its files here). */
  prepare?(dir: string): void;
  /** Called with the folder after the CLI ended, before it is removed. */
  inspect?(dir: string): T;
}

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))} s`;

export class CliRunner implements Runner {
  constructor(readonly adapter: Adapter, readonly opts: CliRunnerOptions) {}

  run(post: PostInput, signal: AbortSignal): Promise<RunResult> {
    return this.runIn(post, signal, {}).then((r) => r.result);
  }

  /** Like run(), in a folder the hooks can prepare and inspect. Also returns what the CLI printed (self-test only). */
  async runIn<T>(post: PostInput, signal: AbortSignal, hooks: FolderHooks<T>): Promise<{ result: RunResult; inspected?: T; stdout: string; stderr: string }> {
    const startedAt = Date.now();
    // Security B5: a call that cannot be prepared (no temporary folder: disk full, /tmp gone) is a failed call.
    let dir = '';
    try {
      dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
      hooks.prepare?.(dir);
    } catch (e) {
      if (dir) rmSync(dir, { recursive: true, force: true });
      return { result: { ok: false, cause: 'unprepared', detail: errorCode(e) }, stdout: '', stderr: '' };
    }
    try {
      const p = await runProcess({
        command: this.opts.command,
        args: this.adapter.argv(this.opts.model, { cwd: dir, help: this.opts.help }),
        stdin: this.adapter.stdin(post),
        cwd: dir,
        env: this.opts.env,
        timeoutMs: this.opts.timeoutMs,
        signal,
      });
      const inspected = hooks.inspect?.(dir);
      const result: RunResult =
        p.status === 'exit' ? this.adapter.parse(p.stdout, p.stderr, p.code)
        : p.status === 'timeout' ? { ok: false, cause: 'timeout', detail: `no answer within ${seconds(this.opts.timeoutMs)}` }
        : p.status === 'too-large' ? { ok: false, cause: 'too-large', detail: 'output over 1 MB' }
        : p.status === 'aborted' ? { ok: false, cause: 'aborted', detail: 'cancelled' }
        : { ok: false, cause: 'failed', detail: 'could not start the CLI' };
      const printed = p.status === 'exit' ? { stdout: p.stdout, stderr: p.stderr } : { stdout: '', stderr: '' };
      return { result, ...(inspected !== undefined ? { inspected } : {}), ...printed };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      // Security B3, layer 2: what the CLI kept of this call (only entries named after this call's unique folder).
      const unique = basename(dir);
      if (unique.startsWith(TEMP_PREFIX) && unique.length === TEMP_PREFIX.length + 6) {
        try {
          this.adapter.cleanup({ unique, startedAt, env: this.opts.env });
        } catch {
          /* never breaks a call; nothing is logged (paths could be shown, text never) */
        }
      }
    }
  }
}
