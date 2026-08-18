// board.js — the vault Project board (Boards/Projects.md, an Obsidian Kanban auto-generated from
// Projects/*.md frontmatter), fetched LIVE from the private second-brain repo via the GitHub API
// with a read-only fine-grained PAT stored only in this browser. Falls back to a committed snapshot.
//
// Why GitHub directly and not Vault Bridge: the bridge holds no credentials of its own — it proxies
// GitHub REST with the caller's OAuth token. A static page can't run that OAuth flow, so the same
// read (`GET /repos/{owner}/{repo}/contents/{path}`) is made here with a scoped token.

const CACHE_KEY = 'atlas.board.cache.v1';

export const BOARD_DEFAULTS = { token: '', repo: 'tbalt88/second-brain', path: 'Boards/Projects.md', branch: 'main', enabled: true };

// Parse Kanban markdown: "## <column>" headers, "- [ ] **[[Name]]** · `status` · 12 open · url" cards.
export function parseBoard(md) {
  const columns = []; let cur = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(/^##\s+(.*)$/);
    if (h) { cur = { title: h[1].trim(), cards: [] }; columns.push(cur); continue; }
    const c = line.match(/^-\s+\[( |x|X)\]\s+(.*)$/);
    if (c && cur) {
      const done = c[1].toLowerCase() === 'x';
      const body = c[2];
      const nameM = body.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      const name = nameM ? (nameM[2] || nameM[1]).trim() : body.replace(/\*\*/g, '').split('·')[0].trim();
      const notePath = nameM ? nameM[1].trim() : null;
      const parts = body.split('·').map(s => s.trim()).slice(1);
      let status = null, open = null, url = null; const extra = [];
      for (const p of parts) {
        const s = p.match(/^`([^`]+)`$/); if (s) { status = s[1]; continue; }
        const o = p.match(/^(\d+)\s+open$/i); if (o) { open = +o[1]; continue; }
        if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(p) || /^https?:\/\//i.test(p)) { url = /^https?:/i.test(p) ? p : 'https://' + p; continue; }
        if (p) extra.push(p);
      }
      cur.cards.push({ name, notePath, status, open, url, extra, done, column: cur.title });
    }
  }
  return columns.filter(col => col.title && !/^for future/i.test(col.title));
}

export function columnKind(title) {
  const t = title.toLowerCase();
  if (/active|wip|progress/.test(t)) return 'active';
  if (/ship|done|complete|closed/.test(t)) return /closed|complete/.test(t) ? 'closed' : 'shipped';
  if (/park|hold|defer|idea/.test(t)) return 'parked';
  return 'other';
}

export function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; } }
function writeCache(obj) { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); }

// Fetch live via GitHub contents API. Returns {ok, markdown, sha, fetched_at, notModified} or {ok:false, error}.
export async function fetchBoardLive(cfg, { timeoutMs = 8000 } = {}) {
  if (!cfg?.token) return { ok: false, error: 'no token' };
  const cached = readCache();
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${cfg.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(cfg.branch || 'main')}`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (r.status === 304 && cached) return { ...cached, ok: true, notModified: true };
    if (!r.ok) return { ok: false, error: `GitHub ${r.status}${r.status === 401 || r.status === 404 ? ' (check token scope: Contents read on ' + cfg.repo + ')' : ''}` };
    const j = await r.json();
    const markdown = decodeURIComponent(escape(atob((j.content || '').replace(/\n/g, ''))));
    const out = { ok: true, markdown, sha: j.sha, etag: r.headers.get('etag'), fetched_at: new Date().toISOString(), html_url: j.html_url };
    writeCache(out);
    return out;
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch failed') }; }
  finally { clearTimeout(t); }
}

// Snapshot committed in the repo (site/board.snapshot.json) — always available, may be stale.
export async function fetchBoardSnapshot() {
  try { const r = await fetch('board.snapshot.json?' + Math.floor(Date.now() / 3600000)); if (!r.ok) return null; return await r.json(); } catch { return null; }
}

// Flatten to the "projects" shape the assistant's prompt uses.
export function boardToProjects(columns) {
  return columns.flatMap(col => col.cards.map(c => ({
    slug: c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: c.name, status: c.status || columnKind(col.title),
    column: col.title, summary: [c.status ? `status ${c.status}` : '', c.open != null ? `${c.open} open tasks` : '', c.url || ''].filter(Boolean).join(' · '),
    uses: [], tags: ['vault-board'], brief: '', url: c.url, notePath: c.notePath, source: 'board',
  })));
}
