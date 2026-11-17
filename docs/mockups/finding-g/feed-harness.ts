// Finding G contrast check: the real Presenter, all 8 bar states (bundled by contrast-check.py; not part of the extension).
import { Presenter, type View } from '../../../src/content/presenter';
const p = new Presenter(document, { isTrusted: () => true });
const noop = { show() {}, hide() {}, keep() {}, lowQuality() {}, undo() {}, judgeSeparately() {} };
const R = 'Engagement bait: asks readers to repost and follow, with a generic announcement.';
const rep = (judging = false, similarity = 0.92) => ({ repeat: { similarity, judging } });
const states: [string, Partial<View>][] = [
  ['1 Active · copied collapse', { outcome: 'collapse', review: false, reason: R, ...rep() }],
  ['2 Active · after Show post', { outcome: 'collapse', review: false, revealed: true, reason: R, ...rep() }],
  ['3 Active · Judging…', { outcome: 'collapse', review: false, reason: R, ...rep(true) }],
  ['4 Active · own verdict after Judge separately', { outcome: 'collapse', review: false, reason: 'Generic announcement with engagement bait ("Agree? Repost").' }],
  ['5 Review · copied would collapse', { outcome: 'collapse', review: true, confidence: 0.93, reason: R, ...rep() }],
  ['6 Review · copied keep (quiet)', { outcome: 'keep', review: true, confidence: 0.9, reason: 'Shares concrete hiring lessons', ...rep(false, 0.88) }],
  ['7 Active · expanded to read', { outcome: 'collapse', review: false, revealed: true, visibleBecause: 'expanded', reason: R, ...rep() }],
  ['8 Marked post', { outcome: 'collapse', source: 'user', review: false, reason: 'You marked this low quality.', ...rep() }],
];
const page = document.getElementById('page')!;
for (const [title, v] of states) {
  const f = document.createElement('div'); f.className = 'frame';
  const h = document.createElement('h3'); h.textContent = title; f.append(h);
  const post = document.createElement('div'); post.className = 'post';
  post.textContent = "🎉 I'm thrilled to announce that I've joined Northwind as Head of Growth! After 6 amazing years… Agree? ♻️ Repost if this inspires you 🚀";
  f.append(post); page.append(f);
  p.apply(post, { outcome: 'keep', source: 'model', reason: '', review: false, revealed: false, ...v } as View, noop);
}
