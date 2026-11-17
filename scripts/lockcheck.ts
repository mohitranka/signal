/**
 * Lockfile check (docs/design-finding-d-lockfile.md): does every package-lock.json entry exist on the configured
 * registry, with the same integrity hash? Explains an `npm ci` 404, telling "your registry is behind this lockfile"
 * apart from unpublished versions, and flags integrity mismatches (possible supply-chain problem).
 * Pure: the registry is passed in, so this runs in tests without network.
 *
 * Everything from the lockfile or the registry is untrusted text: it is printed only through printable() (rule S5),
 * so a hostile registry cannot rewrite the terminal (e.g. erase the INTEGRITY MISMATCH warning). Security S1.
 */
import { printable as p } from '../src/classifier/parse';

export interface LockEntry {
  name: string;
  version: string;
  integrity?: string;
}

/** The parts of an (abbreviated) npm packument this check reads. null: the registry does not know the package. */
export type Packument = {
  versions?: Record<string, { dist?: { integrity?: string } } | undefined>;
  'dist-tags'?: Record<string, string>;
} | null;

export interface Registry {
  packument(name: string): Promise<Packument>;
}

export interface Missing {
  name: string;
  version: string;
  /**
   * Highest version the registry has in the locked version's release line (same major; same minor for 0.x, as `^`
   * ranges do), releases preferred; if it has none in that line, its highest overall; null if it has none at all.
   */
  newest: string | null;
  /** The registry's highest version overall, when that is in a different release line than `newest`. */
  newestOverall?: string;
  /** The locked version is newer than anything the registry has in its line: the registry is probably behind. */
  ahead: boolean;
}

export interface Mismatch {
  name: string;
  version: string;
  lock: string;
  registry: string;
}

export interface LockCheck {
  /** Entries that could be checked (registry answered). */
  checked: number;
  ok: number;
  missing: Missing[];
  mismatched: Mismatch[];
  errors: { name: string; message: string }[];
  registryBehind: boolean;
}

const NM = 'node_modules/';

/** One part of a package name: letters (legacy uppercase allowed), digits, -._~; not starting with . or _. */
const NAME_PART = /^[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

/**
 * npm's package-name rule (security S6): checked before a name is put into a registry URL, so a crafted lockfile name
 * cannot reach other paths on the registry host. Legacy uppercase names (e.g. JSONStream) are accepted.
 */
export function isValidPackageName(name: string): boolean {
  if (typeof name !== 'string' || name.length < 1 || name.length > 214) return false;
  if (!name.startsWith('@')) return NAME_PART.test(name);
  const slash = name.indexOf('/');
  return slash > 1 && NAME_PART.test(name.slice(1, slash)) && NAME_PART.test(name.slice(slash + 1));
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why responses from this registry cannot be trusted, or null (security S5): plain http to another machine, or TLS
 * certificate checks switched off, both let anyone on the network path rewrite the answers.
 */
export function registryTrust(url: string, env: Record<string, string | undefined>): string | null {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return 'TLS certificate checks are disabled (NODE_TLS_REJECT_UNAUTHORIZED=0)';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'the registry URL cannot be parsed';
  }
  if (u.protocol === 'http:') return LOCAL_HOSTS.has(u.hostname) ? null : `plain http to ${u.hostname}`;
  return u.protocol === 'https:' ? null : `unsupported protocol ${u.protocol}`;
}

/** Semver order: numeric major.minor.patch; a pre-release sorts before its release; build metadata ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('+')[0]!.split(/-(.*)/s);
    return { nums: core.split('.').map((x) => Number(x) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // release > pre-release
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The registry packages a lockfile (v2/v3 "packages") installs, one per name@version, sorted. Skips the root,
 * workspace folders and links, and bundled dependencies; an npm alias is listed under its real package name.
 */
export function lockEntries(lock: unknown): LockEntry[] {
  const packages = (lock as { packages?: Record<string, unknown> } | null)?.packages ?? {};
  const byKey = new Map<string, LockEntry>();
  for (const [path, raw] of Object.entries(packages)) {
    if (!path.includes(NM) || !raw || typeof raw !== 'object') continue;
    const v = raw as { name?: unknown; version?: unknown; integrity?: unknown; link?: unknown; inBundle?: unknown };
    if (v.link || v.inBundle || typeof v.version !== 'string') continue;
    const name = typeof v.name === 'string' ? v.name : path.slice(path.lastIndexOf(NM) + NM.length);
    const key = `${name}@${v.version}`;
    if (!byKey.has(key)) byKey.set(key, { name, version: v.version, ...(typeof v.integrity === 'string' ? { integrity: v.integrity } : {}) });
  }
  return [...byKey.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : compareVersions(a.version, b.version)));
}

/** Release line, as `^` ranges see it: "7" for 7.29.14, "0.4" for 0.4.3. */
const lineOf = (v: string): string => {
  const [major = '', minor = ''] = v.split('.');
  return major === '0' ? `0.${minor}` : major;
};

function newestOf(versions: string[]): string | null {
  const releases = versions.filter((v) => !v.split('+')[0]!.includes('-'));
  const pool = releases.length ? releases : versions;
  return pool.length ? pool.reduce((m, v) => (compareVersions(v, m) > 0 ? v : m)) : null;
}

/** Check every entry against the registry; each package's metadata is fetched once, `concurrency` at a time. */
export async function checkLock(lock: unknown, registry: Registry, opts: { concurrency?: number } = {}): Promise<LockCheck> {
  const entries = lockEntries(lock);
  const packuments = new Map<string, Packument>();
  const errors: LockCheck['errors'] = [];
  const names: string[] = [];
  for (const name of new Set(entries.map((e) => e.name))) {
    if (isValidPackageName(name)) names.push(name);
    else errors.push({ name, message: 'invalid package name' }); // never requested
  }
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++]!;
      try {
        const p = await registry.packument(name);
        const versions = (p as { versions?: unknown } | null)?.versions;
        // A packument must be an object whose versions is a plain object (null: the registry does not know it).
        if (p !== null && (typeof p !== 'object' || !versions || typeof versions !== 'object' || Array.isArray(versions))) {
          errors.push({ name, message: 'malformed registry response' });
        } else {
          packuments.set(name, p);
        }
      } catch (e) {
        errors.push({ name, message: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 8, names.length)) }, worker));

  const result: LockCheck = { checked: 0, ok: 0, missing: [], mismatched: [], errors: errors.sort((a, b) => (a.name < b.name ? -1 : 1)), registryBehind: false };
  for (const e of entries) {
    if (!packuments.has(e.name)) continue; // could not check
    result.checked++;
    const versions = packuments.get(e.name)?.versions ?? {};
    // Own properties only: a lockfile version named "constructor" or "__proto__" is not published.
    const published = Object.hasOwn(versions, e.version) ? versions[e.version] : undefined;
    if (!published) {
      // Judge "ahead" within the locked release line: 7.29.14 is ahead of a registry whose 7.x stops at 7.29.13,
      // even if 8.x exists there.
      const all = Object.keys(versions);
      const inLine = newestOf(all.filter((v) => lineOf(v) === lineOf(e.version)));
      const overall = newestOf(all);
      const newest = inLine ?? overall;
      result.missing.push({
        name: e.name,
        version: e.version,
        newest,
        ...(inLine && overall && overall !== inLine ? { newestOverall: overall } : {}),
        ahead: newest !== null && compareVersions(e.version, newest) > 0,
      });
      continue;
    }
    const reg: unknown = published && typeof published === 'object' ? published.dist?.integrity : undefined;
    // Any integrity the registry gives must equal the lockfile's; a non-string one never does.
    if (e.integrity && reg !== undefined && reg !== e.integrity) {
      result.mismatched.push({ name: e.name, version: e.version, lock: e.integrity, registry: String(reg) });
    } else {
      result.ok++;
    }
  }
  result.registryBehind = result.missing.some((m) => m.ahead);
  return result;
}

/**
 * Human-readable report. Exit code: 0 all match, 1 missing or mismatched entries, 2 could not check some. With an
 * untrusted registry (registryTrust), a warning comes first and the exit code is at least 2 (security S5).
 */
export function formatReport(r: LockCheck, opts: { untrusted?: string } = {}): { text: string; exitCode: 0 | 1 | 2 } {
  const plain = reportBody(r);
  if (!opts.untrusted) return plain;
  const warning = `WARNING: the registry connection is not authenticated (${p(opts.untrusted)}): responses can be forged in transit, so a clean result proves nothing.`;
  return { text: `${warning}\n\n${plain.text}`, exitCode: 2 };
}

function reportBody(r: LockCheck): { text: string; exitCode: 0 | 1 | 2 } {
  if (!r.missing.length && !r.mismatched.length && !r.errors.length) {
    return { text: `check-lock: all ${r.checked} entries match the registry.`, exitCode: 0 };
  }
  const lines = [
    `check-lock: ${r.checked} entries checked: ${r.ok} match, ${r.missing.length} missing, ${r.mismatched.length} integrity mismatch, ${r.errors.length} could not check`,
  ];
  if (r.missing.length) {
    lines.push('', 'MISSING (this registry does not have these versions):');
    for (const m of r.missing) {
      const line = m.newestOverall ? ` in ${p(lineOf(m.version))}.x` : '';
      const why = m.newest === null ? '' : m.ahead ? `  (newer than anything published here${line})` : '  (not on the registry: unpublished?)';
      const overall = m.newestOverall ? ` (newest overall: ${p(m.newestOverall)})` : '';
      lines.push(`  ${p(m.name)}@${p(m.version)}  newest available: ${p(m.newest ?? 'none')}${overall}${why}`);
    }
  }
  if (r.mismatched.length) {
    lines.push('', 'INTEGRITY MISMATCH: possible supply-chain problem; do not install until it is explained:');
    for (const m of r.mismatched) lines.push(`  ${p(m.name)}@${p(m.version)}  lockfile ${p(m.lock)}  registry ${p(m.registry)}`);
  }
  if (r.errors.length) {
    lines.push('', 'COULD NOT CHECK (registry error):');
    for (const e of r.errors) lines.push(`  ${p(e.name)}: ${p(e.message)}`);
  }
  if (r.registryBehind) {
    const n = r.missing.filter((m) => m.ahead).length;
    lines.push(
      '',
      `Hint: this registry looks behind this lockfile (${n} ${n === 1 ? 'entry is' : 'entries are'} newer than anything it has).`,
      // Security S4: the remedy that keeps the lockfile's integrity checks first; the bypass only with its warning.
      "Fix: use an up-to-date registry, which keeps the lockfile's integrity checks:",
      '  npm ci --registry=https://registry.npmjs.org/    (or refresh your mirror; see `npm config get registry`)',
      'Last resort, throwaway environments only: npm install --no-package-lock --no-save',
      "  skips the lockfile's pinned versions and integrity checks, so a newly published malicious version could be",
      '  installed. Do not ship or load a build made this way; go back to npm ci once the registry has caught up.',
    );
  }
  return { text: lines.join('\n'), exitCode: r.missing.length || r.mismatched.length ? 1 : 2 };
}
