import { beforeEach, describe, expect, it } from 'vitest';
import { isFeedRoute, linkedinAdapter } from '../src/adapter/linkedin';
import { classicPost, feed, linkExtra, promotedExtra, repostExtra, sduiPost } from './fixtures/feed';

const mount = (html: string) => {
  document.body.innerHTML = html;
  return linkedinAdapter.findPosts(document);
};

describe('linkedin adapter', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('finds classic posts and ignores comments inside them', () => {
    const posts = mount(feed(classicPost('1', 'First post about database indexes and why they matter.'), classicPost('2', 'Second post about shipping a migration safely.')));
    expect(posts).toHaveLength(2);
    const ex = linkedinAdapter.extract(posts[0]!)!;
    expect(ex.id).toBe('urn:li:activity:1');
    expect(ex.input.text).toBe('First post about database indexes and why they matter.');
    expect(ex.input.text).not.toContain('reply');
  });

  it('finds SDUI posts, excluding the comment list items nested inside', () => {
    const posts = mount(feed(sduiPost('k1', 'An SDUI post body that is long enough to count.')));
    expect(posts).toHaveLength(1);
    const ex = linkedinAdapter.extract(posts[0]!)!;
    expect(ex.input.text).toBe('An SDUI post body that is long enough to count.');
    expect(ex.input.text).not.toContain('Comment text');
  });

  it('strips the "…more" control and keeps line breaks', () => {
    const posts = mount(feed(sduiPost('k', 'Line one of the post body<br>Line two of the post body')));
    expect(linkedinAdapter.extract(posts[0]!)!.input.text).toBe('Line one of the post body\nLine two of the post body');
  });

  it('captures reshared text separately from the sharer commentary', () => {
    const posts = mount(feed(classicPost('3', 'My commentary on this reshared item, which adds a point.', repostExtra)));
    const { input } = linkedinAdapter.extract(posts[0]!)!;
    expect(input.text).toContain('My commentary');
    expect(input.quoted).toContain('original post being reshared');
  });

  it('captures link preview title and description', () => {
    const posts = mount(feed(classicPost('4', 'Reading this today, a worthwhile argument about databases.', linkExtra)));
    const { input } = linkedinAdapter.extract(posts[0]!)!;
    expect(input.linkTitle).toBe('Why Postgres is enough');
    expect(input.linkDescription).toBe('A long read');
  });

  it('skips promoted posts and posts with too little text', () => {
    const posts = mount(feed(classicPost('5', 'A sponsored post with a perfectly long body of text.', promotedExtra), classicPost('6', 'Congrats!')));
    expect(posts.map((p) => linkedinAdapter.extract(p))).toEqual([null, null]);
  });

  it('does not treat non-post list items (no text body) as posts', () => {
    expect(mount(`<div role="list"><div role="listitem"><a href="/in/x/">Suggested person</a></div></div>`)).toHaveLength(0);
  });

  it('never mutates the DOM it reads', () => {
    const html = feed(classicPost('7', 'Post body long enough to be extracted properly.'));
    const posts = mount(html);
    const before = document.body.innerHTML;
    linkedinAdapter.extract(posts[0]!);
    expect(document.body.innerHTML).toBe(before);
  });

  it('only runs on the main feed route', () => {
    expect(isFeedRoute({ pathname: '/feed/' })).toBe(true);
    expect(isFeedRoute({ pathname: '/feed' })).toBe(true);
    expect(isFeedRoute({ pathname: '/in/someone/' })).toBe(false);
    expect(isFeedRoute({ pathname: '/messaging/' })).toBe(false);
  });
});

describe('isPostTextChange: which page changes can mean a post\'s text grew (X1/X2)', () => {
  /** The MutationRecords a change produces, as the controller's observer would see them. */
  const recordsOf = (mutate: () => void): MutationRecord[] => {
    const mo = new MutationObserver(() => {});
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    mutate();
    const records = mo.takeRecords();
    mo.disconnect();
    return records;
  };
  const anyText = (mutate: () => void) => recordsOf(mutate).some((r) => linkedinAdapter.isPostTextChange(r));
  const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;

  beforeEach(() => {
    document.body.innerHTML = feed(
      classicPost('1', 'A classic post body that is long enough to count.', repostExtra + linkExtra),
      sduiPost('k', 'An SDUI post body that is long enough to count.'),
    );
  });

  it('classic post text: re-rendered, edited in place, or appended', () => {
    expect(anyText(() => ($('[data-urn] .feed-shared-update-v2__description span').textContent = 'A longer classic post body, now with the rest of the text.'))).toBe(true);
    expect(anyText(() => (($('[data-urn] .feed-shared-update-v2__description span').firstChild as Text).data += ' more'))).toBe(true);
    expect(anyText(() => $('[data-urn] .feed-shared-update-v2__description span').append(' and more'))).toBe(true);
  });

  it('reshared text and link previews count', () => {
    expect(anyText(() => $('.update-components-mini-update-v2 .update-components-text').append(' The rest of the original.'))).toBe(true);
    expect(anyText(() => $('.update-components-article__description').append(' (continued)'))).toBe(true);
  });

  it('SDUI post text counts; SDUI comment text does not', () => {
    expect(anyText(() => $('[componentkey="k"] > p[data-testid="expandable-text-box"]').append(' More SDUI text.'))).toBe(true);
    expect(anyText(() => $('[componentkey="k"] [role="list"] p[data-testid="expandable-text-box"]').append(' A longer comment.'))).toBe(false);
  });

  it('timestamps, reactions and classic comments do not count', () => {
    expect(anyText(() => (($('.update-components-actor__sub-description span').firstChild as Text).data = '3h'))).toBe(false);
    expect(anyText(() => $('[data-urn]').insertAdjacentHTML('beforeend', '<span class="social-counts">42 reactions</span>'))).toBe(false);
    expect(anyText(() => $('.comments-comments-list').insertAdjacentHTML('beforeend', '<article class="comments-comment-item"><div class="update-components-text">A new comment that is long enough.</div></article>'))).toBe(false);
    expect(anyText(() => ($('.comments-comment-item .update-components-text').textContent = 'An edited comment, now longer than before.'))).toBe(false);
  });

  it('LinkedIn replacing the whole text container counts (the change targets the post, not a text area)', () => {
    const post = $('[data-urn]');
    const fresh = document.createElement('div');
    fresh.className = 'feed-shared-update-v2__description';
    fresh.innerHTML = '<div class="update-components-text"><span dir="ltr">A classic post body that is long enough to count, and the rest.</span></div>';
    expect(anyText(() => post.replaceChild(fresh, $('[data-urn] .feed-shared-update-v2__description')))).toBe(true);
  });
});
