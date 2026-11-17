// @vitest-environment node
/**
 * Finding D (docs/design-finding-d-lockfile.md): `npm run check-lock` explains why `npm ci` fails, by checking every
 * lockfile entry against the configured registry: missing versions (and whether the registry looks behind the
 * lockfile), integrity mismatches (possible supply-chain problem), and entries that could not be checked.
 * No network: the registry is a fake object, or a local HTTP server for the end-to-end run.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { checkLock, compareVersions, formatReport, isValidPackageName, lockEntries, registryTrust } from '../scripts/lockcheck';

type Packument = { versions: Record<string, { dist?: { integrity?: string } }>; 'dist-tags'?: Record<string, string> } | null;

/** A fake registry: name -> { version -> integrity }. */
const registryOf = (data: Record<string, Record<string, string>>) => ({
  packument: vi.fn(async (name: string): Promise<Packument> => {
    const vs = data[name];
    if (!vs) return null;
    const versions = Object.fromEntries(Object.entries(vs).map(([v, integrity]) => [v, { dist: { integrity } }]));
    return { versions, 'dist-tags': { latest: Object.keys(vs).at(-1)! } };
  }),
});

const lockWith = (packages: Record<string, unknown>) => ({ name: 'signal', lockfileVersion: 3, packages: { '': { name: 'signal' }, ...packages } });

describe('lockEntries', () => {
  it('lists each real package once; skips the root, workspace links, workspace folders and bundled deps; resolves aliases', () => {
    const lock = lockWith({
      'node_modules/ws': { version: '8.23.0', integrity: 'sha512-A' },
      'node_modules/a/node_modules/ws': { version: '8.23.0', integrity: 'sha512-A' }, // same name@version, other path
      'node_modules/b/node_modules/ws': { version: '7.5.10', integrity: 'sha512-C' },
      'node_modules/strip-ansi-cjs': { name: 'strip-ansi', version: '6.0.1', integrity: 'sha512-B' }, // npm alias
      'node_modules/@babel/parser': { version: '7.29.14', integrity: 'sha512-D' },
      'node_modules/local-pkg': { link: true, resolved: 'packages/local' },
      'node_modules/x/node_modules/bundled': { version: '1.0.0', inBundle: true },
      'packages/local': { version: '0.0.1' },
      'node_modules/no-version': {},
    });
    expect(lockEntries(lock)).toEqual([
      { name: '@babel/parser', version: '7.29.14', integrity: 'sha512-D' },
      { name: 'strip-ansi', version: '6.0.1', integrity: 'sha512-B' },
      { name: 'ws', version: '7.5.10', integrity: 'sha512-C' },
      { name: 'ws', version: '8.23.0', integrity: 'sha512-A' },
    ]);
  });
});

describe('compareVersions', () => {
  it('orders by semver', () => {
    expect(compareVersions('4.68.3', '4.68.2')).toBeGreaterThan(0);
    expect(compareVersions('8.23.0', '8.22.2')).toBeGreaterThan(0);
    expect(compareVersions('10.0.0', '9.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('2.1.6', '2.1.6')).toBe(0);
    expect(compareVersions('2.1.6', '2.1.8')).toBeLessThan(0);
  });
});

describe('checkLock + formatReport', () => {
  const lock = lockWith({
    'node_modules/ws': { version: '8.23.0', integrity: 'sha512-WS' },
    'node_modules/rollup': { version: '4.68.3', integrity: 'sha512-RO' },
    'node_modules/jsdom': { version: '26.1.0', integrity: 'sha512-JS' },
  });

  it('everything present and matching: exit 0', async () => {
    const r = await checkLock(lock, registryOf({ ws: { '8.23.0': 'sha512-WS' }, rollup: { '4.68.3': 'sha512-RO' }, jsdom: { '26.1.0': 'sha512-JS' } }));
    expect(r).toMatchObject({ checked: 3, ok: 3, missing: [], mismatched: [], errors: [], registryBehind: false });
    const rep = formatReport(r);
    expect(rep.exitCode).toBe(0);
    expect(rep.text).toContain('all 3 entries match');
  });

  it('versions newer than anything published: the registry looks behind this lockfile (exit 1, with the fix)', async () => {
    const r = await checkLock(lock, registryOf({ ws: { '8.22.1': 'x', '8.22.2': 'y' }, rollup: { '4.68.2': 'z' }, jsdom: { '26.1.0': 'sha512-JS' } }));
    expect(r.missing).toEqual([
      { name: 'rollup', version: '4.68.3', newest: '4.68.2', ahead: true },
      { name: 'ws', version: '8.23.0', newest: '8.22.2', ahead: true },
    ]);
    expect(r.registryBehind).toBe(true);
    const rep = formatReport(r);
    expect(rep.exitCode).toBe(1);
    expect(rep.text).toContain('ws@8.23.0');
    expect(rep.text).toContain('newest available: 8.22.2');
    expect(rep.text).toMatch(/registry looks behind this lockfile/i);
    // Security S4: the remedy that keeps the lockfile's integrity checks comes first.
    const ci = rep.text.indexOf('npm ci --registry=https://registry.npmjs.org/');
    const bypass = rep.text.indexOf('--no-package-lock');
    expect(ci).toBeGreaterThan(-1);
    expect(bypass === -1 || ci < bypass).toBe(true);
  });

  it('the lockfile bypass is offered only as a last resort, with its supply-chain warning (security S4)', async () => {
    const r = await checkLock(lock, registryOf({ ws: { '8.22.2': 'y' }, rollup: { '4.68.2': 'z' }, jsdom: { '26.1.0': 'sha512-JS' } }));
    const hint = formatReport(r).text.slice(formatReport(r).text.indexOf('Hint:'));
    expect(hint).toContain('--no-package-lock');
    expect(hint).toMatch(/integrity/i);
    expect(hint).toMatch(/throwaway/i);
    expect(hint).toMatch(/do not ship/i);
  });

  it('reports without a "behind" hint mention neither remedy (security S4)', async () => {
    const allMatch = formatReport(await checkLock(lock, registryOf({ ws: { '8.23.0': 'sha512-WS' }, rollup: { '4.68.3': 'sha512-RO' }, jsdom: { '26.1.0': 'sha512-JS' } })));
    const unpublished = formatReport(await checkLock(
      lockWith({ 'node_modules/brace-expansion': { version: '2.0.1', integrity: 'sha512-BE' } }),
      registryOf({ 'brace-expansion': { '2.0.0': 'a', '2.0.2': 'b' } }),
    ));
    for (const rep of [allMatch, unpublished]) {
      expect(rep.text).not.toContain('npm ci --registry');
      expect(rep.text).not.toContain('--no-package-lock');
    }
  });

  it('a version missing below newer ones (unpublished): listed without the "behind" hint', async () => {
    const r = await checkLock(
      lockWith({ 'node_modules/brace-expansion': { version: '2.0.1', integrity: 'sha512-BE' } }),
      registryOf({ 'brace-expansion': { '2.0.0': 'a', '2.0.2': 'b' } }),
    );
    expect(r.missing).toEqual([{ name: 'brace-expansion', version: '2.0.1', newest: '2.0.2', ahead: false }]);
    expect(r.registryBehind).toBe(false);
    const rep = formatReport(r);
    expect(rep.exitCode).toBe(1);
    expect(rep.text).toMatch(/unpublished/i);
    expect(rep.text).not.toMatch(/behind/i);
  });

  it('"ahead" is judged within the locked release line, not against a newer major (found on the real registry)', async () => {
    const r = await checkLock(
      lockWith({
        'node_modules/@babel/parser': { version: '7.29.14', integrity: 'sha512-P' }, // registry: newest 7.x is 7.29.13, but 8.x exists
        'node_modules/tiny': { version: '0.4.3', integrity: 'sha512-T' }, // 0.x: the line is 0.4
        'node_modules/brace-expansion': { version: '2.1.8', integrity: 'sha512-B' }, // no 2.x at all: compare overall
      }),
      registryOf({
        '@babel/parser': { '7.29.12': 'a', '7.29.13': 'b', '8.0.0': 'c', '8.1.0': 'd' },
        tiny: { '0.4.2': 'e', '0.5.0': 'f' },
        'brace-expansion': { '1.1.12': 'g', '5.0.12': 'h' },
      }),
    );
    expect(r.missing).toEqual([
      { name: '@babel/parser', version: '7.29.14', newest: '7.29.13', newestOverall: '8.1.0', ahead: true },
      { name: 'brace-expansion', version: '2.1.8', newest: '5.0.12', ahead: false },
      { name: 'tiny', version: '0.4.3', newest: '0.4.2', newestOverall: '0.5.0', ahead: true },
    ]);
    expect(r.registryBehind).toBe(true);
    expect(formatReport(r).text).toContain('@babel/parser@7.29.14  newest available: 7.29.13 (newest overall: 8.1.0)  (newer than anything published here');
  });

  it('an integrity mismatch is reported separately, as a possible supply-chain problem (exit 1)', async () => {
    const r = await checkLock(lock, registryOf({ ws: { '8.23.0': 'sha512-OTHER' }, rollup: { '4.68.3': 'sha512-RO' }, jsdom: { '26.1.0': 'sha512-JS' } }));
    expect(r.missing).toEqual([]);
    expect(r.mismatched).toEqual([{ name: 'ws', version: '8.23.0', lock: 'sha512-WS', registry: 'sha512-OTHER' }]);
    const rep = formatReport(r);
    expect(rep.exitCode).toBe(1);
    expect(rep.text).toMatch(/integrity mismatch/i);
    expect(rep.text).toMatch(/supply-chain/i);
  });

  it('a package the registry does not know at all is missing, with no newest version', async () => {
    const r = await checkLock(lockWith({ 'node_modules/ghost': { version: '1.0.0', integrity: 'sha512-G' } }), registryOf({}));
    expect(r.missing).toEqual([{ name: 'ghost', version: '1.0.0', newest: null, ahead: false }]);
    expect(formatReport(r).text).toContain('ghost@1.0.0');
  });

  it('a registry error is "could not check", not "missing" (exit 2 when nothing else is wrong)', async () => {
    const reg = registryOf({ rollup: { '4.68.3': 'sha512-RO' }, jsdom: { '26.1.0': 'sha512-JS' } });
    const real = reg.packument.getMockImplementation()!;
    reg.packument.mockImplementation(async (name: string) => {
      if (name === 'ws') throw new Error('ETIMEDOUT');
      return real(name);
    });
    const r = await checkLock(lock, reg);
    expect(r.missing).toEqual([]);
    expect(r.errors).toEqual([{ name: 'ws', message: 'ETIMEDOUT' }]);
    const rep = formatReport(r);
    expect(rep.exitCode).toBe(2);
    expect(rep.text).toMatch(/could not check/i);
  });

  it('fetches each package once, however many of its versions the lockfile holds', async () => {
    const reg = registryOf({ ws: { '7.5.10': 'sha512-C', '8.23.0': 'sha512-A' } });
    await checkLock(
      lockWith({
        'node_modules/ws': { version: '8.23.0', integrity: 'sha512-A' },
        'node_modules/b/node_modules/ws': { version: '7.5.10', integrity: 'sha512-C' },
        'node_modules/c/node_modules/ws': { version: '8.23.0', integrity: 'sha512-A' },
      }),
      reg,
    );
    expect(reg.packument).toHaveBeenCalledTimes(1);
  });
});

describe('hardening (security S6)', () => {
  it('package names are validated before any request (legacy uppercase allowed)', () => {
    for (const ok of ['ws', '@babel/parser', 'JSONStream', 'lodash.merge', 'a-b_c~d', '@types/node']) expect(isValidPackageName(ok), ok).toBe(true);
    for (const bad of ['', '../x', 'a/b', '@a/b/c', '@/x', 'x y', '%2e%2e', '.hidden', '_private', 'a'.repeat(215), '@scope/', 'ws\u001b']) {
      expect(isValidPackageName(bad), JSON.stringify(bad)).toBe(false);
    }
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const names = lockEntries(lock).map((e) => e.name);
    expect(names.length).toBeGreaterThan(150);
    for (const n of names) expect(isValidPackageName(n), n).toBe(true);
  });

  it('an invalid name is reported under "could not check" and never requested', async () => {
    const reg = registryOf({ ws: { '8.23.0': 'sha512-WS' } });
    const r = await checkLock(lockWith({ 'node_modules/ws': { version: '8.23.0', integrity: 'sha512-WS' }, 'node_modules/evil': { name: '../../admin', version: '1.0.0', integrity: 'x' } }), reg);
    expect(r.errors).toEqual([{ name: '../../admin', message: 'invalid package name' }]);
    expect(reg.packument.mock.calls.map((c) => c[0])).toEqual(['ws']);
    expect(formatReport(r).text).toMatch(/could not check/i);
  });

  it('versions named like Object.prototype members are not "published"', async () => {
    const r = await checkLock(
      lockWith({ 'node_modules/a': { version: 'constructor', integrity: 'x' }, 'node_modules/b': { version: '__proto__', integrity: 'y' } }),
      registryOf({ a: { '1.0.0': 'z' }, b: { '1.0.0': 'z' } }),
    );
    expect(r.ok).toBe(0);
    expect(r.missing.map((m) => `${m.name}@${m.version}`)).toEqual(['a@constructor', 'b@__proto__']);
  });

  it('a packument whose versions is not a plain object cannot be checked', async () => {
    for (const versions of [['1.0.0'], '1.0.0', null]) {
      const r = await checkLock(lockWith({ 'node_modules/a': { version: '1.0.0', integrity: 'x' } }), { packument: async () => ({ versions } as any) });
      expect(r.errors, JSON.stringify(versions)).toEqual([{ name: 'a', message: 'malformed registry response' }]);
      expect(r.ok).toBe(0);
    }
  });

  it('a non-string registry integrity is an integrity mismatch, not a match', async () => {
    for (const integrity of [123, { sha: 'x' }]) {
      const r = await checkLock(lockWith({ 'node_modules/a': { version: '1.0.0', integrity: 'sha512-A' } }), {
        packument: async () => ({ versions: { '1.0.0': { dist: { integrity } } } } as any),
      });
      expect(r.ok, JSON.stringify(integrity)).toBe(0);
      expect(r.mismatched).toEqual([{ name: 'a', version: '1.0.0', lock: 'sha512-A', registry: String(integrity) }]);
    }
  });
});

describe('untrusted transport (security S5)', () => {
  it('registryTrust: remote plain http and disabled TLS checks are untrusted; local and https are trusted', () => {
    expect(registryTrust('http://registry.example.com/', {})).toMatch(/plain http/i);
    for (const local of ['http://localhost:4873/', 'http://127.0.0.1:4873/', 'http://[::1]:4873/']) expect(registryTrust(local, {}), local).toBeNull();
    expect(registryTrust('https://registry.npmjs.org/', {})).toBeNull();
    expect(registryTrust('https://registry.npmjs.org/', { NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(registryTrust('http://localhost:4873/', { NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('with an untrusted registry the warning comes first and the exit code is at least 2', async () => {
    const ok = await checkLock(lockWith({ 'node_modules/ws': { version: '8.23.0', integrity: 'sha512-WS' } }), registryOf({ ws: { '8.23.0': 'sha512-WS' } }));
    const rep = formatReport(ok, { untrusted: 'plain http to registry.example.com' });
    expect(rep.text.split('\n')[0]).toMatch(/^WARNING:/);
    expect(rep.text.indexOf('WARNING:')).toBeLessThan(rep.text.indexOf('all 1 entries match'));
    expect(rep.text).toMatch(/proves nothing/i);
    expect(rep.exitCode).toBe(2);
    const missing = await checkLock(lockWith({ 'node_modules/ws': { version: '8.23.0', integrity: 'sha512-WS' } }), registryOf({ ws: { '8.22.2': 'x' } }));
    expect(formatReport(missing, { untrusted: 'plain http' }).exitCode).toBe(2);
    expect(formatReport(ok).exitCode).toBe(0); // trusted: unchanged
  });
});

/** Control characters (except the report's own newlines) and all bidi formatting characters. */
const UNSAFE_OUTPUT = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** Erase the line and rewrite it, a C1 CSI, a right-to-left override and an Arabic letter mark. */
const EVIL = '\u001b[2K\r\u009b31m\u202e\u061c';

describe('untrusted text is never printed raw (security S1)', () => {
  async function hostile() {
    const reg = registryOf({
      evilpkg: { [`0.9.0${EVIL}`]: 'a' }, // lockfile version missing; the registry's version key is hostile
      mm: { '2.0.0': `sha512-B${EVIL}` }, // integrity mismatch with a hostile registry value
      line: { '7.1.0': 'b', [`8.0.0${EVIL}`]: 'c' }, // newest overall is hostile
      err: { '1.0.0': 'd' },
    });
    const real = reg.packument.getMockImplementation()!;
    reg.packument.mockImplementation(async (name: string) => {
      if (name === 'err') throw new Error(`boom${EVIL}`);
      return real(name);
    });
    const lock = lockWith({
      'node_modules/evilpkg': { version: `1.0.0${EVIL}`, integrity: `sha512-L${EVIL}` },
      // A hostile NAME is rejected before any request (security S6) and reported, sanitised, under "could not check".
      'node_modules/evil-alias': { name: `evil${EVIL}pkg`, version: '1.0.0', integrity: 'sha512-N' },
      'node_modules/mm': { version: '2.0.0', integrity: `sha512-A${EVIL}` },
      'node_modules/line': { version: '7.1.1', integrity: 'sha512-X' },
      'node_modules/err': { version: '1.0.0', integrity: 'sha512-E' },
    });
    return formatReport(await checkLock(lock, reg));
  }

  it('no control or bidi characters reach the report, and every section heading stays on its own line', async () => {
    const { text, exitCode } = await hostile();
    expect(text).not.toMatch(UNSAFE_OUTPUT);
    const lines = text.split('\n');
    expect(lines).toContain('MISSING (this registry does not have these versions):');
    expect(lines).toContain('INTEGRITY MISMATCH: possible supply-chain problem; do not install until it is explained:');
    expect(lines).toContain('COULD NOT CHECK (registry error):');
    expect(text).toContain('boom?[2K??31m??');
    expect(exitCode).toBe(1);
  });

  it('the first line is built from numbers only, so no data can spoof it', async () => {
    const { text } = await hostile();
    expect(text.split('\n')[0]).toBe('check-lock: 3 entries checked: 0 match, 2 missing, 1 integrity mismatch, 2 could not check');
  });
});

// These tests start a Node process that talks HTTP to a server in this process: allow for a slow cold start under load
// (a one-off 5 s timeout was seen once in a combined run; it could not be reproduced in 9 further runs).
describe('npm run check-lock (end to end, local registry)', { timeout: 20_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-lock-'));
  let bundle: string;
  beforeAll(() => {
    bundle = join(dir, 'check-lock.mjs');
    buildSync({ entryPoints: ['scripts/check-lock.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  });

  /** A registry serving abbreviated packuments; records each request's path and Accept header. */
  async function serve(data: Record<string, Record<string, string>>) {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      const name = decodeURIComponent((req.url ?? '/').slice(1));
      const vs = data[name];
      if (!vs) return void res.writeHead(404).end('{"error":"Not found"}');
      res.writeHead(200, { 'content-type': 'application/vnd.npm.install-v1+json' });
      res.end(JSON.stringify({ name, 'dist-tags': { latest: Object.keys(vs).at(-1) }, versions: Object.fromEntries(Object.entries(vs).map(([v, i]) => [v, { dist: { integrity: i } }])) }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen, close: () => new Promise((r) => server.close(r)) };
  }

  /** Asynchronous on purpose: spawnSync would block this process, and with it the registry server. */
  const run = (registry: string, lockfile: string, opts: { args?: string[]; env?: Record<string, string>; killAfterMs?: number } = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string; ms: number }>((res) => {
      const env = { ...process.env, npm_config_registry: registry, ...opts.env };
      const started = Date.now();
      const child = spawn(process.execPath, [bundle, '--lockfile', lockfile, ...(opts.args ?? [])], { env, cwd: resolve('.') });
      // A hung child is killed so a failing test ends cleanly (status null) instead of outliving the test.
      const killer = opts.killAfterMs ? setTimeout(() => child.kill(), opts.killAfterMs) : null;
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => {
        if (killer) clearTimeout(killer);
        res({ status, stdout, stderr, ms: Date.now() - started });
      });
    });

  const lockfile = join(dir, 'package-lock.json');
  writeFileSync(lockfile, JSON.stringify(lockWith({
    'node_modules/ws': { version: '8.23.0', integrity: 'sha512-WS' },
    'node_modules/@babel/parser': { version: '7.29.14', integrity: 'sha512-BP' },
    'node_modules/jsdom': { version: '26.1.0', integrity: 'sha512-JS' },
  })));

  it('reports a registry that is behind the lockfile, with exit code 1', async () => {
    const reg = await serve({ ws: { '8.22.2': 'x' }, '@babel/parser': { '7.29.13': 'y' }, jsdom: { '26.1.0': 'sha512-JS' } });
    try {
      const r = await run(reg.url, lockfile);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stdout).toContain('ws@8.23.0');
      expect(r.stdout).toContain('@babel/parser@7.29.14');
      expect(r.stdout).toMatch(/registry looks behind this lockfile/i);
      expect(reg.seen.map((s) => s.url)).toContain('/@babel%2fparser'); // scoped names are encoded
      for (const s of reg.seen) expect(s.headers.accept).toContain('application/vnd.npm.install-v1+json');
    } finally {
      await reg.close();
    }
  });

  it('a hostile registry cannot put control characters on the terminal; the mismatch warning stays intact (security S1)', async () => {
    const reg = await serve({ ws: { [`8.22.2${EVIL}`]: 'x' }, '@babel/parser': { '7.29.14': 'sha512-BP' }, jsdom: { '26.1.0': `sha512-OTHER${EVIL}` } });
    try {
      const r = await run(reg.url, lockfile);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stdout).not.toMatch(UNSAFE_OUTPUT);
      expect(r.stderr).not.toMatch(UNSAFE_OUTPUT);
      expect(r.stdout.split('\n')).toContain('INTEGRITY MISMATCH: possible supply-chain problem; do not install until it is explained:');
    } finally {
      await reg.close();
    }
  });

  it('an error naming a hostile lockfile path is printed sanitised (exit code 2)', async () => {
    const r = await run('http://127.0.0.1:9/', join(dir, `missing${EVIL}.json`));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('check-lock:');
    expect(r.stderr).not.toMatch(UNSAFE_OUTPUT);
  });

  it('a registry that never answers times out per request (--timeout-ms): could not check, exit 2 (security S6)', async () => {
    const server = createServer(() => {}); // accepts, never answers
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const r = await run(url, lockfile, { args: ['--timeout-ms', '300'], killAfterMs: 6000 });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stdout).toMatch(/could not check/i);
      expect(r.stdout).toMatch(/timed out after 300 ms/);
      expect(r.ms).toBeLessThan(5000);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('with TLS checks disabled the report warns first and exits 2, even if everything matches (security S5)', async () => {
    const reg = await serve({ ws: { '8.23.0': 'sha512-WS' }, '@babel/parser': { '7.29.14': 'sha512-BP' }, jsdom: { '26.1.0': 'sha512-JS' } });
    try {
      const r = await run(reg.url, lockfile, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
      expect(r.status, r.stderr).toBe(2);
      expect(r.stdout).toMatch(/WARNING:.*NODE_TLS_REJECT_UNAUTHORIZED/s);
      expect(r.stdout.indexOf('WARNING:')).toBeLessThan(r.stdout.indexOf('entries match'));
    } finally {
      await reg.close();
    }
  });

  it('an invalid package name in the lockfile never reaches the registry (security S6)', async () => {
    const evilLock = join(dir, 'evil-lock.json');
    writeFileSync(evilLock, JSON.stringify(lockWith({
      'node_modules/jsdom': { version: '26.1.0', integrity: 'sha512-JS' },
      'node_modules/evil': { name: '../../-/user/org.couchdb.user:admin', version: '1.0.0', integrity: 'x' },
    })));
    const reg = await serve({ jsdom: { '26.1.0': 'sha512-JS' } });
    try {
      const r = await run(reg.url, evilLock);
      expect(reg.seen.map((s) => s.url)).toEqual(['/jsdom']);
      expect(r.stdout).toMatch(/invalid package name/);
      expect(r.status).toBe(2);
    } finally {
      await reg.close();
    }
  });

  it('exits 0 when the registry has everything', async () => {
    const reg = await serve({ ws: { '8.23.0': 'sha512-WS' }, '@babel/parser': { '7.29.14': 'sha512-BP' }, jsdom: { '26.1.0': 'sha512-JS' } });
    try {
      const r = await run(reg.url, lockfile);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('all 3 entries match');
    } finally {
      await reg.close();
    }
  });
});

describe('wiring', () => {
  it('package.json has the check-lock script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['check-lock']).toMatch(/scripts\/check-lock\.ts/);
  });

  it('this finding leaves package-lock.json untouched', () => {
    const sha = createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');
    expect(sha).toBe('338f1297f4d3d8b6739cb880ff8e3fc0718e1d80d492636891b0725e62c0ffbe'); // as in the baseline commit
  });
});
