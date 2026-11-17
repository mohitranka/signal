/**
 * Terminal output (docs/mockups/bridge/terminal.png): at most 78 columns per line, and invariant I9: lines carry
 * counts, timings and outcomes only, never post text, prompts or model output.
 */
import { printable } from '../src/classifier/parse';

export const MAX_COLUMNS = 78;
const VALUE_COLUMN = 38;

/** "  label ........ value", values aligned at column 39. */
export function dotted(label: string, value: string): string {
  const head = `  ${label} `;
  return `${head}${'.'.repeat(Math.max(2, VALUE_COLUMN - head.length))} ${value}`;
}

/** Untrusted text (e.g. a CLI's error line during the self-test) made printable and cut to `max` characters. */
export function snippet(text: string, max = 70): string {
  const line = printable(text.replace(/\s+/g, ' ').trim());
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

const two = (n: number) => String(n).padStart(2, '0');
export const clock = (d: Date = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** One line per request. `what` is a fixed label chosen by the bridge, never text from the request or the CLI. */
export function requestLine(e: {
  at?: Date;
  outcome: 'ok' | number;
  ms?: number;
  usage?: { input: number; output: number };
  queue?: number;
  what?: string;
}): string {
  const kind = e.outcome === 'ok' || e.ms !== undefined ? 'classify' : 'rejected';
  const parts = [clock(e.at), kind.padEnd(8), String(e.outcome).padEnd(4)];
  if (e.ms !== undefined) parts.push(secs(e.ms).padStart(6));
  if (e.usage) parts.push(`${String(e.usage.input).padStart(5)} in / ${String(e.usage.output).padStart(4)} out`);
  if (e.what) parts.push(e.what);
  if (e.queue !== undefined) parts.push(`queue ${e.queue}`);
  return parts.join('  ').slice(0, MAX_COLUMNS);
}

/** A path shown with "~" for the home folder (only a whole-folder prefix). */
export function tilde(p: string, home: string | undefined): string {
  if (!home) return p;
  return p === home ? '~' : p.startsWith(home.endsWith('/') ? home : home + '/') ? '~' + p.slice(home.replace(/\/$/, '').length) : p;
}

/** `prefix` + `text`, keeping the end of `text` (shortened from the left with "…") so the line fits MAX_COLUMNS. */
export function fitLine(prefix: string, text: string): string {
  const room = MAX_COLUMNS - prefix.length;
  return prefix + (text.length <= room ? text : '…' + text.slice(text.length - room + 1));
}

/** Security B1: where the CLI is, under "found" (docs/mockups/security-b1-b2/terminal.png, 1 and 2). */
export function pathLines(where: { link?: string; real: string; interpreter?: string }, home: string | undefined): string[] {
  const real = tilde(where.real, home);
  const lines: string[] = [];
  if (where.link) {
    const link = tilde(where.link, home);
    const one = `    ${link} → ${real}`;
    if (one.length <= MAX_COLUMNS) lines.push(one);
    else lines.push(fitLine('    ', link), fitLine('    → ', real));
  } else {
    lines.push(fitLine('    ', real));
  }
  if (where.interpreter) lines.push(fitLine('    runs with ', tilde(where.interpreter, home)));
  return lines;
}
