/**
 * Invariant I4, decision D8 (docs/implementation-plan-bridge.md): the bearer token. 32 random bytes (base64url, 43
 * characters) in a file only the user can read; compared in constant time. Fail closed: a token file readable by others,
 * not owned by the user, in a folder others could change (security B6), or corrupt, stops the bridge instead of being
 * used or silently replaced.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import { tilde } from './log';
import { pathProblem } from './runner';

export interface TokenInfo { token: string; path: string; created: boolean }

/** Security B6: a token problem, as the lines the bridge prints after "Not starting." (each path on its own line). */
export class TokenProblem extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join('\n'));
  }
}
type StatView = { mode: number; uid: number; gid: number; isDirectory(): boolean };
/** The file-system facts the checks need; injectable so tests can model a file owned by someone else. */
export interface TokenView { uid: number; gid: number; stat(p: string): StatView; fstat(fd: number): StatView }
const realView = (): TokenView => ({ uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, stat: (p) => statSync(p), fstat: (fd) => fstatSync(fd) });

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const POSIX = process.platform !== 'win32';

export function tokenPath(env: Record<string, string | undefined>, platform: string, home: string): string {
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'signal-bridge', 'token');
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'signal-bridge', 'token');
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code ?? 'error';

function ensureFolder(dir: string, show: (p: string) => string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new TokenProblem([`Cannot create the folder for the bridge token (${errCode(e)}):`, `  ${show(dir)}`]);
  }
}

/**
 * Security B6: the token's folder and every folder above it, with the CLI's rule (B1): owned by you or root, not
 * writable by others (a sticky folder only as a parent), group-writable only for your primary group.
 */
function checkFolders(dir: string, view: TokenView, show: (p: string) => string): void {
  for (let d = dir, own = true; ; own = false) {
    const problem = pathProblem(view.stat(d), { own }, view);
    if (problem) {
      const p = show(d);
      if (own) {
        if (problem === 'owned') throw new TokenProblem(['The bridge token folder is owned by another user:', `  ${p}`, 'Move it away, then start again:', `  mv ${p} ${p}.old`]);
        throw new TokenProblem([`The bridge token folder is writable by ${problem === 'others' ? 'other users' : 'its group'}:`, `  ${p}`, 'Fix it with:', `  chmod 700 ${p}`]);
      }
      if (problem === 'owned') throw new TokenProblem(['A folder above the bridge token belongs to another user:', `  ${p}`, 'Set XDG_CONFIG_HOME to a folder of your own.']);
      throw new TokenProblem([`A folder above the bridge token is writable by ${problem === 'others' ? 'other users' : 'its group'}:`, `  ${p}`, 'Fix it with:', `  chmod ${problem === 'others' ? 'go-w' : 'g-w'} ${p}`]);
    }
    const up = posix.dirname(d);
    if (up === d) return;
    d = up;
  }
}

/** Write a new token with mode 0600 from the start (never briefly readable by others), then move it into place. */
function writeNew(path: string): string {
  const token = randomBytes(32).toString('base64url');
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, token + '\n');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return token;
}

export function loadOrCreateToken(path: string, opts: { rotate?: boolean; home?: string; view?: TokenView } = {}): TokenInfo {
  const show = (p: string) => tilde(p, opts.home);
  const view = opts.view ?? realView();
  ensureFolder(dirname(path), show);
  if (POSIX) checkFolders(dirname(path), view, show);
  let exists = true;
  try {
    statSync(path);
  } catch {
    exists = false;
  }
  if (!exists || opts.rotate) return { token: writeNew(path), path, created: true };

  const fd = openSync(path, constants.O_RDONLY);
  let raw: string;
  try {
    // Checked on the open file: what is read is what was checked.
    const st = POSIX ? view.fstat(fd) : null;
    if (st && st.uid !== view.uid) {
      throw new TokenProblem(['The bridge token file is owned by another user:', `  ${show(path)}`, 'Remove it, then start again (a new token is created):', `  rm ${show(path)}`]);
    }
    if (st && (st.mode & 0o077) !== 0) {
      const how = (st.mode & 0o044) !== 0 ? 'read' : 'changed';
      throw new TokenProblem([`The bridge token file can be ${how} by other users:`, `  ${show(path)}`, 'Fix it with:', `  chmod 600 ${show(path)}`]);
    }
    raw = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  const token = raw.trim();
  if (!TOKEN_RE.test(token)) {
    throw new TokenProblem(['The bridge token file is not a valid token:', `  ${show(path)}`, 'Replace it with a new token: start with --new-token']);
  }
  return { token, path, created: false };
}

/** Constant time: both sides are hashed to 32 bytes first, so neither content nor length leaks through timing. */
export function checkToken(presented: string | undefined, token: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(token, 'utf8').digest();
  return timingSafeEqual(a, b);
}
