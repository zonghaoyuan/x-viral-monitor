// === Tweet Data Store ===
const tweetDataStore = new Map();
const DEFAULT_THRESHOLDS = {
  trending: 1000,
  viral: 10000,
};
let velocityThresholds = { ...DEFAULT_THRESHOLDS };

// === i18n ===
let localizedStrings = {};
function i18n(key) { return localizedStrings[key] || key; }
function i18nOr(key, fallback) { return localizedStrings[key] || fallback; }
const PRODUCT_SITE_PRO_URL = 'https://xvm.icy-cat.com/#pro';

function applyLocalizedUi() {
  if (!leaderboardEl) return;
  const head = leaderboardEl.querySelector('.xvm-lb-head');
  const title = leaderboardEl.querySelector('.xvm-lb-title');
  const back = leaderboardEl.querySelector('.xvm-lb-back');
  const settings = leaderboardEl.querySelector('.xvm-lb-settings');
  const close = leaderboardEl.querySelector('.xvm-lb-close');
  if (head) head.title = i18n('contentLeaderboardDragToMove');
  if (title) title.textContent = `🔥 ${i18n('contentLeaderboardTitle')}`;
  if (back) {
    back.title = i18n('contentLeaderboardBackToPrevious');
    back.setAttribute('aria-label', i18n('contentLeaderboardBackToPrevious'));
  }
  if (settings) {
    settings.title = i18n('contentLeaderboardSettings');
    settings.setAttribute('aria-label', i18n('contentLeaderboardSettings'));
  }
  if (close) {
    close.title = i18n('contentLeaderboardClose');
    close.setAttribute('aria-label', i18n('contentLeaderboardClose'));
  }
  setLeaderboardEdgeToggleState();
  updateLeaderboardSettingsPanel();
}

function normalizeThresholds(raw) {
  const trending = Number.parseInt(raw?.trending, 10);
  const viral = Number.parseInt(raw?.viral, 10);
  const next = {
    trending: Number.isFinite(trending) && trending > 0 ? trending : DEFAULT_THRESHOLDS.trending,
    viral: Number.isFinite(viral) && viral > 0 ? viral : DEFAULT_THRESHOLDS.viral,
  };
  if (next.viral <= next.trending) {
    next.viral = Math.max(next.trending + 1, DEFAULT_THRESHOLDS.viral);
  }
  return next;
}

let leaderboardEnabled = false;
let leaderboardCount = 10;
const DEFAULT_LB_COLUMNS = [
  { id: 'rank',     visible: true  },
  { id: 'icon',     visible: true  },
  { id: 'handle',   visible: false },
  { id: 'preview',  visible: true  },
  { id: 'views',    visible: true  },
  { id: 'velocity', visible: true  },
];
const LB_COLUMN_LABEL_KEYS = {
  rank: 'popupColRank',
  icon: 'popupColIcon',
  handle: 'popupColHandle',
  preview: 'popupColPreview',
  views: 'popupColViews',
  velocity: 'popupColVelocity',
};
let leaderboardColumns = DEFAULT_LB_COLUMNS.map((c) => ({ ...c }));
let badgeStyle = 'pill-solid';
let copyAsMarkdownEnabled = true;
let showBookmarkCount = true;
let leaderboardEdgeHideEnabled = true;
let bookmarkTimelineInjectEnabled = false;
let bookmarkTimelineInjectFolderIds = [];
let bookmarkTimelineInjectEvery = 20;
const bookmarkTimelineEntryCache = new Map();
// folderId -> 'loading' | 'error' (absent = idle). Drives the per-folder status
// badge in the settings dialog.
const bookmarkTimelineFolderStatus = new Map();
// folderId -> last successful refresh timestamp (ms), for the "updated N ago" hint.
const bookmarkTimelineFolderRefreshedAt = new Map();
// Max entries bridge.js paginates/persists per folder. Reaching it means the
// folder likely holds more than we fetched, so the badge shows "N+".
const BOOKMARK_TIMELINE_FETCH_CAP = 120;
const bookmarkTimelineInsertedTweetIds = new Set();
const bookmarkTimelineSeenTweetIds = new Set();
let bookmarkTimelineFolders = [];
let bookmarkTimelineDialog = null;
let pendingReleaseNotesVersion = '';

function bookmarkTimelineDebugEnabled() {
  try { return localStorage.getItem('xvmBtiDebug') === '1'; } catch (_) { return false; }
}

function debugBookmarkTimeline(...args) {
  if (!bookmarkTimelineDebugEnabled()) return;
  console.debug('[XVM-BTI]', ...args);
}

window.__xvmBtiState = () => {
  const cog = document.querySelector('.xvm-bti-cog');
  return {
    enabled: bookmarkTimelineInjectEnabled,
    folderIds: [...bookmarkTimelineInjectFolderIds],
    every: bookmarkTimelineInjectEvery,
    folders: bookmarkTimelineFolders.map((f) => ({ id: String(f.id || ''), name: String(f.name || '') })),
    cache: Array.from(bookmarkTimelineEntryCache.entries()).map(([folderId, entries]) => ({ folderId, count: entries.length })),
    cog: cog ? {
      parentRole: cog.parentElement?.getAttribute?.('role') || '',
      previousText: (cog.previousElementSibling?.textContent || '').trim().slice(0, 80),
      nextText: (cog.nextElementSibling?.textContent || '').trim().slice(0, 80),
    } : null,
  };
};

const RELEASE_NOTE_ITEMS = [
  ['contentUpdateItemReplyToolsTitle', 'contentUpdateItemReplyToolsBody', 'Enter 直接回复', '新增评论时按 Enter 直接发送评论的功能。在设置 → 其他功能 → 按 Enter 直接回复开启后，回复框里不用再按 Command + Enter。'],
  ['contentUpdateItemHotOnlyTitle', 'contentUpdateItemHotOnlyBody', '仅看热帖状态更清楚', '开启仅看热帖后，低于热帖标准的帖子会直接从页面移除；生效范围可以在 Popup 或悬浮面板设置里勾选。'],
  ['contentUpdateItemBookmarkToolsTitle', 'contentUpdateItemBookmarkToolsBody', '书签功能别错过', '在设置 → 其他功能里可以开启书签文件夹菜单和显示书签数。开启后可选择保存文件夹、查看保存位置，并在时间线直接看到书签数量。'],
  ['contentUpdateItemFilterRulesTitle', 'contentUpdateItemFilterRulesBody', '内容屏蔽更稳', '内容屏蔽减少了普通 Telegram 讨论的误判，同时补充更多微信 / Telegram 引流广告特征，减少漏掉的广告回复和个人简介引流。'],
];

function applyBadgeStyle() {
  document.documentElement.dataset.xvmBadgeStyle = badgeStyle;
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === 'XVM_BOOKMARK_TIMELINE_TXID_REQUEST') {
    const requestId = String(event.data.requestId || '');
    const method = String(event.data.method || 'GET');
    const path = String(event.data.path || '');
    Promise.resolve(window.__xvmXct?.generateTxId?.(method, path))
      .then((txId) => {
        window.postMessage({
          type: 'XVM_BOOKMARK_TIMELINE_TXID_RESPONSE',
          requestId,
          ok: !!txId,
          txId: txId || '',
        }, '*');
      })
      .catch((err) => {
        window.postMessage({
          type: 'XVM_BOOKMARK_TIMELINE_TXID_RESPONSE',
          requestId,
          ok: false,
          txId: '',
          error: err?.message || String(err),
        }, '*');
      });
    return;
  }
  if (event.data?.type === 'XVM_RELEASE_NOTES_SHOW' && typeof event.data.version === 'string') {
    pendingReleaseNotesVersion = event.data.version;
    scheduleReleaseNotesModal();
    return;
  }
  if (event.data?.type === 'XVM_FOLDERS_UPDATE') {
    bookmarkTimelineFolders = Array.isArray(event.data.folders) ? event.data.folders : [];
    renderBookmarkTimelineSettings();
    return;
  }
  if (event.data?.type === 'XVM_BOOKMARK_TIMELINE_CACHE_START') {
    const folderId = String(event.data.folderId || '');
    if (folderId) {
      bookmarkTimelineFolderStatus.set(folderId, 'loading');
      renderBookmarkTimelineSettings();
    }
    return;
  }
  if (event.data?.type === 'XVM_BOOKMARK_TIMELINE_CACHE_UPDATE') {
    const folderId = String(event.data.folderId || '');
    if (!bookmarkTimelineInjectEnabled || !bookmarkTimelineInjectFolderIds.includes(folderId)) return;
    bookmarkTimelineEntryCache.delete(folderId);
    const count = window.__xvmBookmarkTimelineInject?.cacheBookmarkTimelineEntries(bookmarkTimelineEntryCache, folderId, event.data.json) || 0;
    // Keep the last page's overflow from inflating the count past the cap.
    const capped = bookmarkTimelineEntryCache.get(folderId);
    if (capped && capped.length > BOOKMARK_TIMELINE_FETCH_CAP) {
      bookmarkTimelineEntryCache.set(folderId, capped.slice(0, BOOKMARK_TIMELINE_FETCH_CAP));
    }
    const fresh = bookmarkTimelineEntryCache.get(folderId);
    if (fresh) bookmarkTimelineEntryCache.set(folderId, filterSeenBookmarkTimelineEntries(fresh));
    const refreshedAt = Number(event.data.refreshedAt) || Date.now();
    bookmarkTimelineFolderStatus.delete(folderId);
    bookmarkTimelineFolderRefreshedAt.set(folderId, refreshedAt);
    debugBookmarkTimeline('direct refresh cache update', { folderId, count });
    renderBookmarkTimelineSettings();
    return;
  }
  if (event.data?.type === 'XVM_BOOKMARK_TIMELINE_CACHE_HYDRATE') {
    const folders = event.data.folders && typeof event.data.folders === 'object' ? event.data.folders : {};
    let loaded = 0;
    for (const [folderId, record] of Object.entries(folders)) {
      const id = String(folderId || '');
      const entries = Array.isArray(record?.entries) ? record.entries : [];
      const fresh = filterSeenBookmarkTimelineEntries(entries);
      // Don't clobber a fresher in-memory cache built this session.
      if (!id || !fresh.length || bookmarkTimelineEntryCache.has(id)) continue;
      bookmarkTimelineEntryCache.set(id, fresh);
      if (record.refreshedAt) bookmarkTimelineFolderRefreshedAt.set(id, Number(record.refreshedAt) || 0);
      loaded += fresh.length;
    }
    debugBookmarkTimeline('hydrate cache from storage', { folders: Object.keys(folders), loaded });
    if (loaded) renderBookmarkTimelineSettings();
    return;
  }
  if (event.data?.type === 'XVM_BOOKMARK_TIMELINE_CACHE_ERROR') {
    const folderId = String(event.data.folderId || '');
    if (folderId) bookmarkTimelineFolderStatus.set(folderId, 'error');
    debugBookmarkTimeline('direct refresh cache error', { folderId, error: event.data.error });
    renderBookmarkTimelineSettings();
    if (!event.data.background) showToast(`书签内容刷新失败：${event.data.error || '未知错误'}`);
    return;
  }
  if (event.data?.type === 'XVM_BOOKMARK_TIMELINE_CACHE_RESET') {
    bookmarkTimelineEntryCache.clear();
    bookmarkTimelineFolderRefreshedAt.clear();
    bookmarkTimelineFolderStatus.clear();
    renderBookmarkTimelineSettings();
    return;
  }
  if (event.data?.type !== 'XVM_SETTINGS_UPDATE') return;

  localizedStrings = event.data.messages || localizedStrings;
  applyLocalizedUi();
  velocityThresholds = normalizeThresholds(event.data.thresholds);
  badgeStyle = event.data.badgeStyle === 'inline-classic' ? 'inline-classic' : 'pill-solid';
  applyBadgeStyle();
  // Apply showBookmarkCount BEFORE renderBadges so the very first
  // post-load render respects the persisted setting — otherwise the
  // counts flash in and out when the user had toggled them off.
  const prevShowBookmark = showBookmarkCount;
  showBookmarkCount = event.data.showBookmarkCount !== false;
  if (prevShowBookmark && !showBookmarkCount) {
    document.querySelectorAll('.xvm-bookmark-count').forEach((el) => el.remove());
  }
  document.querySelectorAll('article[data-xvm-scored]').forEach((article) => {
    article.removeAttribute('data-xvm-scored');
  });
  document.querySelectorAll('.xvm-badge').forEach((badge) => {
    badge.remove();
  });
  renderBadges();

  const prevEdgeHideEnabled = leaderboardEdgeHideEnabled;
  leaderboardEdgeHideEnabled = event.data.leaderboardEdgeHideEnabled !== false;
  if (prevEdgeHideEnabled !== leaderboardEdgeHideEnabled) {
    updateLeaderboardEdgeHideUi();
  }

  const nextLb = !!event.data.featureVelocityLeaderboard;
  const nextCount = Number.isFinite(event.data.leaderboardCount) ? event.data.leaderboardCount : 10;
  const nextCols = Array.isArray(event.data.leaderboardColumns) && event.data.leaderboardColumns.length
    ? event.data.leaderboardColumns
    : leaderboardColumns;
  const countChanged = nextCount !== leaderboardCount;
  const colsChanged = JSON.stringify(nextCols) !== JSON.stringify(leaderboardColumns);
  leaderboardCount = nextCount;
  leaderboardColumns = nextCols;
  if (nextLb !== leaderboardEnabled) {
    leaderboardEnabled = nextLb;
    if (leaderboardEnabled) {
      renderLeaderboard();
    } else {
      hideLeaderboard();
    }
  } else if (leaderboardEnabled && (countChanged || colsChanged)) {
    renderLeaderboard();
  }

  copyAsMarkdownEnabled = event.data.featureCopyAsMarkdown !== false;
  const nextBookmarkTimelineEnabled = event.data.featureBookmarkTimelineInject === true;
  const nextBookmarkTimelineFolderIds = Array.isArray(event.data.bookmarkTimelineInjectFolderIds)
    ? event.data.bookmarkTimelineInjectFolderIds.map(String).filter(Boolean)
    : [];
  for (const folderId of bookmarkTimelineEntryCache.keys()) {
    if (!nextBookmarkTimelineEnabled || !nextBookmarkTimelineFolderIds.includes(folderId)) {
      bookmarkTimelineEntryCache.delete(folderId);
      bookmarkTimelineFolderRefreshedAt.delete(folderId);
      bookmarkTimelineFolderStatus.delete(folderId);
    }
  }
  bookmarkTimelineInjectEnabled = nextBookmarkTimelineEnabled;
  bookmarkTimelineInjectFolderIds = nextBookmarkTimelineFolderIds;
  bookmarkTimelineInjectEvery = Math.max(5, Math.min(100, Number.parseInt(event.data.bookmarkTimelineInjectEvery, 10) || 20));
  bookmarkTimelineSeenTweetIds.clear();
  for (const id of Array.isArray(event.data.bookmarkTimelineSeenTweetIds) ? event.data.bookmarkTimelineSeenTweetIds : []) {
    const tid = String(id || '');
    if (tid) bookmarkTimelineSeenTweetIds.add(tid);
  }
  dropSeenBookmarkTimelineCacheEntries(Array.from(bookmarkTimelineSeenTweetIds));
  renderBookmarkTimelineSettings();
  installLeaderboardThemeSync();
  scheduleReleaseNotesModal();
});

window.postMessage({ type: 'XVM_REQUEST_SETTINGS' }, '*');

// === Request Interception (fetch + XHR) ===
const GRAPHQL_RE = /\/(?:i\/api\/)?graphql\//;
// AI reply generation removed locally (2026-11-11). Only the Enter-to-reply
// setting survives; it still arrives on the old XVM_GROK_SETTINGS_* channel.
let grokEnterToReply = false;
let grokLastReplyArticle = null;

window.postMessage({ type: 'XVM_GROK_SETTINGS_REQUEST' }, '*');

// Pre-warm tx-id context for the TweetDetail fallback fetcher.
window.__xvmXct?.warmup?.();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== 'XVM_GROK_SETTINGS_LOAD') return;
  if (typeof event.data.enterToReply === 'boolean') {
    grokEnterToReply = event.data.enterToReply;
  }
});

function reportRateLimit(remaining, reset) {
  if (remaining === null || remaining === undefined) return;
  window.postMessage({
    type: 'XVM_RATE_LIMIT',
    remaining: parseInt(remaining, 10),
    reset: parseInt(reset, 10),
  }, '*');
}

// Subscribe to GraphQL traffic for star-chart template capture + tweet scanning.
window.__xvmNet?.onRequest(GRAPHQL_RE, ({ url, headers }) => {
  captureBookmarkTimelineQueryId(url);
});
window.__xvmNet?.onResponse(GRAPHQL_RE, async ({ url, response, source }) => {
  if (source === 'fetch') {
    reportRateLimit(response.headers.get('x-rate-limit-remaining'), response.headers.get('x-rate-limit-reset'));
    response.clone().json().then(scanForTweets).catch(() => {});
  } else {
    reportRateLimit(response.getHeader('x-rate-limit-remaining'), response.getHeader('x-rate-limit-reset'));
    try { scanForTweets(response.json()); } catch (_) {}
  }
});
// Ad prune + bookmark inject are separate patch subscribers. Match ONLY the
// timeline ops they need so other GraphQL (BookmarkFoldersSlice, Viewer, …)
// never enters response.clone().json() rewrite — MAIN-world callers like
// bookmark-menu.js share this fetch hook.
const TIMELINE_AD_PRUNE_RE = window.__xvmTimelineAdPrune?.TIMELINE_OPS
  || /\/(?:i\/api\/)?graphql\/[^/]+\/(?:HomeTimeline|HomeLatestTimeline|ListLatestTweetsTimeline|UserTweets|UserTweetsAndReplies|UserMedia|SearchTimeline|TweetDetail|CommunityTweetsTimeline|CommunitiesMainTimeline|ExplorePage)\b/;
window.__xvmNet?.onResponsePatch(TIMELINE_AD_PRUNE_RE, ({ url, json }) => {
  return window.__xvmTimelineAdPrune?.patchTimelineResponse?.({ url, json });
});
window.__xvmNet?.onResponsePatch(/\/(?:i\/api\/)?graphql\/[^/]+\/HomeTimeline(?:\?|$)/, ({ url, json }) => {
  return maybeInjectBookmarkTimeline(url, json);
});

function captureBookmarkTimelineQueryId(url) {
  const qid = String(url || '').match(/\/i\/api\/graphql\/([^/]+)\/BookmarkFolderTimeline(?:\?|$)/)?.[1];
  if (!qid) return;
  window.postMessage({ type: 'XVM_BOOKMARK_TIMELINE_QID_CAPTURED', qid, capturedAt: Date.now() }, '*');
  debugBookmarkTimeline('captured BookmarkFolderTimeline queryId', { qid });
}

function currentBookmarkFolderId() {
  const m = location.pathname.match(/^\/i\/bookmarks\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function rememberBookmarkTimelineEntries(json) {
  const folderId = currentBookmarkFolderId();
  if (!folderId) return;
  if (!bookmarkTimelineInjectEnabled) {
    debugBookmarkTimeline('cache skipped: disabled', { folderId });
    return;
  }
  if (bookmarkTimelineInjectFolderIds.length && !bookmarkTimelineInjectFolderIds.includes(folderId)) {
    debugBookmarkTimeline('cache skipped: folder not selected', { folderId, selected: bookmarkTimelineInjectFolderIds });
    return;
  }
  const inject = window.__xvmBookmarkTimelineInject;
  // Browsing a folder page yields only one ~20-tweet page. Merge it into the
  // existing (possibly fully-paginated) cache instead of replacing, so a casual
  // visit can't shrink what the background refresh already gathered.
  const prev = bookmarkTimelineEntryCache.get(folderId) || [];
  const count = inject?.cacheBookmarkTimelineEntries(bookmarkTimelineEntryCache, folderId, json) || 0;
  if (count && prev.length && typeof inject?._getTweetId === 'function') {
    const fresh = bookmarkTimelineEntryCache.get(folderId) || [];
    const seen = new Set();
    const merged = [];
    for (const entry of [...fresh, ...prev]) {
      const tid = inject._getTweetId(entry);
      if (!tid || seen.has(tid)) continue;
      seen.add(tid);
      merged.push(entry);
    }
    bookmarkTimelineEntryCache.set(folderId, merged.slice(0, BOOKMARK_TIMELINE_FETCH_CAP));
  }
  const fresh = bookmarkTimelineEntryCache.get(folderId);
  if (fresh) bookmarkTimelineEntryCache.set(folderId, filterSeenBookmarkTimelineEntries(fresh));
  debugBookmarkTimeline('cache bookmark folder response', { folderId, count, cachedFolders: Array.from(bookmarkTimelineEntryCache.keys()) });
}

function filterSeenBookmarkTimelineEntries(entries) {
  if (!bookmarkTimelineSeenTweetIds.size) return entries;
  return entries.filter((entry) => {
    const id = window.__xvmBookmarkTimelineInject?._getTweetId?.(entry);
    return id && !bookmarkTimelineSeenTweetIds.has(String(id));
  });
}

function dropSeenBookmarkTimelineCacheEntries(tweetIds) {
  const seen = new Set((Array.isArray(tweetIds) ? tweetIds : []).map(String).filter(Boolean));
  if (!seen.size) return;
  for (const [folderId, entries] of bookmarkTimelineEntryCache.entries()) {
    const fresh = entries.filter((entry) => {
      const id = window.__xvmBookmarkTimelineInject?._getTweetId?.(entry);
      return id && !seen.has(String(id));
    });
    bookmarkTimelineEntryCache.set(folderId, fresh);
  }
}

function maybeInjectBookmarkTimeline(url, json) {
  rememberBookmarkTimelineEntries(json);
  if (!/\/i\/api\/graphql\/.*HomeTimeline/.test(url)) return undefined;
  const before = countBookmarkTimelineHomeEntries(json);
  if (!bookmarkTimelineInjectEnabled) {
    debugBookmarkTimeline('HomeTimeline skipped: disabled', { before });
    return undefined;
  }
  const patched = window.__xvmBookmarkTimelineInject?.injectBookmarkTimelineEntries(json, bookmarkTimelineEntryCache, {
    enabled: true,
    folderIds: bookmarkTimelineInjectFolderIds,
    every: bookmarkTimelineInjectEvery,
    excludedTweetIds: Array.from(bookmarkTimelineSeenTweetIds),
  });
  const after = countBookmarkTimelineHomeEntries(patched || json);
  const inserted = after - before;
  rememberInsertedBookmarkTimelineTweets(patched || json);
  debugBookmarkTimeline('HomeTimeline inject attempt', {
    selectedFolders: bookmarkTimelineInjectFolderIds,
    every: bookmarkTimelineInjectEvery,
    cache: Array.from(bookmarkTimelineEntryCache.entries()).map(([folderId, entries]) => ({ folderId, count: entries.length })),
    before,
    after,
    inserted,
  });
  return inserted > 0 ? patched : undefined;
}

function rememberInsertedBookmarkTimelineTweets(json) {
  const arrays = window.__xvmBookmarkTimelineInject?._findEntryArrays?.(json) || [];
  const freshIds = [];
  for (const entry of arrays.flat()) {
    if (!String(entry?.entryId || '').startsWith('xvm-bookmark-')) continue;
    const id = window.__xvmBookmarkTimelineInject?._getTweetId?.(entry);
    if (!id) continue;
    const tid = String(id);
    bookmarkTimelineInsertedTweetIds.add(tid);
    if (bookmarkTimelineSeenTweetIds.has(tid)) continue;
    bookmarkTimelineSeenTweetIds.add(tid);
    freshIds.push(tid);
  }
  if (!freshIds.length) return;
  dropSeenBookmarkTimelineCacheEntries(freshIds);
  window.postMessage({ type: 'XVM_BOOKMARK_TIMELINE_SEEN', tweetIds: freshIds }, '*');
}

function countBookmarkTimelineHomeEntries(json) {
  const instructions = json?.data?.home?.home_timeline_urt?.instructions
    || json?.data?.home?.home_timeline?.instructions
    || [];
  for (const instruction of instructions) {
    const entries = instruction?.entries || [];
    if (entries.some((entry) => window.__xvmBookmarkTimelineInject?._getTweetId?.(entry))) return entries.length;
  }
  const arrays = window.__xvmBookmarkTimelineInject?._findEntryArrays?.(json) || [];
  const entries = arrays.find((items) => items.length) || [];
  return entries.length;
}

// === Data Extraction ===
// X marks an ad on the timeline ENTRY, never on the tweet object:
//   { entryId: "promoted-tweet-123",
//     content: { itemContent: { promotedMetadata: {...},
//                               tweet_results: { result: {...} } } } }
// promotedMetadata is a SIBLING of tweet_results. scanForTweets recurses
// straight down to tweet_results.result and hands only that to
// extractTweetData, so its `legacy.promotedMetadata || tweet.promotedMetadata`
// check never sees the marker and every ad lands in tweetDataStore. Ads carry
// bought impression counts, so their views/hour dwarfs organic posts and they
// pin themselves to the top of the leaderboard.
// Catch it at the entry level, where the marker actually is.
// Recursively scan any JSON for tweet_results objects
// Author follower counts (local addition). X has moved user fields between
// `legacy`, `core` and other blocks before, so read every known spot and
// cache by handle: a tweet whose payload lacks the count can still use one
// seen elsewhere (hover cards, profile loads, other tweets).
const followerCountByHandle = new Map();
window.__xvmFollowerDebug = { seenUsers: 0, cached: 0, rendered: 0, noCount: 0, noAvatar: 0 };

function readUserFollowers(user) {
  if (!user || typeof user !== 'object') return null;
  const candidates = [
    user.legacy?.followers_count,
    user.legacy?.normal_followers_count,
    user.core?.followers_count,
    user.relationship_counts?.followers,
    user.relationship_counts?.followers_count,
    user.followers_count,
  ];
  for (const raw of candidates) {
    const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function rememberUserFollowers(user) {
  if (!user || typeof user !== 'object') return null;
  const handle = user.core?.screen_name || user.legacy?.screen_name || user.screen_name || '';
  const followers = readUserFollowers(user);
  window.__xvmFollowerDebug.seenUsers++;
  if (handle && followers != null) {
    followerCountByHandle.set(handle.toLowerCase(), followers);
    window.__xvmFollowerDebug.cached = followerCountByHandle.size;
  }
  return followers;
}

function scanForTweets(obj) {
  if (!obj || typeof obj !== 'object') return;
  let found = false;

  const promotedId = promotedTweetIdFrom(obj);
  if (promotedId !== null) {
    if (promotedId) {
      promotedTweetIds.add(promotedId);
      // The same ad can arrive through a path that reached the store first.
      tweetDataStore.delete(promotedId);
    }
    return; // do not descend - nothing under an ad entry belongs in the store
  }

  if (obj.__typename === 'User' && (obj.legacy || obj.core)) {
    rememberUserFollowers(obj);
  }

  const result = obj.tweet_results?.result
    || obj.tweetResult?.result
    || obj.tweetResults?.result;
  if (result) {
    const data = extractTweetData(result);
    if (data) {
      tweetDataStore.set(data.id, data);
      found = true;
    }
  }

  // Recurse into arrays and objects
  if (Array.isArray(obj)) {
    for (const item of obj) scanForTweets(item);
  } else {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === 'object') scanForTweets(val);
    }
  }

  if (found) { renderBadges(); }
}

// Ad ids seen on the timeline entry. Declared here (not at the top of the
// file) so it stays inside the source range tests/tweet-data-extraction.test.js
// slices out to evaluate scanForTweets.
const promotedTweetIds = new Set();

function promotedTweetIdFrom(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const itemContent = obj.content?.itemContent || obj.itemContent || obj;
  const promoted = /^promoted-/i.test(String(obj.entryId || ''))
    || !!itemContent.promotedMetadata
    || !!itemContent.promoted_metadata;
  if (!promoted) return null;
  const result = itemContent.tweet_results?.result
    || itemContent.tweetResult?.result
    || itemContent.tweetResults?.result;
  const tweet = result?.tweet || result;
  // '' means "promoted, but the id is not resolvable here" - still enough to
  // stop the walk before the ad reaches the store.
  return String(tweet?.rest_id || tweet?.legacy?.id_str || '');
}

function extractTweetData(result) {
  const tweet = result.tweet || result;
  const legacy = tweet.legacy;
  if (!legacy) return null;

  const viewCount = parseInt(tweet.views?.count, 10);
  if (!viewCount || tweet.views?.state !== 'EnabledWithCount') return null;

  if (legacy.promotedMetadata || tweet.promotedMetadata) return null;

  const tweetId = legacy.id_str;
  const screenName = tweet.core?.user_results?.result?.legacy?.screen_name
    || tweet.core?.user_results?.result?.core?.screen_name
    || '';
  const followers = rememberUserFollowers(tweet.core?.user_results?.result);
  // Rewrite the opaque /i/article/<articleId> form X serializes into the
  // human-readable /<handle>/article/<tweetId> form. Same article, but the
  // copied markdown points back to the post the user actually shared.
  const canonicalArticleUrl = (screenName && tweetId)
    ? `https://x.com/${screenName}/article/${tweetId}`
    : '';
  const articleUrlRe = /^https?:\/\/(?:x|twitter)\.com\/i\/article\/\d+/i;
  const normalizeExpanded = (raw) => {
    if (!raw) return raw;
    return canonicalArticleUrl && articleUrlRe.test(raw) ? canonicalArticleUrl : raw;
  };

  const urlMap = {};
  for (const u of legacy.entities?.urls || []) {
    if (u?.url && u.expanded_url) urlMap[u.url] = normalizeExpanded(u.expanded_url);
  }

  // Long-form tweet body (note_tweet) overrides full_text if present
  const noteText = tweet.note_tweet?.note_tweet_results?.result?.text;
  for (const u of tweet.note_tweet?.note_tweet_results?.result?.entity_set?.urls || []) {
    if (u?.url && u.expanded_url && !urlMap[u.url]) urlMap[u.url] = normalizeExpanded(u.expanded_url);
  }

  // X Article (long-form essay) content
  const articleResult = tweet.article?.article_results?.result;
  let articleMd = '';
  let articleTitle = '';
  if (articleResult) {
    articleMd = buildArticleMarkdown(articleResult);
    articleTitle = articleResult.title || articleResult.preview_text || '';
  }
  for (const m of legacy.extended_entities?.media || legacy.entities?.media || []) {
    if (!m?.url) continue;
    if (m.type === 'photo') {
      urlMap[m.url] = `![](${m.media_url_https})`;
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      const variants = m.video_info?.variants || [];
      const mp4s = variants.filter((v) => v.content_type === 'video/mp4' && v.bitrate != null);
      mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const videoUrl = mp4s[0]?.url || m.media_url_https;
      urlMap[m.url] = `[📹 video](${videoUrl})`;
    } else {
      urlMap[m.url] = m.media_url_https;
    }
  }

  return {
    id: legacy.id_str,
    screenName,
    inReplyToStatusId: legacy.in_reply_to_status_id_str || '',
    inReplyToScreenName: legacy.in_reply_to_screen_name || '',
    views: viewCount,
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    bookmarks: legacy.bookmark_count || 0,
    followers,
    createdAt: legacy.created_at,
    text: noteText || legacy.full_text || '',
    urlMap,
    articleMd,
    articleTitle,
  };
}

// Draft.js-style content_state → Markdown for X Articles
function buildArticleMarkdown(articleResult) {
  const title = articleResult.title || '';
  const coverUrl = extractMediaUrl(articleResult.cover_media)
    || articleResult.cover_media?.media_info?.original_img_url
    || articleResult.cover_media?.media_info?.media_url_https
    || articleResult.cover_media?.url
    || '';

  // Article-level media lookup: in X's payload the content_state's MEDIA
  // entities carry only a mediaId reference (e.g. {"mediaItems":[{"mediaId":
  // "2051..."}]}). The actual URLs live on a sibling collection of the
  // article result. Build a mediaId → renderedMd map by scanning all known
  // shapes so each MEDIA entity can be resolved at block time.
  const mediaLookup = buildArticleMediaLookup(articleResult);
  // dev-only diagnostic — downgraded from console.warn so it stops
  // polluting normal users' DevTools console. Articles without a media
  // lookup are common (text-only X Articles) and surface no actionable
  // information; the previous warn was instrumentation left over from
  // the article-media work in #16.
  if (!buildArticleMarkdown._loggedShape && (Object.keys(mediaLookup).length === 0)) {
    buildArticleMarkdown._loggedShape = true;
    try {
      const keys = Object.keys(articleResult || {});
      console.debug('[XVM] articleResult shape (no media lookup found):', keys, articleResult);
    } catch (_) {}
  }

  let state = articleResult.content_state;
  if (typeof state === 'string') {
    try { state = JSON.parse(state); } catch (_) { state = null; }
  }

  const lines = [];
  if (title) lines.push(`# ${title}`, '');
  if (coverUrl) lines.push(`![](${coverUrl})`, '');

  if (state?.blocks?.length) {
    // X serialises entityMap as an ARRAY of {key, value} pairs (not the
    // classic Draft.js {[key]: entity} object). Normalise to a plain
    // dict so entityRange.key lookups work regardless of array index.
    const entityMap = normalizeEntityMap(state.entityMap);
    for (const block of state.blocks) {
      lines.push(renderArticleBlock(block, entityMap, mediaLookup));
    }
  } else if (articleResult.preview_text) {
    lines.push(articleResult.preview_text);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Walk every plausible "where X parks the resolved media for an article"
// path and collect mediaId → markdown string. The content_state entity
// references images by mediaId; we resolve them here.
function buildArticleMediaLookup(articleResult) {
  const map = Object.create(null);
  if (!articleResult) return map;

  const buckets = [
    articleResult.media_entities,
    articleResult.media,
    articleResult.tweet_media,
    articleResult.attached_media,
    articleResult.media_results,
    // Sometimes nested under a `result` wrapper.
    articleResult.media?.media_results,
  ];

  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object') return;

    // Common nested wrappers
    if (node.result) visit(node.result);
    if (node.media_results?.result) visit(node.media_results.result);
    if (node.tweet_media_results?.result) visit(node.tweet_media_results.result);

    const ids = [
      node.media_id_str, node.media_id, node.mediaId,
      node.id_str, node.rest_id, node.id,
    ].filter(Boolean).map(String);
    if (ids.length) {
      const md = renderResolvedMedia(node);
      if (md) {
        for (const id of ids) {
          if (!map[id]) map[id] = md;
        }
      }
    }
  };

  for (const b of buckets) visit(b);

  // Last resort: walk all top-level array fields and pull anything that
  // looks media-shaped. Catches unknown bucket names.
  for (const key of Object.keys(articleResult)) {
    const v = articleResult[key];
    if (Array.isArray(v)) visit(v);
  }

  return map;
}

function normalizeEntityMap(em) {
  if (!em) return {};
  if (Array.isArray(em)) {
    const out = Object.create(null);
    for (const entry of em) {
      if (entry && entry.key != null && entry.value) {
        out[String(entry.key)] = entry.value;
      }
    }
    return out;
  }
  return em;
}

function renderResolvedMedia(node) {
  const src = extractMediaUrl(node);
  if (!src) return '';
  if (isVideoMedia(node) || /\.mp4(\?|$)/i.test(src)) {
    return `[📹 video](${src})`;
  }
  return `![](${src})`;
}

function renderArticleBlock(block, entityMap, mediaLookup = {}) {
  const type = block.type || 'unstyled';
  const raw = block.text || '';
  const text = applyInlineFormatting(raw, block.inlineStyleRanges || [], block.entityRanges || [], entityMap, mediaLookup);

  switch (type) {
    case 'header-one':   return `# ${text}\n`;
    case 'header-two':   return `## ${text}\n`;
    case 'header-three': return `### ${text}\n`;
    case 'unordered-list-item': return `- ${text}`;
    case 'ordered-list-item':   return `1. ${text}`;
    case 'blockquote':   return `> ${text}`;
    case 'code-block':   return '```\n' + text + '\n```';
    case 'atomic': {
      // Atomic blocks carry one media-bearing entity: image, video, GIF,
      // embedded tweet, or generic embed (YouTube, etc). X Articles use
      // several entity-type names and a handful of payload shapes — we try
      // each one in order, then fall back to a console.warn diagnostic so
      // we can extend support if a new shape shows up.
      const ranges = block.entityRanges || [];
      for (const r of ranges) {
        const entity = entityMap[r.key];
        if (!entity) continue;
        const rendered = renderArticleAtomicEntity(entity, mediaLookup);
        if (rendered) return rendered;
      }
      if (ranges.length) {
        try {
          const dump = ranges.map((r) => entityMap[r.key]).filter(Boolean);
          // Demoted to debug to avoid console-spamming users on every
          // article we copy. Re-enable verbose logging in DevTools by
          // setting `window.__xvmVerboseArticleAtomic = true` before the
          // copy action.
          if (window.__xvmVerboseArticleAtomic) {
            console.debug('[XVM] article atomic: unsupported entity', JSON.stringify(dump).slice(0, 800));
          }
        } catch (_) {}
      }
      return '';
    }
    default:
      return text ? `${text}\n` : '';
  }
}

// Pick the best media URL out of any media-like payload — X uses
// several casings (mediaInfo / media_info), several places (top-level,
// nested under media / mediaEntity / tweet_media_results), and a video
// shape with multiple bitrate variants. Returns null if none usable.
function extractMediaUrl(payload) {
  if (!payload) return null;
  const candidates = [payload, payload.data, payload.media, payload.mediaEntity,
    payload.tweet_media_results?.result, payload.media_results?.result];
  for (const node of candidates) {
    if (!node) continue;
    const info = node.media_info || node.mediaInfo;
    const direct = (info && (info.original_img_url || info.media_url_https || info.url))
      || node.original_img_url || node.media_url_https || node.url || node.src;
    if (direct && /^https?:/.test(direct)) return direct;
    const variants = (info && info.variants) || node.video_info?.variants || node.variants || [];
    if (Array.isArray(variants) && variants.length) {
      const mp4s = variants
        .filter((v) => v && v.content_type === 'video/mp4' && v.bitrate != null)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (mp4s[0]?.url) return mp4s[0].url;
      const anyUrl = variants.find((v) => v && v.url)?.url;
      if (anyUrl) return anyUrl;
    }
  }
  return null;
}

function isVideoMedia(payload) {
  if (!payload) return false;
  const info = payload.media_info || payload.mediaInfo || payload.data?.media_info || payload.data?.mediaInfo || {};
  const t = (info.type || payload.type || payload.data?.type || '').toLowerCase();
  if (t.includes('video') || t.includes('gif')) return true;
  return false;
}

function renderArticleAtomicEntity(entity, mediaLookup = {}) {
  const rawType = String(entity.type || '').toUpperCase();
  const data = entity.data || {};

  // X Article newer block kinds. MARKDOWN entities carry an inline
  // markdown snippet (e.g. user-pasted code blocks); DIVIDER is a
  // horizontal rule. Both used to warn-spam the console.
  if (rawType === 'MARKDOWN') {
    const md = String(data.markdown ?? data.text ?? data.content ?? '');
    return md ? md.replace(/\n+$/, '') + '\n' : '';
  }
  if (rawType === 'DIVIDER' || rawType === 'HORIZONTAL_RULE' || rawType === 'HR') {
    return '\n---\n';
  }

  // MEDIA entities with only a mediaId reference — resolve via the
  // article-level lookup built in buildArticleMediaLookup. Multiple
  // mediaItems → render each on its own line.
  if ((rawType === 'MEDIA' || rawType === 'IMAGE') && Array.isArray(data.mediaItems) && data.mediaItems.length) {
    const out = [];
    for (const item of data.mediaItems) {
      const id = String(item?.mediaId || item?.media_id || '');
      const md = id && mediaLookup[id];
      if (md) out.push(md);
    }
    if (out.length) return out.join('\n') + '\n';
  }

  // Embedded tweet — render as blockquote with author + link.
  if (rawType === 'TWEET' || rawType === 'EMBEDDED_TWEET' || rawType === 'TWEET_EMBED'
    || data.tweet_results || data.tweetResults || data.tweet_id || data.tweetId) {
    const info = extractEmbeddedTweetInfo(entity);
    if (info?.url || info?.text) {
      const out = [];
      if (info.text) {
        out.push(info.text.split('\n').map((ln) => `> ${ln}`).join('\n'));
      }
      const handleLabel = info.screenName ? `@${info.screenName}` : 'tweet';
      if (info.url) {
        out.push(info.text ? `> — [${handleLabel}](${info.url})` : `[${handleLabel}](${info.url})`);
      }
      return out.join('\n') + '\n';
    }
  }

  // Image / video / GIF / generic media
  if (rawType === 'IMAGE' || rawType === 'MEDIA' || rawType === 'PHOTO'
    || rawType === 'VIDEO' || rawType === 'GIF' || rawType === 'ANIMATED_GIF') {
    const src = extractMediaUrl(entity) || extractMediaUrl(entity.data);
    if (src) {
      if (isVideoMedia(entity) || isVideoMedia(entity.data) || /\.mp4(\?|$)/i.test(src)) {
        return `[📹 video](${src})\n`;
      }
      return `![](${src})\n`;
    }
  }

  // YouTube / generic oEmbed.
  if (rawType === 'YOUTUBE' || rawType === 'OEMBED' || rawType === 'EMBED'
    || rawType === 'LINK_PREVIEW' || rawType === 'CARD') {
    const href = data.url || data.href || data.embed_url || '';
    const label = data.title || data.name || rawType.toLowerCase();
    if (href) return `[🔗 ${label}](${href})\n`;
  }

  // Last-ditch: any URL-like field in data.
  const fallbackHref = data.url || data.href || data.expanded_url || '';
  if (fallbackHref && /^https?:/.test(fallbackHref)) {
    return `[${data.title || data.name || fallbackHref}](${fallbackHref})\n`;
  }
  return '';
}

function extractEmbeddedTweetInfo(entity) {
  const data = entity?.data || {};
  const result = data.tweet_results?.result
    || data.tweetResults?.result
    || data.tweet
    || null;
  if (result) {
    const legacy = result.legacy || result;
    const text = result.note_tweet?.note_tweet_results?.result?.text
      || legacy?.full_text
      || legacy?.text
      || '';
    const screenName = result.core?.user_results?.result?.legacy?.screen_name
      || result.user?.screen_name
      || result.user_results?.result?.legacy?.screen_name
      || '';
    const id = legacy?.id_str || result.rest_id || data.tweet_id || data.tweetId || data.id || '';
    const url = (screenName && id)
      ? `https://x.com/${screenName}/status/${id}`
      : (data.url || data.href || '');
    return { text, screenName, id, url };
  }
  const rawUrl = data.url || data.href || '';
  if (rawUrl && /(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(rawUrl)) {
    const m = rawUrl.match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/);
    return {
      text: '',
      screenName: m?.[1] || '',
      id: m?.[2] || '',
      url: rawUrl.replace('twitter.com', 'x.com'),
    };
  }
  return null;
}

function applyInlineFormatting(raw, inlineStyleRanges, entityRanges, entityMap, mediaLookup = {}) {
  if (!raw) return '';

  const boundaries = new Set([0, raw.length]);
  const addRangeBoundaries = (range) => {
    const start = Math.max(0, Math.min(raw.length, range.offset || 0));
    const end = Math.max(start, Math.min(raw.length, start + (range.length || 0)));
    boundaries.add(start);
    boundaries.add(end);
  };

  inlineStyleRanges.forEach(addRangeBoundaries);
  entityRanges.forEach(addRangeBoundaries);

  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  const parts = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start === end) continue;

    const slice = raw.slice(start, end);
    const styles = new Set(
      inlineStyleRanges
        .filter((r) => rangeContains(r, start, end))
        .map((r) => String(r.style || '').toUpperCase())
    );
    const entityRange = entityRanges.find((r) => rangeContains(r, start, end));
    const entity = entityRange ? entityMap[entityRange.key] : null;

    let text = applyMarkdownStyles(slice, styles);
    const entityType = String(entity?.type || '').toUpperCase();
    if (entityType === 'LINK') {
      const href = entity.data?.url || entity.data?.href || '';
      if (href) text = `[${text}](${href})`;
    } else if (entity && entityType !== '') {
      // Inline image / embedded tweet / embed within a text block — rare,
      // but worth rendering instead of dropping the slice.
      const atomic = renderArticleAtomicEntity(entity, mediaLookup);
      if (atomic) text = atomic.trimEnd();
    }

    parts.push(text);
  }

  return parts.join('');
}

function rangeContains(range, start, end) {
  const rangeStart = range.offset || 0;
  const rangeEnd = rangeStart + (range.length || 0);
  return start >= rangeStart && end <= rangeEnd;
}

function applyMarkdownStyles(text, styles) {
  if (!text) return '';
  if (styles.has('CODE')) return `\`${text}\``;

  let result = text;
  if (styles.has('BOLD')) result = `**${result}**`;
  if (styles.has('ITALIC')) result = `*${result}*`;
  if (styles.has('STRIKETHROUGH')) result = `~~${result}~~`;
  if (styles.has('UNDERLINE')) result = `<u>${result}</u>`;
  return result;
}

// === Formatting ===
function formatVelocity(v) {
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return Math.round(v).toString();
}

// === Scoring ===
function computeScore(data) {
  const now = Date.now();
  const created = new Date(data.createdAt).getTime();
  const hours = Math.max((now - created) / 3600000, 0.1);
  const velocity = data.views / hours;

  const velocityScore = Math.min(velocity / 50000, 1) * 40;

  const engagements = data.likes + data.retweets + data.replies;
  const engagementRate = data.views > 0 ? engagements / data.views : 0;
  const engagementScore = Math.min(engagementRate / 0.1, 1) * 25;

  const rtRatio = data.likes > 0 ? data.retweets / data.likes : 0;
  const rtScore = Math.min(rtRatio / 0.5, 1) * 20;

  const bmRatio = data.likes > 0 ? data.bookmarks / data.likes : 0;
  const bmScore = Math.min(bmRatio / 0.3, 1) * 15;

  const totalScore = Math.round(velocityScore + engagementScore + rtScore + bmScore);

  return {
    velocity,
    score: Math.min(totalScore, 100),
    isHot: velocity >= velocityThresholds.viral,
  };
}

function getTweetDataForArticle(article, tweetId) {
  const cached = tweetDataStore.get(tweetId);
  if (cached) return cached;
  if (!article.parentElement?.closest('article[data-testid="tweet"]')) return null;

  const own = (selector) => Array.from(article.querySelectorAll(selector))
    .find((node) => node.closest('article[data-testid="tweet"]') === article);
  const readCount = (element) => {
    const match = String(element?.getAttribute('aria-label') || '').match(/\d[\d.,\s\u00a0\u202f]*/);
    return match ? Number.parseInt(match[0].replace(/\D/g, ''), 10) || 0 : 0;
  };
  const time = own('time[datetime]');
  const analytics = own(`a[href*="/status/${tweetId}/analytics"]`);
  if (!time || !analytics) return null;

  const group = own('[role="group"]');
  const groupCounts = String(group?.getAttribute('aria-label') || '')
    .match(/\d[\d.,\s\u00a0\u202f]*/g)
    ?.map((value) => Number.parseInt(value.replace(/\D/g, ''), 10) || 0) || [];
  const statusLink = own(`a[href*="/status/${tweetId}"]`);
  const screenName = statusLink?.getAttribute('href')?.match(/^\/([^/]+)\/status\//)?.[1] || '';
  const data = {
    id: tweetId,
    screenName,
    inReplyToStatusId: '',
    inReplyToScreenName: '',
    views: readCount(analytics),
    likes: readCount(own('button[data-testid="like"], button[data-testid="unlike"]')),
    retweets: readCount(own('button[data-testid="retweet"]')),
    replies: readCount(own('button[data-testid="reply"]')),
    bookmarks: groupCounts.length >= 5 ? groupCounts[groupCounts.length - 2] : 0,
    createdAt: time.getAttribute('datetime'),
    text: own('[data-testid="tweetText"]')?.textContent || '',
    urlMap: {},
    articleMd: '',
    articleTitle: '',
  };
  if (!data.views || !data.createdAt) return null;
  tweetDataStore.set(tweetId, data);
  return data;
}

// === Tooltip Container (fixed, appended to body) ===
let tooltipEl = null;
let tooltipGlobalDismissBound = false;
function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

function bindTooltipGlobalDismiss() {
  if (tooltipGlobalDismissBound) return;
  tooltipGlobalDismissBound = true;

  window.addEventListener('blur', hideTooltip);
  window.addEventListener('scroll', hideTooltip, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hideTooltip();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTooltip();
  });
  document.addEventListener('pointerdown', (event) => {
    if (event.target?.closest?.('.xvm-badge, .xvm-tooltip')) return;
    hideTooltip();
  }, true);
}

function getTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'xvm-tooltip';
    tooltipEl.addEventListener('mouseleave', hideTooltip);
    document.body.appendChild(tooltipEl);
    bindTooltipGlobalDismiss();
  }
  return tooltipEl;
}

// === Badge Rendering ===
// Author follower count under the avatar (local addition).
function formatFollowers(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n < 1000000) return Math.floor(n / 1000) + 'K';
  return (Math.floor(n / 100000) / 10).toFixed(1).replace(/\.0$/, '') + 'M';
}

function findAvatarColumn(article, avatar) {
  const userName = Array.from(article.querySelectorAll('[data-testid="User-Name"]'))
    .find((node) => node.closest('article[data-testid="tweet"]') === article);
  let col = avatar;
  while (col.parentElement && col.parentElement !== article) {
    if (userName && col.parentElement.contains(userName)) return col;
    col = col.parentElement;
  }
  return avatar.parentElement;
}

function renderFollowerCount(article, data) {
  const followers = data.followers ?? followerCountByHandle.get(String(data.screenName || '').toLowerCase());
  if (followers == null) { window.__xvmFollowerDebug.noCount++; return; }
  const avatar = Array.from(article.querySelectorAll('[data-testid="Tweet-User-Avatar"]'))
    .find((node) => node.closest('article[data-testid="tweet"]') === article);
  if (!avatar) { window.__xvmFollowerDebug.noAvatar++; return; }
  const column = findAvatarColumn(article, avatar);
  if (!column) { window.__xvmFollowerDebug.noAvatar++; return; }
  let label = column.querySelector(':scope > .xvm-followers');
  if (!label) {
    label = document.createElement('div');
    label.className = 'xvm-followers';
    column.appendChild(label);
    window.__xvmFollowerDebug.rendered++;
  }
  label.textContent = formatFollowers(followers);
  label.title = `${followers.toLocaleString()} followers`;
}

function renderBadges() {
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  for (const article of articles) {
    const tweetId = getTweetIdFromArticle(article);
    if (!tweetId) continue;
    const data = getTweetDataForArticle(article, tweetId);
    if (!data) continue;

    if (article.hasAttribute('data-xvm-scored')) {
      if (article.getAttribute('data-xvm-scored-id') === tweetId) {
        if (!article.querySelector('.xvm-followers')) renderFollowerCount(article, data);
        continue;
      }
      article.querySelectorAll(':scope .xvm-badge, :scope .xvm-followers').forEach((badge) => badge.remove());
      article.removeAttribute('data-xvm-scored');
    }

    const caretBtn = Array.from(article.querySelectorAll('[data-testid="caret"]'))
      .find((node) => node.closest('article[data-testid="tweet"]') === article);
    const userName = Array.from(article.querySelectorAll('[data-testid="User-Name"]'))
      .find((node) => node.closest('article[data-testid="tweet"]') === article);
    if (!userName) continue;
    let headerRow = null;
    let el = (caretBtn || userName).parentElement;
    while (el && el !== article) {
      const cs = getComputedStyle(el);
      if (cs.display === 'flex' && cs.flexDirection === 'row'
        && el.contains(userName) && (caretBtn || el.children.length > 1)) {
        headerRow = el;
        break;
      }
      el = el.parentElement;
    }
    if (!headerRow) continue;

    // Only mark scored after we confirmed headerRow is valid
    article.setAttribute('data-xvm-scored', '1');
    article.setAttribute('data-xvm-scored-id', tweetId);
    renderFollowerCount(article, data);

    const { velocity, score } = computeScore(data);
    // 🌱 normal | 🚀 trending | 🔥 viral
    const prefix = velocity >= velocityThresholds.viral ? '\u{1F525}' : velocity >= velocityThresholds.trending ? '\u{1F680}' : '\u{1F331}';
    const colorClass = velocity >= velocityThresholds.viral ? 'xvm-badge--red' : velocity >= velocityThresholds.trending ? 'xvm-badge--orange' : 'xvm-badge--green';
    const velocityLabel = formatVelocity(velocity);
    if (!prefix || !velocityLabel) continue;

    const badge = document.createElement('span');
    badge.className = `xvm-badge ${colorClass}`;
    badge.dataset.prefix = prefix;
    badge.dataset.velocity = velocityLabel;

    // Tooltip: show/hide a single shared fixed element
    const postedDate = new Date(data.createdAt);
    const postedStr = postedDate.getFullYear() + ':' +
      String(postedDate.getMonth() + 1).padStart(2, '0') + ':' +
      String(postedDate.getDate()).padStart(2, '0') + ' ' +
      String(postedDate.getHours()).padStart(2, '0') + ':' +
      String(postedDate.getMinutes()).padStart(2, '0') + ':' +
      String(postedDate.getSeconds()).padStart(2, '0');
    const tooltipContent =
      `${i18n('contentViews')}: ${data.views.toLocaleString()}\n` +
      `${i18n('contentLikes')}: ${data.likes.toLocaleString()}\n` +
      `${i18n('contentRetweets')}: ${data.retweets.toLocaleString()}\n` +
      `${i18n('contentReplies')}: ${data.replies.toLocaleString()}\n` +
      `${i18n('contentBookmarks')}: ${data.bookmarks.toLocaleString()}\n` +
      `${i18n('contentVelocity')}: ${velocityLabel}/h\n` +
      `${i18n('contentViralScore')}: ${score}/100\n` +
      `${i18n('contentPosted')}: ${postedStr}`;

    badge.addEventListener('mouseenter', () => {
      const tip = getTooltip();
      tip.textContent = tooltipContent;
      const rect = badge.getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.top = (rect.bottom + 6) + 'px';
      tip.style.left = '';
      tip.style.right = '';
      // Align right edge of tooltip with right edge of badge
      const tipWidth = tip.offsetWidth;
      let left = rect.right - tipWidth;
      if (left < 8) left = 8;
      tip.style.left = left + 'px';
    });

    badge.addEventListener('mouseleave', (e) => {
      const tip = getTooltip();
      // Don't hide if mouse is moving into the tooltip itself
      if (tip.contains(e.relatedTarget)) return;
      hideTooltip();
    });

    headerRow.insertBefore(badge, headerRow.lastElementChild);
  }

  renderBookmarkTimelineBadges();
  renderBookmarkCounts();
  if (leaderboardEnabled) renderLeaderboard();
}

function renderBookmarkTimelineBadges() {
  if (!bookmarkTimelineInsertedTweetIds.size) return;
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  for (const article of articles) {
    if (article.querySelector('.xvm-bookmark-timeline-badge')) continue;
    const tweetId = getTweetIdFromArticle(article);
    if (!tweetId || !bookmarkTimelineInsertedTweetIds.has(tweetId)) continue;
    const caretBtn = article.querySelector('[data-testid="caret"]');
    if (!caretBtn?.parentElement) continue;
    const badge = document.createElement('span');
    badge.className = 'xvm-bookmark-timeline-badge';
    badge.textContent = '书签';
    badge.title = '插入的书签推文';
    caretBtn.parentElement.insertBefore(badge, caretBtn);
  }
}

// Inject a bookmark count next to each tweet's bookmark button. X hides
// this number from the timeline action bar (only exposed via the group's
// aria-label and the analytics page), so we clone the counter wrapper
// from a sibling action button to inherit Twitter's current typography
// classes exactly, then rewrite the leaf text.
function renderBookmarkCounts() {
  if (!showBookmarkCount) return;

  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  for (const article of articles) {
    const tweetId = getTweetIdFromArticle(article);
    if (!tweetId) continue;
    const data = tweetDataStore.get(tweetId);
    if (!data) continue;

    const bookmarkBtn = article.querySelector(
      'button[data-testid="bookmark"], button[data-testid="removeBookmark"]'
    );
    if (!bookmarkBtn) continue;

    // On the status detail page X renders its own bookmark counter — skip
    // injection there, otherwise the number shows up twice.
    const nativeCounter = bookmarkBtn.querySelector('.r-1udh08x:not(.xvm-bookmark-count)');
    if (nativeCounter) {
      const ours = bookmarkBtn.querySelector('.xvm-bookmark-count');
      if (ours) ours.remove();
      continue;
    }

    const count = Math.max(0, data.bookmarks | 0);
    const formatted = count > 0 ? formatViews(count) : '';

    const existing = bookmarkBtn.querySelector(':scope .xvm-bookmark-count');
    if (existing) {
      if (existing.dataset.value !== String(count)) {
        existing.dataset.value = String(count);
        const leaf = existing.querySelector('.xvm-bookmark-count-text');
        if (leaf) leaf.textContent = formatted;
      }
      continue;
    }

    const group = bookmarkBtn.closest('[role="group"]');
    if (!group) continue;
    let template = null;
    for (const sib of group.querySelectorAll(
      'button[data-testid="reply"], button[data-testid="like"], button[data-testid="unlike"], a[href$="/analytics"]'
    )) {
      const c = sib.querySelector('.r-1udh08x');
      if (c) { template = c; break; }
    }
    if (!template) continue;

    const cloned = template.cloneNode(true);
    cloned.classList.add('xvm-bookmark-count');
    cloned.dataset.value = String(count);
    cloned.querySelectorAll('[data-testid]').forEach((n) => n.removeAttribute('data-testid'));

    const leaves = Array.from(cloned.querySelectorAll('span')).filter((s) => s.children.length === 0);
    const leaf = leaves[leaves.length - 1];
    if (leaf) {
      leaf.textContent = formatted;
      leaf.classList.add('xvm-bookmark-count-text');
    } else {
      cloned.textContent = formatted;
      cloned.classList.add('xvm-bookmark-count-text');
    }

    const inner = bookmarkBtn.querySelector(':scope > div');
    (inner || bookmarkBtn).appendChild(cloned);
  }
}

// Optimistic bump on the user's own bookmark/unbookmark click — X swaps
// the testid between "bookmark" and "removeBookmark" instantly but the
// new total only arrives on the next API refresh. We bump the store and
// re-render so the displayed number tracks the user's intent.
document.addEventListener('click', (e) => {
  if (!showBookmarkCount) return;
  const btn = e.target.closest?.('button[data-testid="bookmark"], button[data-testid="removeBookmark"]');
  if (!btn) return;
  const article = btn.closest('article[data-testid="tweet"]');
  if (!article) return;
  const tweetId = getTweetIdFromArticle(article);
  if (!tweetId) return;
  const data = tweetDataStore.get(tweetId);
  if (!data) return;
  const delta = btn.getAttribute('data-testid') === 'removeBookmark' ? -1 : 1;
  data.bookmarks = Math.max(0, (data.bookmarks | 0) + delta);
  setTimeout(() => renderBookmarkCounts(), 0);
}, true);

// === Velocity Leaderboard ===
let leaderboardEl = null;
let leaderboardSettingsEl = null;
let leaderboardRaf = 0;
const leaderboardItemMeta = new Map();
let pendingLeaderboardJump = null;
const LB_DEFAULT_WIDTH = 280;
const LB_MIN_WIDTH = 240;
const LB_MAX_WIDTH = 640;
const LB_DEFAULT_HEIGHT = 300;
const LB_MIN_HEIGHT = 120;
const LB_MAX_HEIGHT = 800;
let leaderboardWidth = LB_DEFAULT_WIDTH;
let leaderboardHeight = LB_DEFAULT_HEIGHT;

function ensureLeaderboard() {
  if (leaderboardEl) return leaderboardEl;
  leaderboardEl = document.createElement('div');
  leaderboardEl.className = 'xvm-lb';
  leaderboardEl.innerHTML = `
    <div class="xvm-lb-head" title="${i18n('contentLeaderboardDragToMove')}">
      <span class="xvm-lb-grip">⋮⋮</span>
      <button class="xvm-lb-edge-toggle" type="button" title="${i18nOr('contentLeaderboardEdgeHide', '贴边隐藏')}" aria-label="${i18nOr('contentLeaderboardEdgeHide', '贴边隐藏')}">›</button>
      <span class="xvm-lb-title">🔥 ${i18n('contentLeaderboardTitle')}</span>
      <button class="xvm-lb-back" type="button" title="${i18n('contentLeaderboardBackToPrevious')}" aria-label="${i18n('contentLeaderboardBackToPrevious')}" hidden>
        <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 16 L12.5 16 Q16 16 16 12.5 L16 8.5 Q16 5 12.5 5 L5 5"></path>
          <path d="M8 2 L5 5 L8 8"></path>
        </svg>
      </button>
    </div>
    <div class="xvm-lb-hot-notice" hidden></div>
    <div class="xvm-lb-sortbar">
      <div class="xvm-lb-sort-modes" role="group" aria-label="排序">
        <button type="button" data-sort="velocity" title="按流速从高到低">流速</button>
        <button type="button" data-sort="newest" title="按发布时间从近到久">最新</button>
        <button type="button" data-sort="replies" title="按评论数从少到多">评论少</button>
      </div>
      <label class="xvm-lb-limit" title="只看这么多小时内发布的帖子，留空不限">≤<input class="xvm-lb-max-age" type="number" min="0" step="0.5" placeholder="不限">小时</label>
      <label class="xvm-lb-limit" title="只看评论数不超过这个数的帖子，留空不限">≤<input class="xvm-lb-max-replies" type="number" min="0" step="1" placeholder="不限">评论</label>
    </div>
    <ul class="xvm-lb-list"></ul>
    <div class="xvm-lb-resize" aria-hidden="true"></div>
    <div class="xvm-lb-resize-v" aria-hidden="true"></div>
  `;
  const controls = document.createElement('div');
  controls.className = 'xvm-lb-controls';
  controls.insertAdjacentHTML('beforeend', `
    <button class="xvm-lb-action xvm-lb-settings" type="button" title="${i18nOr('contentLeaderboardSettings', '设置')}" aria-label="${i18nOr('contentLeaderboardSettings', '设置')}">
      <svg class="lucide lucide-settings-icon lucide-settings" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
    </button>
    <button class="xvm-lb-action xvm-lb-close" type="button" title="${i18nOr('contentLeaderboardClose', '关闭热度榜')}" aria-label="${i18nOr('contentLeaderboardClose', '关闭热度榜')}">
      <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M5 5l10 10M15 5L5 15"></path>
      </svg>
    </button>
  `);
  leaderboardEl.querySelector('.xvm-lb-head').appendChild(controls);
  installLeaderboardSortBar(leaderboardEl);

  document.body.appendChild(leaderboardEl);
  applyLeaderboardWidth();
  applyLeaderboardHeight();
  applyLeaderboardPosition();
  applyLeaderboardTheme();
  installLeaderboardDrag();
  installLeaderboardResize();
  installLeaderboardResizeHeight();
  installLeaderboardEdgeToggle();
  installLeaderboardPanelActions();
  updateLeaderboardEdgeHideUi();
  installLeaderboardBackButton();
  // v1.7.0 #2 — sync leaderboard theme + tier with popup.
  installLeaderboardThemeSync();
  installLeaderboardTierSync();
  installLeaderboardFilterStateSync();
  return leaderboardEl;
}

// ── Leaderboard theme sync (v1.7.0 #2) ─────────────────────────────────────
// Mirrors chrome.storage.sync.theme into the leaderboard root via
// data-theme="light|dark". Resolves 'system' against
// `prefers-color-scheme`. Updates on storage change + OS color-scheme
// change. data-theme on .xvm-lb drives the dark overrides in styles.css.
function applyLeaderboardTheme(resolved) {
  const r = resolved || _resolvedTheme(_themePref);
  if (leaderboardEl) leaderboardEl.setAttribute('data-theme', r);
  if (leaderboardSettingsEl) leaderboardSettingsEl.setAttribute('data-theme', r);
  applyReleaseNotesTheme(r);
}
let _themePref = 'system';
let _themeSyncInstalled = false;
function _resolvedTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (_) { return 'light'; }
}
function applyReleaseNotesTheme(resolved) {
  const r = resolved || _resolvedTheme(_themePref);
  document.querySelectorAll('.xvm-update-backdrop').forEach((el) => el.setAttribute('data-theme', r));
}
function installLeaderboardThemeSync() {
  if (_themeSyncInstalled) return;
  _themeSyncInstalled = true;
  // Bootstrap: ask the page for the chrome.storage.sync.theme value via
  // the ISOLATED-world bridge.js. content.js is in MAIN world, so we
  // postMessage XVM_THEME_REQUEST and listen for XVM_THEME_UPDATE.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    if (ev.data?.type === 'XVM_THEME_UPDATE' && typeof ev.data.pref === 'string') {
      _themePref = ev.data.pref;
      applyLeaderboardTheme();
    }
  });
  window.postMessage({ type: 'XVM_THEME_REQUEST' }, '*');
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (_themePref === 'system') applyLeaderboardTheme();
    });
  } catch (_) {}
}

// ── Leaderboard tier sync (v1.7.0 #4 — hot-only toggle behavior) ──────────
function installLeaderboardTierSync() {
  function refreshTier() {
    leaderboardTier = window.__xvmPro?.getCurrentTier?.() || 'free';
    const hot = getLeaderboardHotToggle();
    if (hot) {
      hot.dataset.tier = leaderboardTier;
      setLeaderboardHotSwitchState();
    }
  }
  refreshTier();
  window.__xvmPro?.onTierChange?.(() => refreshTier());
}

// ── Filter-state sync ──────────────────────────────────────────────────────
// The hot-only switch is global. Scope flags (home / list / profile /
// status) are configured separately and decide where the global switch has
// an effect. The floating panel still marks the current scope so users can
// tell whether this page is covered.
const RESERVED_PROFILE_PATHS = new Set([
  'compose', 'explore', 'home', 'i', 'jobs', 'messages', 'notifications',
  'search', 'settings',
]);
function scopeFromPath(pathname = window.location.pathname) {
  const path = String(pathname || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/home') return 'home';
  if (/^\/i\/lists\/[^/]+/.test(path) || /^\/[^/]+\/lists\/[^/]+/.test(path)) return 'list';
  if (/^\/[^/]+\/status\/\d+/.test(path)) return 'status';
  const m = path.match(/^\/([^/]+)$/);
  if (m && !RESERVED_PROFILE_PATHS.has(m[1])) return 'profile';
  return null;
}
const SCOPE_KEY_FOR = { home: 'scopeHome', list: 'scopeList', profile: 'scopeProfile', status: 'scopeStatus' };
const LEADERBOARD_HOT_SCOPE_ITEMS = [
  { scope: 'home', key: 'scopeHome', labelKey: 'contentLbHotScopeHome', fallback: '首页 / 推荐流' },
  { scope: 'list', key: 'scopeList', labelKey: 'contentLbHotScopeList', fallback: '列表' },
  { scope: 'profile', key: 'scopeProfile', labelKey: 'contentLbHotScopeProfile', fallback: '个人主页' },
  { scope: 'status', key: 'scopeStatus', labelKey: 'contentLbHotScopeStatus', fallback: '推文详情页' },
];
let _rateFilterScopes = { scopeHome: false, scopeList: false, scopeProfile: false, scopeStatus: false };
let _rateFilterEnabled = false;
let leaderboardTier = 'free';
// Three signals feed into the leaderboard's current scope:
//   1. _activeScope: pushed by rate-filter on each GraphQL response
//      (authoritative for the first visit to a tab, but stale on
//      cached re-visits where X doesn't re-fetch).
//   2. _tabSelectedScope: derived from the currently aria-selected
//      [role=tab] in the DOM. This is set on tab clicks and via
//      MutationObserver, so it survives cached re-visits.
//   3. scopeFromPath(): URL fallback for cold start before either
//      signal lands.
// Priority: tab-selected > active-from-graphql > URL. The tab-selected
// signal wins because the user just told us which tab they want; the
// GraphQL signal can lag or be entirely missing on cached navigations.
let _activeScope = null;
let _tabSelectedScope = null;
let _rateFilterSettingsSeen = false;
const HOME_SUB_TAB_LABELS = new Set([
  'For you', 'Following', 'Subscribed',
  '为你推荐', '正在关注', '订阅',
  'おすすめ', 'フォロー中', '購読中',
]);
// /home is the only page where a tablist drives scope choice today
// (For you / Following / Subscribed / pinned-list tabs all share the
// same URL). On other pages — list detail, profile, tweet detail —
// the URL is authoritative. Keep the function name and early return
// matched so future readers don't generalize this for other tablists
// (list detail page also has Tweets / Replies / Media tabs that have
// nothing to do with rate-filter scope).
function detectHomeSubTabScope() {
  if (window.location.pathname !== '/home') return null;
  const tab = document.querySelector('[role="tablist"] [role="tab"][aria-selected="true"]');
  if (!tab) return null;
  const txt = (tab.textContent || '').trim();
  if (!txt) return null;
  if (HOME_SUB_TAB_LABELS.has(txt)) return 'home';
  // Anything else under the home tablist is a pinned list tab.
  return 'list';
}
function syncTabSelectedScope() {
  const next = detectHomeSubTabScope();
  if (next !== _tabSelectedScope) {
    _tabSelectedScope = next;
    setLeaderboardHotSwitchState();
  }
  ensureBookmarkTimelineCog();
}
function currentLeaderboardScope() {
  return _tabSelectedScope || _activeScope || scopeFromPath();
}
function currentScopeSelected() {
  const scope = currentLeaderboardScope();
  if (!scope) return false;
  return !!_rateFilterScopes[SCOPE_KEY_FOR[scope]];
}
function currentScopeEnabled() {
  return _rateFilterEnabled === true && currentScopeSelected();
}
function updateLeaderboardHotScopeControls() {
  const grid = leaderboardSettingsEl?.querySelector?.('.xvm-lb-hot-scope-grid');
  if (!grid) return;
  const current = currentLeaderboardScope();
  const isFree = (leaderboardTier || 'free') === 'free';
  for (const item of LEADERBOARD_HOT_SCOPE_ITEMS) {
    const label = grid.querySelector(`[data-hot-scope="${item.scope}"]`);
    const input = label?.querySelector?.('input[type="checkbox"]');
    const currentBadge = label?.querySelector?.('[data-role="scope-current"]');
    if (!label || !input) continue;
    const isCurrent = item.scope === current;
    input.checked = _rateFilterScopes[item.key] === true;
    input.disabled = isFree;
    label.classList.toggle('xvm-lb-hot-scope-current', isCurrent);
    if (currentBadge) currentBadge.hidden = !isCurrent;
  }
}
function getLeaderboardHotToggle() {
  return leaderboardSettingsEl?.querySelector?.('.xvm-lb-hot') || leaderboardEl?.querySelector?.('.xvm-lb-hot');
}
function setLeaderboardHotSwitchState() {
  const hot = getLeaderboardHotToggle();
  if (!hot) {
    updateLeaderboardHotNotice(false);
    return;
  }
  const tier = leaderboardTier || hot.dataset.tier || 'free';
  const scope = currentLeaderboardScope();
  const on = tier !== 'free' && _rateFilterEnabled === true;
  hot.dataset.tier = tier;
  hot.dataset.on = on ? '1' : '0';
  hot.dataset.scope = scope || '';
  hot.setAttribute('aria-disabled', tier === 'free' ? 'true' : 'false');
  hot.title = tier === 'free'
    ? (i18n('contentLbHotProTitle') || '流速过滤是 Pro 功能')
    : '';
  const cb = hot.querySelector('input[type="checkbox"]');
  if (cb) {
    if (cb.checked !== on) cb.checked = on;
    cb.disabled = tier === 'free';
  }
  updateLeaderboardHotNotice(currentScopeEnabled());
  updateLeaderboardHotScopeControls();
}

function updateLeaderboardHotNotice(on = false) {
  const notice = leaderboardEl?.querySelector?.('.xvm-lb-hot-notice');
  if (!notice) return;
  notice.hidden = !on;
  if (on) {
    notice.textContent = i18nOr(
      'contentLbHotActiveNotice',
      '仅看热帖已开启，低于标准的帖子已隐藏'
    );
  }
}
// Track X's tablist aria-selected so the leaderboard hot toggle reflects
// the user's actual selected tab — not the URL (which is /home for
// pinned-list tabs too) and not the most recent GraphQL response (which
// may not fire when X serves a cached tab from memory).
let _tabMo = null;
let _tabObserved = null;
let _bodyMo = null;
let _bookmarkTimelineCogTimer = null;
function disconnectTabMo() {
  if (_tabMo) { try { _tabMo.disconnect(); } catch (_) {} _tabMo = null; }
  _tabObserved = null;
}
function attachTabObserver() {
  const tl = document.querySelector('[role="tablist"]');
  if (!tl) return false;
  if (tl === _tabObserved) {
    ensureBookmarkTimelineCog();
    return true;
  }
  // Tablist re-mounted (SPA navigation) — drop the orphaned observer on
  // the detached node so we don't leak one per navigation.
  disconnectTabMo();
  _tabObserved = tl;
  _tabMo = new MutationObserver(syncTabSelectedScope);
  _tabMo.observe(tl, { attributes: true, childList: true, subtree: true, attributeFilter: ['aria-selected'] });
  syncTabSelectedScope();
  ensureBookmarkTimelineCog();
  return true;
}

function ensureBookmarkTimelineCog() {
  document.querySelectorAll('.xvm-bti-cog').forEach((btn) => {
    if (window.location.pathname !== '/home' || !btn.closest('[role="tablist"]')) btn.remove();
  });
  if (window.location.pathname !== '/home') return;
  const tl = document.querySelector('[role="tablist"]');
  const firstTab = tl?.querySelector?.('[role="tab"]');
  if (!tl || !firstTab) return;
  const firstTabItem = firstTab.closest('[role="presentation"]') || firstTab;
  let btn = tl.querySelector('.xvm-bti-cog');
  if (btn) {
    if (btn.previousElementSibling !== firstTabItem) {
      firstTabItem.after(btn);
      debugBookmarkTimeline('move cog after first tab', { firstTabText: (firstTab.textContent || '').trim() });
    }
    return;
  }
  btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'xvm-bti-cog';
  btn.title = '书签穿插设置';
  btn.setAttribute('aria-label', '书签穿插设置');
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"></path>
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .58V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-.5 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.58-1H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 .5-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.58V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 .5 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.32.39.65.58 1H20a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-.5 1Z"></path>
    </svg>`;
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showBookmarkTimelineSettings();
  });
  firstTabItem.after(btn);
  debugBookmarkTimeline('insert cog after first tab', { firstTabText: (firstTab.textContent || '').trim() });
}

function saveBookmarkTimelineSettings() {
  window.postMessage({
    type: 'XVM_BOOKMARK_TIMELINE_INJECT_SAVE',
    enabled: bookmarkTimelineInjectEnabled,
    folderIds: bookmarkTimelineInjectFolderIds,
    every: bookmarkTimelineInjectEvery,
  }, '*');
}

function selectedBookmarkTimelineFoldersFromDialog() {
  return Array.from(bookmarkTimelineDialog?.querySelectorAll('.xvm-bti-folder input:checked') || [])
    .map((input) => input.value)
    .filter(Boolean);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function renderBookmarkTimelineSettings() {
  if (!bookmarkTimelineDialog) return;
  const enabled = bookmarkTimelineDialog.querySelector('.xvm-bti-enabled');
  const every = bookmarkTimelineDialog.querySelector('.xvm-bti-every');
  const list = bookmarkTimelineDialog.querySelector('.xvm-bti-folders');
  const count = bookmarkTimelineDialog.querySelector('.xvm-bti-count');
  if (enabled) enabled.checked = bookmarkTimelineInjectEnabled;
  if (every) every.value = String(bookmarkTimelineInjectEvery);
  const selected = new Set(bookmarkTimelineInjectFolderIds.map(String));
  if (count) {
    const selectedCount = bookmarkTimelineInjectFolderIds.length;
    const cachedCount = bookmarkTimelineInjectFolderIds.reduce(
      (sum, id) => sum + (bookmarkTimelineEntryCache.get(String(id))?.length || 0),
      0,
    );
    const loading = bookmarkTimelineInjectFolderIds.some((id) => bookmarkTimelineFolderStatus.get(String(id)) === 'loading');
    const parts = [];
    if (!selectedCount) {
      parts.push('未选择文件夹');
    } else {
      parts.push(`已选 ${selectedCount} 个文件夹`);
      parts.push(loading ? '缓存中…' : `已缓存 ${cachedCount} 条`);
      const updated = bookmarkTimelineInjectFolderIds.reduce(
        (max, id) => Math.max(max, bookmarkTimelineFolderRefreshedAt.get(String(id)) || 0),
        0,
      );
      if (!loading && updated) parts.push(`${formatBookmarkTimelineAgo(updated)}更新`);
    }
    count.textContent = parts.join(' · ');
  }
  if (!list) return;
  if (!bookmarkTimelineFolders.length) {
    list.innerHTML = '<div class="xvm-bti-empty">还没有文件夹列表，点刷新或先开启书签文件夹功能。</div>';
    return;
  }
  list.innerHTML = bookmarkTimelineFolders.map((folder) => {
    const id = String(folder.id || '');
    const name = String(folder.name || id || '未命名文件夹');
    const isSelected = selected.has(id);
    const cached = bookmarkTimelineEntryCache.get(id)?.length || 0;
    const status = bookmarkTimelineFolderStatus.get(id);
    let badgeClass = 'xvm-bti-folder-count';
    let badgeText = '';
    if (status === 'loading') {
      badgeClass += ' is-loading';
      badgeText = '缓存中…';
    } else if (status === 'error') {
      badgeClass += ' is-error';
      badgeText = '刷新失败';
    } else if (cached) {
      badgeText = cached >= BOOKMARK_TIMELINE_FETCH_CAP ? `${BOOKMARK_TIMELINE_FETCH_CAP}+ 条` : `${cached} 条`;
    } else if (isSelected && bookmarkTimelineInjectEnabled) {
      badgeClass += ' is-empty';
      badgeText = '待缓存';
    }
    const badge = badgeText ? `<span class="${badgeClass}">${badgeText}</span>` : '';
    return `
      <label class="xvm-bti-folder">
        <input type="checkbox" value="${escapeHtml(id)}" ${isSelected ? 'checked' : ''}>
        <span class="xvm-bti-folder-name">${escapeHtml(name)}</span>
        ${badge}
      </label>`;
  }).join('');
}

function formatBookmarkTimelineAgo(ts) {
  const diff = Date.now() - (Number(ts) || 0);
  if (diff < 60 * 1000) return '刚刚';
  const mins = Math.floor(diff / (60 * 1000));
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function showBookmarkTimelineSettings() {
  if (bookmarkTimelineDialog?.isConnected) {
    renderBookmarkTimelineSettings();
    return;
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'xvm-bti-backdrop';
  backdrop.innerHTML = `
    <div class="xvm-bti-dialog" role="dialog" aria-modal="true" aria-label="书签穿插设置">
      <button class="xvm-bti-close" type="button" aria-label="关闭">×</button>
      <h2>书签穿插</h2>
      <p class="xvm-bti-sub">把选中文件夹里的书签帖穿插到首页时间线里。</p>
      <label class="xvm-bti-row">
        <span><b>启用</b><small>首页时间线响应返回时插入缓存书签</small></span>
        <input class="xvm-bti-enabled" type="checkbox">
      </label>
      <label class="xvm-bti-row">
        <span><b>插入频率</b><small>每浏览多少条时间线推文插入 1 条</small></span>
        <input class="xvm-bti-every" type="number" min="5" max="100" step="1" inputmode="numeric">
      </label>
      <div class="xvm-bti-section-title">书签文件夹</div>
      <div class="xvm-bti-folders"></div>
      <div class="xvm-bti-footer">
        <span class="xvm-bti-count"></span>
        <button class="xvm-bti-refresh" type="button">刷新</button>
      </div>
    </div>`;
  bookmarkTimelineDialog = backdrop;
  document.body.appendChild(backdrop);
  renderBookmarkTimelineSettings();
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop || ev.target.closest('.xvm-bti-close')) {
      backdrop.remove();
      bookmarkTimelineDialog = null;
    }
  });
  backdrop.querySelector('.xvm-bti-enabled')?.addEventListener('change', (ev) => {
    bookmarkTimelineInjectEnabled = ev.target.checked;
    saveBookmarkTimelineSettings();
    renderBookmarkTimelineSettings();
  });
  backdrop.querySelector('.xvm-bti-every')?.addEventListener('change', (ev) => {
    bookmarkTimelineInjectEvery = Math.max(5, Math.min(100, Number.parseInt(ev.target.value, 10) || 20));
    saveBookmarkTimelineSettings();
    renderBookmarkTimelineSettings();
  });
  backdrop.querySelector('.xvm-bti-folders')?.addEventListener('change', (ev) => {
    if (!ev.target?.matches?.('input[type="checkbox"]')) return;
    bookmarkTimelineInjectFolderIds = selectedBookmarkTimelineFoldersFromDialog();
    saveBookmarkTimelineSettings();
    renderBookmarkTimelineSettings();
  });
  backdrop.querySelector('.xvm-bti-refresh')?.addEventListener('click', () => {
    window.postMessage({ type: 'XVM_REQUEST_FOLDER_REFRESH' }, '*');
    window.postMessage({ type: 'XVM_BOOKMARK_TIMELINE_REFRESH', folderIds: bookmarkTimelineInjectFolderIds }, '*');
    window.postMessage({ type: 'XVM_REQUEST_SETTINGS' }, '*');
    showToast(bookmarkTimelineInjectFolderIds.length ? '正在刷新书签内容' : '请先勾选书签文件夹');
  });
}
function armBodyTablistWatch() {
  // Cheap one-shot: watch body until the tablist appears, then disconnect
  // so we're not paying for every X mutation on the busy timeline.
  if (_bodyMo) return;
  if (!document.body) return;
  _bodyMo = new MutationObserver(() => {
    if (attachTabObserver()) {
      try { _bodyMo.disconnect(); } catch (_) {}
      _bodyMo = null;
    }
  });
  _bodyMo.observe(document.body, { childList: true, subtree: true });
}
function installTabSelectedObserver() {
  // Click delegation: when the user clicks any role=tab, re-detect after
  // X swaps aria-selected. The setTimeout lets X's handler run first.
  document.addEventListener('click', (ev) => {
    const tab = ev.target?.closest?.('[role="tab"]');
    if (!tab) return;
    setTimeout(syncTabSelectedScope, 50);
    setTimeout(syncTabSelectedScope, 250);
  }, true);
  if (!attachTabObserver()) armBodyTablistWatch();
  if (!_bookmarkTimelineCogTimer) {
    _bookmarkTimelineCogTimer = setInterval(() => {
      if (window.location.pathname === '/home') ensureBookmarkTimelineCog();
    }, 1000);
  }
}

function installLeaderboardFilterStateSync() {
  installTabSelectedObserver();
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    if (ev.data?.type === 'XVM_RATE_SETTINGS_UPDATE' && ev.data.settings) {
      const s = ev.data.settings;
      const wasSeen = _rateFilterSettingsSeen;
      const wasEnabled = currentScopeEnabled();
      _rateFilterEnabled = s.enabled === true;
      _rateFilterScopes = {
        scopeHome: s.scopeHome === true,
        scopeList: s.scopeList === true,
        scopeProfile: s.scopeProfile === true,
        scopeStatus: s.scopeStatus === true,
      };
      _rateFilterSettingsSeen = true;
      setLeaderboardHotSwitchState();
      updateLeaderboardHotScopeControls();
      if (wasSeen && !wasEnabled && currentScopeEnabled()) {
        showToast(i18nOr(
          'contentLbHotEnabledToast',
          '仅看热帖已开启：未达到热帖标准的帖子会从页面移除并不显示。'
        ), { type: 'success', position: 'top', duration: 3600 });
      }
      if (leaderboardEnabled) setTimeout(renderLeaderboard, 80);
    }
    if (ev.data?.type === 'XVM_RATE_FILTER_ACTIVE_SCOPE' && typeof ev.data.scope === 'string') {
      if (_activeScope !== ev.data.scope) {
        _activeScope = ev.data.scope;
        setLeaderboardHotSwitchState();
      }
    }
  });
  // Track SPA navigation: X uses pushState/popstate. When the path changes
  // the current scope changes too, so refresh the toggle.
  let lastPath = window.location.pathname;
  const checkPath = () => {
    if (window.location.pathname === lastPath) return;
    lastPath = window.location.pathname;
    // Drop the previously observed signals — until the new page's first
    // response and tab-selected mutation land, fall back to URL-based
    // inference. Otherwise an in-flight toggle could write to the
    // previous page's scope key.
    _activeScope = null;
    _tabSelectedScope = null;
    // Drop the previous page's tablist observer; the new page may mount
    // a different one (or none at all).
    disconnectTabMo();
    setLeaderboardHotSwitchState();
    // The new page may have its own tablist; try immediately, then arm
    // a body-watcher in case it mounts a moment later.
    if (!attachTabObserver()) armBodyTablistWatch();
    setTimeout(syncTabSelectedScope, 100);
    setTimeout(syncTabSelectedScope, 500);
  };
  window.addEventListener('popstate', checkPath);
  // Hook pushState/replaceState since SPAs don't emit popstate for them.
  // Guard against double-wrapping on extension hot-reload (content.js
  // re-runs in the same tab but history.* is still wrapped from before).
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    if (typeof orig !== 'function' || orig.__xvmWrapped) continue;
    const wrapped = function () {
      const r = orig.apply(this, arguments);
      setTimeout(checkPath, 0);
      return r;
    };
    wrapped.__xvmWrapped = true;
    history[m] = wrapped;
  }
  window.postMessage({ type: 'XVM_RATE_FILTER_REQUEST' }, '*');
}

function onHotGateClick(ev) {
  const hot = getLeaderboardHotToggle();
  if (!hot) return;
  const tier = leaderboardTier || hot.dataset.tier || 'free';
  if (tier === 'free') {
    ev.preventDefault();
    showLeaderboardUpgradeBubble();
    return;
  }
}

function onHotToggleClick(ev) {
  const hot = getLeaderboardHotToggle();
  if (!hot) return;
  const tier = leaderboardTier || hot.dataset.tier || 'free';
  if (tier === 'free') {
    ev.preventDefault();
    showLeaderboardUpgradeBubble();
    return;
  }
  const wasSeen = _rateFilterSettingsSeen;
  const wasEnabled = currentScopeEnabled();
  _rateFilterEnabled = ev.target.checked === true;
  _rateFilterSettingsSeen = true;
  setLeaderboardHotSwitchState();
  if (wasSeen && !wasEnabled && currentScopeEnabled()) {
    showToast(i18nOr(
      'contentLbHotEnabledToast',
      '仅看热帖已开启：未达到热帖标准的帖子会从页面移除并不显示。'
    ), { type: 'success', position: 'top', duration: 3600 });
  }
  if (leaderboardEnabled) setTimeout(renderLeaderboard, 80);
  // Storage round-trip via isolated.js → XVM_RATE_SETTINGS_UPDATE will sync
  // data-on back. We only emit; the round-trip is the source of truth.
  window.postMessage({
    type: 'XVM_RATE_FILTER_SET_ENABLED',
    enabled: _rateFilterEnabled,
  }, '*');
}

function onHotScopeToggleChange(ev) {
  const input = ev.target?.closest?.('.xvm-lb-hot-scope input[type="checkbox"]');
  if (!input) return;
  const scope = input.dataset.scope;
  const key = SCOPE_KEY_FOR[scope];
  if (!key) return;
  const tier = leaderboardTier || 'free';
  if (tier === 'free') {
    input.checked = _rateFilterScopes[key] === true;
    showLeaderboardUpgradeBubble();
    return;
  }
  const wasSeen = _rateFilterSettingsSeen;
  const wasEnabled = currentScopeEnabled();
  _rateFilterScopes = { ..._rateFilterScopes, [key]: input.checked === true };
  _rateFilterSettingsSeen = true;
  setLeaderboardHotSwitchState();
  updateLeaderboardHotScopeControls();
  if (wasSeen && !wasEnabled && currentScopeEnabled()) {
    showToast(i18nOr(
      'contentLbHotEnabledToast',
      '仅看热帖已开启：未达到热帖标准的帖子会从页面移除并不显示。'
    ), { type: 'success', position: 'top', duration: 3600 });
  }
  if (leaderboardEnabled) setTimeout(renderLeaderboard, 80);
  window.postMessage({
    type: 'XVM_RATE_FILTER_SET_SCOPE',
    scope,
    enabled: input.checked === true,
  }, '*');
}

function showLeaderboardUpgradeBubble() {
  if (!leaderboardEl) return;
  if (leaderboardEl.querySelector('.xvm-lb-upgrade')) return; // already open
  const bubble = document.createElement('div');
  bubble.className = 'xvm-lb-upgrade';
  bubble.innerHTML = `
    <button class="xvm-lb-upgrade-close" type="button" aria-label="Close">×</button>
    <div class="xvm-lb-upgrade-title">✨ <span></span></div>
    <div class="xvm-lb-upgrade-sub"></div>
    <div class="xvm-lb-upgrade-actions">
      <a class="xvm-lb-upgrade-link" target="_blank" rel="noopener"></a>
      <a class="xvm-lb-upgrade-btn"  target="_blank" rel="noopener"></a>
    </div>
  `;
  bubble.querySelector('.xvm-lb-upgrade-title span').textContent = i18n('contentLbHotProTitle') || '流速过滤是 Pro 功能';
  bubble.querySelector('.xvm-lb-upgrade-sub').textContent = i18n('contentLbHotProSub') || '隐藏低浏览量推文,保留真正在传播的内容';
  const link = bubble.querySelector('.xvm-lb-upgrade-link');
  link.textContent = i18n('contentLbHotDetails') || '查看 Pro 范围';
  link.href = PRODUCT_SITE_PRO_URL;
  const btn = bubble.querySelector('.xvm-lb-upgrade-btn');
  btn.textContent = i18n('contentLbHotOpenSite') || '去官网开通';
  btn.href = PRODUCT_SITE_PRO_URL;
  bubble.querySelector('.xvm-lb-upgrade-close').addEventListener('click', () => bubble.remove());
  const head = leaderboardEl.querySelector('.xvm-lb-head');
  head.insertAdjacentElement('afterend', bubble);
}

// === Back-to-previous-scroll ===
let savedScrollY = null;
function setBackButtonVisible(visible) {
  if (!leaderboardEl) return;
  const btn = leaderboardEl.querySelector('.xvm-lb-back');
  if (!btn) return;
  if (visible) btn.removeAttribute('hidden');
  else btn.setAttribute('hidden', '');
}
function installLeaderboardBackButton() {
  const btn = leaderboardEl.querySelector('.xvm-lb-back');
  if (!btn) return;
  // Prevent the drag handler from kicking in when pressing the button
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (savedScrollY === null) return;
    const target = savedScrollY;
    clearLink();
    window.scrollTo({ top: target, behavior: 'smooth' });
    savedScrollY = null;
    setBackButtonVisible(false);
  });
}

// === Leaderboard drag + persisted position ===
const LB_POS_KEY = 'xvmLeaderboardPos';
const LB_EDGE_PEEK = 34;
const LB_EDGE_SNAP = 32;
let leaderboardPos = null; // {left, top} in px from top-left of viewport
let leaderboardHiddenEdge = null;
let leaderboardExpandedPos = null;
let leaderboardTempExpandedEdge = null;
let leaderboardTempExpandedByHover = false;
let suppressLeaderboardEdgeExpandClick = false;

function isLeaderboardEdge(value) {
  return ['left', 'right', 'top', 'bottom'].includes(value);
}

function savedLeaderboardPosition() {
  const expanded = leaderboardExpandedPos || leaderboardPos;
  return {
    ...(expanded || {}),
    hiddenEdge: leaderboardHiddenEdge || null,
    expandedPos: expanded || null,
  };
}

function saveLeaderboardPosition() {
  const pos = savedLeaderboardPosition();
  if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
    window.postMessage({ type: 'XVM_LB_POS_SAVE', pos }, '*');
  }
}

function syncLeaderboardHiddenDom() {
  if (!leaderboardEl) return;
  if (leaderboardHiddenEdge) {
    leaderboardEl.classList.add('xvm-lb-edge-hidden');
    leaderboardEl.dataset.edge = leaderboardHiddenEdge;
  } else {
    leaderboardEl.classList.remove('xvm-lb-edge-hidden');
    delete leaderboardEl.dataset.edge;
  }
  setLeaderboardEdgeToggleState();
}

function restoreLeaderboardPosition(pos) {
  if (!pos || typeof pos !== 'object') return;
  const expanded = pos.expandedPos && typeof pos.expandedPos === 'object'
    ? pos.expandedPos
    : pos;
  if (Number.isFinite(expanded.left) && Number.isFinite(expanded.top)) {
    leaderboardPos = { left: expanded.left, top: expanded.top };
    leaderboardExpandedPos = { ...leaderboardPos };
  }
  if (leaderboardEdgeHideEnabled && isLeaderboardEdge(pos.hiddenEdge)) {
    leaderboardHiddenEdge = pos.hiddenEdge;
    if (leaderboardEl) {
      positionHiddenLeaderboard(leaderboardHiddenEdge);
      syncLeaderboardHiddenDom();
    }
  } else {
    leaderboardHiddenEdge = null;
    syncLeaderboardHiddenDom();
    applyLeaderboardPosition();
  }
}

function setLeaderboardEdgeToggleState() {
  const btn = leaderboardEl?.querySelector?.('.xvm-lb-edge-toggle');
  if (!btn) return;
  const label = leaderboardHiddenEdge
    ? i18nOr('contentLeaderboardEdgeShow', '展开')
    : i18nOr('contentLeaderboardEdgeHide', '贴边隐藏');
  btn.textContent = leaderboardHiddenEdge ? '‹' : '›';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!leaderboardHiddenEdge));
}

function updateLeaderboardEdgeHideUi() {
  if (!leaderboardEl) return;
  leaderboardEl.dataset.edgeHide = leaderboardEdgeHideEnabled ? '1' : '0';
  if (!leaderboardEdgeHideEnabled && leaderboardHiddenEdge) {
    setLeaderboardEdgeHidden(false);
  } else {
    setLeaderboardEdgeToggleState();
  }
}

function positionHiddenLeaderboard(edge = leaderboardHiddenEdge || 'right') {
  if (!leaderboardEl) return;
  const rect = leaderboardEl.getBoundingClientRect();
  const left = clampToViewport(rect.left || (leaderboardExpandedPos?.left ?? window.innerWidth - rect.width - 16), 'x');
  const top = clampToViewport(rect.top || (leaderboardExpandedPos?.top ?? 72), 'y');
  if (edge === 'left') {
    leaderboardEl.style.left = '0px';
    leaderboardEl.style.top = top + 'px';
  } else if (edge === 'top') {
    leaderboardEl.style.left = left + 'px';
    leaderboardEl.style.top = '0px';
  } else if (edge === 'bottom') {
    leaderboardEl.style.left = left + 'px';
    leaderboardEl.style.top = Math.max(0, window.innerHeight - LB_EDGE_PEEK) + 'px';
  } else {
    leaderboardEl.style.left = Math.max(0, window.innerWidth - LB_EDGE_PEEK) + 'px';
    leaderboardEl.style.top = top + 'px';
  }
  leaderboardEl.style.right = 'auto';
}

function getLeaderboardExpandedPositionForEdge(edge = 'right') {
  if (!leaderboardEl) return null;
  const rect = leaderboardEl.getBoundingClientRect();
  const currentLeft = Number.isFinite(rect.left) ? rect.left : (leaderboardExpandedPos?.left ?? window.innerWidth - rect.width);
  const currentTop = Number.isFinite(rect.top) ? rect.top : (leaderboardExpandedPos?.top ?? 72);
  let left = currentLeft;
  let top = currentTop;
  if (edge === 'left') {
    left = 0;
  } else if (edge === 'right') {
    left = window.innerWidth - rect.width;
  } else if (edge === 'top') {
    top = 0;
  } else if (edge === 'bottom') {
    top = window.innerHeight - rect.height;
  }
  return {
    left: clampToViewport(left, 'x'),
    top: clampToViewport(top, 'y'),
  };
}

function clearLeaderboardTempExpand() {
  leaderboardTempExpandedEdge = null;
  leaderboardTempExpandedByHover = false;
  document.removeEventListener('pointerdown', onLeaderboardTempExpandOutsidePointerDown, true);
}

function armLeaderboardTempExpand(edge, byHover = false) {
  if (!edge || !leaderboardEdgeHideEnabled) return;
  leaderboardTempExpandedEdge = edge;
  leaderboardTempExpandedByHover = byHover === true;
  document.addEventListener('pointerdown', onLeaderboardTempExpandOutsidePointerDown, true);
}

function onLeaderboardTempExpandOutsidePointerDown(e) {
  if (!leaderboardTempExpandedEdge || leaderboardHiddenEdge || !leaderboardEdgeHideEnabled) {
    clearLeaderboardTempExpand();
    return;
  }
  const target = e.target;
  if (leaderboardEl?.contains?.(target) || leaderboardSettingsEl?.contains?.(target)) return;
  const edge = leaderboardTempExpandedEdge;
  clearLeaderboardTempExpand();
  setLeaderboardEdgeHidden(true, edge);
}

function rehideHoverExpandedLeaderboard() {
  if (!leaderboardTempExpandedByHover || !leaderboardTempExpandedEdge || leaderboardHiddenEdge || !leaderboardEdgeHideEnabled) return;
  const edge = leaderboardTempExpandedEdge;
  clearLeaderboardTempExpand();
  setLeaderboardEdgeHidden(true, edge);
}

function setLeaderboardEdgeHidden(hidden, edge = 'right', options = {}) {
  if (!leaderboardEl) return;
  if (hidden && !leaderboardEdgeHideEnabled) return;
  const nextEdge = hidden ? (edge || 'right') : null;
  if (nextEdge === leaderboardHiddenEdge) {
    if (nextEdge) positionHiddenLeaderboard(nextEdge);
    setLeaderboardEdgeToggleState();
    return;
  }
  if (nextEdge) {
    clearLeaderboardTempExpand();
    hideLeaderboardSettingsPanel();
    const rect = leaderboardEl.getBoundingClientRect();
    leaderboardExpandedPos = options.snapExpandedToEdge
      ? getLeaderboardExpandedPositionForEdge(nextEdge)
      : {
      left: clampToViewport(rect.left, 'x'),
      top: clampToViewport(rect.top, 'y'),
    };
    leaderboardHiddenEdge = nextEdge;
    positionHiddenLeaderboard(nextEdge);
    syncLeaderboardHiddenDom();
    saveLeaderboardPosition();
  } else {
    clearLeaderboardTempExpand();
    leaderboardHiddenEdge = null;
    syncLeaderboardHiddenDom();
    if (leaderboardExpandedPos) {
      leaderboardPos = { ...leaderboardExpandedPos };
    }
    applyLeaderboardPosition();
    saveLeaderboardPosition();
  }
  setLeaderboardEdgeToggleState();
  if (linkState) updateLinkGeometry();
}

function expandLeaderboardFromHiddenEdge(byHover = false) {
  if (!leaderboardHiddenEdge || !leaderboardEdgeHideEnabled) return false;
  if (suppressLeaderboardEdgeExpandClick) return false;
  const hiddenEdge = leaderboardHiddenEdge;
  setLeaderboardEdgeHidden(false);
  leaderboardExpandedPos = getLeaderboardExpandedPositionForEdge(hiddenEdge);
  if (leaderboardExpandedPos) {
    leaderboardPos = { ...leaderboardExpandedPos };
    applyLeaderboardPosition();
  }
  renderLeaderboard();
  armLeaderboardTempExpand(hiddenEdge, byHover);
  return true;
}

function getLeaderboardSnapEdge(rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const gaps = [
    ['left', rect.left],
    ['right', window.innerWidth - rect.right],
    ['top', rect.top],
    ['bottom', window.innerHeight - rect.bottom],
  ];
  let best = null;
  for (const [edge, gap] of gaps) {
    if (!Number.isFinite(gap) || gap > LB_EDGE_SNAP) continue;
    if (!best || gap < best.gap) best = { edge, gap };
  }
  return best?.edge || null;
}

function getPointerSnapEdge(clientX, clientY) {
  const x = Number(clientX);
  const y = Number(clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const gaps = [
    ['left', x],
    ['right', window.innerWidth - x],
    ['top', y],
    ['bottom', window.innerHeight - y],
  ];
  let best = null;
  for (const [edge, gap] of gaps) {
    if (!Number.isFinite(gap) || gap > LB_EDGE_SNAP) continue;
    if (!best || gap < best.gap) best = { edge, gap };
  }
  return best?.edge || null;
}

function safeSetPointerCapture(el, pointerId) {
  if (!el?.setPointerCapture || !Number.isFinite(pointerId)) return;
  try {
    el.setPointerCapture(pointerId);
  } catch (_) {}
}

function safeReleasePointerCapture(el, pointerId) {
  if (!el?.releasePointerCapture || !Number.isFinite(pointerId)) return;
  try {
    if (!el.hasPointerCapture || el.hasPointerCapture(pointerId)) {
      el.releasePointerCapture(pointerId);
    }
  } catch (_) {}
}

function clampLeaderboardWidth(width) {
  const safeWidth = Number.isFinite(width) ? width : LB_DEFAULT_WIDTH;
  const maxByViewport = Math.max(LB_MIN_WIDTH, Math.min(LB_MAX_WIDTH, window.innerWidth - 16));
  const maxByPosition = leaderboardPos && Number.isFinite(leaderboardPos.left)
    ? Math.max(LB_MIN_WIDTH, Math.min(maxByViewport, window.innerWidth - leaderboardPos.left - 8))
    : maxByViewport;
  return Math.max(LB_MIN_WIDTH, Math.min(safeWidth, maxByPosition));
}
function applyLeaderboardWidth() {
  if (!leaderboardEl) return;
  leaderboardWidth = clampLeaderboardWidth(leaderboardWidth);
  leaderboardEl.style.width = leaderboardWidth + 'px';
}
function clampLeaderboardHeight(height) {
  const safeHeight = Number.isFinite(height) ? height : LB_DEFAULT_HEIGHT;
  const maxByViewport = Math.max(LB_MIN_HEIGHT, Math.min(LB_MAX_HEIGHT, window.innerHeight - 80));
  const maxByPosition = leaderboardPos && Number.isFinite(leaderboardPos.top)
    ? Math.max(LB_MIN_HEIGHT, Math.min(maxByViewport, window.innerHeight - leaderboardPos.top - 16))
    : maxByViewport;
  return Math.max(LB_MIN_HEIGHT, Math.min(safeHeight, maxByPosition));
}
function applyLeaderboardHeight() {
  if (!leaderboardEl) return;
  leaderboardHeight = clampLeaderboardHeight(leaderboardHeight);
  const list = leaderboardEl.querySelector('.xvm-lb-list');
  if (list) {
    const px = leaderboardHeight + 'px';
    list.style.height = px;
    list.style.minHeight = px;
    list.style.maxHeight = px;
  }
}
function applyLeaderboardPosition() {
  if (!leaderboardEl) return;
  if (leaderboardHiddenEdge) {
    positionHiddenLeaderboard();
    syncLeaderboardHiddenDom();
    return;
  }
  if (leaderboardPos && Number.isFinite(leaderboardPos.left) && Number.isFinite(leaderboardPos.top)) {
    applyLeaderboardWidth();
    leaderboardEl.style.left = clampToViewport(leaderboardPos.left, 'x') + 'px';
    leaderboardEl.style.top = clampToViewport(leaderboardPos.top, 'y') + 'px';
    leaderboardEl.style.right = 'auto';
  } else {
    applyLeaderboardWidth();
  }
}
function clampToViewport(v, axis) {
  if (!leaderboardEl) return v;
  const rect = leaderboardEl.getBoundingClientRect();
  if (axis === 'x') return Math.max(8, Math.min(v, window.innerWidth - rect.width - 8));
  return Math.max(8, Math.min(v, window.innerHeight - rect.height - 8));
}

// Load persisted position via bridge
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === 'XVM_LB_POS_LOAD' && event.data.pos) {
    restoreLeaderboardPosition(event.data.pos);
    return;
  }
  if (event.data?.type === 'XVM_LB_SIZE_LOAD' && Number.isFinite(event.data.width)) {
    leaderboardWidth = event.data.width;
    applyLeaderboardWidth();
    applyLeaderboardPosition();
  }
  if (event.data?.type === 'XVM_LB_HEIGHT_LOAD' && Number.isFinite(event.data.height)) {
    leaderboardHeight = event.data.height;
    applyLeaderboardHeight();
    applyLeaderboardPosition();
  }
});
window.postMessage({ type: 'XVM_LB_POS_REQUEST' }, '*');
window.postMessage({ type: 'XVM_LB_HEIGHT_REQUEST' }, '*');
window.postMessage({ type: 'XVM_LB_SIZE_REQUEST' }, '*');

function installLeaderboardDrag() {
  if (!leaderboardEl) return;
  const head = leaderboardEl.querySelector('.xvm-lb-head');
  if (!head) return;
  let dragState = null;
  let dragRaf = 0;
  let pendingClientX = 0;
  let pendingClientY = 0;
  let pendingSnapEdge = null;

  const flushDrag = () => {
    dragRaf = 0;
    if (!dragState) return;
    const left = clampToViewport(pendingClientX - dragState.offsetX, 'x');
    const top = clampToViewport(pendingClientY - dragState.offsetY, 'y');
    const rect = leaderboardEl.getBoundingClientRect();
    leaderboardEl.style.left = left + 'px';
    leaderboardEl.style.top = top + 'px';
    leaderboardEl.style.right = 'auto';
    leaderboardPos = { left, top };
    leaderboardExpandedPos = { left, top };
    positionLeaderboardSettingsPanel();
    pendingSnapEdge = getPointerSnapEdge(pendingClientX, pendingClientY)
      || getLeaderboardSnapEdge({
        left,
        top,
        right: left + rect.width,
        bottom: top + rect.height,
        width: rect.width,
        height: rect.height,
      });
    if (linkState) updateLinkGeometry();
  };

  head.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.isPrimary === false) return;
    if (e.button !== 0) return;
    if (e.target?.closest?.('.xvm-lb-controls, .xvm-lb-hot, label, button, input, a')) return;
    if (leaderboardHiddenEdge) {
      setLeaderboardEdgeHidden(false);
      return;
    }
    clearLeaderboardTempExpand();
    const rect = leaderboardEl.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    pendingClientX = e.clientX;
    pendingClientY = e.clientY;
    pendingSnapEdge = null;
    leaderboardEl.classList.add('xvm-lb-dragging');
    safeSetPointerCapture(head, e.pointerId);
    e.preventDefault();
  });
  const onDragMove = (e) => {
    if (!dragState) return;
    if (e.pointerId !== dragState.pointerId) return;
    pendingClientX = e.clientX;
    pendingClientY = e.clientY;
    if (dragRaf) return;
    dragRaf = requestAnimationFrame(flushDrag);
  };
  document.addEventListener('pointermove', onDragMove, { capture: true, passive: true });
  window.addEventListener('pointermove', onDragMove, { passive: true });

  const stopDrag = (e) => {
    if (!dragState) return;
    if (e?.pointerId != null && e.pointerId !== dragState.pointerId) return;
    const pointerId = dragState.pointerId;
    const releaseSnapEdge = Number.isFinite(e?.clientX) && Number.isFinite(e?.clientY)
      ? getPointerSnapEdge(e.clientX, e.clientY)
      : null;
    if (Number.isFinite(e?.clientX) && Number.isFinite(e?.clientY)) {
      pendingClientX = e.clientX;
      pendingClientY = e.clientY;
      pendingSnapEdge = releaseSnapEdge || pendingSnapEdge;
    }
    if (dragRaf) {
      cancelAnimationFrame(dragRaf);
      dragRaf = 0;
    }
    if (Number.isFinite(pendingClientX) && Number.isFinite(pendingClientY)) {
      flushDrag();
    }
    if (!dragState) return;
    dragState = null;
    leaderboardEl.classList.remove('xvm-lb-dragging');
    safeReleasePointerCapture(head, pointerId);
    const edge = leaderboardEdgeHideEnabled
      ? (releaseSnapEdge || pendingSnapEdge || getLeaderboardSnapEdge(leaderboardEl.getBoundingClientRect()))
      : null;
    pendingSnapEdge = null;
    if (edge) {
      e?.stopPropagation?.();
      e?.preventDefault?.();
      suppressLeaderboardEdgeExpandClick = true;
      setTimeout(() => {
        suppressLeaderboardEdgeExpandClick = false;
      }, 650);
      setLeaderboardEdgeHidden(true, edge);
      return;
    }
    clearLeaderboardTempExpand();
    saveLeaderboardPosition();
  };
  document.addEventListener('pointerup', stopDrag, true);
  document.addEventListener('pointercancel', stopDrag, true);
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);
}

function installLeaderboardResize() {
  if (!leaderboardEl) return;
  const handle = leaderboardEl.querySelector('.xvm-lb-resize');
  if (!handle) return;
  let resizeState = null;
  let resizeRaf = 0;
  let pendingClientX = 0;

  const flushResize = () => {
    resizeRaf = 0;
    if (!resizeState) return;
    leaderboardWidth = clampLeaderboardWidth(resizeState.startWidth + (pendingClientX - resizeState.startClientX));
    applyLeaderboardWidth();
    applyLeaderboardPosition();
    if (linkState) updateLinkGeometry();
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.isPrimary === false) return;
    if (leaderboardHiddenEdge) return;
    resizeState = {
      pointerId: e.pointerId,
      startWidth: leaderboardEl.getBoundingClientRect().width,
      startClientX: e.clientX,
    };
    leaderboardEl.classList.add('xvm-lb-resizing');
    safeSetPointerCapture(handle, e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!resizeState) return;
    if (e.pointerId !== resizeState.pointerId) return;
    pendingClientX = e.clientX;
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(flushResize);
  }, { passive: true });

  const stopResize = (e) => {
    if (!resizeState) return;
    if (e?.pointerId != null && e.pointerId !== resizeState.pointerId) return;
    const pointerId = resizeState.pointerId;
    resizeState = null;
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
    }
    leaderboardEl.classList.remove('xvm-lb-resizing');
    safeReleasePointerCapture(handle, pointerId);
    window.postMessage({ type: 'XVM_LB_SIZE_SAVE', width: leaderboardWidth }, '*');
  };
  window.addEventListener('pointerup', stopResize);
  window.addEventListener('pointercancel', stopResize);
}

function installLeaderboardResizeHeight() {
  if (!leaderboardEl) return;
  const handle = leaderboardEl.querySelector('.xvm-lb-resize-v');
  if (!handle) return;
  let resizeState = null;
  let resizeRaf = 0;
  let pendingClientY = 0;

  const flushResize = () => {
    resizeRaf = 0;
    if (!resizeState) return;
    leaderboardHeight = clampLeaderboardHeight(resizeState.startHeight + (pendingClientY - resizeState.startClientY));
    applyLeaderboardHeight();
    if (linkState) updateLinkGeometry();
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.isPrimary === false) return;
    if (leaderboardHiddenEdge) return;
    const list = leaderboardEl.querySelector('.xvm-lb-list');
    resizeState = {
      pointerId: e.pointerId,
      startHeight: list ? list.getBoundingClientRect().height : leaderboardHeight,
      startClientY: e.clientY,
    };
    leaderboardEl.classList.add('xvm-lb-resizing');
    safeSetPointerCapture(handle, e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!resizeState) return;
    if (e.pointerId !== resizeState.pointerId) return;
    pendingClientY = e.clientY;
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(flushResize);
  }, { passive: true });

  const stopResize = (e) => {
    if (!resizeState) return;
    if (e?.pointerId != null && e.pointerId !== resizeState.pointerId) return;
    const pointerId = resizeState.pointerId;
    resizeState = null;
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
    }
    leaderboardEl.classList.remove('xvm-lb-resizing');
    safeReleasePointerCapture(handle, pointerId);
    window.postMessage({ type: 'XVM_LB_HEIGHT_SAVE', height: leaderboardHeight }, '*');
  };
  window.addEventListener('pointerup', stopResize);
  window.addEventListener('pointercancel', stopResize);
}

function installLeaderboardEdgeToggle() {
  if (!leaderboardEl) return;
  const btn = leaderboardEl.querySelector('.xvm-lb-edge-toggle');
  if (!btn) return;
  setLeaderboardEdgeToggleState();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!leaderboardEdgeHideEnabled) return;
    const hiddenEdge = leaderboardHiddenEdge;
    setLeaderboardEdgeHidden(!hiddenEdge, 'right', { snapExpandedToEdge: !hiddenEdge });
    if (hiddenEdge) armLeaderboardTempExpand(hiddenEdge);
  });
  leaderboardEl.addEventListener('click', (e) => {
    if (!leaderboardHiddenEdge) return;
    e.stopPropagation();
    e.preventDefault();
    expandLeaderboardFromHiddenEdge();
  }, true);
  leaderboardEl.addEventListener('pointerenter', () => {
    expandLeaderboardFromHiddenEdge(true);
  });
  leaderboardEl.addEventListener('pointerleave', (e) => {
    if (leaderboardSettingsEl?.contains?.(e.relatedTarget)) return;
    rehideHoverExpandedLeaderboard();
  });
}

function installLeaderboardPanelActions() {
  if (!leaderboardEl) return;
  const settings = leaderboardEl.querySelector('.xvm-lb-settings');
  const close = leaderboardEl.querySelector('.xvm-lb-close');
  settings?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLeaderboardSettingsPanel();
  });
  close?.addEventListener('click', (e) => {
    e.stopPropagation();
    leaderboardEnabled = false;
    hideLeaderboard();
    window.postMessage({ type: 'XVM_LEADERBOARD_DISABLE' }, '*');
  });
}

function normalizeLeaderboardCountInput(v) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, n));
}

function leaderboardColumnLabel(id) {
  return i18nOr(LB_COLUMN_LABEL_KEYS[id], id);
}

function saveLeaderboardSettingsPatch(patch) {
  window.postMessage({ type: 'XVM_LEADERBOARD_SETTINGS_SAVE', patch }, '*');
}

function ensureLeaderboardSettingsPanel() {
  if (leaderboardSettingsEl) return leaderboardSettingsEl;
  leaderboardSettingsEl = document.createElement('div');
  leaderboardSettingsEl.className = 'xvm-lb-settings-panel';
  leaderboardSettingsEl.hidden = true;
  leaderboardSettingsEl.innerHTML = `
    <div class="xvm-lb-settings-head">
      <strong class="xvm-lb-settings-title"></strong>
      <button class="xvm-lb-settings-close" type="button" aria-label="${i18nOr('contentLeaderboardCloseSettings', '关闭设置')}">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15"></path>
        </svg>
      </button>
    </div>
    <label class="xvm-lb-settings-row">
      <span class="xvm-lb-settings-label" data-role="count-label"></span>
      <input class="xvm-lb-settings-count" type="number" min="1" max="50" step="1">
    </label>
    <div class="xvm-lb-settings-toggle xvm-lb-settings-hot-row">
      <span>
        <b data-role="hot-title"></b>
        <small data-role="hot-desc"></small>
      </span>
      <label class="xvm-lb-hot" data-on="0" data-tier="free">
        <span class="xvm-lb-pro-badge">Pro</span>
        <span class="xvm-lb-hot-switch">
          <input type="checkbox" />
          <span class="xvm-lb-hot-slider"></span>
        </span>
      </label>
    </div>
    <div class="xvm-lb-settings-section xvm-lb-hot-scopes-section">
      <div class="xvm-lb-settings-section-title" data-role="hot-scope-title"></div>
      <div class="xvm-lb-hot-scope-grid"></div>
    </div>
    <label class="xvm-lb-settings-toggle">
      <span>
        <b data-role="edge-title"></b>
        <small data-role="edge-desc"></small>
      </span>
      <input class="xvm-lb-settings-edge" type="checkbox">
    </label>
    <div class="xvm-lb-settings-section">
      <div class="xvm-lb-settings-section-title" data-role="columns-title"></div>
      <div class="xvm-lb-settings-cols"></div>
    </div>
    <p class="xvm-lb-settings-hint" data-role="hint"></p>
  `;
  document.body.appendChild(leaderboardSettingsEl);

  leaderboardSettingsEl.querySelector('.xvm-lb-settings-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    hideLeaderboardSettingsPanel();
  });
  const hot = leaderboardSettingsEl.querySelector('.xvm-lb-hot');
  hot?.addEventListener('click', onHotGateClick);
  hot?.querySelector('input')?.addEventListener('click', onHotToggleClick);
  leaderboardSettingsEl.querySelector('.xvm-lb-hot-scope-grid')?.addEventListener('change', onHotScopeToggleChange);
  leaderboardSettingsEl.querySelector('.xvm-lb-settings-count')?.addEventListener('change', (e) => {
    const n = normalizeLeaderboardCountInput(e.target.value);
    e.target.value = String(n);
    leaderboardCount = n;
    renderLeaderboard();
    saveLeaderboardSettingsPatch({ leaderboardCount: n });
  });
  leaderboardSettingsEl.querySelector('.xvm-lb-settings-edge')?.addEventListener('change', (e) => {
    leaderboardEdgeHideEnabled = !!e.target.checked;
    updateLeaderboardEdgeHideUi();
    saveLeaderboardSettingsPatch({ leaderboardEdgeHideEnabled });
  });
  leaderboardSettingsEl.addEventListener('change', (e) => {
    const input = e.target?.closest?.('.xvm-lb-settings-col input[type="checkbox"]');
    if (!input) return;
    const id = input.dataset.colId;
    if (!id) return;
    const visibleCount = leaderboardColumns.filter((c) => c.visible).length;
    if (!input.checked && visibleCount <= 1) {
      input.checked = true;
      return;
    }
    leaderboardColumns = leaderboardColumns.map((c) => (
      c.id === id ? { ...c, visible: !!input.checked } : c
    ));
    updateLeaderboardSettingsPanel();
    renderLeaderboard();
    saveLeaderboardSettingsPatch({ leaderboardColumns });
  });
  return leaderboardSettingsEl;
}

function updateLeaderboardSettingsPanel() {
  if (!leaderboardSettingsEl) return;
  leaderboardSettingsEl.setAttribute('data-theme', _resolvedTheme(_themePref));
  const title = leaderboardSettingsEl.querySelector('.xvm-lb-settings-title');
  const countLabel = leaderboardSettingsEl.querySelector('[data-role="count-label"]');
  const countInput = leaderboardSettingsEl.querySelector('.xvm-lb-settings-count');
  const hotTitle = leaderboardSettingsEl.querySelector('[data-role="hot-title"]');
  const hotDesc = leaderboardSettingsEl.querySelector('[data-role="hot-desc"]');
  const hotScopeTitle = leaderboardSettingsEl.querySelector('[data-role="hot-scope-title"]');
  const hotScopeGrid = leaderboardSettingsEl.querySelector('.xvm-lb-hot-scope-grid');
  const edgeTitle = leaderboardSettingsEl.querySelector('[data-role="edge-title"]');
  const edgeDesc = leaderboardSettingsEl.querySelector('[data-role="edge-desc"]');
  const edgeInput = leaderboardSettingsEl.querySelector('.xvm-lb-settings-edge');
  const columnsTitle = leaderboardSettingsEl.querySelector('[data-role="columns-title"]');
  const cols = leaderboardSettingsEl.querySelector('.xvm-lb-settings-cols');
  const hint = leaderboardSettingsEl.querySelector('[data-role="hint"]');
  if (title) title.textContent = i18nOr('contentLeaderboardSettingsPanelTitle', '热度榜设置');
  if (countLabel) countLabel.textContent = i18nOr('featureLeaderboardShowTop', '显示前 N 条');
  if (countInput && document.activeElement !== countInput) countInput.value = String(leaderboardCount);
  if (hotTitle) hotTitle.textContent = i18nOr('contentLbHotOnly', '仅看热帖');
  if (hotDesc) hotDesc.textContent = i18nOr('contentLbHotProSub', '隐藏低浏览量推文,保留真正在传播的内容');
  if (hotScopeTitle) hotScopeTitle.textContent = i18nOr('contentLbHotScopeTitle', '生效范围');
  if (hotScopeGrid) {
    hotScopeGrid.innerHTML = LEADERBOARD_HOT_SCOPE_ITEMS.map((item) => `
      <label class="xvm-lb-hot-scope" data-hot-scope="${lbEscapeHtml(item.scope)}">
        <input type="checkbox" data-scope="${lbEscapeHtml(item.scope)}">
        <span>${lbEscapeHtml(i18nOr(item.labelKey, item.fallback))}</span>
        <em data-role="scope-current" hidden>${lbEscapeHtml(i18nOr('contentLbHotScopeCurrent', '当前'))}</em>
      </label>
    `).join('');
  }
  if (edgeTitle) edgeTitle.textContent = i18nOr('featureLeaderboardEdgeHideTitle', '贴边隐藏');
  if (edgeDesc) edgeDesc.textContent = i18nOr('featureLeaderboardEdgeHideDesc', '拖到屏幕边缘后自动收起');
  if (edgeInput) edgeInput.checked = leaderboardEdgeHideEnabled !== false;
  if (columnsTitle) columnsTitle.textContent = i18nOr('contentLeaderboardColumns', '显示列');
  if (cols) {
    cols.innerHTML = leaderboardColumns.map((c) => `
      <label class="xvm-lb-settings-col">
        <input type="checkbox" data-col-id="${lbEscapeHtml(c.id)}" ${c.visible ? 'checked' : ''}>
        <span>${lbEscapeHtml(leaderboardColumnLabel(c.id))}</span>
      </label>
    `).join('');
  }
  if (hint) hint.textContent = i18nOr('contentLeaderboardSettingsAutoSave', '设置会自动保存');
  setLeaderboardHotSwitchState();
  positionLeaderboardSettingsPanel();
}

function positionLeaderboardSettingsPanel() {
  if (!leaderboardEl || !leaderboardSettingsEl || leaderboardSettingsEl.hidden) return;
  const rect = leaderboardEl.getBoundingClientRect();
  const panelRect = leaderboardSettingsEl.getBoundingClientRect();
  const gap = 8;
  const panelWidth = panelRect.width || 248;
  const panelHeight = panelRect.height || 260;
  let side = 'right';
  let left = rect.right + gap;
  let top = Math.max(8, Math.min(rect.top, window.innerHeight - panelHeight - 8));
  if (left + panelWidth <= window.innerWidth - 8) {
    side = 'right';
  } else if (rect.left - panelWidth - gap >= 8) {
    left = rect.left - panelWidth - gap;
    side = 'left';
  } else {
    side = 'bottom';
    left = Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8));
    top = rect.bottom + gap;
    if (top + panelHeight > window.innerHeight - 8) {
      side = 'top';
      top = Math.max(8, rect.top - panelHeight - gap);
    }
  }
  left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - panelHeight - 8));
  leaderboardSettingsEl.dataset.side = side;
  leaderboardSettingsEl.style.left = left + 'px';
  leaderboardSettingsEl.style.top = top + 'px';
}

function showLeaderboardSettingsPanel() {
  const panel = ensureLeaderboardSettingsPanel();
  updateLeaderboardSettingsPanel();
  panel.hidden = false;
  panel.classList.add('is-open');
  positionLeaderboardSettingsPanel();
}

function hideLeaderboardSettingsPanel() {
  if (!leaderboardSettingsEl) return;
  leaderboardSettingsEl.hidden = true;
  leaderboardSettingsEl.classList.remove('is-open');
}

function toggleLeaderboardSettingsPanel() {
  if (leaderboardSettingsEl && !leaderboardSettingsEl.hidden) {
    hideLeaderboardSettingsPanel();
  } else {
    showLeaderboardSettingsPanel();
  }
}

window.addEventListener('resize', () => {
  if (!leaderboardEl) return;
  applyLeaderboardWidth();
  applyLeaderboardHeight();
  applyLeaderboardPosition();
  positionLeaderboardSettingsPanel();
  if (linkState) updateLinkGeometry();
});

function formatViews(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function lbEscapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const LB_COLUMN_RENDERERS = {
  rank: (_t, i) => `<span class="xvm-lb-rank">${i + 1}</span>`,
  icon: (t) => {
    const tier = t.velocity >= velocityThresholds.viral ? 'red'
      : t.velocity >= velocityThresholds.trending ? 'orange'
        : 'green';
    const icon = tier === 'red' ? '\u{1F525}' : tier === 'orange' ? '\u{1F680}' : '\u{1F331}';
    return `<span class="xvm-lb-icon">${icon}</span>`;
  },
  handle: (t) => {
    const fallbackHandle = `(${i18n('contentFallbackTweetLabel')})`;
    const handle = (t.handle || '').trim() || fallbackHandle;
    // Let CSS text-overflow do the truncation so the full name is shown
    // whenever there's space, and only clipped when the row is actually
    // too narrow. This plays nicer with mixed CJK/Latin names.
    return `<span class="xvm-lb-handle" title="${lbEscapeHtml(handle)}">${lbEscapeHtml(handle)}</span>`;
  },
  preview: (t) => {
    const text = (t.text || '').replace(/\s+/g, ' ').trim();
    return `<span class="xvm-lb-preview" title="${lbEscapeHtml(text.slice(0, 280))}">${lbEscapeHtml(text)}</span>`;
  },
  views: (t) => `<span class="xvm-lb-views" title="${i18n('contentLeaderboardTotalViews')}">\u{1F441} ${formatViews(t.views)}</span>`,
  velocity: (t) => `<span class="xvm-lb-vel">${formatVelocity(t.velocity)}/h</span>`,
};

function hideLeaderboard() {
  if (leaderboardRaf) {
    cancelAnimationFrame(leaderboardRaf);
    leaderboardRaf = 0;
  }
  hideLeaderboardSettingsPanel();
  if (leaderboardEl) leaderboardEl.style.display = 'none';
  clearLink();
}

function getTweetPermalinkFromArticle(article, tweetId = '') {
  if (!article) return '';
  const links = article.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) continue;
    if (tweetId && match[2] !== tweetId) continue;
    return `https://x.com/${match[1]}/status/${match[2]}`;
  }
  return '';
}

function leaderboardCellForArticle(article) {
  return article.closest('[data-testid="cellInnerDiv"]') || article;
}

// `data-xvm-rate-hidden` is a SOFT marker — it stays on the article
// even after the user turns the filter OFF, so the next ON can be a
// single CSS root-flag flip rather than an N-article re-mark pass.
// Whether the marker is actually hiding right now is gated by
// html[data-xvm-rate-filter-on]. content-filter still uses an
// always-active marker so it remains hard.
// Leaderboard-only fallback: skip any ad cell that still rendered despite
// API-layer timeline prune (cached paint / missed shape). Does NOT hide or
// collapse DOM — no scroll-restore arming. X renders the disclosure as its
// own leaf label; match the whole trimmed text so a post that merely says
// "ad" in its body is never hit, and skip the tweet body entirely.
const PROMOTED_LABELS = new Set([
  'ad', 'ads', 'promoted', 'promoted tweet', 'sponsored',
  '\u5e7f\u544a', '\u63a8\u5e7f', '\u5df2\u63a8\u5e7f',
  '\u30d7\u30ed\u30e2\u30fc\u30b7\u30e7\u30f3', '\u5e83\u544a',
]);

function isPromotedArticle(article) {
  if (!article) return false;
  for (const node of article.querySelectorAll('span, div[dir]')) {
    if (node.firstElementChild) continue;            // leaf nodes only
    if (node.closest('[data-testid="tweetText"]')) continue;  // never the body
    const text = (node.textContent || '').trim().toLowerCase();
    if (text && text.length <= 16 && PROMOTED_LABELS.has(text)) return true;
  }
  return false;
}

function isLeaderboardArticleHidden(article) {
  if (!article) return true;
  if (article.getClientRects().length === 0) return true;
  if (article.hasAttribute('data-xvm-content-filter-hidden')) return true;
  const rateFilterOn = document.documentElement.hasAttribute('data-xvm-rate-filter-on');
  if (rateFilterOn && article.hasAttribute('data-xvm-rate-hidden')) return true;
  const cell = leaderboardCellForArticle(article);
  if (cell?.style?.display === 'none' || article.style?.display === 'none') return true;
  return false;
}

function isArticleHiddenByXvmFilters(article) {
  return isLeaderboardArticleHidden(article);
}

function rememberLeaderboardItem(entry) {
  if (!entry?.id) return;
  leaderboardItemMeta.set(entry.id, entry);
}

// === Leaderboard sort / filter (local addition) ===
// Goal: spot posts that are fresh, fast and still quiet, then reply early.
// Pool = every tweet seen on this URL (on screen or scrolled past).
const LB_SORT_KEY = 'xvmLbSortV1';
let lbSort = { mode: 'velocity', maxAgeHours: null, maxReplies: null };
try {
  const saved = JSON.parse(localStorage.getItem(LB_SORT_KEY) || 'null');
  if (saved && typeof saved === 'object') lbSort = { ...lbSort, ...saved };
} catch (_) {}

function saveLbSort() {
  try { localStorage.setItem(LB_SORT_KEY, JSON.stringify(lbSort)); } catch (_) {}
}

function parseLbLimit(value) {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function syncLeaderboardSortBar(root = leaderboardEl) {
  if (!root) return;
  root.querySelectorAll('.xvm-lb-sort-modes button').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.sort === lbSort.mode ? 'true' : 'false');
  });
  const age = root.querySelector('.xvm-lb-max-age');
  const replies = root.querySelector('.xvm-lb-max-replies');
  if (age && document.activeElement !== age) age.value = lbSort.maxAgeHours ?? '';
  if (replies && document.activeElement !== replies) replies.value = lbSort.maxReplies ?? '';
}

function installLeaderboardSortBar(root) {
  const bar = root.querySelector('.xvm-lb-sortbar');
  if (!bar) return;
  for (const type of ['pointerdown', 'mousedown', 'click', 'keydown']) {
    bar.addEventListener(type, (ev) => ev.stopPropagation());
  }
  bar.querySelectorAll('.xvm-lb-sort-modes button').forEach((btn) => {
    btn.addEventListener('click', () => {
      lbSort.mode = btn.dataset.sort;
      saveLbSort();
      syncLeaderboardSortBar(root);
      renderLeaderboard();
    });
  });
  const bindLimit = (selector, key) => {
    const input = bar.querySelector(selector);
    input?.addEventListener('input', () => {
      lbSort[key] = parseLbLimit(input.value);
      saveLbSort();
      renderLeaderboard();
    });
  };
  bindLimit('.xvm-lb-max-age', 'maxAgeHours');
  bindLimit('.xvm-lb-max-replies', 'maxReplies');
  syncLeaderboardSortBar(root);
}

function sortAndFilterLeaderboard(entries) {
  const now = Date.now();
  const out = entries.filter((e) => {
    const ageHours = (now - e.createdMs) / 3600000;
    if (lbSort.maxAgeHours != null && lbSort.maxAgeHours > 0 && ageHours > lbSort.maxAgeHours) return false;
    if (lbSort.maxReplies != null && e.replies > lbSort.maxReplies) return false;
    return true;
  });
  if (lbSort.mode === 'newest') {
    out.sort((a, b) => b.createdMs - a.createdMs);
  } else if (lbSort.mode === 'replies') {
    out.sort((a, b) => (a.replies - b.replies) || (b.velocity - a.velocity));
  } else {
    out.sort((a, b) => b.velocity - a.velocity);
  }
  return out;
}

function formatLbAge(createdMs) {
  const mins = Math.max(0, Math.floor((Date.now() - createdMs) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function collectRanked() {
  const out = [];
  const seen = new Set();
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  for (const article of articles) {
    if (isLeaderboardArticleHidden(article)) continue;
    const id = getTweetIdFromArticle(article);
    if (!id || seen.has(id)) continue;
    if (promotedTweetIds.has(id) || isPromotedArticle(article)) continue;
    const data = getTweetDataForArticle(article, id);
    if (!data) continue;
    seen.add(id);
    const { velocity } = computeScore(data);
    // Use the canonical User-Name container (works on x.com AND pro.x.com).
    // Prefer the display name ("张三") over the @handle ("zhangsan") — more
    // recognizable to humans skimming the leaderboard.
    const { displayName, handle: authorHandle } = getAuthorInfo(article);
    let handle = displayName || authorHandle || '';
    if (!handle) {
      handle = (data.text || '').slice(0, 60);
    }
    const entry = {
      id,
      article,
      pageY: window.scrollY + article.getBoundingClientRect().top,
      velocity,
      views: data.views || 0,
      replies: data.replies || 0,
      createdMs: new Date(data.createdAt).getTime(),
      url: location.href,
      data,
      handle,
      text: data.text,
    };
    rememberLeaderboardItem(entry);
    out.push(entry);
  }
  // Tweets seen earlier on this same page but no longer in the DOM
  // (X recycles off-screen rows). Their velocity is recomputed from the
  // stored numbers so it stays comparable.
  for (const [id, meta] of leaderboardItemMeta) {
    if (seen.has(id) || meta.url !== location.href || !meta.data) continue;
    if (promotedTweetIds.has(id)) continue;
    if (meta.article?.isConnected && isLeaderboardArticleHidden(meta.article)) continue;
    seen.add(id);
    const fresh = tweetDataStore.get(id) || meta.data;
    out.push({
      ...meta,
      data: fresh,
      velocity: computeScore(fresh).velocity,
      views: fresh.views || 0,
      replies: fresh.replies || 0,
    });
  }
  return out.sort((a, b) => b.velocity - a.velocity);
}

function waitForLeaderboardTarget(tweetId, itemEl = null, timeoutMs = 12000) {
  const startedAt = Date.now();
  pendingLeaderboardJump = { tweetId, itemEl, startedAt };
  const finish = (article) => {
    if (pendingLeaderboardJump?.tweetId !== tweetId) return;
    pendingLeaderboardJump = null;
    if (!article) return;
    article.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (itemEl?.isConnected) {
      setLink(tweetId, itemEl, article);
    } else {
      clearLink();
      article.classList.add('xvm-article-linked');
    }
  };
  const tick = () => {
    const article = findArticleByTweetId(tweetId);
    if (article) {
      finish(article);
      return true;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      pendingLeaderboardJump = null;
      return true;
    }
    return false;
  };
  if (tick()) return;
  const observer = new MutationObserver(() => {
    if (tick()) observer.disconnect();
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  setTimeout(() => {
    observer.disconnect();
    tick();
  }, timeoutMs + 50);
}

function jumpToLeaderboardTweet(id, itemEl) {
  const latest = collectRanked().find((e) => e.id === id);
  const meta = latest || leaderboardItemMeta.get(id);
  const article = latest?.article?.isConnected
    ? latest.article
    : findArticleByTweetId(id);

  if (article) {
    if (linkState && linkState.tweetId === id) {
      clearLink();
      return;
    }
    if (savedScrollY === null) {
      savedScrollY = window.scrollY;
      setBackButtonVisible(true);
    }
    article.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setLink(id, itemEl, article);
    return;
  }

  clearLink();
  if (!Number.isFinite(meta?.pageY)) {
    showToast('无法定位该推文：页面已回收该条目');
    return;
  }
  if (savedScrollY === null) {
    savedScrollY = window.scrollY;
    setBackButtonVisible(true);
  }
  window.scrollTo({ top: meta.pageY, behavior: 'smooth' });
  waitForLeaderboardTarget(id, itemEl);
}

function renderLeaderboard() {
  cancelAnimationFrame(leaderboardRaf);
  leaderboardRaf = requestAnimationFrame(() => {
    leaderboardRaf = 0;
    if (!leaderboardEnabled) {
      hideLeaderboard();
      return;
    }
    const el = ensureLeaderboard();
    syncLeaderboardSortBar(el);
    const pool = collectRanked();
    const top = sortAndFilterLeaderboard(pool).slice(0, leaderboardCount);
    const list = el.querySelector('.xvm-lb-list');
    if (!pool.length) {
      if (list) list.innerHTML = '';
      el.style.display = 'none';
      clearLink();
      return;
    }
    el.style.display = 'block';
    if (leaderboardHiddenEdge) positionHiddenLeaderboard(leaderboardHiddenEdge);
    if (!top.length) {
      // Keep the panel up so the filters can be loosened.
      if (list) list.innerHTML = '<li class="xvm-lb-empty">没有符合条件的帖子，放宽上面的条件试试</li>';
      clearLink();
      return;
    }
    const visibleCols = leaderboardColumns.filter((c) => c.visible && LB_COLUMN_RENDERERS[c.id]);
    list.innerHTML = top.map((t, i) => {
      const tier = t.velocity >= velocityThresholds.viral ? 'red'
        : t.velocity >= velocityThresholds.trending ? 'orange'
          : 'green';
      const cells = visibleCols.map((c) => LB_COLUMN_RENDERERS[c.id](t, i)).join('');
      const meta = `<span class="xvm-lb-meta" title="发布时间 · 评论数">${formatLbAge(t.createdMs)} · \u{1F4AC}${formatViews(t.replies)}</span>`;
      return `<li class="xvm-lb-item xvm-lb-${tier}" data-id="${t.id}">${cells}${meta}</li>`;
    }).join('');

    list.querySelectorAll('.xvm-lb-item').forEach((li) => {
      li.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = li.dataset.id;
        jumpToLeaderboardTweet(id, li);
      });
    });

    // Restore link highlight if the linked item is in the freshly rendered list
    if (linkState) {
      const relinkItem = list.querySelector(`.xvm-lb-item[data-id="${CSS.escape(linkState.tweetId)}"]`);
      if (relinkItem) {
        linkState.itemEl = relinkItem;
        relinkItem.classList.add('xvm-lb-item-selected');
      } else {
        clearLink();
      }
    }
  });
}

// === Leaderboard ↔ article connector (infinite-canvas style) ===
// linkState: { tweetId, itemEl, article, svg, rafHandle }
let linkState = null;
const SVG_NS = 'http://www.w3.org/2000/svg';

function ensureLinkSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'xvm-lb-link');
  svg.style.position = 'fixed';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.width = '100vw';
  svg.style.height = '100vh';
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = '2147483645';
  svg.innerHTML = `
    <path class="xvm-lb-link-path" fill="none" />
    <circle class="xvm-lb-link-dot xvm-lb-link-start" r="5" />
    <circle class="xvm-lb-link-dot xvm-lb-link-end" r="5" />
  `;
  document.body.appendChild(svg);
  return svg;
}

function findArticleByTweetId(tweetId) {
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  for (const article of articles) {
    if (isLeaderboardArticleHidden(article)) continue;
    const id = getTweetIdFromArticle(article);
    if (id === tweetId) return article;
  }
  return null;
}

function updateLinkGeometry() {
  if (!linkState) return;
  const { tweetId, itemEl, svg } = linkState;

  // Re-resolve article each frame — React can swap the node on virtualization
  let article = linkState.article;
  if (!article || !article.isConnected) {
    article = findArticleByTweetId(tweetId);
    linkState.article = article;
  }

  if (!itemEl.isConnected || !article) {
    if (!article) svg.style.display = 'none';
    return;
  }
  svg.style.display = '';

  const itemRect = itemEl.getBoundingClientRect();
  const articleRect = article.getBoundingClientRect();

  // Re-apply article highlight (React may have stripped it on re-render)
  if (!article.classList.contains('xvm-article-linked')) {
    article.classList.add('xvm-article-linked');
  }

  // Pick the item side that faces the article
  const itemCx = itemRect.left + itemRect.width / 2;
  const articleCx = articleRect.left + articleRect.width / 2;
  const startOnRight = articleCx >= itemCx;

  const startX = startOnRight ? itemRect.right : itemRect.left;
  const startY = itemRect.top + itemRect.height / 2;

  // Clamp article endpoint vertically to the visible article region
  const articleVisibleTop = Math.max(articleRect.top, 8);
  const articleVisibleBottom = Math.min(articleRect.bottom, window.innerHeight - 8);
  const endY = Math.max(articleVisibleTop, Math.min(startY, articleVisibleBottom));
  const endX = startOnRight ? articleRect.left : articleRect.right;

  // Cubic bezier with horizontal control handles — the "canvas connection" feel
  const dx = Math.abs(endX - startX);
  const handle = Math.max(60, dx * 0.4);
  const c1x = startX + (startOnRight ? handle : -handle);
  const c2x = endX - (startOnRight ? handle : -handle);

  const path = svg.querySelector('.xvm-lb-link-path');
  path.setAttribute('d', `M ${startX},${startY} C ${c1x},${startY} ${c2x},${endY} ${endX},${endY}`);

  const s = svg.querySelector('.xvm-lb-link-start');
  s.setAttribute('cx', startX);
  s.setAttribute('cy', startY);
  const e = svg.querySelector('.xvm-lb-link-end');
  e.setAttribute('cx', endX);
  e.setAttribute('cy', endY);
}

let linkUpdateRaf = 0;
function scheduleLinkUpdate() {
  if (!linkState || linkUpdateRaf) return;
  linkUpdateRaf = requestAnimationFrame(() => {
    linkUpdateRaf = 0;
    updateLinkGeometry();
  });
}

function setLink(tweetId, itemEl, article) {
  clearLink();
  const svg = ensureLinkSvg();
  itemEl.classList.add('xvm-lb-item-selected');
  article.classList.add('xvm-article-linked');
  linkState = { tweetId, itemEl, article, svg };
  updateLinkGeometry();
}

function clearLink() {
  if (!linkState) return;
  linkState.itemEl?.classList.remove('xvm-lb-item-selected');
  linkState.article?.classList.remove('xvm-article-linked');
  // Also clean any stale highlights on the current DOM article for this id
  const stale = findArticleByTweetId(linkState.tweetId);
  stale?.classList.remove('xvm-article-linked');
  linkState.svg?.remove();
  linkState = null;
  if (linkUpdateRaf) {
    cancelAnimationFrame(linkUpdateRaf);
    linkUpdateRaf = 0;
  }
}

// Event-driven link geometry updates — no idle rAF loop burning CPU.
// Capture phase so we catch scroll events on inner scroll containers too.
window.addEventListener('scroll', scheduleLinkUpdate, { capture: true, passive: true });
window.addEventListener('resize', scheduleLinkUpdate, { passive: true });

document.addEventListener('click', (e) => {
  if (!linkState) return;
  const insideItem = linkState.itemEl && linkState.itemEl.contains(e.target);
  const insideArticle = linkState.article && linkState.article.contains(e.target);
  const insidePanel = leaderboardEl && leaderboardEl.contains(e.target);
  if (!insideItem && !insideArticle && !insidePanel) clearLink();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && linkState) clearLink();
});

function getTweetIdFromArticle(article) {
  const ownLinks = (selector) => Array.from(article.querySelectorAll(selector))
    .filter((link) => link.closest('article[data-testid="tweet"]') === article);
  const idFromLink = (link) => link?.getAttribute('href')?.match(/\/status\/(\d+)(?:[/?#]|$)/)?.[1] || null;
  const analyticsLink = ownLinks('a[href*="/status/"][href*="/analytics"]')[0];
  const analyticsId = idFromLink(analyticsLink);
  if (analyticsId) return analyticsId;
  const links = Array.from(article.querySelectorAll('a[href*="/status/"]'))
    .filter((link) => link.closest('article[data-testid="tweet"]') === article);
  for (const link of links) {
    const id = idFromLink(link);
    if (id && tweetDataStore.has(id)) return id;
  }
  const firstLink = links[0];
  return idFromLink(firstLink);
}

// Periodic re-render for tweets whose data arrived after DOM render
setInterval(() => {
  const unscored = document.querySelectorAll('article[data-testid="tweet"]:not([data-xvm-scored])');
  if (unscored.length > 0) {
    renderBadges();
  } else if (bookmarkTimelineInsertedTweetIds.size) {
    renderBookmarkTimelineBadges();
  } else if (leaderboardEnabled) {
    renderLeaderboard();
  }
}, 2000);

// Refresh leaderboard on scroll as virtualized articles come and go
let lbScrollTick = false;
window.addEventListener('scroll', () => {
  if (!leaderboardEnabled || lbScrollTick) return;
  lbScrollTick = true;
  setTimeout(() => { lbScrollTick = false; renderLeaderboard(); }, 250);
}, { passive: true });

// === MutationObserver ===
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'ARTICLE' || node.querySelector?.('article[data-testid="tweet"]')) {
        renderBadges();
        return;
      }
    }
  }
});

function startObserver() {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

if (document.body) {
  startObserver();
  installEnterToReplyShortcut();
} else {
  document.addEventListener('DOMContentLoaded', () => {
    startObserver();
    installEnterToReplyShortcut();
  });
}

// Reset on SPA navigation (URL change).
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    dismissStickyToasts();
    clearLink();
    if (pendingLeaderboardJump?.tweetId) {
      waitForLeaderboardTarget(pendingLeaderboardJump.tweetId, pendingLeaderboardJump.itemEl);
    }
  }
}).observe(document.body || document.documentElement, { childList: true, subtree: true });

// === Copy-as-Markdown: inject entry into X's native share dropdown ===
// Remember the tweet the user was interacting with when opening a menu.
let lastShareContext = null; // { article, tweetId, permalink }

function createShareContextFromArticle(article) {
  if (!article) return null;
  const tweetId = getTweetIdFromArticle(article);
  const permalink = getTweetPermalinkFromArticle(article, tweetId);
  return { article, tweetId, permalink };
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('button[aria-haspopup="menu"], button[aria-expanded]');
  if (!btn) return;
  const article = btn.closest('article[data-testid="tweet"]');
  if (!article) return;
  lastShareContext = createShareContextFromArticle(article);
}, true);

function getAuthorInfo(article) {
  // User-Name block has display name + @handle
  const nameBlock = article.querySelector('[data-testid="User-Name"]');
  let displayName = '';
  let handle = '';
  if (nameBlock) {
    const spans = nameBlock.querySelectorAll('span');
    for (const s of spans) {
      const t = (s.textContent || '').trim();
      if (!handle && t.startsWith('@')) handle = t;
      else if (!displayName && t && !t.startsWith('@') && t !== '·') displayName = t;
      if (handle && displayName) break;
    }
  }
  return { displayName, handle };
}

function formatLocalDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join(':');
}

function buildTweetMarkdown(ctx) {
  const { article, tweetId, permalink } = ctx;
  const data = tweetId ? tweetDataStore.get(tweetId) : null;

  let text = data?.text || '';
  if (!text) {
    const textEl = article.querySelector('[data-testid="tweetText"]');
    text = (textEl?.textContent || '').trim();
  }
  // Expand t.co shortlinks into their real URLs / image markdown
  const urlMap = data?.urlMap;
  if (urlMap) {
    for (const short of Object.keys(urlMap)) {
      text = text.split(short).join(urlMap[short]);
    }
  }

  const { displayName, handle } = getAuthorInfo(article);
  const screenName = (handle || '').replace(/^@/, '');

  // Safety net: rewrite any leftover /i/article/<id> form (e.g. from text
  // assembled outside the urlMap path) to /<handle>/article/<tweetId>.
  if (screenName && tweetId) {
    text = text.replace(
      /https?:\/\/(?:x|twitter)\.com\/i\/article\/\d+/gi,
      `https://x.com/${screenName}/article/${tweetId}`
    );
  }
  // If this tweet is a long-form Article, prefer the full article body.
  if (data?.articleMd) {
    text = text ? `${data.articleMd}\n\n${text}` : data.articleMd;
  }

  const url = permalink || (screenName && tweetId ? `https://x.com/${screenName}/status/${tweetId}` : '');

  const createdAt = data?.createdAt ? new Date(data.createdAt) : null;
  const dateStr = createdAt && !isNaN(createdAt)
    ? formatLocalDateTime(createdAt)
    : '';

  const authorLabel = displayName && handle
    ? `${displayName} (${handle})`
    : (displayName || handle || i18n('contentFallbackTweetLabel'));
  const authorLine = url ? `[${authorLabel}](${url})` : authorLabel;
  const metaParts = [authorLine];
  if (dateStr) metaParts.push(dateStr);

  return `${text.trim()}\n\n— ${metaParts.join(' · ')}\n`;
}

function findVisibleCommentArticles(ctx) {
  if (!ctx?.article) return [];
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const start = articles.indexOf(ctx.article);
  if (start < 0) return [];
  const seen = new Set([ctx.tweetId].filter(Boolean));
  const comments = [];
  for (const article of articles.slice(start + 1)) {
    if (isArticleHiddenByXvmFilters(article)) continue;
    const tweetId = getTweetIdFromArticle(article);
    if (!tweetId || seen.has(tweetId)) continue;
    if (!isVisibleCommentArticleForContext(ctx, article, tweetId)) continue;
    seen.add(tweetId);
    comments.push(article);
  }
  return comments;
}

function isVisibleCommentArticleForContext(ctx, article, tweetId = '') {
  const rootTweetId = ctx?.tweetId || '';
  const data = tweetId ? tweetDataStore.get(tweetId) : null;
  if (data?.inReplyToStatusId) {
    return !!(rootTweetId && data.inReplyToStatusId === rootTweetId);
  }

  const rootHandle = getAuthorInfo(ctx.article).handle.replace(/^@/, '');
  if (!rootHandle) return false;
  const textEl = article.querySelector('[data-testid="tweetText"]');
  const text = (textEl?.textContent || '').trim();
  return new RegExp(`^@${rootHandle}\\b`, 'i').test(text);
}

function buildTweetWithVisibleCommentsMarkdown(ctx) {
  const tweetMd = buildTweetMarkdown(ctx).trim();
  const comments = findVisibleCommentArticles(ctx)
    .map((article) => createShareContextFromArticle(article))
    .filter((commentCtx) => commentCtx?.article)
    .map((commentCtx, idx) => `### ${idx + 1}\n\n${buildTweetMarkdown(commentCtx).trim()}`);
  if (!comments.length) return `${tweetMd}\n`;
  return [
    tweetMd,
    `## ${i18nOr('contentCopyTweetCommentsHeading', 'Comments')}`,
    comments.join('\n\n'),
  ].join('\n\n') + '\n';
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  // Fallback
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

const stickyToasts = new Set();

function dismissToast(toast) {
  if (!toast) return;
  stickyToasts.delete(toast);
  toast.classList.remove('xvm-toast--show');
  setTimeout(() => toast.remove(), 250);
}

function dismissStickyToasts() {
  for (const toast of Array.from(stickyToasts)) {
    dismissToast(toast);
  }
}

function showToast(msg, options = {}) {
  const {
    type = 'default',
    sticky = false,
    position = 'bottom',
    duration = 1400,
  } = options;
  const toast = document.createElement('div');
  toast.className = [
    'xvm-toast',
    type === 'error' ? 'xvm-toast--error' : type === 'success' ? 'xvm-toast--success' : '',
    position === 'top' ? 'xvm-toast--top' : '',
    sticky ? 'xvm-toast--sticky' : '',
  ].filter(Boolean).join(' ');
  toast.textContent = msg;
  if (sticky) {
    stickyToasts.add(toast);
    toast.addEventListener('click', () => dismissToast(toast), { once: true });
  }
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('xvm-toast--show'));
  if (!sticky) {
    setTimeout(() => dismissToast(toast), duration);
  }
}

function scheduleReleaseNotesModal() {
  if (!pendingReleaseNotesVersion) return;
  const run = () => showReleaseNotesModal(pendingReleaseNotesVersion);
  if (document.body) {
    setTimeout(run, 300);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(run, 300), { once: true });
  }
}

function closeReleaseNotesModal(version) {
  document.querySelector('.xvm-update-backdrop')?.remove();
  if (version) {
    window.postMessage({ type: 'XVM_RELEASE_NOTES_DISMISS', version }, '*');
  }
  if (pendingReleaseNotesVersion === version) pendingReleaseNotesVersion = '';
}

function showReleaseNotesModal(version) {
  if (!version || !document.body) return;
  if (document.querySelector('.xvm-update-backdrop')) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'xvm-update-backdrop';
  backdrop.setAttribute('data-theme', _resolvedTheme(_themePref));

  const dialog = document.createElement('div');
  dialog.className = 'xvm-update-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'xvm-update-title');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'xvm-update-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'xvm-update-eyebrow';
  eyebrow.textContent = `v${version}`;

  const title = document.createElement('h2');
  title.id = 'xvm-update-title';
  title.textContent = i18nOr('contentUpdateTitle', 'X Viral Monitor 已更新');

  const subtitle = document.createElement('p');
  subtitle.className = 'xvm-update-subtitle';
  subtitle.textContent = i18nOr('contentUpdateSubtitle', '这次更新里有几个容易错过的小功能：');

  const list = document.createElement('div');
  list.className = 'xvm-update-list';
  for (const [titleKey, bodyKey, fallbackTitle, fallbackBody] of RELEASE_NOTE_ITEMS) {
    const item = document.createElement('section');
    item.className = 'xvm-update-item';
    const itemTitle = document.createElement('h3');
    itemTitle.textContent = i18nOr(titleKey, fallbackTitle);
    const body = document.createElement('p');
    body.textContent = i18nOr(bodyKey, fallbackBody);
    item.append(itemTitle, body);
    list.appendChild(item);
  }

  const actions = document.createElement('div');
  actions.className = 'xvm-update-actions';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'xvm-update-primary';
  ok.textContent = i18nOr('contentUpdateDismiss', '知道了');
  actions.appendChild(ok);

  let onKeyDown = null;
  const dismiss = () => {
    if (onKeyDown) document.removeEventListener('keydown', onKeyDown, true);
    closeReleaseNotesModal(version);
  };
  close.addEventListener('click', dismiss);
  ok.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss();
  });
  onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    dismiss();
  };
  document.addEventListener('keydown', onKeyDown, true);

  dialog.append(close, eyebrow, title, subtitle, list, actions);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  ok.focus({ preventScroll: true });
}

function getStatusIdFromLocation() {
  const match = location.pathname.match(/\/status\/(\d+)/);
  return match?.[1] || '';
}

function findArticleForCurrentStatus() {
  const statusId = getStatusIdFromLocation();
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  if (!articles.length) return null;
  if (statusId) {
    for (const article of articles) {
      const id = getTweetIdFromArticle(article);
      if (id === statusId) return article;
      if (article.querySelector(`a[href*="/status/${statusId}"]`)) return article;
    }
  }
  return articles[0] || null;
}

function findReplyComposerRoot(editable) {
  if (!editable) return null;
  const dialog = editable.closest('[role="dialog"]');
  if (dialog?.querySelector?.('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')) return dialog;

  let node = editable;
  for (let depth = 0; node && depth < 32; depth++, node = node.parentElement) {
    if (node.querySelector?.('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')) return node;
    if (node.matches?.('article[data-testid="tweet"]')) break;
  }
  return editable.closest('form') || editable.parentElement || null;
}

function findReplyArticleForEnterShortcut(composerRoot) {
  const dialog = composerRoot?.closest?.('[role="dialog"]');
  if (dialog) {
    const article = dialog.querySelector?.('article[data-testid="tweet"]');
    return article || null;
  }
  const article = composerRoot?.querySelector?.('article[data-testid="tweet"]')
    || composerRoot?.closest?.('article[data-testid="tweet"]');
  if (article) return article;
  if (getStatusIdFromLocation()) return findArticleForCurrentStatus();
  return null;
}

const RECENT_REPLY_CONTEXT_TTL_MS = 30000;
let grokLastReplyClickAt = 0;

function hasRecentReplyClickContext() {
  return !!(grokLastReplyArticle?.isConnected && Date.now() - grokLastReplyClickAt <= RECENT_REPLY_CONTEXT_TTL_MS);
}

function findReplyArticleForAiComposer(composerRoot) {
  const visibleReplyArticle = findReplyArticleForEnterShortcut(composerRoot);
  if (visibleReplyArticle) return visibleReplyArticle;
  if (composerRoot?.closest?.('[role="dialog"]')) return null;
  if (location.pathname === '/compose/post' && hasRecentReplyClickContext()) {
    return grokLastReplyArticle;
  }
  if (getStatusIdFromLocation()) {
    return findArticleForCurrentStatus();
  }
  return null;
}

const GROK_SUBMIT_SELECTOR = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
function findReplySubmitButton(editable) {
  const root = findReplyComposerRoot(editable);
  const scope = root?.closest?.('[role="dialog"]') || root;
  return scope?.querySelector?.(GROK_SUBMIT_SELECTOR) || null;
}

function installEnterToReplyShortcut() {
  document.addEventListener('keydown', (event) => {
    if (!grokEnterToReply) return;
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.isComposing || event.keyCode === 229) return;

    const editable = event.target?.closest?.(
      '[data-testid="tweetTextarea_0"][contenteditable="true"], div[role="textbox"][contenteditable="true"], textarea[placeholder], textarea[aria-label]'
    );
    if (!editable) return;

    const composerRoot = findReplyComposerRoot(editable);
    if (!composerRoot || !findReplyArticleForAiComposer(composerRoot)) return;

    const submitBtn = findReplySubmitButton(editable);
    if (!submitBtn || submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true') return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    submitBtn.click();
  }, true);
}

// Remember which tweet the user clicked reply on, so Enter-to-reply still
// knows the target on /compose/post.
document.addEventListener('click', (e) => {
  const replyBtn = e.target.closest?.('[data-testid="reply"]');
  if (!replyBtn) return;
  const article = replyBtn.closest('article[data-testid="tweet"]');
  if (article) grokLastReplyArticle = article;
  grokLastReplyClickAt = Date.now();
}, true);

function closeOpenMenus() {
  // X's dropdown listens for outside pointerdown/mousedown on document to
  // auto-dismiss. Simulate that + Escape for belt-and-suspenders.
  const opts = { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 0 };
  try { document.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
  document.dispatchEvent(new MouseEvent('mousedown', opts));
  document.dispatchEvent(new MouseEvent('mouseup', opts));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  // Last resort: if the menu is still around next tick, remove its layer.
  setTimeout(() => {
    document.querySelectorAll('[data-testid="Dropdown"]').forEach((el) => {
      const layer = el.closest('[role="menu"]')?.parentElement?.parentElement;
      (layer || el).remove();
    });
  }, 60);
}

function menuItemLabel(item) {
  return `${item.getAttribute('aria-label') || ''} ${item.textContent || ''}`.toLowerCase();
}

function isArticleBlockInsertMenu(menuEl) {
  // X Articles' "+" inserter is a role="menu" too: 媒体 / GIF / 链接预览 /
  // LaTeX / … . It portals to the layer root, so it cannot be excluded by
  // ancestry. 链接预览 and リンクプレビュー are enough to identify it.
  const items = menuEl.querySelectorAll('[role="menuitem"]');
  for (const item of items) {
    if (/链接预览|リンクプレビュー|link preview|preview link|\blatex\b/.test(menuItemLabel(item))) {
      return true;
    }
  }
  return false;
}

function isShareMenu(menuEl) {
  // Only the native share dropdown, which contains a copy-link action.
  // A bare 链接 / リンク / *Link* test id also matches the article inserter
  // ("链接预览") and unrelated rows such as muteLink.
  if (isArticleBlockInsertMenu(menuEl)) return false;

  const testIdNodes = menuEl.querySelectorAll('[data-testid]');
  for (const node of testIdNodes) {
    const testid = node.getAttribute('data-testid') || '';
    if (/copy/i.test(testid) && /link/i.test(testid)) return true;
  }

  const items = menuEl.querySelectorAll('[role="menuitem"]');
  for (const item of items) {
    if (/copy link|copy post link|复制(?:帖子|推文)?链接|リンクをコピー/.test(menuItemLabel(item))) {
      return true;
    }
  }
  return false;
}

function replaceClonedMenuItemText(clone, titleText, attributionText) {
  const textSpans = clone.querySelectorAll('span');
  let labelSpan = clone.querySelector('.xvm-copy-md-source')?.parentElement || null;
  for (const s of textSpans) {
    if (labelSpan) break;
    if (s.children.length === 0 && (s.textContent || '').trim()) {
      labelSpan = s;
      break;
    }
  }
  if (labelSpan) {
    labelSpan.textContent = '';
    const title = document.createElement('span');
    title.textContent = titleText;
    const attribution = document.createElement('span');
    attribution.className = 'xvm-copy-md-source';
    attribution.textContent = attributionText;
    labelSpan.appendChild(title);
    labelSpan.appendChild(document.createElement('br'));
    labelSpan.appendChild(attribution);
  } else {
    clone.textContent = titleText;
  }
}

function injectCopyMarkdownItem(menuEl) {
  if (!copyAsMarkdownEnabled) return;
  if (menuEl.querySelector('.xvm-copy-md-item')) return;
  const items = menuEl.querySelectorAll('[role="menuitem"]');
  if (!items.length) return;

  // Clone an existing menuitem so we inherit X's hover/active styling.
  const template = items[items.length - 1];
  const clone = template.cloneNode(true);
  clone.classList.add('xvm-copy-md-item');
  clone.removeAttribute('data-testid');
  clone.querySelectorAll('[data-testid]').forEach((el) => el.removeAttribute('data-testid'));

  replaceClonedMenuItemText(clone, i18n('contentCopyMdLabel'), i18n('contentCopyMdAttribution'));

  // Swap the icon with a Markdown glyph
  const svg = clone.querySelector('svg');
  if (svg) {
    const mdIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    mdIcon.setAttribute('viewBox', '0 0 24 24');
    mdIcon.setAttribute('width', svg.getAttribute('width') || '18');
    mdIcon.setAttribute('height', svg.getAttribute('height') || '18');
    mdIcon.setAttribute('aria-hidden', 'true');
    mdIcon.style.fill = 'currentColor';
    mdIcon.innerHTML = '<path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm2 3v8h2v-5l2 3 2-3v5h2V8H9.5L8 10.5 6.5 8H5zm11 0v4h-2l3 4 3-4h-2V8h-2z"/>';
    svg.replaceWith(mdIcon);
  }

  // cloneNode(true) already drops React/native listeners — just preventDefault
  // for any <a> navigation and let native CSS hover/active still work.
  clone.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const ctx = lastShareContext;
    if (!ctx || !ctx.article || !ctx.article.isConnected) {
      showToast(i18n('contentCopyMdNoTweetFound'));
      closeOpenMenus();
      return;
    }
    const md = buildTweetMarkdown(ctx);
    const ok = await copyTextToClipboard(md);
    showToast(ok ? i18n('contentCopyMdDone') : i18n('contentCopyMdCopyFailed'));
    closeOpenMenus();
  });

  // Insert as the very last menuitem, matching the original group's parent.
  const lastItem = items[items.length - 1];
  lastItem.parentNode.appendChild(clone);
}

function injectCopyTweetCommentsItem(menuEl) {
  if (!copyAsMarkdownEnabled) return;
  if (menuEl.querySelector('.xvm-copy-comments-item')) return;
  const copyItem = menuEl.querySelector('.xvm-copy-md-item');
  if (!copyItem?.parentNode) return;

  const clone = copyItem.cloneNode(true);
  clone.classList.remove('xvm-copy-md-item');
  clone.classList.add('xvm-copy-comments-item');
  replaceClonedMenuItemText(
    clone,
    i18n('contentCopyTweetCommentsLabel'),
    i18n('contentCopyMdAttribution')
  );

  const svg = clone.querySelector('svg');
  if (svg) {
    const commentsIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    commentsIcon.setAttribute('viewBox', '0 0 24 24');
    commentsIcon.setAttribute('width', svg.getAttribute('width') || '18');
    commentsIcon.setAttribute('height', svg.getAttribute('height') || '18');
    commentsIcon.setAttribute('aria-hidden', 'true');
    commentsIcon.style.fill = 'currentColor';
    commentsIcon.innerHTML = '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2h9A3.5 3.5 0 0 1 20 5.5v6A3.5 3.5 0 0 1 16.5 15H11l-4.4 4.1c-.7.6-1.6.1-1.6-.8v-3.6A3.5 3.5 0 0 1 4 12.5v-7Zm3.5-1.3A1.3 1.3 0 0 0 6.2 5.5v7c0 .7.6 1.3 1.3 1.3h.7v2.2l2.3-2.2h6A1.3 1.3 0 0 0 17.8 12.5v-7a1.3 1.3 0 0 0-1.3-1.3h-9Z"/>';
    svg.replaceWith(commentsIcon);
  }

  clone.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const ctx = lastShareContext;
    if (!ctx || !ctx.article || !ctx.article.isConnected) {
      showToast(i18n('contentCopyMdNoTweetFound'));
      closeOpenMenus();
      return;
    }
    const md = buildTweetWithVisibleCommentsMarkdown(ctx);
    const ok = await copyTextToClipboard(md);
    showToast(ok ? i18n('contentCopyTweetCommentsDone') : i18n('contentCopyMdCopyFailed'));
    closeOpenMenus();
  });

  copyItem.parentNode.insertBefore(clone, copyItem.nextSibling);
}

const menuObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      const menus = [];
      if (node.matches?.('[role="menu"]')) menus.push(node);
      node.querySelectorAll?.('[role="menu"]').forEach((el) => menus.push(el));
      for (const menu of menus) {
        if (!isShareMenu(menu)) continue;
        injectCopyMarkdownItem(menu);
        injectCopyTweetCommentsItem(menu);
      }
    }
  }
});

function startMenuObserver() {
  menuObserver.observe(document.body, { childList: true, subtree: true });
}
if (document.body) startMenuObserver();
else document.addEventListener('DOMContentLoaded', startMenuObserver);

// ---------------------------------------------------------------------------
// Back-navigation scroll-restore guard.
//
// X's SPA + virtual list often lands Back at the wrong window (Chrome clamps
// programmatic scroll while feed height is still short). We do NOT cover the
// UI with a freeze/snapshot overlay — clones ghost and misalign at the header.
//
// Light restore only:
//   - Save tweetId + viewport offset (+ up to 8 visible anchors) on click.
//   - On browser Back / BFCache: suppress X window.scrollTo/By (and scrollTop)
//     briefly; wait for a plausible feed cell; ONE fine pin (repin only if
//     drift persists). Never clamped coarse while scrollMax < want.y.
//   - Prefer wait-for-anchor over coarse wake; at most one coarse after height
//     quiets if the cell is still missing.
//   - Pin/repin uses a short custom ease (~260ms) for the deep return hop;
//     coarse and tiny corrections stay instant (native smooth fights the VL).
//   - Quiet early-exit; no blank veil; no freeze overlay.
//   - Cancel on real user scroll intent. Sidebar Home is not restored.
(() => {
  const HIDE_SEL = '[data-xvm-content-filter-hidden], [data-xvm-rate-hidden]';
  const MAX_ANCHORS = 8;
  const POST_GUARD_FEED_MS = 1600; // hard cap only
  const POST_GUARD_HIDE_MS = 2200;
  const QUIET_STABLE_MS = 160; // finish pinning this long after |d|<=24
  const DEFEND_PAD_MS = 400;
  const DEFEND_TAIL_MS = 700; // keep suppressing X after pin loop ends
  const PIN_THRESH = 24;
  const QUIET_THRESH = 96; // same band as REPIN — if we won't move again, finish
  const REPIN_THRESH = 96; // avoid chase from virtualizer height churn
  const REPIN_PERSIST_MS = 90; // drift must persist before re-pin
  // Early coarse while scrollHeight is still rocketing lands in a phantom
  // virtual window. Wait for height to quiet before the single wake.
  const HEIGHT_STABLE_MS = 100;
  const HEIGHT_STABLE_PX = 280;
  const COARSE_FALLBACK_MS = 420; // if height never quiets, wake anyway
  const saved = new Map(); // pageKey -> {y, anchors:[{id,top}], clickTs?}
  let watch = null;
  let recScheduled = false;

  try { history.scrollRestoration = 'manual'; } catch (_) {}

  let defendUntil = 0;
  let allowScroll = false;
  let suppressedScrolls = 0;
  let restoreRun = null;
  const dbgOn = () => !!(typeof window !== 'undefined' && window.__xvmScrollRestoreDebug);
  const dbgGeom = () => {
    const se = document.scrollingElement || document.documentElement;
    const sh = Math.max(
      se?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
    );
    const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
    return {
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(sh),
      scrollMax: Math.max(0, Math.round(sh - vh)),
      vh: Math.round(vh),
    };
  };
  const dbgPush = (type, extra) => {
    if (!dbgOn() || !restoreRun) return;
    const g = dbgGeom();
    const ev = { t: Math.round(performance.now() - restoreRun.t0), type, ...g, ...extra };
    restoreRun.events.push(ev);
    try {
      const log = (window.__xvmScrollRestoreLog = window.__xvmScrollRestoreLog || []);
      log.push({ ...ev, runId: restoreRun.runId });
      if (log.length > 2000) log.splice(0, log.length - 2000);
    } catch (_) {}
  };
  // High-freq (~rAF) height/scroll sampler while a restore is active.
  let hfRaf = 0;
  let hfLastY = null;
  let hfLastDir = 0; // -1 up (Y↓), +1 down (Y↑)
  let hfOsc = [];
  const stopHf = () => {
    if (hfRaf) {
      try { cancelAnimationFrame(hfRaf); } catch (_) {}
      hfRaf = 0;
    }
  };
  const startHf = () => {
    stopHf();
    if (!dbgOn() || !restoreRun) return;
    hfLastY = window.scrollY;
    hfLastDir = 0;
    hfOsc = [];
    restoreRun.hf = restoreRun.hf || [];
    restoreRun.oscillations = restoreRun.oscillations || [];
    const tick = () => {
      if (!restoreRun) { hfRaf = 0; return; }
      const g = dbgGeom();
      const y = g.scrollY;
      const dy = hfLastY == null ? 0 : y - hfLastY;
      const sample = {
        t: Math.round(performance.now() - restoreRun.t0),
        ...g,
        dy,
      };
      const last = restoreRun.hf[restoreRun.hf.length - 1];
      if (!last
          || Math.abs(y - last.scrollY) >= 2
          || Math.abs(g.scrollHeight - last.scrollHeight) >= 8
          || sample.t - last.t >= 48) {
        restoreRun.hf.push(sample);
        if (restoreRun.hf.length > 400) restoreRun.hf.splice(0, restoreRun.hf.length - 400);
      }
      if (Math.abs(dy) >= 48) {
        const dir = dy < 0 ? -1 : 1;
        if (hfLastDir && dir !== hfLastDir) {
          const osc = {
            t: sample.t,
            fromY: Math.round(hfLastY),
            toY: y,
            prevDir: hfLastDir < 0 ? 'up' : 'down',
            nextDir: dir < 0 ? 'up' : 'down',
            scrollMax: g.scrollMax,
            scrollHeight: g.scrollHeight,
          };
          hfOsc.push(osc);
          restoreRun.oscillations.push(osc);
          dbgPush('oscillation', osc);
        }
        hfLastDir = dir;
        hfLastY = y;
      } else if (hfLastY == null) {
        hfLastY = y;
      }
      hfRaf = requestAnimationFrame(tick);
    };
    hfRaf = requestAnimationFrame(tick);
  };
  const natScrollTo = window.scrollTo.bind(window);
  const natScrollBy = window.scrollBy.bind(window);
  const inDefend = () => performance.now() < defendUntil;
  const bumpDefend = (ms) => {
    const until = performance.now() + ms;
    if (until > defendUntil) defendUntil = until;
  };
  const scrollEl = () => document.scrollingElement || document.documentElement;
  function pageScrollHeight() {
    const se = scrollEl();
    return Math.max(
      se?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
    );
  }
  function maxScrollY() {
    const sh = pageScrollHeight();
    const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
    return Math.max(0, sh - vh);
  }
  function canReachY(y) {
    return maxScrollY() >= Math.max(0, Math.round(y)) - 32;
  }
  // Pin/repin: short custom ease (~260ms). Native behavior:"smooth" fights
  // X's virtualizer (cells unload mid-tween). Coarse stays instant. Small
  // deltas snap — smooth only helps the unavoidable deep return hop.
  const EASE_MS = 260;
  const EASE_MIN_DIST = 120; // px; below this, instant is cleaner
  let easeRaf = 0;
  let easeToken = 0;
  let easeTarget = null;
  function cancelEase() {
    if (easeRaf) {
      try { cancelAnimationFrame(easeRaf); } catch (_) {}
      easeRaf = 0;
    }
    easeToken += 1;
    easeTarget = null;
  }
  function forceScrollBehaviorAuto() {
    try {
      const root = document.documentElement;
      if (root && root.style) root.style.scrollBehavior = 'auto';
      if (document.body && document.body.style) document.body.style.scrollBehavior = 'auto';
    } catch (_) {}
  }
  function writeScrollY(y) {
    forceScrollBehaviorAuto();
    const target = Math.max(0, Math.round(y));
    allowScroll = true;
    try {
      natScrollTo(0, target);
      const se = scrollEl();
      if (se && Math.abs((se.scrollTop || 0) - target) > 1) {
        try { se.scrollTop = target; } catch (_) {}
      }
    } finally {
      allowScroll = false;
    }
  }
  function writeScrollYSoft(y) {
    // Intermediate ease frames: prefer scrollTop so we own the tween and
    // do not flood window.scrollTo (tests + X listeners).
    forceScrollBehaviorAuto();
    const target = Math.max(0, Math.round(y));
    allowScroll = true;
    try {
      const se = scrollEl();
      if (se) {
        try { se.scrollTop = target; } catch (_) { natScrollTo(0, target); }
      } else {
        natScrollTo(0, target);
      }
    } finally {
      allowScroll = false;
    }
  }
  function noteControlledMove(kind, target) {
    if (!restoreRun) return;
    restoreRun.jumps += 1;
    if (kind === 'coarse') restoreRun.coarse += 1;
    else if (kind === 'pin' || kind === 'repin') {
      if (restoreRun.firstPinAt == null) restoreRun.firstPinAt = performance.now() - restoreRun.t0;
      if (kind === 'repin') restoreRun.repins += 1;
      else restoreRun.pins += 1;
    }
    restoreRun.lastMoveAt = performance.now() - restoreRun.t0;
    dbgPush(kind || 'scroll', { y: target, scrollY: window.scrollY, max: maxScrollY() });
  }
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  function controlledScrollTo(y, kind) {
    const target = Math.max(0, Math.round(y));
    // Refuse clamped coarse: a no-op clamp is still a visible hop to the wrong window.
    if (kind === 'coarse' && !canReachY(target)) {
      dbgPush('coarse_skip_clamp', { y: target, max: maxScrollY(), scrollY: window.scrollY });
      return false;
    }
    const from = window.scrollY;
    const dist = Math.abs(target - from);
    const wantEase = (kind === 'pin' || kind === 'repin') && dist >= EASE_MIN_DIST;

    // Already easing to the same place — coalesce (step() re-calls every frame).
    if (wantEase && easeRaf && easeTarget != null && Math.abs(easeTarget - target) <= 48) {
      return true;
    }

    if (!wantEase) {
      cancelEase();
      writeScrollY(target);
      noteControlledMove(kind, target);
      return true;
    }

    cancelEase();
    easeTarget = target;
    const token = easeToken;
    const t0 = performance.now();
    const startY = from;
    const delta = target - startY;
    noteControlledMove(kind, target);
    bumpDefend(EASE_MS + DEFEND_PAD_MS);
    dbgPush('ease_start', { from: Math.round(startY), to: target, ms: EASE_MS });

    const tick = () => {
      if (token !== easeToken) return;
      const elapsed = performance.now() - t0;
      const t = Math.min(1, elapsed / EASE_MS);
      const yNow = startY + delta * easeOutCubic(t);
      if (t >= 1) {
        easeRaf = 0;
        easeTarget = null;
        writeScrollY(target);
        dbgPush('ease_end', { y: target, scrollY: window.scrollY });
        return;
      }
      writeScrollYSoft(yNow);
      easeRaf = requestAnimationFrame(tick);
    };
    easeRaf = requestAnimationFrame(tick);
    return true;
  }
  window.scrollTo = function (...args) {
    if (inDefend() && !allowScroll) {
      suppressedScrolls += 1;
      if (restoreRun) restoreRun.suppressed += 1;
      dbgPush('suppress_scrollTo');
      return;
    }
    return natScrollTo(...args);
  };
  window.scrollBy = function (...args) {
    if (inDefend() && !allowScroll) {
      suppressedScrolls += 1;
      if (restoreRun) restoreRun.suppressed += 1;
      dbgPush('suppress_scrollBy');
      return;
    }
    return natScrollBy(...args);
  };
  // X sometimes sets scrollingElement.scrollTop directly (bypassing
  // window.scrollTo). Hold the property during defend; our controlled
  // path sets allowScroll first so it still writes.
  (function hookScrollTop() {
    const targets = [];
    try { if (document.documentElement) targets.push(document.documentElement); } catch (_) {}
    try {
      const se = document.scrollingElement;
      if (se && se !== document.documentElement) targets.push(se);
    } catch (_) {}
    for (const el of targets) {
      try {
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
          || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'scrollTop');
        if (!desc || !desc.set || el.__xvmScrollTopHooked) continue;
        const rawGet = desc.get.bind(el);
        const rawSet = desc.set.bind(el);
        Object.defineProperty(el, 'scrollTop', {
          configurable: true,
          get() { return rawGet(); },
          set(v) {
            if (inDefend() && !allowScroll) {
              suppressedScrolls += 1;
              if (restoreRun) restoreRun.suppressed += 1;
              dbgPush('suppress_scrollTop');
              return;
            }
            rawSet(v);
          },
        });
        el.__xvmScrollTopHooked = true;
      } catch (_) {}
    }
  })();
  try {
    Object.defineProperty(window, '__xvmScrollRestoreLast', {
      configurable: true,
      get() { return restoreRun ? { ...restoreRun, events: restoreRun.events.slice() } : window.__xvmScrollRestoreFinished || null; },
    });
  } catch (_) {}

  const pageKey = () => {
    const m = window.location.pathname.match(/\/status\/(\d+)/);
    if (m) return m[1];
    let path = window.location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/') path = '/home';
    return path;
  };

  const isFeedKey = (id) => typeof id === 'string' && id.startsWith('/');

  const hadHides = new Set();
  function pageHasHides(id) {
    if (document.querySelector(HIDE_SEL)) {
      if (id) hadHides.add(id);
      return true;
    }
    return id ? hadHides.has(id) : false;
  }

  function shouldArm(id) {
    if (!id) return false;
    if (isFeedKey(id)) return true;
    return pageHasHides(id);
  }

  function isUsableArticle(art) {
    if (!art) return false;
    if (art.matches?.(HIDE_SEL) || art.closest?.(HIDE_SEL)) return false;
    if (art.closest?.('[role="dialog"], [aria-hidden="true"], [hidden], [inert]')) return false;
    const r = art.getBoundingClientRect();
    return r.height > 0 && r.width > 0;
  }

  function feedShellReady(id) {
    if (!isFeedKey(id)) return true;
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (!primary) return true;
    if (id === '/home') return !!primary.querySelector('[role="tablist"]');
    return true;
  }

  function expectedDocTop(want, anchorTop) {
    return (want?.y || 0) + (Number.isFinite(anchorTop) ? anchorTop : (want?.anchorTop || 0));
  }

  // Reject detail leftovers / wrong-window cells: their document Y is nowhere
  // near the saved reading position (classic false pin to y≈174).
  function isPlausibleHit(art, want, anchorTop) {
    if (!art || !want) return false;
    const docTop = window.scrollY + art.getBoundingClientRect().top;
    const expected = expectedDocTop(want, anchorTop);
    const slack = Math.max(900, Math.min(2800, Math.abs(want.y) * 0.22 + 500));
    if (Math.abs(docTop - expected) <= slack) return true;
    // Deep save + shallow cell while we still cannot scroll there → leftover.
    if (want.y > (window.innerHeight || 800) && !canReachY(want.y)) {
      if (docTop < (window.innerHeight || 800) * 2) return false;
    }
    return false;
  }

  function collectVisibleAnchors(preferArt) {
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const out = [];
    const seen = new Set();
    const push = (art) => {
      if (!isUsableArticle(art)) return;
      const tid = getTweetIdFromArticle(art);
      if (!tid || seen.has(tid)) return;
      seen.add(tid);
      out.push({
        id: tid,
        top: Math.round(art.getBoundingClientRect().top),
      });
    };
    if (preferArt) push(preferArt);
    const fully = [];
    const partial = [];
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (preferArt && art === preferArt) continue;
      if (!isUsableArticle(art)) continue;
      const r = art.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= viewportHeight) continue;
      const tid = getTweetIdFromArticle(art);
      if (!tid) continue;
      const entry = { art, top: r.top, tid };
      if (r.top >= 0 && r.bottom <= viewportHeight) fully.push(entry);
      else partial.push(entry);
    }
    fully.sort((a, b) => a.top - b.top);
    partial.sort((a, b) => {
      const score = (t) => (t.top >= 0 ? t.top : viewportHeight + Math.abs(t.top));
      return score(a) - score(b);
    });
    for (const entry of [...fully, ...partial]) {
      if (seen.has(entry.tid)) continue;
      seen.add(entry.tid);
      out.push({ id: entry.tid, top: Math.round(entry.top) });
      if (out.length >= MAX_ANCHORS) break;
    }
    return out.slice(0, MAX_ANCHORS);
  }

  function findAnchorArticle(anchorId, targetTop) {
    if (!anchorId) return null;
    let best = null;
    let bestScore = Infinity;
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (getTweetIdFromArticle(art) !== anchorId) continue;
      if (!isUsableArticle(art)) continue;
      const top = art.getBoundingClientRect().top;
      const score = Number.isFinite(targetTop) ? Math.abs(top - targetTop) : 0;
      // Prefer cells whose document position is deeper when multiple copies
      // exist (detail leftover near top vs feed cell).
      const docTop = window.scrollY + top;
      const depthBias = docTop < 400 ? 50 : 0;
      const s = score + depthBias;
      if (s < bestScore) {
        best = art;
        bestScore = s;
      }
    }
    return best;
  }

  function findBestAvailable(want) {
    const list = Array.isArray(want?.anchors) && want.anchors.length
      ? want.anchors
      : (want?.anchorId ? [{ id: want.anchorId, top: want.anchorTop || 0 }] : []);
    // Prefer clicked id (anchors[0]) when plausible; then fallbacks.
    for (const a of list) {
      const art = findAnchorArticle(a.id, a.top);
      if (art && isPlausibleHit(art, want, a.top)) return { art, top: a.top, id: a.id };
    }
    return null;
  }

  document.addEventListener('pointerdown', (e) => {
    if (watch) return;
    const id = pageKey();
    if (!shouldArm(id)) return;
    const art = e.target?.closest?.('article[data-testid="tweet"]');
    if (!art || art.closest('[role="dialog"]')) return;
    if (art.matches(HIDE_SEL) || art.closest(HIDE_SEL)) return;
    const tid = getTweetIdFromArticle(art);
    if (!tid) return;
    const anchors = collectVisibleAnchors(art);
    if (!anchors.length) {
      anchors.push({
        id: tid,
        top: Math.round(art.getBoundingClientRect().top),
      });
    }
    saved.set(id, {
      y: Math.round(window.scrollY),
      anchors,
      anchorId: anchors[0].id,
      anchorTop: anchors[0].top,
      clickTs: performance.now(),
    });
  }, true);

  function record() {
    if (recScheduled || watch) return;
    recScheduled = true;
    requestAnimationFrame(() => {
      recScheduled = false;
      if (watch) return;
      const id = pageKey();
      if (!shouldArm(id)) {
        if (id) saved.delete(id);
        return;
      }
      const prev = saved.get(id);
      if (prev && prev.clickTs !== undefined && performance.now() - prev.clickTs < 2000) return;
      const anchors = collectVisibleAnchors(null);
      saved.set(id, {
        y: Math.round(window.scrollY),
        anchors,
        anchorId: anchors[0]?.id || null,
        anchorTop: anchors[0]?.top || 0,
      });
    });
  }
  window.addEventListener('scroll', record, { passive: true });

  function beginRestore(source) {
    const id = pageKey();
    const want = id && saved.get(id);
    if (!want) return;
    const hasHides = pageHasHides(id);
    const needsRepin = hasHides || isFeedKey(id);
    const postGuardMs = hasHides ? POST_GUARD_HIDE_MS : POST_GUARD_FEED_MS;
    if (watch && typeof watch.abort === 'function') {
      try { watch.abort(); } catch (_) {}
    }
    const state = { id, source };
    watch = state;
    const t0 = performance.now();
    if (dbgOn()) {
      restoreRun = {
        runId: Math.round(t0),
        source,
        id,
        t0,
        jumps: 0,
        coarse: 0,
        pins: 0,
        repins: 0,
        suppressed: 0,
        firstPinAt: null,
        lastMoveAt: 0,
        finishedAt: null,
        events: [],
      };
      dbgPush('begin', {
        wantY: want.y,
        max: maxScrollY(),
        canReach: canReachY(want.y),
        anchors: (want.anchors || []).length,
      });
      startHf();
    } else {
      restoreRun = null;
      stopHf();
    }
    bumpDefend(postGuardMs + DEFEND_PAD_MS);
    let lastY = window.scrollY;
    let lastMove = t0;
    let pinned = false;
    let didCoarse = false;
    let stableSince = null;
    let driftSince = null;
    let mo = null;
    const finish = (reason = 'quiet') => {
      if (watch === state) watch = null;
      cancelEase();
      if (mo) {
        try { mo.disconnect(); } catch (_) {}
        mo = null;
      }
      for (const ev of USER_EVENTS) window.removeEventListener(ev, onUserInput);
      // User cancel / hard stop → drop defend. Quiet success → keep
      // suppressing X briefly so its late scrollTo cannot yank us off.
      if (reason === 'user' || reason === 'timeout' || reason === 'hard') {
        defendUntil = 0;
      } else {
        bumpDefend(DEFEND_TAIL_MS);
      }
      if (restoreRun && restoreRun.t0 === t0) {
        restoreRun.finishedAt = performance.now() - t0;
        restoreRun.stableAt = restoreRun.lastMoveAt ?? restoreRun.firstPinAt ?? restoreRun.finishedAt;
        restoreRun.finishReason = reason;
        stopHf();
        const dirs = (restoreRun.oscillations || []).map((o) => `${o.prevDir[0]}>${o.nextDir[0]}`);
        restoreRun.flashPattern = dirs.join('|') || 'none';
        dbgPush('finish', {
          reason,
          jumps: restoreRun.jumps,
          coarse: restoreRun.coarse,
          pins: restoreRun.pins,
          repins: restoreRun.repins,
          suppressed: restoreRun.suppressed,
          firstPinAt: restoreRun.firstPinAt,
          stableAt: restoreRun.stableAt,
          finishedAt: restoreRun.finishedAt,
          defendTailMs: reason === 'user' || reason === 'timeout' || reason === 'hard' ? 0 : DEFEND_TAIL_MS,
          oscillations: (restoreRun.oscillations || []).length,
          flashPattern: restoreRun.flashPattern,
          hfSamples: (restoreRun.hf || []).length,
        });
        try {
          window.__xvmScrollRestoreFinished = {
            ...restoreRun,
            events: restoreRun.events.slice(),
            hf: (restoreRun.hf || []).slice(),
            oscillations: (restoreRun.oscillations || []).slice(),
          };
        } catch (_) {}
        restoreRun = null;
      } else {
        stopHf();
      }
    };
    state.abort = () => finish('hard');
    const USER_EVENTS = ['wheel', 'touchstart', 'mousedown', 'keydown'];
    const SCROLL_KEYS = new Set([
      'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Space',
    ]);
    const onUserInput = (e) => {
      if (e.type === 'wheel' && Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (e.type === 'keydown') {
        const key = e.key || e.code;
        if (!SCROLL_KEYS.has(key)) return;
      }
      finish('user');
    };
    for (const ev of USER_EVENTS) window.addEventListener(ev, onUserInput, { passive: true });

    const applyPin = (hit, d, now) => {
      const thresh = pinned ? REPIN_THRESH : PIN_THRESH;
      if (Math.abs(d) > thresh) {
        if (pinned) {
          if (driftSince == null) driftSince = now;
          if (now - driftSince < REPIN_PERSIST_MS) {
            dbgPush('repin_wait', { d, waited: Math.round(now - driftSince) });
            return false;
          }
        }
        controlledScrollTo(window.scrollY + d, pinned ? 'repin' : 'pin');
        lastY = window.scrollY;
        lastMove = now;
        stableSince = null;
        driftSince = null;
        bumpDefend(DEFEND_PAD_MS + 200);
        pinned = true;
        return true;
      }
      driftSince = null;
      if (restoreRun && restoreRun.firstPinAt == null) {
        restoreRun.firstPinAt = now - restoreRun.t0;
        restoreRun.pins += 1;
        dbgPush('pin_noop', { d, id: hit.id });
      }
      if (stableSince == null) stableSince = now;
      pinned = true;
      return true;
    };
    const tryPinNow = () => {
      if (!feedShellReady(id)) return false;
      const hit = findBestAvailable(want);
      if (!hit) return false;
      const d = hit.art.getBoundingClientRect().top - hit.top;
      return applyPin(hit, d, performance.now());
    };

    // Height-stability tracker: avoid coarse into a still-growing virtual list.
    let lastSh = pageScrollHeight();
    let shQuietSince = t0;
    const noteHeight = (now) => {
      const sh = pageScrollHeight();
      if (Math.abs(sh - lastSh) >= HEIGHT_STABLE_PX) {
        lastSh = sh;
        shQuietSince = now;
        dbgPush('height_grow', { sh, max: maxScrollY() });
        return false;
      }
      lastSh = sh;
      return (now - shQuietSince) >= HEIGHT_STABLE_MS;
    };
    const mayCoarse = (now) => {
      if (didCoarse) return false;
      if (!canReachY(want.y)) return false;
      if (Math.abs(window.scrollY - want.y) <= PIN_THRESH) return false;
      const quiet = noteHeight(now);
      const waited = now - t0;
      // Prefer quiet height; fall back so we never stall forever.
      return quiet || waited >= COARSE_FALLBACK_MS;
    };

    // First paint: pin if plausible anchor ready. Never coarse on the
    // first frame — height is almost always mid-growth right after Back.
    if (!tryPinNow()) {
      dbgPush('wait_anchor', { scrollY: window.scrollY, max: maxScrollY(), wantY: want.y, sh: lastSh });
    }

    if (needsRepin && typeof MutationObserver === 'function') {
      try {
        mo = new MutationObserver(() => {
          if (watch !== state) return;
          lastMove = performance.now();
        });
        mo.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            'data-xvm-rate-hidden',
            'data-xvm-content-filter-hidden',
            'data-xvm-rate-filter-on',
            'style',
            'class',
          ],
        });
      } catch (_) {
        mo = null;
      }
    }

    const step = () => {
      if (watch !== state) return;
      const now = performance.now();
      const y = window.scrollY;
      if (Math.abs(y - lastY) > 1) {
        lastY = y;
        lastMove = now;
      }
      if (now - t0 > 5000) return finish('timeout');

      bumpDefend(Math.max(0, postGuardMs - (now - t0)) + DEFEND_PAD_MS);

      // Keep height tracker warm every frame (also while shell not ready).
      noteHeight(now);

      if (!feedShellReady(id)) {
        if (mayCoarse(now)) {
          if (controlledScrollTo(want.y, 'coarse')) {
            didCoarse = true;
            lastY = window.scrollY;
            lastMove = now;
            shQuietSince = now;
            lastSh = pageScrollHeight();
          }
        }
        if (now - t0 > 3500) return finish('timeout');
        requestAnimationFrame(step);
        return;
      }

      const hit = findBestAvailable(want);
      if (hit) {
        const d = hit.art.getBoundingClientRect().top - hit.top;
        applyPin(hit, d, now);
        // Quiet early-exit after a good pin. Pending repin_wait delays exit.
        if (pinned && driftSince == null && stableSince != null
            && now - stableSince >= QUIET_STABLE_MS && Math.abs(d) <= QUIET_THRESH) {
          return finish('quiet');
        }
        if (pinned && driftSince == null && now - t0 > postGuardMs && Math.abs(d) <= QUIET_THRESH) {
          return finish('cap');
        }
      } else {
        driftSince = null;
        // Virtualizer height churn often unmounts the cell for a frame after
        // a good pin. Keep stableSince if we are still near the saved Y so
        // quiet-exit can fire.
        const nearWant = Math.abs(y - want.y) <= Math.max(PIN_THRESH * 5, 140);
        if (!(pinned && nearWant)) stableSince = null;
        else if (stableSince == null) stableSince = now;
        if (pinned && nearWant && stableSince != null
            && now - stableSince >= QUIET_STABLE_MS) {
          return finish('quiet_near');
        }
        // Prefer pin when the cell is mounted. Otherwise one coarse wake
        // only after height has quieted (or fallback timeout). Never coarse
        // again after a successful pin.
        if (tryPinNow()) {
          lastY = window.scrollY;
          lastMove = now;
        } else if (!pinned && mayCoarse(now)) {
          if (controlledScrollTo(want.y, 'coarse')) {
            didCoarse = true;
            lastY = window.scrollY;
            lastMove = now;
            shQuietSince = now;
            lastSh = pageScrollHeight();
          }
        }
        if (now - t0 > 3500) return finish('timeout');
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  window.addEventListener('popstate', () => beginRestore('popstate'));
  window.addEventListener('pageshow', (e) => {
    if (e && e.persisted) beginRestore('bfcache');
  });
})();

