// agent.js — Fork Atlas assistant: keeper panel (no LLM), lexical search, two-stage Q&A.
import { BM25, rankForBrief, itemText, tokenize } from './retrieval.js';
import { loadConfig, saveConfig, probeOllama, pickOllamaModels, resolveProvider, complete, DEFAULTS } from './llm.js';
import { SHORTLIST_SCHEMA, ANSWER_SCHEMA, SHORTLIST_SYSTEM, ANSWER_SYSTEM, shortlistUser, answerUser, VALIDATE_SCHEMA, VALIDATE_SYSTEM, validateUser } from './prompts.js';
import { parseBoard, columnKind, fetchBoardLive, fetchBoardSnapshot, boardToProjects, readCache } from './board.js';
import { fetchPrivateRepos, toItem as privateToItem, fetchReadme, clearPrivateCache } from './private.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = s => (s || '').slice(0, 10);
const HIST_KEY = 'atlas.history.v1', VISIT_KEY = 'atlas.lastVisit';

let matrix, items, byId, compactById, projects = [], boardProjects = [], index, cfg, active = { provider: null, status: {} }, abort;
let privateItems = [], privateMeta = { state: 'off', text: '' };

// ---------------------------------------------------------------- boot
(async function boot() {
  const bust = '?' + Math.floor(Date.now() / 60000);
  const [m, c, p] = await Promise.all([
    fetch('matrix.json' + bust).then(r => r.json()),
    fetch('index.compact.json' + bust).then(r => r.json()),
    fetch('projects.json' + bust).then(r => r.json()).catch(() => ({ projects: [] })),
  ]);
  matrix = m; items = m.items; byId = new Map(items.map(i => [i.id, i]));
  compactById = new Map(c.items.map(i => [i.id, i])); projects = p.projects || [];
  index = new BM25(items, itemText);
  window.__atlas = { index, items, rankForBrief, tokenize };  // debugging handle (read-only)
  renderKeeper(); renderHistory();
  const langs = [...new Set(items.map(i => i.language).filter(Boolean))].sort();
  langs.forEach(l => { const o = document.createElement('option'); o.value = l; o.textContent = l; $('#lang').appendChild(o); });
  cfg = loadConfig();
  loadBoard();            // lazy: snapshot/cache first, live overlay when it arrives — never blocks the page
  loadPrivate();          // lazy: private repos straight from GitHub (browser token), merged into search when they arrive
  await refreshProvider();
  localStorage.setItem(VISIT_KEY, new Date().toISOString());
  const q = new URLSearchParams(location.search).get('q'); if (q) { $('#brief').value = q; ask(); }
})();

async function refreshProvider() {
  active = await resolveProvider(cfg);
  const pill = $('#pill');
  pill.classList.remove('ok', 'warn');
  if (active.provider === 'ollama') { pill.classList.add('ok'); $('#pillText').textContent = `Ollama · ${cfg.ollama.reasonModel}`; }
  else if (active.provider === 'anthropic') { pill.classList.add('ok'); $('#pillText').textContent = `Anthropic · ${cfg.anthropic.reasonModel}`; }
  else { pill.classList.add('warn'); $('#pillText').textContent = 'no LLM · search-only mode'; }
  pill.title = Object.entries(active.status).filter(([k]) => k !== 'ollamaModels').map(([k, v]) => `${k}: ${v}`).join('\n');
}

// ---------------------------------------------------------------- keeper
function renderKeeper() {
  const last = localStorage.getItem(VISIT_KEY);
  const since = last ? items.filter(i => i.forked_at > last) : [];
  const recent = items.filter(i => Date.now() - Date.parse(i.forked_at) < 7 * 864e5);
  const unclassified = items.filter(i => i.status !== 'classified' && !i.private);
  const review = items.filter(i => i.needs_review);
  const usedIds = new Set([...projects.flatMap(p => p.uses || []), ...items.filter(i => i.pinned || i.note).map(i => i.id)]);
  const risky = items.filter(i => usedIds.has(i.id) && (i.archived || i.upstream_deleted || i.maturity === 'dormant'));
  const dormantAll = items.filter(i => i.archived || i.upstream_deleted).length;
  const cronForks = items.filter(i => (i.relation || 'fork') === 'fork' && i.actions?.enabled && (i.actions.scheduled_runs || 0) > 0);
  const cronFailing = cronForks.filter(i => (i.actions.failing_scheduled || []).length);
  const el = $('#keeper');
  const tile = (n, label, cls = '') => `<div class="tile ${cls}"><b>${n}</b><span>${label}</span></div>`;
  el.innerHTML = `<h2>Keeper</h2>
    <div class="tiles">
      ${tile(items.filter(i => !i.private).length, 'repos tracked')}
      ${tile(recent.length, 'forked last 7 days', recent.length ? 'ok' : '')}
      ${tile(unclassified.length, 'unclassified', unclassified.length ? 'warn' : '')}
      ${tile(review.length, 'need review', review.length ? 'warn' : '')}
      ${tile(dormantAll, 'archived / gone')}
      ${tile(cronForks.length, 'forks running upstream crons', cronForks.length ? 'warn' : 'ok')}
      ${tile(privateItems.length, 'private repos (live, this browser)', privateMeta.state === 'error' ? 'warn' : privateItems.length ? 'ok' : '')}
      ${tile(`<span style="font-size:15px;line-height:1.5">${fmtDate(matrix.generated_at)}</span>`, 'catalog updated')}
    </div>
    ${privateMeta.text ? `<div class="muted" style="margin-top:6px;font-size:11px;${privateMeta.state === 'error' ? 'color:var(--warn)' : ''}">${privateMeta.state === 'error' ? '⚠ ' : ''}${esc(privateMeta.text)}</div>` : ''}
    ${cronForks.length ? nag(`${cronForks.length} fork${cronForks.length > 1 ? 's' : ''} run upstream scheduled workflows on your account${cronFailing.length ? ` (${cronFailing.length} failing → emails)` : ''}: ${cronForks.slice(0, 6).map(i => esc(i.name)).join(', ')}${cronForks.length > 6 ? '…' : ''}. Say to Claude Code:`, PROMPTS.crons) : ''}
    ${since.length ? `<h2 style="margin-top:12px">New since your last visit${last ? ' (' + fmtDate(last) + ')' : ''}</h2><ul class="plain">${since.slice(0, 8).map(i => `<li><a href="index.html#${encodeURIComponent(JSON.stringify({ q: i.name }))}">${esc(i.upstream || i.name)}</a> <span class="muted">${esc(i.domain_label)}</span></li>`).join('')}${since.length > 8 ? `<li class="muted">+${since.length - 8} more</li>` : ''}</ul>` : ''}
    ${staleNotes(unclassified.length)}
    ${risky.length ? `<h2 style="margin-top:12px">Watch — used/pinned repos at risk</h2><ul class="plain">${risky.map(i => `<li>${esc(i.upstream)} <span class="tag warn">${i.archived ? 'archived' : i.upstream_deleted ? 'upstream gone' : 'dormant'}</span></li>`).join('')}</ul>` : ''}`;
}

// ---------------------------------------------------------------- private repos (live, browser-only)
async function loadPrivate() {
  if (!cfg.priv?.enabled || !cfg.priv?.token) { privateMeta = { state: 'off', text: 'add a read-only GitHub token in ⚙ to search private repos' }; renderKeeper(); return; }
  privateMeta = { state: 'loading', text: 'loading private repos…' }; renderKeeper();
  const r = await fetchPrivateRepos(cfg.priv);
  if (!r.ok) { privateMeta = { state: 'error', text: r.error }; renderKeeper(); return; }
  // replace any previous private items, then rebuild the index over public + private
  items = items.filter(i => !i.private);
  privateItems = r.repos.map(privateToItem);
  items = [...items, ...privateItems];
  byId = new Map(items.map(i => [i.id, i]));
  privateItems.forEach(p => compactById.set(p.id, { id: p.id, rel: 'private', d: 'private', f: 'unclassified', m: null, s: p.stars, l: p.language, one: p.description.slice(0, 220), kw: p.keywords.slice(0, 10), uc: [], note: null }));
  index = new BM25(items, itemText);
  window.__atlas = { index, items, rankForBrief, tokenize };
  privateMeta = { state: 'live', text: `${privateItems.length} private repos in search · ${r.fromCache ? 'cached' : 'live'} ${fmtDate(r.fetched_at)}${r.stale ? ' (stale: ' + r.error + ')' : ''}` };
  renderKeeper();
}

// ---------------------------------------------------------------- staleness — the page carries the runbook so Dexter doesn't have to
const daysSince = iso => iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : null;
const PROMPTS = {
  classify: 'Classify unclassified forks in fork-atlas (prepare → Sonnet fan-out → ingest → build → push).',
  board: 'Refresh the fork-atlas Project board snapshot from vault-bridge (Boards/Projects.md) and push.',
  action: 'Check why the fork-atlas nightly Action stopped building (gh run list in tbalt88/fork-atlas) and fix it.',
  crons: 'In fork-atlas, list forks whose upstream scheduled workflows run on my account and disable GitHub Actions on them (gh api PUT repos/<fork>/actions/permissions enabled=false), then rebuild.',
};
const nag = (title, prompt) => `<div class="nag"><b>${esc(title)}</b><div class="row" style="gap:6px;margin-top:4px"><code style="flex:1;white-space:normal">${esc(prompt)}</code><button class="ghost" data-copy="${esc(prompt)}" style="padding:3px 8px;font-size:11px">copy</button></div></div>`;
function staleNotes(unclassifiedCount) {
  const out = [];
  const built = daysSince(matrix.generated_at);
  if (built != null && built > 3) out.push(nag(`Catalog last built ${built} days ago — the nightly Action may be broken. Say to Claude Code:`, PROMPTS.action));
  if (unclassifiedCount) out.push(nag(`${unclassifiedCount} new fork${unclassifiedCount > 1 ? 's' : ''} need the one-shot LLM pass. Say to Claude Code:`, PROMPTS.classify));
  return out.length ? `<div style="margin-top:10px">${out.join('')}</div>` : '';
}
document.addEventListener('click', e => { const b = e.target.closest('[data-copy]'); if (b) copy(b.dataset.copy); });

// ---------------------------------------------------------------- Project board (vault Boards/Projects.md)
// Order of truth: live (GitHub API + PAT) > browser cache of last live > committed snapshot.
async function loadBoard() {
  const el = $('#projects');
  const cached = readCache();
  if (cached?.markdown) renderBoard(cached.markdown, { kind: 'cached', at: cached.fetched_at, url: cached.html_url });
  else {
    el.innerHTML = '<h2>Project board</h2><div class="muted">loading…</div>';
    const snap = await fetchBoardSnapshot();
    if (snap?.markdown) renderBoard(snap.markdown, { kind: 'snapshot', at: snap.fetched_at });
    else el.innerHTML = '<h2>Project board</h2><div class="muted">no snapshot; add a GitHub token in ⚙ to load live.</div>';
  }
  if (!cfg.board?.enabled || !cfg.board?.token) { markBoard('offline', 'add a read-only GitHub token in ⚙ to go live'); return; }
  markBoard('loading', 'refreshing from vault…');
  const live = await fetchBoardLive(cfg.board);
  if (live.ok) renderBoard(live.markdown, { kind: 'live', at: live.fetched_at, url: live.html_url || (readCache()?.html_url) });
  else markBoard('error', live.error);
}

function markBoard(state, text) {
  const h = $('#boardHint'); if (!h) return;
  h.textContent = state === 'loading' ? '⟳ ' + text : state === 'error' ? '⚠ ' + text : text;
  h.style.color = state === 'error' ? 'var(--warn)' : '';
  h.title = text;
}

function renderBoard(markdown, meta) {
  const cols = parseBoard(markdown);
  boardProjects = boardToProjects(cols);
  const label = meta.kind === 'live' ? `live · ${fmtDate(meta.at)}` : meta.kind === 'cached' ? `cached · ${fmtDate(meta.at)}` : `snapshot · ${fmtDate(meta.at)}`;
  const el = $('#projects');
  el.innerHTML = `<h2 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">Project board <span id="boardState" class="tag ${meta.kind === 'live' ? 'ok' : ''}" style="text-transform:none;letter-spacing:0;font-weight:500">${label}</span>
      ${meta.url ? `<a class="muted" style="margin-left:auto;font-size:11px" href="${esc(meta.url)}" target="_blank" rel="noopener">open ↗</a>` : ''}</h2>
    <div id="boardHint" class="muted" style="margin:-6px 0 8px;font-size:11px;text-transform:none;letter-spacing:0"></div>` +
    (meta.kind !== 'live' && daysSince(meta.at) > 7 ? nag(`Board ${meta.kind} is ${daysSince(meta.at)} days old. Add a GitHub token in ⚙ for live, or say to Claude Code:`, PROMPTS.board) : '') +
    cols.map(col => {
      const kind = columnKind(col.title);
      const collapsed = kind === 'closed' || (kind === 'parked' && !col.cards.length);
      if (!col.cards.length) return `<div class="bcol"><div class="bhead muted">${esc(col.title)} <span class="muted">— empty</span></div></div>`;
      return `<details class="bcol" ${collapsed ? '' : 'open'}><summary class="bhead">${esc(col.title)} <span class="muted">${col.cards.length}</span></summary>
        ${col.cards.map(c => `<div class="bcard ${c.done ? 'done' : ''}">
          <span class="bname">${esc(c.name)}</span>
          ${c.status ? `<span class="tag ${kind === 'active' ? 'dom' : ''}">${esc(c.status)}</span>` : ''}
          ${c.open != null ? `<span class="muted">${c.open} open</span>` : ''}
          ${c.url ? `<a class="muted" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url.replace(/^https?:\/\//, ''))}</a>` : ''}
        </div>`).join('')}</details>`;
    }).join('') +
    (projects.length ? `<details class="bcol"><summary class="bhead">Atlas briefs <span class="muted">${projects.length}</span></summary>${projects.map(p => `<div class="bcard"><span class="bname">${esc(p.name)}</span><span class="tag">${esc(p.status)}</span>${p.uses?.length ? `<span class="muted">uses ${p.uses.map(u => esc(u.split('/')[1] || u)).join(', ')}</span>` : ''}</div>`).join('')}</details>` : '');
}

function history() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } }
function pushHistory(entry) { const h = [entry, ...history().filter(e => e.brief !== entry.brief)].slice(0, 12); localStorage.setItem(HIST_KEY, JSON.stringify(h)); renderHistory(); }
function renderHistory() {
  const h = history(); const el = $('#history');
  el.innerHTML = '<h2>Recent questions</h2>' + (h.length ? h.map((e, i) => `<button data-i="${i}" title="${esc(e.brief)}">${esc(e.brief.slice(0, 70))}${e.brief.length > 70 ? '…' : ''}<br><span class="muted">${fmtDate(e.at)} · ${e.provider || 'search'}</span></button>`).join('') : '<div class="muted">none yet</div>');
  el.querySelectorAll('button').forEach(b => b.onclick = () => { const e = h[+b.dataset.i]; $('#brief').value = e.brief; if (e.answer) renderAnswer(e.answer, e.context || [], e.requirements || []); else ask(); });
}

// ---------------------------------------------------------------- filters + candidates
function boostFn() {
  const selfHosted = $('#selfHosted').checked, minMat = $('#minMat').value, lang = $('#lang').value;
  return it => {
    let w = 1;
    if (selfHosted && !(it.keywords.includes('self-hosted') || it.signals.includes('docker'))) w *= 0.6;
    if (minMat === 'active' && (it.maturity === 'toy' || it.maturity === 'dormant')) w *= 0.5;
    if (minMat === 'production' && it.maturity !== 'production') w *= 0.4;
    if (lang && it.language !== lang) w *= 0.7;
    if (it.archived || it.upstream_deleted) w *= 0.7;
    return w;
  };
}

function setSteps(states) {
  $('#steps').innerHTML = ['lexical rank', 'LLM shortlist', 'reasoning'].map((n, i) => `<span class="step ${states[i] || ''}">${i + 1}. ${n}</span>`).join('');
}

// ---------------------------------------------------------------- lexical only
function lexicalOnly() {
  const brief = $('#brief').value.trim(); if (!brief) return;
  const { requirements, ranked } = rankForBrief(index, brief, { n: 25, boost: boostFn() });
  setSteps(['done']);
  $('#stream').hidden = true;
  $('#out').innerHTML = `<div class="answer"><h3>Ranked candidates (no model)</h3>
    ${requirements.length ? `<p class="muted">Requirements parsed: ${requirements.map((r, i) => `<b>${String.fromCharCode(97 + i)})</b> ${esc(r)}`).join(' · ')}</p>` : ''}
    <ol class="lex">${ranked.map(r => `<li><a href="index.html#${encodeURIComponent(JSON.stringify({ q: r.item.name }))}"><b>${esc(r.item.upstream || r.item.id)}</b></a> <span class="tag dom">${esc(r.item.domain_label)}</span> <span class="tag">${esc(r.item.form_label)}</span> ${r.hits.size ? `<span class="hits">hits ${[...r.hits].map(i => String.fromCharCode(97 + i)).join(',')}</span>` : ''}<br><span class="muted">${esc((r.item.analysis || r.item.description).slice(0, 180))}</span>${r.item.use_cases.length ? `<br><span class="muted">use: ${esc(r.item.use_cases.slice(0, 2).map(u => u.title).join(' · '))}</span>` : ''}</li>`).join('')}</ol>
    ${ranked.length ? '' : '<p class="muted">Nothing matched. Try different words.</p>'}</div>`;
  pushHistory({ brief, at: new Date().toISOString(), provider: null });
}

// ---------------------------------------------------------------- full pipeline
async function ask() {
  const brief = $('#brief').value.trim(); if (!brief) return;
  if (!active.provider) { lexicalOnly(); return; }
  abort?.abort(); abort = new AbortController();
  $('#ask').disabled = true; $('#out').innerHTML = ''; $('#stream').hidden = false; $('#stream').textContent = '';
  const onToken = (_, all) => { $('#stream').textContent = all.slice(-1500); $('#stream').scrollTop = 1e9; };
  try {
    setSteps(['on']);
    // Local models: smaller candidate pool + smaller reasoning context (laptop GPUs prefill slowly).
    const local = active.provider === 'ollama';
    let { requirements, ranked } = rankForBrief(index, brief, { n: local ? 28 : 40, boost: boostFn() });
    // Short/free-form briefs give BM25 little to grip: widen the pool so the LLM shortlist can recover synonyms
    if (requirements.length <= 1) ranked = rankForBrief(index, brief, { n: local ? 40 : 60, boost: boostFn() }).ranked;
    if (!requirements.length) requirements = [brief.slice(0, 200)];
    const cands = ranked.map(r => compactById.get(r.item.id)).filter(Boolean);
    setSteps(['done', 'on']);
    let short;
    try {
      short = await complete({ provider: active.provider, cfg, slot: 'shortlist', system: SHORTLIST_SYSTEM, user: shortlistUser(brief, requirements, cands), schema: SHORTLIST_SCHEMA, onToken, signal: abort.signal });
    } catch (e) { console.warn('shortlist failed, falling back to lexical top-12', e); short = { candidates: ranked.slice(0, 12).map(r => ({ id: r.item.id, covers: [], hint: '' })), uncovered: [] }; }
    const picked = new Set(short.candidates.map(c => c.id).filter(id => byId.has(id)));
    ranked.slice(0, local ? 3 : 6).forEach(r => picked.add(r.item.id));  // lexical never fully loses
    const records = [...picked].slice(0, local ? 10 : 16).map(id => byId.get(id));
    // private repos have no stored analysis: pull README on demand (bounded) so the reasoning stage has substance
    if (cfg.priv?.includeReadme && cfg.priv?.token) {
      const privs = records.filter(r => r.private && !r.analysis).slice(0, 6);
      await Promise.all(privs.map(async r => { const md = await fetchReadme(cfg.priv, r.id); if (md) r.analysis = 'README (private repo, live): ' + md.replace(/\s+/g, ' ').slice(0, 900); }));
    }
    const allProjects = [...boardProjects, ...projects];
    const relProjects = allProjects.filter(p => (p.uses || []).some(u => picked.has(u)) || tokenOverlap(brief, p.name + ' ' + p.summary + ' ' + (p.tags || []).join(' ')));
    // always give the model the WHOLE board (it's small) so it can say "already built: Dex Fabric (shipped)"
    const activeBoard = boardProjects.filter(p => !relProjects.includes(p)).map(p => ({ ...p, brief: '' }));
    setSteps(['done', 'done', 'on']);
    $('#stream').textContent = '';
    const boardCtx = [...relProjects, ...activeBoard.slice(0, 12)];
    const answer = await complete({ provider: active.provider, cfg, slot: 'reason', system: ANSWER_SYSTEM, user: answerUser(brief, requirements, records, boardCtx, local), schema: ANSWER_SCHEMA, onToken, signal: abort.signal });
    normalizeAnswer(answer, requirements);
    groundAnswer(answer, records, requirements);   // first pass: deterministic, instant — record facts beat model claims
    setSteps(['done', 'done', 'done']); $('#stream').hidden = true;
    renderAnswer(answer, records.map(r => r.id), requirements);
    const hist = { brief, at: new Date().toISOString(), provider: `${active.provider}/${cfg[active.provider].reasonModel}`, answer, context: records.map(r => r.id), requirements };
    pushHistory(hist);
    // second pass: a separate validator run, lazy — the answer is already on screen; verdicts patch it in place
    validateAnswer({ brief, requirements, records, answer, projects: boardCtx, signal: abort.signal }).then(v => { if (v) { hist.answer = answer; pushHistory(hist); } });
  } catch (e) {
    if (e.name !== 'AbortError') { const errBox = `<div class="err">${esc(e.message)}</div>`; lexicalOnly(); $('#out').insertAdjacentHTML('afterbegin', errBox); }
  } finally { $('#ask').disabled = false; }
}

// ---------------------------------------------------------------- grounding (pass 1, deterministic)
// The records the model saw are the only truth. Anything the answer says that a record contradicts is
// removed here, instantly, before render; what was changed is written into answer.grounding for display.
function groundAnswer(a, records, requirements) {
  const recById = new Map(records.map(r => [r.id, r]));
  const notes = [];
  for (const p of a.plan || []) {
    p.recommended = (p.recommended || []).filter(r => {
      r.id = resolveId(r.id);
      if (!recById.has(r.id)) { notes.push(`dropped ${r.id}: not among the records the answer was grounded in`); return false; }
      const it = recById.get(r.id);
      r.confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0));
      if (r.caveats) {
        const kept = String(r.caveats).split(/[;,]\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean).filter(seg => {
          const s = seg.toLowerCase();
          if (/archiv/.test(s) && !it.archived) { notes.push(`${r.id}: caveat "${seg}" removed — record says archived: false`); return false; }
          if (/dormant|abandon|inactive|unmaintained|stale/.test(s) && it.maturity !== 'dormant') { notes.push(`${r.id}: caveat "${seg}" removed — record maturity is ${it.maturity || 'unknown'}${it.pushed_at ? ', pushed ' + it.pushed_at.slice(0, 10) : ''}`); return false; }
          if (/deleted|gone|missing upstream/.test(s) && !it.upstream_deleted) { notes.push(`${r.id}: caveat "${seg}" removed — upstream is not deleted`); return false; }
          if (/^none$|^n\/a$|^no caveats?$/.test(s)) return false;
          return true;
        });
        r.caveats = kept.join(', ');
      }
      if ((it.relation === 'owner') && /third[- ]party|external|unknown (author|origin)/i.test(r.reason + ' ' + (r.caveats || ''))) notes.push(`${r.id}: is the owner's own repo (relation: owner)`);
      return true;
    });
  }
  // gaps must be about requirements the owner actually stated; anything else is model-raised
  // one shared word ("context") is not the same requirement: need ≥2 shared content tokens or half the gap's tokens
  const sameReq = (rq, g) => { const A = new Set((rq.toLowerCase().match(/[a-z0-9]{4,}/g) || [])); const B = [...new Set(g.toLowerCase().match(/[a-z0-9]{4,}/g) || [])]; const n = B.filter(t => A.has(t)).length; return n >= 2 || (B.length > 0 && n / B.length >= 0.5); };
  a.gaps = (a.gaps || []).map(g => {
    const asked = requirements.some(rq => sameReq(rq, g.requirement || '')) || (a.plan || []).some(p => sameReq(p.requirement || '', g.requirement || ''));
    if (!asked) { g.model_added = true; notes.push(`gap "${g.requirement}" was not in your brief — shown as model-raised`); }
    return g;
  });
  a.grounding = notes;
  return a;
}

// ---------------------------------------------------------------- validator (pass 2, lazy, in-model)
// A second, independent model call over the SAME records + the rendered answer. Non-blocking: the user is
// already reading; verdicts patch the DOM as badges/corrections. Aborted by the next ask.
async function validateAnswer({ brief, requirements, records, answer, projects, signal }) {
  const box = $('#validator'); if (!box) return null;
  const model = cfg[active.provider]?.reasonModel;
  box.textContent = `verifying with ${active.provider}/${model}…`; box.className = 'muted vstatus';
  let v;
  try {
    v = await complete({ provider: active.provider, cfg, slot: 'reason', system: VALIDATE_SYSTEM, user: validateUser(brief, requirements, records, answer, projects), schema: VALIDATE_SCHEMA, signal });
  } catch (e) {
    if (e.name === 'AbortError' || signal.aborted) return null;
    box.textContent = `validator did not run: ${e.message}`; return null;
  }
  if (signal.aborted) return null;
  const counts = { supported: 0, partial: 0, unsupported: 0 };
  const recEls = [...document.querySelectorAll('#out .rec[data-id]')];
  const judged = new Set();   // one verdict per rendered recommendation — a check the model invents for a (repo, requirement) pair the answer never made is dropped
  const findRec = (id, req) => {
    const rid = resolveId(id);
    const exact = recEls.find(el => el.dataset.id === rid && req && tokenOverlap(req, el.dataset.req || '') && !judged.has(el));
    if (exact) return exact;
    // requirement text names a different plan item than any this repo was recommended for → the model checked a pairing the answer never made
    if (req && recEls.some(el => el.dataset.id !== rid && tokenOverlap(req, el.dataset.req || ''))) return null;
    return recEls.find(el => el.dataset.id === rid && !judged.has(el)) || null;   // mangled/absent requirement text: fall back to the repo, once
  };
  for (const c of v.checks || []) {
    const el = findRec(c.id, c.requirement); if (!el) continue;
    judged.add(el);
    const verdict = ['supported', 'partial', 'unsupported'].includes(c.verdict) ? c.verdict : 'partial';
    counts[verdict]++;
    el.classList.add('v-' + verdict);
    const rec = findRecInAnswer(answer, el.dataset.id, el.dataset.req);
    if (verdict === 'partial') {
      if (c.corrected_reason && rec) { const p = el.querySelector('p.why'); if (p) p.innerHTML = `<b>Why:</b> ${esc(c.corrected_reason)} <s class="muted">${esc(rec.reason)}</s>`; rec.reason = c.corrected_reason; }
      if (c.corrected_caveats != null && rec) { let p = el.querySelector('p.cav'); if (!p) { p = document.createElement('p'); p.className = 'cav'; el.appendChild(p); } p.innerHTML = c.corrected_caveats ? `<b>Caveats:</b> ${esc(c.corrected_caveats)}` : ''; rec.caveats = c.corrected_caveats; }
      if (typeof c.confidence === 'number' && rec) { rec.confidence = Math.max(0, Math.min(1, c.confidence)); const cf = el.querySelector('.conf'); if (cf) cf.textContent = `fit ${Math.round(rec.confidence * 100)}%`; }
    }
    if (rec) rec.validation = { verdict, issue: c.issue || '' };
    el.querySelector('.t')?.insertAdjacentHTML('beforeend', `<span class="vbadge ${verdict}" title="${esc(c.issue || '')}">${verdict === 'supported' ? 'verified' : verdict === 'partial' ? 'corrected' : 'unsupported'}</span>`);
    if (verdict !== 'supported' && c.issue) el.insertAdjacentHTML('beforeend', `<p class="vnote">Validator: ${esc(c.issue)}</p>`);
  }
  for (const g of v.gaps || []) {
    if (g.verdict !== 'invented') continue;
    const el = [...document.querySelectorAll('#out .gap[data-req]')].find(e => tokenOverlap(g.requirement || '', e.dataset.req || ''));
    if (el) { el.classList.add('v-unsupported'); el.insertAdjacentHTML('beforeend', `<div class="vnote">Validator: invented gap${g.issue ? ' — ' + esc(g.issue) : ''}</div>`); }
    const ag = (answer.gaps || []).find(x => tokenOverlap(g.requirement || '', x.requirement || '')); if (ag) ag.validation = { verdict: 'invented', issue: g.issue || '' };
  }
  if (v.summary_verdict === 'unsupported' && v.summary_issue) { document.querySelector('#out .answer > p:first-child')?.insertAdjacentHTML('afterend', `<p class="vnote">Validator on summary: ${esc(v.summary_issue)}</p>`); }
  answer.validation = { model: `${active.provider}/${model}`, at: new Date().toISOString(), counts, summary_verdict: v.summary_verdict, summary_issue: v.summary_issue || '' };
  box.className = 'muted vstatus done';
  box.textContent = `validated by ${model}: ${counts.supported} verified · ${counts.partial} corrected · ${counts.unsupported} unsupported`;
  return v;
}

function findRecInAnswer(a, id, req) {
  for (const p of a.plan || []) for (const r of p.recommended || []) if (r.id === id && (!req || tokenOverlap(req, p.requirement || ''))) return r;
  for (const p of a.plan || []) for (const r of p.recommended || []) if (r.id === id) return r;
  return null;
}

function tokenOverlap(a, b) { const A = new Set(a.toLowerCase().match(/[a-z0-9]{4,}/g) || []); return (b.toLowerCase().match(/[a-z0-9]{4,}/g) || []).some(t => A.has(t)); }

// ---------------------------------------------------------------- render answer
// Small models sometimes bend the schema: plan items named after schema keys, gaps stuffed into
// alternatives, missing arrays. Repair in place so rendering and history stay sane.
function normalizeAnswer(a, requirements) {
  const SCHEMA_KEYS = new Set(['architecture_note', 'gaps', 'summary', 'next_actions', 'plan', 'alternatives']);
  a.plan = Array.isArray(a.plan) ? a.plan : [];
  a.gaps = Array.isArray(a.gaps) ? a.gaps : [];
  a.next_actions = Array.isArray(a.next_actions) ? a.next_actions : [];
  const keep = [];
  for (const p of a.plan) {
    if (!p || typeof p !== 'object') continue;
    const name = String(p.requirement || '').trim();
    if (SCHEMA_KEYS.has(name.toLowerCase())) {
      // fold stray "architecture_note"-style items into the first real plan item as alternatives
      if (keep.length && Array.isArray(p.recommended)) keep[0].recommended.push(...p.recommended.filter(r => r?.id));
      continue;
    }
    p.recommended = Array.isArray(p.recommended) ? p.recommended.filter(r => r?.id) : [];
    // "alternatives" that look like search queries or the word "gaps" belong in gaps
    p.alternatives = (Array.isArray(p.alternatives) ? p.alternatives : []).filter(s => {
      const t = String(s || '').trim();
      if (!t || /^gaps?$/i.test(t)) return false;
      const m = t.match(/^search query:\s*"?(.+?)"?$/i);
      if (m) { a.gaps.push({ requirement: name || 'general', why_uncovered: 'suggested by model', github_search: m[1] }); return false; }
      return true;
    });
    keep.push(p);
  }
  a.plan = keep;
  // de-dupe recommendations within a plan item by id
  for (const p of a.plan) { const seen = new Set(); p.recommended = p.recommended.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true))); }
  if (!a.plan.length && requirements?.length) a.plan = requirements.map(r => ({ requirement: r, recommended: [], alternatives: [] }));
  return a;
}

// Small models sometimes drop the owner prefix or cite the upstream name — resolve leniently.
function resolveId(id) {
  if (!id) return null;
  if (byId.has(id)) return id;
  const s = String(id).toLowerCase();
  const hit = items.find(i => i.name.toLowerCase() === s || (i.upstream || '').toLowerCase() === s || i.id.toLowerCase().endsWith('/' + s));
  return hit ? hit.id : id;
}

function renderAnswer(a, contextIds, requirements) {
  (a.plan || []).forEach(p => (p.recommended || []).forEach(r => { r.id = resolveId(r.id); }));
  const link = id => { const it = byId.get(id); return it ? `<a href="index.html#${encodeURIComponent(JSON.stringify({ q: it.name }))}"><b>${esc(it.upstream || id)}</b></a>` : `<b>${esc(id)}</b>`; };
  const meta = id => { const it = byId.get(id); return it ? `<span class="tag dom">${esc(it.domain_label)}</span> <span class="tag">${esc(it.form_label)}</span> ${it.maturity ? `<span class="tag ${it.maturity === 'dormant' ? 'warn' : ''}">${esc(it.maturity)}</span>` : ''} <span class="muted">★ ${it.stars || 0}${it.language ? ' · ' + esc(it.language) : ''}</span> <a class="muted" href="${esc(it.upstream_url || it.fork_url)}" target="_blank" rel="noopener">↗</a>` : ''; };
  const vb = r => r.validation ? `<span class="vbadge ${esc(r.validation.verdict)}" title="${esc(r.validation.issue || '')}">${r.validation.verdict === 'supported' ? 'verified' : r.validation.verdict === 'partial' ? 'corrected' : 'unsupported'}</span>` : '';
  const plan = (a.plan || []).map(p => `<div class="req"><h3>${esc(p.requirement)}</h3>
      ${(p.recommended || []).map(r => `<div class="rec${r.validation ? ' v-' + esc(r.validation.verdict) : ''}" data-id="${esc(r.id)}" data-req="${esc(p.requirement)}"><div class="t">${link(r.id)} ${meta(r.id)}<span class="conf">fit ${Math.round((r.confidence || 0) * 100)}%</span>${vb(r)}</div>
        <p><b>Role:</b> ${esc(r.role)}</p><p class="why"><b>Why:</b> ${esc(r.reason)}</p>${r.caveats ? `<p class="cav"><b>Caveats:</b> ${esc(r.caveats)}</p>` : ''}${r.validation && r.validation.verdict !== 'supported' && r.validation.issue ? `<p class="vnote">Validator: ${esc(r.validation.issue)}</p>` : ''}</div>`).join('') || '<p class="muted">no direct fit</p>'}
      ${p.alternatives?.length ? `<p class="muted">Alternatives: ${p.alternatives.map(esc).join(', ')}</p>` : ''}</div>`).join('');
  const gaps = (a.gaps || []).map(g => `<div class="gap${g.model_added ? ' model-added' : ''}${g.validation ? ' v-unsupported' : ''}" data-req="${esc(g.requirement)}">${g.model_added ? '<span class="vbadge partial">model-raised, not in your brief</span> ' : ''}<b>${esc(g.requirement)}</b> — ${esc(g.why_uncovered)}<br><a href="https://github.com/search?q=${encodeURIComponent(g.github_search)}&type=repositories" target="_blank" rel="noopener">Search GitHub: ${esc(g.github_search)}</a>${g.validation ? `<div class="vnote">Validator: invented gap${g.validation.issue ? ' — ' + esc(g.validation.issue) : ''}</div>` : ''}</div>`).join('');
  const vs = a.validation ? `validated by ${esc(a.validation.model.split('/').slice(1).join('/'))}: ${a.validation.counts.supported} verified · ${a.validation.counts.partial} corrected · ${a.validation.counts.unsupported} unsupported` : '';
  $('#out').innerHTML = `<div class="answer">
    <p>${esc(a.summary)}</p>
    ${a.validation?.summary_verdict === 'unsupported' && a.validation.summary_issue ? `<p class="vnote">Validator on summary: ${esc(a.validation.summary_issue)}</p>` : ''}
    <div id="validator" class="muted vstatus${a.validation ? ' done' : ''}">${vs}</div>
    ${plan}
    ${gaps ? `<h3>Gaps — nothing forked covers this</h3>${gaps}` : ''}
    ${a.architecture_note ? `<h3>How it fits together</h3><p>${esc(a.architecture_note)}</p>` : ''}
    ${a.next_actions?.length ? `<h3>Next actions</h3><ol>${a.next_actions.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
    ${a.grounding?.length ? `<details class="grounding"><summary class="muted">Grounding: ${a.grounding.length} correction${a.grounding.length > 1 ? 's' : ''} applied from record facts</summary><ul class="muted">${a.grounding.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    <p class="muted" style="margin-top:14px">Context: ${contextIds.length} records — ${contextIds.map(id => esc(id.split('/')[1] || id)).join(', ')} · provider ${esc(active.provider || 'n/a')}</p>
    <div class="row"><button class="ghost" id="copyBrief">Copy as project brief (markdown)</button><button class="ghost" id="copyJson">Copy answer JSON</button></div>
  </div>`;
  $('#copyBrief').onclick = () => copy(briefMarkdown(a, requirements));
  $('#copyJson').onclick = () => copy(JSON.stringify(a, null, 2));
}

function briefMarkdown(a, requirements) {
  const uses = [...new Set((a.plan || []).flatMap(p => (p.recommended || []).map(r => r.id)))];
  const brief = $('#brief').value.trim();
  const slug = brief.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
  return `---\nname: ${slug}\nstatus: idea\nsummary: ${a.summary.replace(/\n/g, ' ')}\nuses: [${uses.join(', ')}]\ntags: []\n---\n\n## Goal\n\n${brief}\n\n## Requirements\n\n${(a.plan || []).map((p, i) => `- ${String.fromCharCode(97 + i)}) ${p.requirement} → ${(p.recommended || []).map(r => `**${r.id.split('/')[1]}** (${r.role})`).join(', ') || '_gap_'}`).join('\n')}\n\n## Gaps\n\n${(a.gaps || []).map(g => `- ${g.requirement}: ${g.why_uncovered} (search: \`${g.github_search}\`)`).join('\n') || '- none'}\n\n## Architecture\n\n${a.architecture_note}\n\n## Next actions\n\n${(a.next_actions || []).map(s => `- [ ] ${s}`).join('\n')}\n\n_Save as projects/${slug}.md_\n`;
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('copied'); } catch { prompt('Copy:', text); } }
function toast(msg) { const t = document.createElement('div'); t.textContent = msg; t.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:6px 12px;border-radius:8px;font-size:12px;z-index:20'; document.body.appendChild(t); setTimeout(() => t.remove(), 1400); }

// ---------------------------------------------------------------- settings drawer
function fillDrawer() {
  $('#oUrl').value = cfg.ollama.url; $('#oCtx').value = cfg.ollama.numCtx; $('#oEnabled').checked = cfg.ollama.enabled;
  fillModelSelects(active.status.ollamaModels || []);
  $('#aKey').value = cfg.anthropic.key; $('#aShort').value = cfg.anthropic.shortlistModel; $('#aReason').value = cfg.anthropic.reasonModel; $('#aEnabled').checked = cfg.anthropic.enabled;
  $('#oStatus').textContent = active.status.ollama || '';
  $('#bToken').value = cfg.board.token; $('#bRepo').value = cfg.board.repo; $('#bPath').value = cfg.board.path; $('#bEnabled').checked = cfg.board.enabled;
  $('#pToken').value = cfg.priv.token; $('#pEnabled').checked = cfg.priv.enabled; $('#pReadme').checked = cfg.priv.includeReadme; $('#pForks').checked = cfg.priv.includeForks;
}
function fillModelSelects(models) {
  for (const [sel, cur] of [[$('#oShort'), cfg.ollama.shortlistModel], [$('#oReason'), cfg.ollama.reasonModel]]) {
    sel.innerHTML = '';
    const names = models.map(m => m.name); if (cur && !names.includes(cur)) names.unshift(cur);
    if (!names.length) names.push('');
    names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n || '(none detected)'; if (n === cur) o.selected = true; sel.appendChild(o); });
  }
}
$('#gear').onclick = () => { fillDrawer(); $('#drawer').classList.add('open'); };
$('#closeDrawer').onclick = () => $('#drawer').classList.remove('open');
$('#oDetect').onclick = async () => {
  $('#oStatus').textContent = 'probing…';
  const pr = await probeOllama($('#oUrl').value.trim(), 3000);
  if (!pr.ok) { $('#oStatus').textContent = 'unreachable: ' + pr.reason; return; }
  const pick = pickOllamaModels(pr.models);
  cfg.ollama.shortlistModel ||= pick.shortlist; cfg.ollama.reasonModel ||= pick.reason;
  fillModelSelects(pr.models); $('#oStatus').textContent = `${pr.models.length} model(s) found`;
};
$('#saveCfg').onclick = async () => {
  cfg.ollama.url = $('#oUrl').value.trim() || DEFAULTS.ollama.url; cfg.ollama.numCtx = parseInt($('#oCtx').value, 10) || 8192; cfg.ollama.enabled = $('#oEnabled').checked;
  cfg.ollama.shortlistModel = $('#oShort').value; cfg.ollama.reasonModel = $('#oReason').value;
  cfg.anthropic.key = $('#aKey').value.trim(); cfg.anthropic.shortlistModel = $('#aShort').value.trim(); cfg.anthropic.reasonModel = $('#aReason').value.trim(); cfg.anthropic.enabled = $('#aEnabled').checked;
  const boardChanged = cfg.board.token !== $('#bToken').value.trim() || cfg.board.repo !== $('#bRepo').value.trim() || cfg.board.path !== $('#bPath').value.trim();
  cfg.board.token = $('#bToken').value.trim(); cfg.board.repo = $('#bRepo').value.trim() || DEFAULTS.board.repo; cfg.board.path = $('#bPath').value.trim() || DEFAULTS.board.path; cfg.board.enabled = $('#bEnabled').checked;
  saveConfig(cfg); await refreshProvider(); $('#oStatus').textContent = active.status.ollama || ''; toast('saved'); $('#drawer').classList.remove('open');
  if (boardChanged) { localStorage.removeItem('atlas.board.cache.v1'); loadBoard(); }
  const privChanged = cfg.priv.token !== $('#pToken').value.trim() || cfg.priv.enabled !== $('#pEnabled').checked || cfg.priv.includeForks !== $('#pForks').checked;
  cfg.priv.token = $('#pToken').value.trim(); cfg.priv.enabled = $('#pEnabled').checked; cfg.priv.includeReadme = $('#pReadme').checked; cfg.priv.includeForks = $('#pForks').checked;
  saveConfig(cfg);
  if (privChanged) { clearPrivateCache(); loadPrivate(); }
};
$('#clearCfg').onclick = async () => { localStorage.removeItem('atlas.llm.v1'); cfg = loadConfig(); await refreshProvider(); fillDrawer(); toast('cleared'); };

$('#ask').onclick = ask; $('#lexOnly').onclick = lexicalOnly;
$('#brief').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') ask(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#drawer').classList.remove('open'); abort?.abort(); } });
