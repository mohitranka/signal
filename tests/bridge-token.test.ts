// @vitest-environment node
/**
 * Bridge T2 (docs/implementation-plan-bridge.md, D8): the bearer token (invariant I4). 32 random bytes, in a file only
 * the user can read, compared in constant time. Fail closed if the file is readable by others.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenProblem, checkToken, loadOrCreateToken, tokenPath } from '../bridge/token';
import { fstatSync } from 'node:fs';

const POSIX = process.platform !== 'win32';
const mode = (p: string) => statSync(p).mode & 0o777;
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});
const fresh = () => {
  root = mkdtempSync(join(tmpdir(), 'signal-token-'));
  return join(root, 'config', 'signal-bridge', 'token');
};

describe('where the token lives', () => {
  it('XDG_CONFIG_HOME, else ~/.config, else %APPDATA% on Windows', () => {
    expect(tokenPath({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux', '/home/u')).toBe('/x/cfg/signal-bridge/token');
    expect(tokenPath({}, 'linux', '/home/u')).toBe('/home/u/.config/signal-bridge/token');
    expect(tokenPath({}, 'darwin', '/Users/u')).toBe(posix.join('/Users/u', '.config', 'signal-bridge', 'token'));
    expect(tokenPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toBe(win32.join('C:\\Users\\u\\AppData\\Roaming', 'signal-bridge', 'token'));
  });
});

describe('create, reuse, rotate', () => {
  it('first start creates a 43-character base64url token (32 bytes) in a 0700 folder, file 0600', () => {
    const p = fresh();
    const t = loadOrCreateToken(p);
    expect(t.created).toBe(true);
    expect(t.path).toBe(p);
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t.token, 'base64url')).toHaveLength(32);
    expect(readFileSync(p, 'utf8').trim()).toBe(t.token);
    if (POSIX) {
      expect(mode(p)).toBe(0o600);
      expect(mode(dirname(p))).toBe(0o700);
    }
  });

  it('a second start reads the same token and reports it as not new', () => {
    const p = fresh();
    const first = loadOrCreateToken(p);
    const second = loadOrCreateToken(p);
    expect(second).toEqual({ token: first.token, path: p, created: false });
  });

  it('two tokens are different (random)', () => {
    const a = loadOrCreateToken(fresh()).token;
    rmSync(root, { recursive: true, force: true });
    const b = loadOrCreateToken(fresh()).token;
    expect(a).not.toBe(b);
  });

  it('rotate replaces the token, still 0600, reported as new', () => {
    const p = fresh();
    const first = loadOrCreateToken(p);
    const rotated = loadOrCreateToken(p, { rotate: true });
    expect(rotated.created).toBe(true);
    expect(rotated.token).not.toBe(first.token);
    expect(readFileSync(p, 'utf8').trim()).toBe(rotated.token);
    if (POSIX) expect(mode(p)).toBe(0o600);
  });
});

describe.runIf(POSIX)('fail closed on a file others can read', () => {
  for (const bad of [0o644, 0o640, 0o604, 0o660]) {
    it(`mode ${bad.toString(8)}: refuses, naming the file and the fix`, () => {
      const p = fresh();
      loadOrCreateToken(p);
      chmodSync(p, bad);
      expect(() => loadOrCreateToken(p)).toThrow(p);
      expect(() => loadOrCreateToken(p)).toThrow(`chmod 600 ${p}`);
    });
  }

  it('a corrupt token file (wrong length or characters) is refused, not silently replaced', () => {
    const p = fresh();
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, 'short\n', { mode: 0o600 });
    expect(() => loadOrCreateToken(p)).toThrow(/--new-token/);
    expect(readFileSync(p, 'utf8')).toBe('short\n');
  });

  it('a folder that cannot be created: a clear error naming it', () => {
    root = mkdtempSync(join(tmpdir(), 'signal-token-'));
    writeFileSync(join(root, 'file'), 'x');
    const p = join(root, 'file', 'signal-bridge', 'token'); // parent is a file
    expect(() => loadOrCreateToken(p)).toThrow(dirname(p));
    expect(existsSync(p)).toBe(false);
  });
});

describe('checkToken', () => {
  const token = 'k3Jt0wZq8vN2mR5xL7cT1bY4hF9dS6gA0eW3uK8pQ9x';
  it('accepts only the exact token', () => {
    expect(checkToken(token, token)).toBe(true);
    for (const bad of [undefined, '', 'x', token.slice(0, -1), token + 'x', token.toUpperCase(), token.replace('k', 'é'), ' ' + token]) {
      expect(checkToken(bad, token), String(bad)).toBe(false);
    }
  });

  it('compares in constant time (timingSafeEqual on digests, never ===)', () => {
    const src = readFileSync('bridge/token.ts', 'utf8');
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).toMatch(/createHash\(['"]sha256['"]\)/);
  });
});

describe.runIf(POSIX)('who else could change the token (security B6)', () => {
  /** The problem's lines, as the bridge prints them (paths under the test root shown with ~). */
  const problem = (p: string, opts: Parameters<typeof loadOrCreateToken>[1] = {}): string[] => {
    try {
      loadOrCreateToken(p, { home: root, ...opts });
    } catch (e) {
      if (e instanceof TokenProblem) return e.lines;
      throw e;
    }
    throw new Error('accepted');
  };
  const tokenIn = (folderMode: number, cfgMode = 0o700) => {
    root = mkdtempSync(join(tmpdir(), 'signal-token-'));
    mkdirSync(join(root, 'cfg', 'signal-bridge'), { recursive: true });
    chmodSync(join(root, 'cfg'), cfgMode);
    chmodSync(join(root, 'cfg', 'signal-bridge'), folderMode);
    return join(root, 'cfg', 'signal-bridge', 'token');
  };

  it('the token folder writable by other users: refused (mockup 1)', () => {
    expect(problem(tokenIn(0o777))).toEqual(['The bridge token folder is writable by other users:', '  ~/cfg/signal-bridge', 'Fix it with:', '  chmod 700 ~/cfg/signal-bridge']);
  });

  it('a folder above it writable by other users: refused, naming that folder (mockup 2)', () => {
    expect(problem(tokenIn(0o700, 0o777))).toEqual(['A folder above the bridge token is writable by other users:', '  ~/cfg', 'Fix it with:', '  chmod go-w ~/cfg']);
  });

  it('group-writable with your own primary group, and a sticky parent: accepted', () => {
    expect(loadOrCreateToken(tokenIn(0o770), { home: root }).created).toBe(true);
    rmSync(root, { recursive: true, force: true });
    const p = tokenIn(0o700, 0o1777);
    expect(loadOrCreateToken(p, { home: root }).created).toBe(true);
  });

  it('a token file owned by another user: refused (mockup 3)', () => {
    const p = tokenIn(0o700);
    loadOrCreateToken(p);
    const view = {
      uid: process.getuid!(), gid: process.getgid!(), stat: (x: string) => statSync(x),
      fstat: (fd: number) => Object.assign(fstatSync(fd), { uid: 4242 }), // modelled: someone else's file
    };
    expect(problem(p, { view })).toEqual(['The bridge token file is owned by another user:', '  ~/cfg/signal-bridge/token', 'Remove it, then start again (a new token is created):', '  rm ~/cfg/signal-bridge/token']);
  });

  it('the existing problems, as lines (mockups 4, 5, 6)', () => {
    const p = tokenIn(0o700);
    loadOrCreateToken(p);
    chmodSync(p, 0o644);
    expect(problem(p)).toEqual(['The bridge token file can be read by other users:', '  ~/cfg/signal-bridge/token', 'Fix it with:', '  chmod 600 ~/cfg/signal-bridge/token']);
    chmodSync(p, 0o620);
    expect(problem(p)[0]).toBe('The bridge token file can be changed by other users:');
    chmodSync(p, 0o600);
    writeFileSync(p, 'short\n');
    expect(problem(p)).toEqual(['The bridge token file is not a valid token:', '  ~/cfg/signal-bridge/token', 'Replace it with a new token: start with --new-token']);
    rmSync(join(root, 'cfg', 'signal-bridge'), { recursive: true });
    writeFileSync(join(root, 'cfg', 'signal-bridge'), 'a file in the way');
    expect(problem(p)).toEqual(['Cannot create the folder for the bridge token (EEXIST):', '  ~/cfg/signal-bridge']);
  });
});
