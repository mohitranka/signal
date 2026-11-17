/**
 * Invariant I6 (docs/design-bridge.md): the bridge accepts only Signal's own classification request. The post is taken
 * out, checked to be in Signal's normalised form, and the whole request is rebuilt from Signal's own prompt code and
 * compared. Anything else is rejected, so a leaked token cannot turn the user's CLI login into a general-purpose proxy.
 */
import { buildMessages } from '../src/classifier/prompt';
import { isPostInput, prepareInput } from '../src/shared/post';
import type { PostInput } from '../src/shared/types';

export type RequestCheck = { ok: true; post: PostInput } | { ok: false; reason: string };

const NOT_SIGNAL = 'Not a Signal classification request.';
const POST_FIELDS = new Set(['text', 'quoted', 'linkTitle', 'linkDescription']);

// The fixed frame around the post JSON, derived from Signal's own prompt code (never copied here).
const PROBE = '\u0000probe\u0000';
const FRAME = buildMessages({ text: PROBE })[1]!.content;
const [PREFIX, SUFFIX] = FRAME.split(JSON.stringify({ text: PROBE })) as [string, string];

export function checkSignalRequest(body: unknown, servedModel: string): RequestCheck {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: NOT_SIGNAL };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages)) return { ok: false, reason: NOT_SIGNAL };
  if (b.model !== servedModel) return { ok: false, reason: `This bridge serves ${servedModel}; set Model to that.` };

  const user = b.messages[1] as { content?: unknown } | undefined;
  if (b.messages.length !== 2 || !user || typeof user.content !== 'string') return { ok: false, reason: NOT_SIGNAL };
  const content = user.content;
  if (!content.startsWith(PREFIX) || !content.endsWith(SUFFIX) || content.length < PREFIX.length + SUFFIX.length) {
    return { ok: false, reason: NOT_SIGNAL };
  }
  let post: unknown;
  try {
    post = JSON.parse(content.slice(PREFIX.length, content.length - SUFFIX.length));
  } catch {
    return { ok: false, reason: NOT_SIGNAL };
  }
  if (!isPostInput(post) || Object.keys(post).some((k) => !POST_FIELDS.has(k))) return { ok: false, reason: NOT_SIGNAL };
  // Signal sends posts already normalised and cut to its limits; anything else did not come from Signal.
  const normal = prepareInput(post);
  if (JSON.stringify(normal) !== JSON.stringify(post)) return { ok: false, reason: NOT_SIGNAL };
  // Rebuild the whole conversation and compare it exactly: roles, system prompt, frame, and no extra fields.
  if (JSON.stringify(b.messages) !== JSON.stringify(buildMessages(normal))) return { ok: false, reason: NOT_SIGNAL };
  return { ok: true, post: normal };
}
