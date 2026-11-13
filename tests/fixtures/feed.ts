/** Hand-written approximations of LinkedIn markup, NOT captured from a live session. Update when real DOM is captured. */

export const classicPost = (urn: string, text: string, extra = '') => `
<div class="feed-shared-update-v2" data-urn="urn:li:activity:${urn}" role="article">
  <div class="update-components-actor"><a href="/in/someone/">Someone</a>
    <span class="update-components-actor__sub-description"><span>2h</span></span></div>
  <div class="feed-shared-update-v2__description"><div class="update-components-text"><span dir="ltr">${text}</span>
    <button class="feed-shared-inline-show-more-text__see-more-less-toggle">…more</button></div></div>
  ${extra}
  <div class="comments-comments-list"><article class="comments-comment-item"><div class="update-components-text">A reply that must never be classified as the post</div></article></div>
</div>`;

export const sduiPost = (key: string, text: string, extra = '') => `
<div role="listitem" componentkey="${key}">
  <a href="/in/someone/">Someone</a>
  <p data-testid="expandable-text-box">${text}<button>…more</button></p>
  ${extra}
  <button aria-label="React Like"></button><button aria-label="Comment"></button>
  <div role="list"><div role="listitem"><p data-testid="expandable-text-box">Comment text should be ignored entirely here.</p></div></div>
</div>`;

export const repostExtra = `<div class="update-components-mini-update-v2"><div class="update-components-text">The original post being reshared says something quite different.</div></div>`;
export const linkExtra = `<a class="update-components-article__meta-link"><span class="update-components-article__title">Why Postgres is enough</span><span class="update-components-article__description">A long read</span></a>`;
export const promotedExtra = `<span class="update-components-actor__sub-description"><span>Promoted</span></span>`;

export const feed = (...posts: string[]) => `<main><div role="list">${posts.join('\n')}</div></main>`;
