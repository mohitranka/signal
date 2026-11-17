/**
 * Template posts for the repeated-template feature (docs/design-repeats.md). Hand-written, synthetic.
 *
 * Variants of one template differ by ONE single-word name, plus numbers and emoji (which the signature's cleanup
 * erases). At ~90 words a one-word swap changes 3 of ~88 three-word shingles, so true Jaccard ≈ 0.93, well above
 * the 0.85 threshold even allowing for MinHash estimation error (σ ≈ 0.02 with 128 hashes).
 */

/** "Thrilled to announce" + engagement bait. The fake model collapses anything containing "thrilled to announce". */
export const announce = (company = 'Northwind', years = 6, emoji = '🚀') =>
  `🎉 I'm thrilled to announce that I've joined ${company} as Head of Growth! After ${years} amazing years at my previous ` +
  `company, it was time for a new chapter in my career. I'm so grateful to everyone who supported me along the way, ` +
  `especially my mentors, my former team and my family, who believed in me when I doubted myself. I can't wait to ` +
  `learn, grow and build something meaningful with this incredible team. The best is yet to come and I am ready for ` +
  `it. Agree? ♻️ Repost if this inspires you and follow me for more lessons on growth, leadership and hustle ${emoji}`;

/** "N lessons" listicle. Only numbers and emoji vary, so variants are identical after cleanup. Fake model: keep. */
export const lessons = (hired = 12, count = 7, emoji = '👇') =>
  `I hired ${hired} people last year. Here are ${count} lessons nobody tells you about hiring ${emoji} ` +
  `First, attitude beats skills almost every single time, because skills can be taught but attitude rarely can. ` +
  `Second, hire slowly and let go quickly when something is clearly not working for either side. Third, culture is ` +
  `not the ping pong table, it is what you tolerate on a bad day. Fourth, trust your gut but verify with references. ` +
  `Fifth, pay properly for talent. Sixth, never stop learning from the people you hire. Which one resonates most ` +
  `with you? Comment below and repost to help your network ♻️`;

/** An evidence post: its substance is in the numbers, which the cleanup erases. Fake model: highlight. */
export const evidence = (before = 180, after = 95, rows = 1.2) =>
  `We migrated our billing database to a new cluster last quarter and I want to share what we measured. p99 latency ` +
  `went from ${before}ms to ${after}ms, mostly by removing an N+1 query in the invoice renderer and adding one ` +
  `composite index. The table holds ${rows} billion rows, so we backfilled in batches of ${after} thousand with a ` +
  `throttle tied to replica lag. Two things surprised us: vacuum was the real bottleneck, not the copy itself, and ` +
  `our connection pool was sized for the old cluster. The runbook and the dashboards are linked in the comments below.`;

/** Under 40 words: only exact matches may ever count. */
export const short = (name = 'Priya') => `Congrats to ${name} on the new role! So proud of this team. Agree? Repost if you agree and follow for more.`;

/** Shares its first 20 words with announce(), then says something entirely different. */
export const announceOpenerOnly = () =>
  `🎉 I'm thrilled to announce that I've joined Northwind as Head of Growth! After 6 amazing years at my previous ` +
  `company, I want to write down what actually went wrong in my last role, because nobody posts about that part. ` +
  `We missed our pipeline target three quarters in a row, and the cause was not effort. Our attribution model ` +
  `double counted webinar leads, so we kept funding the channel that looked best on paper. Fixing the model cut ` +
  `reported pipeline by a third overnight, and it was the most useful week of the year.`;

/** Generic commentary, long enough to be signed, to be combined with different quoted posts. */
export const commentary = () =>
  `This is exactly what I have been saying for years and I am glad someone finally wrote it down so clearly. ` +
  `Every leader in our industry should read this twice, share it with their team, and then actually act on it ` +
  `instead of just nodding along in meetings. Bookmark it now and thank me later.`;

export const quotedA = () =>
  `Our postmortem culture changed when we stopped asking who made the mistake and started asking which alarm ` +
  `should have fired. In two years our mean time to detect dropped from hours to minutes, mostly from three ` +
  `alerts we had been too proud to add because they felt obvious to the senior engineers on the team.`;

export const quotedB = () =>
  `Remote hiring works if you write everything down. We replaced our onboarding calls with a written guide, a ` +
  `recorded architecture tour and a buddy rotation, and new engineers now ship their first change in their ` +
  `second week instead of their second month, according to the numbers we track for every cohort.`;

/** Unrelated long posts. */
export const unrelated = [
  `Spent the weekend repairing an old mechanical watch with my daughter. Nothing about work here. We cleaned the ` +
    `movement, replaced a mainspring that had lost its strength, and learned that patience matters more than tools. ` +
    `She now wants to take apart the kitchen clock, which I consider a success and my partner considers a threat. ` +
    `If anyone knows a good beginner book on horology for a curious ten year old, I would love a recommendation.`,
  `A short thread on reading interest rate decisions. The statement matters less than the changes to it, so diff ` +
    `it against the previous one line by line. Watch the dissent count and the dot plot median separately, because ` +
    `they often move in different directions. Finally, the press conference answers about services inflation told ` +
    `us more this year than any single data release, especially the remarks about shelter costs and wage growth.`,
];

/** Number of words after the signature's cleanup would count them (rough: letters/digits runs, emoji excluded). */
export const roughWordCount = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
