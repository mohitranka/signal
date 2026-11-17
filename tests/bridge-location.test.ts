// @vitest-environment node
/**
 * Security B1 (docs/design-security-b1-b2.md, docs/implementation-plan-security-b1-b2.md): which CLI binary the bridge
 * runs. npm folders and relative PATH entries are never searched; the CLI, its symlink, its interpreter and all their
 * folders must be changeable only by the user or root.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADAPTERS } from '../bridge/adapters';
import { CliRunner, checkLocation, ignoredMatches, resolveCommand, scrubEnv, searchDirs, type FsView } from '../bridge/runner';
import { POST, installFakes, type Fakes } from './bridge-helpers';

const POSIX = process.platform !== 'win32';

describe('searchDirs: where the bridge may look (B1)', () => {
  it('skips relative entries and every node_modules/.bin; keeps order; drops duplicates', () => {
    const path = ['/home/u/proj/node_modules/.bin', '/home/u/node_modules/.bin', '/node_modules/.bin', '.', 'bin', '', '/home/u/.local/bin', '/usr/bin', '/home/u/.local/bin', '/opt/node_modules/.bin/', '/usr/local/bin'].join(':');
    expect(searchDirs(path, 'linux')).toEqual(['/home/u/.local/bin', '/usr/bin', '/usr/local/bin']);
  });

  it('a folder merely named like it is kept (segment comparison, not substring)', () => {
    expect(searchDirs('/opt/my_node_modules/.bin:/opt/node_modules/.binaries:/opt/node_modules', 'linux')).toEqual(['/opt/my_node_modules/.bin', '/opt/node_modules/.binaries', '/opt/node_modules']);
  });

  it('Windows: ; separator, drive-absolute only, case-insensitive npm folders', () => {
    expect(searchDirs('C:\\proj\\Node_Modules\\.BIN;C:\\tools;relative\\bin;C:\\Users\\u\\AppData\\Local\\bin', 'win32')).toEqual(['C:\\tools', 'C:\\Users\\u\\AppData\\Local\\bin']);
  });
});

describe('the B1 reproduction: a claude in a parent folder\'s node_modules/.bin', () => {
  let fakes: Fakes;
  let npmRoot = '';
  afterEach(() => {
    fakes?.cleanup();
    if (npmRoot) rmSync(npmRoot, { recursive: true, force: true });
  });
  const npmFake = () => {
    npmRoot = mkdtempSync(join(tmpdir(), 'signal-parent-'));
    const bin = join(npmRoot, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    copyFileSync('tests/fixtures/fake-cli.cjs', join(bin, 'claude'));
    chmodSync(join(bin, 'claude'), 0o755);
    return bin;
  };

  it('is ignored (and reported) when yours is on PATH too', () => {
    fakes = installFakes();
    const bin = npmFake();
    const path = `${bin}:${fakes.PATH}`;
    expect(resolveCommand('claude', path)).toBe(join(fakes.dir, 'claude'));
    expect(ignoredMatches('claude', path)).toEqual([join(bin, 'claude')]);
  });

  it('when it is the only one: not found, and reported', () => {
    fakes = installFakes();
    const bin = npmFake();
    expect(resolveCommand('claude', bin)).toBeNull();
    expect(ignoredMatches('claude', bin)).toEqual([join(bin, 'claude')]);
  });

  it('the CLI\'s own PATH has no npm folders or relative entries either (for #!/usr/bin/env node)', async () => {
    fakes = installFakes();
    const bin = npmFake();
    const env = scrubEnv({ PATH: `${bin}:.:${fakes.PATH}`, HOME: '/home/u' }, 'linux');
    expect(env.PATH).toBe(searchDirs(fakes.PATH, 'linux').join(':'));
    const runner = new CliRunner(ADAPTERS.claude, { command: join(fakes.dir, 'claude'), model: 'sonnet', timeoutMs: 10_000, help: '', env });
    await runner.run(POST, new AbortController().signal);
    const seen = fakes.calls()[0]!.env.PATH!;
    expect(seen.split(':')).not.toContain(bin);
    expect(seen.split(':')).not.toContain('.');
  });
});

// ---- checkLocation with a modelled file system ------------------------------------------------------------------

const ME = 1000;
const MY_GROUP = 1000;
type Node = { type: 'file' | 'dir' | 'link'; mode: number; uid?: number; gid?: number; target?: string; head?: string };
/** A file system: path → node. Folders not listed are root-owned 0755. `realpath` follows links in any component. */
function fsOf(nodes: Record<string, Node>, me = { uid: ME, gid: MY_GROUP }): FsView {
  const get = (p: string): Node => nodes[p] ?? { type: 'dir', mode: 0o755, uid: 0, gid: 0 };
  const resolve = (p: string, depth = 0): string => {
    if (depth > 20) throw new Error('link loop');
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur = `${cur}/${parts[i]}`;
      const n = nodes[cur];
      if (n?.type === 'link') {
        const t = n.target!.startsWith('/') ? n.target! : `${cur.slice(0, cur.lastIndexOf('/'))}/${n.target}`;
        return resolve([t, ...parts.slice(i + 1)].join('/'), depth + 1);
      }
    }
    return cur || '/';
  };
  const st = (n: Node) => ({ mode: n.mode | (n.type === 'dir' ? 0o040000 : n.type === 'link' ? 0o120000 : 0o100000), uid: n.uid ?? ME, gid: n.gid ?? MY_GROUP, isSymbolicLink: () => n.type === 'link', isFile: () => n.type === 'file', isDirectory: () => n.type === 'dir' });
  return {
    uid: me.uid,
    gid: me.gid,
    lstat: (p) => st(get(p)),
    stat: (p) => st(get(resolve(p))),
    realpath: (p) => resolve(p),
    head: (p) => get(resolve(p)).head ?? '\u007fELF',
    exists: (p) => resolve(p) in nodes,
  };
}
const HOME = { '/home': { type: 'dir', mode: 0o755, uid: 0 }, '/home/u': { type: 'dir', mode: 0o750, uid: ME } } as const;
const claudeIn = (dir: string, file: Partial<Node> = {}, dirNode: Partial<Node> = {}): Record<string, Node> => ({
  ...HOME,
  [dir]: { type: 'dir', mode: 0o755, uid: ME, ...dirNode },
  [`${dir}/claude`]: { type: 'file', mode: 0o755, uid: ME, ...file },
});
const check = (command: string, nodes: Record<string, Node>, path = '/usr/bin') => checkLocation(command, { path, platform: 'linux', fs: fsOf(nodes) });

describe('checkLocation: owner and permissions (B1)', () => {
  it('a CLI in your own folder, in root-owned system folders: ok', () => {
    expect(check('/home/u/.local/bin/claude', { ...claudeIn('/home/u/.local/bin'), '/home/u/.local': { type: 'dir', mode: 0o755, uid: ME } })).toMatchObject({ ok: true, real: '/home/u/.local/bin/claude' });
    expect(check('/usr/local/bin/claude', { '/usr/local/bin/claude': { type: 'file', mode: 0o755, uid: 0 } })).toMatchObject({ ok: true });
  });

  it('a file or folder owned by another user: refused', () => {
    expect(check('/home/u/bin/claude', claudeIn('/home/u/bin', { uid: 1001 }))).toEqual({ ok: false, path: '/home/u/bin/claude', reason: '/home/u/bin/claude is owned by another user' });
    expect(check('/home/u/bin/claude', claudeIn('/home/u/bin', {}, { uid: 1001 }))).toEqual({ ok: false, path: '/home/u/bin/claude', reason: '/home/u/bin is owned by another user' });
  });

  it('others-writable: a file never; a folder only as a sticky parent, never as the CLI\'s own folder', () => {
    expect(check('/home/u/bin/claude', claudeIn('/home/u/bin', { mode: 0o757 }))).toMatchObject({ ok: false, reason: '/home/u/bin/claude is writable by other users' });
    expect(check('/srv/shared/bin/claude', { '/srv/shared/bin': { type: 'dir', mode: 0o777, uid: 0 }, '/srv/shared/bin/claude': { type: 'file', mode: 0o755, uid: ME } })).toMatchObject({ ok: false, reason: '/srv/shared/bin is writable by other users' });
    expect(check('/tmp/tools/claude', { '/tmp': { type: 'dir', mode: 0o1777, uid: 0 }, '/tmp/tools': { type: 'dir', mode: 0o700, uid: ME }, '/tmp/tools/claude': { type: 'file', mode: 0o755, uid: ME } })).toMatchObject({ ok: true });
    expect(check('/tmp/claude', { '/tmp': { type: 'dir', mode: 0o1777, uid: 0 }, '/tmp/claude': { type: 'file', mode: 0o755, uid: ME } })).toMatchObject({ ok: false, reason: '/tmp is writable by other users' });
    expect(check('/srv/a/b/claude', { '/srv': { type: 'dir', mode: 0o777, uid: 0 }, '/srv/a': { type: 'dir', mode: 0o755, uid: ME }, '/srv/a/b': { type: 'dir', mode: 0o755, uid: ME }, '/srv/a/b/claude': { type: 'file', mode: 0o755, uid: ME } })).toMatchObject({ ok: false, reason: '/srv is writable by other users' });
  });

  it('group-writable: only when the group is your own primary group', () => {
    expect(check('/home/u/bin/claude', claudeIn('/home/u/bin', {}, { mode: 0o775, gid: MY_GROUP }))).toMatchObject({ ok: true });
    expect(check('/home/u/bin/claude', claudeIn('/home/u/bin', { mode: 0o775, gid: MY_GROUP }))).toMatchObject({ ok: true });
    expect(check('/usr/local/bin/claude', { '/usr/local/bin': { type: 'dir', mode: 0o775, uid: ME, gid: 80 }, '/usr/local/bin/claude': { type: 'file', mode: 0o755, uid: ME } })).toMatchObject({ ok: false, reason: '/usr/local/bin is writable by its group' });
    expect(check('/home/u/bin/claude', claudeIn('/home/u/bin', { mode: 0o775, gid: 100 }))).toMatchObject({ ok: false, reason: '/home/u/bin/claude is writable by its group' });
  });
});

describe('checkLocation: symlinks (B1)', () => {
  const versions = { '/home/u/.local': { type: 'dir', mode: 0o755, uid: ME }, '/home/u/.local/share': { type: 'dir', mode: 0o755, uid: ME }, '/home/u/.local/share/claude': { type: 'dir', mode: 0o755, uid: ME }, '/home/u/.local/share/claude/versions': { type: 'dir', mode: 0o755, uid: ME }, '/home/u/.local/share/claude/versions/2.1.4': { type: 'file', mode: 0o755, uid: ME } } as const;

  it('the native installer layout (link in ~/.local/bin → versions folder): ok, with both paths', () => {
    const r = check('/home/u/.local/bin/claude', { ...HOME, ...versions, '/home/u/.local/bin': { type: 'dir', mode: 0o755, uid: ME }, '/home/u/.local/bin/claude': { type: 'link', mode: 0o777, uid: ME, target: '/home/u/.local/share/claude/versions/2.1.4' } });
    expect(r).toEqual({ ok: true, checked: true, link: '/home/u/.local/bin/claude', real: '/home/u/.local/share/claude/versions/2.1.4' });
  });

  it('a safe real file behind a link in an unsafe folder: refused, naming the link\'s folder', () => {
    const r = check('/srv/bin/claude', { ...HOME, ...versions, '/srv/bin': { type: 'dir', mode: 0o777, uid: 0 }, '/srv/bin/claude': { type: 'link', mode: 0o777, uid: ME, target: '/home/u/.local/share/claude/versions/2.1.4' } });
    expect(r).toMatchObject({ ok: false, reason: '/srv/bin is writable by other users' });
  });

  it('a safe link to an unsafe real file: refused', () => {
    const r = check('/home/u/bin/claude', { ...HOME, '/home/u/bin': { type: 'dir', mode: 0o755, uid: ME }, '/home/u/bin/claude': { type: 'link', mode: 0o777, uid: ME, target: '/opt/x/claude.js' }, '/opt/x': { type: 'dir', mode: 0o777, uid: 0 }, '/opt/x/claude.js': { type: 'file', mode: 0o755, uid: ME } });
    expect(r).toMatchObject({ ok: false, reason: '/opt/x is writable by other users' });
  });
});

describe('checkLocation: scripts and their interpreter (B1)', () => {
  const script = (head: string, extra: Record<string, Node> = {}) => ({ ...claudeIn('/home/u/bin', { head }), '/usr/bin/env': { type: 'file', mode: 0o755, uid: 0 } as Node, ...extra });

  it('#!/usr/bin/env node: the node on the filtered PATH is checked and reported', () => {
    const nodes = script('#!/usr/bin/env node\n', { '/usr/bin/node': { type: 'file', mode: 0o755, uid: 0 } });
    expect(check('/home/u/bin/claude', nodes, '/home/u/proj/node_modules/.bin:/usr/bin')).toMatchObject({ ok: true, interpreter: '/usr/bin/node' });
  });

  it('an unsafe node is refused; a node only in an npm folder is not used', () => {
    const unsafe = script('#!/usr/bin/env node\n', { '/opt/n': { type: 'dir', mode: 0o777, uid: 0 }, '/opt/n/node': { type: 'file', mode: 0o755, uid: ME } });
    expect(check('/home/u/bin/claude', unsafe, '/opt/n')).toMatchObject({ ok: false, reason: '/opt/n is writable by other users' });
    const npmOnly = script('#!/usr/bin/env node\n', { '/p/node_modules/.bin/node': { type: 'file', mode: 0o755, uid: ME } });
    expect(check('/home/u/bin/claude', npmOnly, '/p/node_modules/.bin')).toMatchObject({ ok: false, reason: 'its interpreter node was not found' });
  });

  it('#!/usr/bin/env -S node --flag, and an absolute interpreter', () => {
    const s = script('#!/usr/bin/env -S node --no-warnings\n', { '/usr/bin/node': { type: 'file', mode: 0o755, uid: 0 } });
    expect(check('/home/u/bin/claude', s)).toMatchObject({ ok: true, interpreter: '/usr/bin/node' });
    const abs = script('#!/opt/node/bin/node\n', { '/opt/node/bin': { type: 'dir', mode: 0o777, uid: 0 }, '/opt/node/bin/node': { type: 'file', mode: 0o755, uid: 0 } });
    expect(check('/home/u/bin/claude', abs)).toMatchObject({ ok: false, reason: '/opt/node/bin is writable by other users' });
  });

  it('a binary (no #!) has no interpreter', () => {
    expect(check('/home/u/bin/claude', claudeIn('/home/u/bin'))).toEqual({ ok: true, checked: true, real: '/home/u/bin/claude' });
  });

  it('Windows: not checked (ACLs), said so in the result', () => {
    expect(checkLocation('C:\\tools\\claude.exe', { path: 'C:\\tools', platform: 'win32' })).toEqual({ ok: true, checked: false, real: 'C:\\tools\\claude.exe' });
  });
});

describe.runIf(POSIX)('checkLocation on the real file system', () => {
  let fakes: Fakes;
  afterEach(() => fakes.cleanup());

  it('the test fakes (0700 temp folder under sticky /tmp, a #!/usr/bin/env node script) pass', () => {
    fakes = installFakes();
    const r = checkLocation(join(fakes.dir, 'claude'), { path: fakes.PATH });
    expect(r).toMatchObject({ ok: true, checked: true });
    if (r.ok) expect(r.interpreter).toMatch(/\/node$/);
  });

  it('the same folder made writable by everyone: refused', () => {
    fakes = installFakes();
    chmodSync(fakes.dir, 0o777);
    expect(checkLocation(join(fakes.dir, 'claude'), { path: fakes.PATH })).toEqual({ ok: false, path: join(fakes.dir, 'claude'), reason: `${fakes.dir} is writable by other users` });
  });
});
