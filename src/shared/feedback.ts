import type { Verdict } from './types';

/**
 * Rules for feedback data that crosses a trust boundary (content script -> background, storage -> popup).
 * Shared so the background, the popup and the corrections report agree on what a valid entry is.
 */

/** Content fingerprints are the first 16 bytes of a SHA-256, as 32 lowercase hex characters (see shared/post.ts). */
export const FP_PATTERN = /^[0-9a-f]{32}$/;

/** Upper bound on stored corrections, well inside chrome.storage.local's 10 MB quota (shared with settings and cache). */
export const MAX_FEEDBACK_ENTRIES = 2000;

export const isVerdict = (v: unknown): v is Verdict => v === 'keep' || v === 'collapse';
