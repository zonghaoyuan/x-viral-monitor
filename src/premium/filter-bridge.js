// === Filter settings bridge (ISOLATED world) ===
// Local build (2026-11-11): split out of the removed license bridge
// (src/premium/license/isolated.js). Forwards the popup's rate-filter and
// content-filter settings to the MAIN-world filters, and keeps the remote
// content-filter rules fresh. No license or trial logic remains.
(() => {
  if (window.__xvmFilterBridge) return; // idempotent on hot reload
  window.__xvmFilterBridge = true;

  const RATE_FILTER_KEY = 'xvm_rate_filter_v1';
  const CONTENT_FILTER_KEY = 'xvm_content_filter_v1';
  const CONTENT_FILTER_RULES_KEY = 'xvm_content_filter_rules_remote_v1';

  // Remote rules: fetched from the repo's canonical rules.json so we can
  // ship new filter heuristics without rebuilding the extension. Cached in
  // chrome.storage with a 6h TTL; cold-start falls back to the bundled
  // rules.js when cache is empty AND fetch fails.
  const REMOTE_RULES_URL = 'https://raw.githubusercontent.com/Icy-Cat/x-viral-monitor/main/src/premium/content-filter/rules.json';
  const REMOTE_RULES_TTL_MS = 6 * 60 * 60 * 1000;
  // Even on failure, never re-attempt more than once per 5 min. Multi-tab
  // users would otherwise hammer raw.githubusercontent.com per page load.
  const REMOTE_RULES_MIN_RETRY_MS = 5 * 60 * 1000;
  const REMOTE_RULES_SCHEMA_MAX = 2;
  const REMOTE_RULES_CURRENT_VERSION = 2;


  function safeStorageGet(key, fallback) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) return resolve(fallback);
        chrome.storage.local.get(key, (o) => resolve(o?.[key] ?? fallback));
      } catch (_) { resolve(fallback); }
    });
  }
  function safeStorageSet(obj) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) return resolve();
        chrome.storage.local.set(obj, resolve);
      } catch (_) { resolve(); }
    });
  }
  function safeStorageRemove(key) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) return resolve();
        chrome.storage.local.remove(key, resolve);
      } catch (_) { resolve(); }
    });
  }

  // ─── Rate filter settings bridge ────────────────────────────────────
  // Popup (extension context) owns xvm_rate_filter_v1; filter.js (MAIN
  // world) needs to react to changes. We forward the storage value as
  // XVM_RATE_SETTINGS_UPDATE postMessage at boot + on every change.
  async function pushRateSettings() {
    const settings = await safeStorageGet(RATE_FILTER_KEY, null);
    if (settings && typeof settings === 'object') {
      window.postMessage({ type: 'XVM_RATE_SETTINGS_UPDATE', settings }, '*');
    }
  }

  async function pushContentFilterSettings() {
    const settings = await safeStorageGet(CONTENT_FILTER_KEY, null);
    if (settings && typeof settings === 'object') {
      window.postMessage({ type: 'XVM_CONTENT_FILTER_SETTINGS_UPDATE', settings }, '*');
    }
  }

  // ─── Remote content-filter rules ────────────────────────────────────
  // Validate the shape AND contents. A broken/malicious remote payload
  // should not wipe out the cached-or-bundled rules and should not be
  // able to inject a regex that catastrophically backtracks per reply.
  const RULE_TYPES_ALLOWED = new Set(['keyword', 'regex', 'domain', 'short-symbol']);
  const RULE_FIELDS_ALLOWED = new Set(['name', 'screen_name', 'bio', 'location', 'content', 'url']);
  const RULE_SEVERITIES_ALLOWED = new Set(['low', 'medium', 'high', 'block']);
  // Spam rule unions can legitimately get long (we've shipped a
  // 278-char content-funnel union; the previous 240 cap silently
  // rejected the whole payload). 400 still blocks obviously-crafted
  // catastrophic regexes paired with the nested-quantifier heuristic.
  const REGEX_MAX_LEN = 400;
  // Catastrophic backtracking heuristic: nested unbounded quantifiers
  // like (.+)+ / (.*)*. Not exhaustive but blocks the obvious foot-guns.
  const REGEX_NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)[+*?]/;

  function isValidRule(rule) {
    if (!rule || typeof rule !== 'object') return false;
    if (!RULE_TYPES_ALLOWED.has(rule.type)) return false;
    if (rule.field && !RULE_FIELDS_ALLOWED.has(rule.field)) return false;
    if (!RULE_SEVERITIES_ALLOWED.has(rule.severity)) return false;
    if (typeof rule.value !== 'string' || !rule.value.length) return false;
    if (rule.type === 'regex') {
      if (rule.value.length > REGEX_MAX_LEN) return false;
      if (REGEX_NESTED_QUANTIFIER.test(rule.value)) return false;
      try { new RegExp(rule.value, 'iu'); } catch (_) { return false; }
    }
    return true;
  }

  function isValidRulesPayload(p) {
    if (!p || typeof p !== 'object') return false;
    if (p.version !== REMOTE_RULES_CURRENT_VERSION) return false;
    if (!p.levels || typeof p.levels !== 'object') return false;
    if (!Array.isArray(p.rules)) return false;
    if (typeof p.version === 'number' && p.version > REMOTE_RULES_SCHEMA_MAX) return false;
    // Reject the whole payload if ANY rule is invalid. Partial trust is a
    // bigger surface to reason about than all-or-nothing.
    return p.rules.every(isValidRule);
  }

  async function pushCachedContentFilterRules() {
    const cached = await safeStorageGet(CONTENT_FILTER_RULES_KEY, null);
    if (cached && isValidRulesPayload(cached.payload)) {
      window.postMessage({
        type: 'XVM_CONTENT_FILTER_RULES_UPDATE',
        rules: cached.payload,
        source: 'remote-cache',
        fetchedAt: cached.fetchedAt || 0,
      }, '*');
      return cached;
    }
    return null;
  }

  async function fetchRemoteContentFilterRules({ force = false } = {}) {
    const cached = await safeStorageGet(CONTENT_FILTER_RULES_KEY, null);
    const cachedValid = cached && isValidRulesPayload(cached.payload);
    const now = Date.now();
    if (!force) {
      // Successful fetch within TTL → skip.
      if (cachedValid && cached.fetchedAt && (now - cached.fetchedAt) < REMOTE_RULES_TTL_MS) return;
      // Recent attempt (success or failure) within retry floor → skip so
      // a flapping network or down origin can't trigger a request per page.
      if (cachedValid && cached.lastAttemptedAt && (now - cached.lastAttemptedAt) < REMOTE_RULES_MIN_RETRY_MS) return;
    }
    let payload = null;
    try {
      const res = await fetch(REMOTE_RULES_URL, { cache: 'no-cache' });
      if (res.ok) {
        const json = await res.json();
        if (isValidRulesPayload(json)) payload = json;
      }
    } catch (_) {
      // Network error: fall through to mark the attempt.
    }
    if (payload) {
      const record = { fetchedAt: now, lastAttemptedAt: now, payload };
      await safeStorageSet({ [CONTENT_FILTER_RULES_KEY]: record });
      window.postMessage({
        type: 'XVM_CONTENT_FILTER_RULES_UPDATE',
        rules: payload,
        source: 'remote-fresh',
        fetchedAt: record.fetchedAt,
      }, '*');
    } else if (cachedValid) {
      // Failed fetch — keep payload, just record the attempt so we throttle.
      await safeStorageSet({ [CONTENT_FILTER_RULES_KEY]: { ...cached, lastAttemptedAt: now } });
    } else {
      // No cache and fetch failed — write a stub so retry-throttle applies.
      await safeStorageSet({ [CONTENT_FILTER_RULES_KEY]: { lastAttemptedAt: now } });
    }
  }

  // ─── Message router ─────────────────────────────────────────────────
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const t = event.data?.type;
    if (t === 'XVM_CONTENT_FILTER_RULES_REFRESH') {
      await fetchRemoteContentFilterRules({ force: true });
      window.postMessage({ type: 'XVM_CONTENT_FILTER_RULES_REFRESH_DONE' }, '*');
    }
  });

  // ─── Bootstrap ──────────────────────────────────────────────────────
  (async () => {
    pushRateSettings();
    pushContentFilterSettings();
    await pushCachedContentFilterRules();
    fetchRemoteContentFilterRules().catch(() => {});
  })();

  try {
    chrome?.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== 'local') return;
      if (RATE_FILTER_KEY in changes) pushRateSettings();
      if (CONTENT_FILTER_KEY in changes) pushContentFilterSettings();
      if (CONTENT_FILTER_RULES_KEY in changes) pushCachedContentFilterRules();
    });
  } catch (_) {}
})();
