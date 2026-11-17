// @vitest-environment node
/**
 * Security S4 (docs/design-security-s4.md): user-facing docs never suggest bypassing the lockfile without its
 * supply-chain warning, and always give the remedy that keeps the lockfile's integrity checks first.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const paragraphs = (file: string) => readFileSync(file, 'utf8').split(/\n\s*\n/);

describe('README: lockfile-bypass advice', () => {
  const mentions = paragraphs('README.md').filter((p) => p.includes('--no-package-lock'));

  it('every paragraph mentioning --no-package-lock warns about integrity and limits it to throwaway environments', () => {
    for (const p of mentions) {
      expect(p, p.slice(0, 80)).toMatch(/integrity/i);
      expect(p, p.slice(0, 80)).toMatch(/throwaway/i);
    }
  });

  it('and gives `npm ci --registry=…` (which keeps the integrity checks) before it', () => {
    for (const p of mentions) {
      const ci = p.indexOf('npm ci --registry');
      expect(ci, p.slice(0, 80)).toBeGreaterThan(-1);
      expect(ci, p.slice(0, 80)).toBeLessThan(p.indexOf('--no-package-lock'));
    }
  });
});
