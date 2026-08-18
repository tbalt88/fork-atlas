// private.js — LIVE private repos, browser-side only. Nothing here is ever persisted to the repo:
// the page lists the owner's private repositories straight from GitHub with a read-only token
// stored in this browser, turns them into lightweight records, and merges them into the search
// index. READMEs are fetched on demand (when a private repo is shortlisted for a question) and
// cached in localStorage. No LLM classification is stored for these; they sit in a "Private (live)"
// bucket. If you want write-once classification for private repos too, that is the "private
// overlay" design (separate private repo), not this file.

const CACHE_KEY = 'atlas.private.cache.v1';
const README_KEY = 'atlas.private.readme.v1';
const README_TTL_MS = 24 * 3600 * 1000;

export const PRIVATE_DEFAULTS = { token: '', enabled: true, includeReadme: true, includeForks: false };

const H = token => ({ Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' });

function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; } }
function writeCache(o) { localStorage.setItem(CACHE_KEY, JSON.stringify(o)); }

// Returns {ok, repos:[...GitHub repo objects], fetched_at, fromCache} or {ok:false, error}
export async function fetchPrivateRepos(cfg, { timeoutMs = 10000 } = {}) {
  if (!cfg?.token) return { ok: false, error: 'no token' };
  const cached = readCache();
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const repos = [];
    let page = 1, etagFirst = null, notModified = false;
    while (page <= 5) {
      const url = `https://api.github.com/user/repos?visibility=private&affiliation=owner&per_page=100&sort=pushed&page=${page}`;
      const headers = H(cfg.token);
      if (page === 1 && cached?.etag) headers['If-None-Match'] = cached.etag;
      const r = await fetch(url, { headers, signal: ctl.signal });
      if (page === 1 && r.status === 304 && cached) { notModified = true; break; }
      if (!r.ok) return { ok: false, error: `GitHub ${r.status}${r.status === 401 || r.status === 403 ? ' (token needs Metadata + Contents read on all repos)' : ''}` };
      if (page === 1) etagFirst = r.headers.get('etag');
      const batch = await r.json();
      repos.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    if (notModified) return { ...cached, ok: true, fromCache: true };
    const out = { ok: true, repos: repos.filter(x => x.private && (cfg.includeForks || !x.fork)).map(slim), etag: etagFirst, fetched_at: new Date().toISOString() };
    writeCache(out);
    return out;
  } catch (e) {
    if (cached) return { ...cached, ok: true, fromCache: true, stale: true, error: e.name === 'AbortError' ? 'timeout' : e.message };
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch failed') };
  } finally { clearTimeout(t); }
}

function slim(r) {
  return {
    full_name: r.full_name, name: r.name, html_url: r.html_url, description: r.description || '', language: r.language,
    topics: r.topics || [], stars: r.stargazers_count || 0, pushed_at: r.pushed_at, created_at: r.created_at,
    archived: !!r.archived, fork: !!r.fork, default_branch: r.default_branch, homepage: r.homepage || null,
    license: r.license?.spdx_id || null,
  };
}

// Convert to the matrix item shape so search, cards, drawer, keeper and prompts all just work.
export function toItem(p) {
  const kw = [...new Set([...(p.topics || []), ...(p.language ? [p.language.toLowerCase()] : [])])];
  return {
    id: p.full_name, name: p.name, relation: 'private', private: true,
    fork_url: p.html_url, forked_at: p.created_at, upstream: p.full_name, upstream_url: p.html_url, upstream_deleted: false,
    description: p.description || '', stars: p.stars || 0, language: p.language, topics: p.topics || [], pushed_at: p.pushed_at,
    archived: !!p.archived, license: p.license, homepage: p.homepage, signals: [], actions: {},
    status: 'private', domain: 'private', domain_label: 'Private (live)', form: 'unclassified', form_label: 'Unclassified',
    maturity: null, analysis: '', use_cases: [], keywords: kw, confidence: null, proposed_domain: null, needs_review: false,
    classified_at: null, note: null, pinned: false, overridden: false,
  };
}

// README on demand, cached 24h. Returns text (truncated) or ''.
export async function fetchReadme(cfg, full_name, { maxChars = 3000, timeoutMs = 8000 } = {}) {
  if (!cfg?.token) return '';
  let cache = {}; try { cache = JSON.parse(localStorage.getItem(README_KEY) || '{}'); } catch { cache = {}; }
  const hit = cache[full_name];
  if (hit && Date.now() - hit.at < README_TTL_MS) return hit.text;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.github.com/repos/${full_name}/readme`, { headers: H(cfg.token), signal: ctl.signal });
    if (!r.ok) { cache[full_name] = { at: Date.now(), text: '' }; localStorage.setItem(README_KEY, JSON.stringify(cache)); return ''; }
    const j = await r.json();
    const text = decodeURIComponent(escape(atob((j.content || '').replace(/\n/g, '')))).slice(0, maxChars);
    cache[full_name] = { at: Date.now(), text };
    // keep the cache bounded
    const keys = Object.keys(cache); if (keys.length > 60) keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 60).forEach(k => delete cache[k]);
    localStorage.setItem(README_KEY, JSON.stringify(cache));
    return text;
  } catch { return hit?.text || ''; }
  finally { clearTimeout(t); }
}

export function clearPrivateCache() { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(README_KEY); }
