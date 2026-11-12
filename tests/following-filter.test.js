import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Local addition: /<handle>/following "只看没回关" toggle.
const source = readFileSync(resolve(process.cwd(), 'src/following-filter.js'), 'utf8');

function load() {
  const subs = [];
  const win = {
    addEventListener() {},
    __xvmNet: { onResponse: (re, fn) => subs.push({ re, fn }) },
    dispatchEvent() {},
  };
  const html = { attrs: new Map(), hasAttribute(k) { return this.attrs.has(k); }, setAttribute(k, v) { this.attrs.set(k, v); }, removeAttribute(k) { this.attrs.delete(k); } };
  const doc = { documentElement: html, body: null, querySelector: () => null, getElementById: () => null };
  class MO { observe() {} }
  Function('window', 'document', 'location', 'localStorage', 'MutationObserver', 'requestAnimationFrame', 'Event', 'setTimeout', source)(
    win, doc, { pathname: '/yzh_im/following' }, { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }, MO, (fn) => fn(), class {}, () => 0,
  );
  return { api: win.__xvmFollowingFilter._debug, subs };
}

const fakeCell = ({ badge = false, label = '', href = '/someone' } = {}) => ({
  querySelector: (sel) => (badge && sel === '[data-testid="userFollowIndicator"]' ? {} : null),
  querySelectorAll: (sel) => {
    if (sel === 'span') return label ? [{ textContent: ` ${label} ` }] : [{ textContent: 'Some bio text' }];
    if (sel === 'a[href^="/"]') return [{ getAttribute: () => '/someone/photo' }, { getAttribute: () => href }];
    return [];
  },
});

it('only runs on a /<handle>/following page', () => {
  const { api } = load();
  expect(api.isFollowingPage('/yzh_im/following')).toBe(true);
  expect(api.isFollowingPage('/yzh_im/following/')).toBe(true);
  expect(api.isFollowingPage('/yzh_im/followers')).toBe(false);
  expect(api.isFollowingPage('/yzh_im/status/1')).toBe(false);
  expect(api.isFollowingPage('/home')).toBe(false);
});

it('reads followed_by from the Following GraphQL response', async () => {
  const { api, subs } = load();
  expect(subs[0].re.test('https://x.com/i/api/graphql/abc/Following?variables=1')).toBe(true);
  expect(subs[0].re.test('https://x.com/i/api/graphql/abc/Followers?variables=1')).toBe(false);
  const json = { data: { user: { result: { timeline: { instructions: [{ entries: [
    { content: { itemContent: { user_results: { result: { __typename: 'User', core: { screen_name: 'Back' }, relationship_perspectives: { followed_by: true } } } } } },
    { content: { itemContent: { user_results: { result: { __typename: 'User', legacy: { screen_name: 'NoBack', followed_by: false } } } } } },
  ] }] } } } } };
  subs[0].fn({ source: 'xhr', response: { json: () => json } });
  expect(api.followedBy.get('back')).toBe(true);
  expect(api.followedBy.get('noback')).toBe(false);
});

it('treats the badge, the label text or followed_by as following back', () => {
  const { api } = load();
  expect(api.followsBack(fakeCell({ badge: true }), 'a')).toBe(true);
  expect(api.followsBack(fakeCell({ label: 'Follows you' }), 'a')).toBe(true);
  expect(api.followsBack(fakeCell({ label: '关注了你' }), 'a')).toBe(true);
  expect(api.followsBack(fakeCell(), 'a')).toBe(false);
  api.followedBy.set('a', true);
  expect(api.followsBack(fakeCell(), 'a')).toBe(true);
  expect(api.cellHandle(fakeCell({ href: '/Someone_1' }))).toBe('someone_1');
});
