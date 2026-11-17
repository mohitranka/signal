/**
 * npm run check-lock [-- --lockfile path/to/package-lock.json] [--timeout-ms 30000]
 *
 * Checks every lockfile entry against the configured registry (npm_config_registry, set by `npm run`; default: the
 * public registry). Explains why `npm ci` fails with a 404, and flags integrity mismatches. Needs network access, like
 * `npm ci` itself. Registries that require authentication are not supported.
 */
import { readFileSync } from 'node:fs';
import { printable } from '../src/classifier/parse';
import { checkLock, formatReport, registryTrust, type Packument } from './lockcheck';

const args = process.argv.slice(2);
const at = args.indexOf('--lockfile');
const lockfile = at === -1 ? 'package-lock.json' : args[at + 1] ?? 'package-lock.json';
const base = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/*$/, '/');
/** Per-request timeout (security S6): a registry that stalls cannot hang the tool. */
const timeoutAt = args.indexOf('--timeout-ms');
const timeoutMs = timeoutAt === -1 ? 30_000 : Number(args[timeoutAt + 1]);

/** The registry URL for display, without any credentials it may carry. */
function shown(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '(unparseable registry URL)';
  }
}

const registry = {
  async packument(name: string): Promise<Packument> {
    // Scoped packages: "@scope/name" is requested as "@scope%2fname".
    // Names are validated before they get here (isValidPackageName), so the only "/" is a scope's.
    let res: Response;
    try {
      res = await fetch(base + name.replace('/', '%2f'), {
        headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') throw new Error(`timed out after ${timeoutMs} ms`);
      throw e;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Packument;
  },
};

async function main(): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive whole number of milliseconds');
  const lock = JSON.parse(readFileSync(lockfile, 'utf8')) as unknown;
  console.log(`checking ${printable(lockfile)} against ${printable(shown(base))}`);
  const untrusted = registryTrust(base, process.env);
  const report = formatReport(await checkLock(lock, registry), untrusted ? { untrusted } : {});
  console.log(report.text);
  process.exitCode = report.exitCode;
}

main().catch((e) => {
  console.error(`check-lock: ${printable(e instanceof Error ? e.message : String(e))}`);
  process.exitCode = 2;
});
