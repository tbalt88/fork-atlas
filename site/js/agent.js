// agent.js — Fork Atlas assistant: keeper panel (no LLM), lexical search, two-stage Q&A.
import { BM25, rankForBrief, itemText } from './retrieval.js';
import { loadConfig, saveConfig, probeOllama, pickOllamaModels, resolveProvider, complete, DEFAULTS } from './llm.js';
import { SHORTLIST_SCHEMA, ANSWER_SCHEMA, SHORTLIST_SYSTEM, ANSWER_SYSTEM, shortlistUser, answerUser } from './prompts.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = s => (s || '').slice(0, 10);
const HIST_KEY = 'atlas.history.v1', VISIT_KEY = 'atlas.lastVisit';

let matrix, items, byId, compactById, projects = [], index, cfg, active = { provider: null, status: {} }, abort;

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
  renderKeeper(); renderProjects(); renderHistory();
  const langs = [...new Set(items.map(i => i.language).filter(Boolean))].sort();
  langs.forEach(l => { const o = document.createElement('option'); o.value = l; o.textContent = l; $('#lang').appendChild(o); });
  cfg = loadConfig();
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
  const unclassified = items.filter(i => i.status !== 'classified');
  const review = items.filter(i => i.needs_review);
  const usedIds = new Set([...projects.flatMap(p => p.uses || []), ...items.filter(i => i.pinned || i.note).map(i => i.id)]);
  const risky = items.filter(i => usedIds.has(i.id) && (i.archived || i.upstream_deleted || i.maturity === 'dormant'));
  const dormantAll = items.filter(i => i.archived || i.upstream_deleted).length;
  const el = $('#keeper');
  const tile = (n, label, cls = '') => `<div class="tile ${cls}"><b>${n}</b><span>${label}</span></div>`;
  el.innerHTML = `<h2>Keeper</h2>
    <div class="tiles">
      ${tile(items.length, 'forks tracked')}
      ${tile(recent.length, 'forked last 7 days', recent.length ? 'ok' : '')}
      ${tile(unclassified.length, 'unclassified', unclassified.length ? 'warn' : '')}
      ${tile(review.length, 'need review', review.length ? 'warn' : '')}
      ${tile(dormantAll, 'archived / gone')}
      ${tile(`<span style="font-size:15px;line-height:1.5">${fmtDate(matrix.generated_at)}</span>`, 'catalog updated')}
    </div>
    ${since.length ? `<h2 style="margin-top:12px">New since your last visit${last ? ' (' + fmtDate(last) + ')' : ''}</h2><ul class="plain">${since.slice(0, 8).map(i => `<li><a href="index.html#${encodeURIComponent(JSON.stringify({ q: i.name }))}">${esc(i.upstream || i.name)}</a> <span class="muted">${esc(i.domain_label)}</span></li>`).join('')}${since.length > 8 ? `<li class="muted">+${since.length - 8} more</li>` : ''}</ul>` : ''}
    ${unclassified.length ? `<p class="muted" style="margin:10px 0 0">Run <code>python scripts/classify.py</code> (or ask Claude Code) to classify new forks.</p>` : ''}
    ${risky.length ? `<h2 style="margin-top:12px">Watch — used/pinned repos at risk</h2><ul class="plain">${risky.map(i => `<li>${esc(i.upstream)} <span class="tag warn">${i.archived ? 'archived' : i.upstream_deleted ? 'upstream gone' : 'dormant'}</span></li>`).join('')}</ul>` : ''}`;
}

function renderProjects() {
  const el = $('#projects');
  if (!projects.length) { el.innerHTML = '<h2>Projects</h2><p class="muted">Add briefs in <code>projects/</code> to ground answers in your own work.</p>'; return; }
  el.innerHTML = '<h2>Projects</h2>' + projects.map(p => `<div class="stat" style="flex-direction:column;align-items:flex-start;gap:2px"><span><b>${esc(p.name)}</b> <span class="tag">${esc(p.status)}</span></span><span class="muted">${esc(p.summary)}</span>${p.uses?.length ? `<span class="muted">uses: ${p.uses.map(u => esc(u.split('/')[1] || u)).join(', ')}</span>` : ''}</div>`).join('');
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
    const { requirements, ranked } = rankForBrief(index, brief, { n: local ? 28 : 40, boost: boostFn() });
    const cands = ranked.map(r => compactById.get(r.item.id)).filter(Boolean);
    setSteps(['done', 'on']);
    let short;
    try {
      short = await complete({ provider: active.provider, cfg, slot: 'shortlist', system: SHORTLIST_SYSTEM, user: shortlistUser(brief, requirements, cands), schema: SHORTLIST_SCHEMA, onToken, signal: abort.signal });
    } catch (e) { console.warn('shortlist failed, falling back to lexical top-12', e); short = { candidates: ranked.slice(0, 12).map(r => ({ id: r.item.id, covers: [], hint: '' })), uncovered: [] }; }
    const picked = new Set(short.candidates.map(c => c.id).filter(id => byId.has(id)));
    ranked.slice(0, local ? 3 : 6).forEach(r => picked.add(r.item.id));  // lexical never fully loses
    const records = [...picked].slice(0, local ? 10 : 16).map(id => byId.get(id));
    const relProjects = projects.filter(p => (p.uses || []).some(u => picked.has(u)) || tokenOverlap(brief, p.name + ' ' + p.summary + ' ' + p.tags.join(' ')));
    setSteps(['done', 'done', 'on']);
    $('#stream').textContent = '';
    const answer = await complete({ provider: active.provider, cfg, slot: 'reason', system: ANSWER_SYSTEM, user: answerUser(brief, requirements, records, relProjects, local), schema: ANSWER_SCHEMA, onToken, signal: abort.signal });
    setSteps(['done', 'done', 'done']); $('#stream').hidden = true;
    renderAnswer(answer, records.map(r => r.id), requirements);
    pushHistory({ brief, at: new Date().toISOString(), provider: `${active.provider}/${cfg[active.provider].reasonModel}`, answer, context: records.map(r => r.id), requirements });
  } catch (e) {
    if (e.name !== 'AbortError') { $('#out').innerHTML = `<div class="err">${esc(e.message)}</div>` + $('#out').innerHTML; lexicalOnly(); }
  } finally { $('#ask').disabled = false; }
}

function tokenOverlap(a, b) { const A = new Set(a.toLowerCase().match(/[a-z0-9]{4,}/g) || []); return (b.toLowerCase().match(/[a-z0-9]{4,}/g) || []).some(t => A.has(t)); }

// ---------------------------------------------------------------- render answer
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
  const plan = (a.plan || []).map(p => `<div class="req"><h3>${esc(p.requirement)}</h3>
      ${(p.recommended || []).map(r => `<div class="rec"><div class="t">${link(r.id)} ${meta(r.id)}<span class="conf">fit ${Math.round((r.confidence || 0) * 100)}%</span></div>
        <p><b>Role:</b> ${esc(r.role)}</p><p><b>Why:</b> ${esc(r.reason)}</p>${r.caveats ? `<p class="cav"><b>Caveats:</b> ${esc(r.caveats)}</p>` : ''}</div>`).join('') || '<p class="muted">no direct fit</p>'}
      ${p.alternatives?.length ? `<p class="muted">Alternatives: ${p.alternatives.map(esc).join(', ')}</p>` : ''}</div>`).join('');
  const gaps = (a.gaps || []).map(g => `<div class="gap"><b>${esc(g.requirement)}</b> — ${esc(g.why_uncovered)}<br><a href="https://github.com/search?q=${encodeURIComponent(g.github_search)}&type=repositories" target="_blank" rel="noopener">Search GitHub: ${esc(g.github_search)}</a></div>`).join('');
  $('#out').innerHTML = `<div class="answer">
    <p>${esc(a.summary)}</p>
    ${plan}
    ${gaps ? `<h3>Gaps — nothing forked covers this</h3>${gaps}` : ''}
    ${a.architecture_note ? `<h3>How it fits together</h3><p>${esc(a.architecture_note)}</p>` : ''}
    ${a.next_actions?.length ? `<h3>Next actions</h3><ol>${a.next_actions.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
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
  saveConfig(cfg); await refreshProvider(); $('#oStatus').textContent = active.status.ollama || ''; toast('saved'); $('#drawer').classList.remove('open');
};
$('#clearCfg').onclick = async () => { localStorage.removeItem('atlas.llm.v1'); cfg = loadConfig(); await refreshProvider(); fillDrawer(); toast('cleared'); };

$('#ask').onclick = ask; $('#lexOnly').onclick = lexicalOnly;
$('#brief').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') ask(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#drawer').classList.remove('open'); abort?.abort(); } });
