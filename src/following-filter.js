// Local addition for /<handle>/following: a "只看没回关" toggle that hides
// people who already follow you back, so only the accounts you may want to
// unfollow stay in the list. The list is newest first, so the oldest follows
// are at the bottom.
//
// "Follows you" comes from two places, either is enough:
//   - the badge X draws in each UserCell ([data-testid=userFollowIndicator]
//     or the plain "Follows you" / 关注了你 label), and
//   - relationship_perspectives.followed_by (or legacy.followed_by) on the
//     User objects in the Following GraphQL response.
// Hidden cells use the same root-attribute + per-cell marker pattern as the
// rate filter, so turning the toggle off is one attribute flip.
(() => {
  if (window.__xvmFollowingFilter) return;

  const STORE_KEY = 'xvmFollowingOnlyNonMutualV1';
  const ROOT_ATTR = 'data-xvm-nonmutual-on';
  const MUTUAL_ATTR = 'data-xvm-mutual';
  const BAR_ID = 'xvm-following-bar';
  const PATH_RE = /^\/([A-Za-z0-9_]{1,15})\/following\/?$/;
  const FOLLOWING_GQL_RE = /\/(?:i\/api\/)?graphql\/[^/]+\/Following(?:\?|$)/;
  const FOLLOWS_YOU_TEXT = new Set(['Follows you', '关注了你', '關注了你', '跟隨你']);

  const followedBy = new Map(); // lowercased handle -> boolean (GraphQL)
  const seen = new Map(); // lowercased handle -> follows back, for this page's counts
  let lastPath = '';
  let enabled = false;
  try { enabled = localStorage.getItem(STORE_KEY) === '1'; } catch (_) {}

  // A short-lived follow-age feature kept its stamps under this prefix; drop them.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('xvmFollowAgeV1:')) localStorage.removeItem(key);
    }
  } catch (_) {}

  function isFollowingPage(path) {
    return PATH_RE.test(path == null ? location.pathname : path);
  }

  function rememberUsers(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 60) return;
    if (Array.isArray(obj)) {
      for (const v of obj) rememberUsers(v, depth + 1);
      return;
    }
    if (obj.__typename === 'User') {
      const handle = obj.core?.screen_name || obj.legacy?.screen_name || '';
      const fb = obj.relationship_perspectives?.followed_by ?? obj.legacy?.followed_by;
      if (handle && typeof fb === 'boolean') followedBy.set(handle.toLowerCase(), fb);
    }
    for (const key in obj) {
      const v = obj[key];
      if (v && typeof v === 'object') rememberUsers(v, depth + 1);
    }
  }

  window.__xvmNet?.onResponse(FOLLOWING_GQL_RE, ({ response, source }) => {
    const done = (json) => { rememberUsers(json); scheduleApply(); };
    if (source === 'fetch') {
      response.clone().json().then(done).catch(() => {});
    } else {
      try { done(response.json()); } catch (_) {}
    }
  });

  function cellHandle(cell) {
    let fallback = '';
    for (const a of cell.querySelectorAll('a[href^="/"]')) {
      const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (!m) continue;
      if ((a.textContent || '').trim().startsWith('@')) return m[1].toLowerCase();
      if (!fallback) fallback = m[1].toLowerCase();
    }
    return fallback;
  }

  function hasFollowsYouBadge(cell) {
    if (cell.querySelector('[data-testid="userFollowIndicator"]')) return true;
    for (const el of cell.querySelectorAll('span')) {
      if (FOLLOWS_YOU_TEXT.has((el.textContent || '').trim())) return true;
    }
    return false;
  }

  function followsBack(cell, handle) {
    if (hasFollowsYouBadge(cell)) return true;
    return followedBy.get(handle) === true;
  }

  function userCells() {
    const col = document.querySelector('[data-testid="primaryColumn"]');
    if (!col) return [];
    return Array.from(col.querySelectorAll('[data-testid="cellInnerDiv"]'))
      .filter((cell) => cell.querySelector('[data-testid="UserCell"]'));
  }

  // Same trick as the rate filter: make X's virtual list re-measure right away
  // so the remaining cells don't sit on top of each other for a frame.
  function nudgeXVirtualizer() {
    try {
      const scroller = document.scrollingElement || document.documentElement;
      const y = scroller.scrollTop;
      scroller.scrollTop = y + 1;
      scroller.scrollTop = y;
      window.dispatchEvent(new Event('scroll'));
    } catch (_) {}
  }

  function setRoot(active) {
    const html = document.documentElement;
    const prev = html.hasAttribute(ROOT_ATTR);
    if (active && !prev) html.setAttribute(ROOT_ATTR, '1');
    else if (!active && prev) html.removeAttribute(ROOT_ATTR);
    if (prev !== active) nudgeXVirtualizer();
  }

  function createBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'xvm-following-bar';
    bar.innerHTML = '<button type="button" class="xvm-following-toggle"></button><span class="xvm-following-count"></span>';
    bar.querySelector('button').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      enabled = !enabled;
      try { localStorage.setItem(STORE_KEY, enabled ? '1' : '0'); } catch (_) {}
      apply();
    });
    return bar;
  }

  let headerCache = null;
  // Put the bar in the sticky profile header, centred above the 关注者 tab.
  // Falls back to a floating bar at the bottom when the header isn't found.
  function placeBar(bar) {
    const col = document.querySelector('[data-testid="primaryColumn"]');
    const tablist = col?.querySelector('[role="tablist"]');
    const tab = tablist?.querySelector('a[role="tab"][href$="/followers"]')
      || tablist?.querySelectorAll('[role="tab"]')[1];
    let header = headerCache && headerCache.isConnected && tablist && headerCache.contains(tablist) ? headerCache : null;
    for (let el = tablist?.parentElement, i = 0; !header && el && el !== col && i < 12; el = el.parentElement, i++) {
      const pos = getComputedStyle(el).position;
      if (pos === 'sticky' || pos === 'fixed') header = el;
    }
    headerCache = header;
    if (!header || !tab) {
      if (bar.parentElement !== document.body) document.body.appendChild(bar);
      bar.classList.remove('xvm-following-bar--header');
      bar.style.left = '';
      bar.style.top = '';
      return;
    }
    if (bar.parentElement !== header) header.appendChild(bar);
    bar.classList.add('xvm-following-bar--header');
    const h = header.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    const tl = tablist.getBoundingClientRect();
    const gap = tl.top - h.top;
    const barH = bar.offsetHeight || 28;
    bar.style.left = `${Math.round(t.left + t.width / 2 - h.left)}px`;
    bar.style.top = `${Math.max(2, Math.round((gap - barH) / 2))}px`;
  }

  function updateBar(bar) {
    let notBack = 0;
    for (const back of seen.values()) if (!back) notBack++;
    const btn = bar.querySelector('button');
    const label = enabled ? '只看没回关 ✓' : '只看没回关';
    if (btn.textContent !== label) btn.textContent = label;
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    const count = `没回关 ${notBack} · 共 ${seen.size}`;
    const countEl = bar.querySelector('.xvm-following-count');
    if (countEl.textContent !== count) countEl.textContent = count;
    bar.dataset.on = enabled ? '1' : '0';
  }

  function teardown() {
    document.getElementById(BAR_ID)?.remove();
    if (document.documentElement.hasAttribute(ROOT_ATTR)) setRoot(false);
  }

  function apply() {
    const path = location.pathname;
    if (path !== lastPath) {
      lastPath = path;
      seen.clear();
    }
    if (!isFollowingPage(path)) {
      teardown();
      return;
    }
    if (!document.body) return;
    const bar = document.getElementById(BAR_ID) || createBar();
    for (const cell of userCells()) {
      const handle = cellHandle(cell);
      const back = followsBack(cell, handle);
      if (handle) seen.set(handle, back);
      if (back) {
        if (!cell.hasAttribute(MUTUAL_ATTR)) cell.setAttribute(MUTUAL_ATTR, '1');
      } else if (cell.hasAttribute(MUTUAL_ATTR)) {
        cell.removeAttribute(MUTUAL_ATTR);
      }
    }
    setRoot(enabled);
    updateBar(bar);
    placeBar(bar);
  }

  let scheduled = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    const run = () => { scheduled = false; apply(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  // X is a single-page app: navigation and virtual scroll both show up as
  // DOM mutations, so one observer covers entering, scrolling and leaving.
  const mo = new MutationObserver((mutations) => {
    if (!(isFollowingPage() || location.pathname !== lastPath || document.getElementById(BAR_ID))) return;
    // Ignore mutations inside our own bar (its text updates).
    const ours = mutations.every((m) => {
      const t = m.target;
      return t && t.nodeType === 1 && (t.id === BAR_ID || t.closest?.(`#${BAR_ID}`));
    });
    if (!ours) scheduleApply();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('resize', () => { if (isFollowingPage()) scheduleApply(); });

  window.__xvmFollowingFilter = {
    apply,
    isEnabled: () => enabled,
    _debug: { isFollowingPage, rememberUsers, followedBy, seen, hasFollowsYouBadge, cellHandle, followsBack },
  };
})();
