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
