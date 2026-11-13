import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });

const common = {
  bundle: true,
  target: 'chrome116',
  format: 'esm',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
};
const entries = [
  { entryPoints: { 'service-worker': 'src/background/service-worker.ts' }, ...common },
  // Content scripts and popup are classic scripts, not modules.
  { entryPoints: { content: 'src/content/index.ts' }, ...common, format: 'iife' },
  { entryPoints: { popup: 'src/popup/popup.ts' }, ...common, format: 'iife' },
];

for (const e of entries) {
  const opts = { ...e, outdir: 'dist' };
  if (watch) await (await context(opts)).watch();
  else await build(opts);
}
