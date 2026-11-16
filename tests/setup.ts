/**
 * Loaded before every test file (vitest setupFiles).
 * Slow-machine mode: SIGNAL_TEST_SLOW_HASH=<ms> delays content fingerprinting (crypto.subtle.digest) like a loaded
 * CI box does. The suite must pass with it: tests must wait for the code, not for a fixed number of ms.
 */
import { vi } from 'vitest';

const SLOW_HASH_MS = Number(process.env.SIGNAL_TEST_SLOW_HASH ?? 0);
if (SLOW_HASH_MS > 0 && globalThis.crypto?.subtle) {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args: Parameters<typeof digest>) => {
    await new Promise((r) => setTimeout(r, SLOW_HASH_MS));
    return digest(...args);
  });
}
