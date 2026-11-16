// @vitest-environment node
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

/** Bundle an entry point exactly as build.mjs does, in memory. */
const bundle = (entry: string) =>
  buildSync({ entryPoints: [entry], bundle: true, format: 'iife', target: 'chrome116', platform: 'browser', write: false, logLevel: 'silent' }).outputFiles[0]!.text;

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('popup bundle', () => {
  const js = bundle('src/popup/popup.ts');

  it('contains the feed policy and the eval scoring code exactly once: shared, not copied', () => {
    expect(count(js, 'function decide(')).toBe(1);
    expect(count(js, 'function score(')).toBe(1);
    expect(count(js, 'function correctionReport(')).toBe(1);
    expect(count(js, 'function partitionCorrections(')).toBe(1);
  });

  it('pulls in no Node built-ins (the eval file loader stays out of the extension)', () => {
    expect(js).not.toMatch(/from\s*["']node:|require\(["']node:|readFileSync/);
  });
});
