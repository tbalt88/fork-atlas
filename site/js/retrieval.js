// retrieval.js — BM25 lexical index over atlas items + requirement splitting.
// No dependencies. Used by agent.js (and reusable by index.html later).

const STOP = new Set(('a an the and or of to for in on with by from at as is are be this that it its into your our we i you ' +
  'want need build make create app application project using use used which what how can should would like give me some ' +
  'via per over under about than then also more most very just really so do does done have has had will not no yes').split(' '));

export function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9+#.\-\s]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(stem);
}

// tiny stemmer: plurals + common suffixes; good enough for tag-like vocab
function stem(t) {
  if (t.length <= 4) return t;
  return t.replace(/(ations?|izations?|isations?)$/, 'ate').replace(/(ings?|ers?|ed|es|s)$/, '');
}

export class BM25 {
  constructor(items, fields) {
    this.items = items;
    this.k1 = 1.4; this.b = 0.75;
    this.docs = items.map(it => tokenize(fields(it)));
    this.avgdl = this.docs.reduce((a, d) => a + d.length, 0) / Math.max(1, this.docs.length);
    this.df = new Map();
    this.tf = this.docs.map(d => { const m = new Map(); d.forEach(t => m.set(t, (m.get(t) || 0) + 1)); m.forEach((_, t) => this.df.set(t, (this.df.get(t) || 0) + 1)); return m; });
    this.N = items.length;
  }
  idf(t) { const n = this.df.get(t) || 0; return Math.log(1 + (this.N - n + 0.5) / (n + 0.5)); }
  score(queryTokens, i) {
    const tf = this.tf[i], dl = this.docs[i].length; let s = 0;
    for (const t of queryTokens) {
      const f = tf.get(t); if (!f) continue;
      s += this.idf(t) * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * dl / this.avgdl));
    }
    return s;
  }
  search(query, n = 40, boost = null) {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const scored = this.items.map((it, i) => ({ item: it, score: this.score(q, i) * (boost ? boost(it) : 1) }))
      .filter(r => r.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, n);
  }
}

// Split a brief into requirement phrases: bullets, "a) b) c)", numbered, or clauses joined by ; / , and / and.
export function splitRequirements(brief) {
  const lines = brief.split(/\n+/).map(s => s.trim()).filter(Boolean);
  let parts = [];
  for (const line of lines) {
    const m = line.match(/^(?:[-*•]|\(?[a-z0-9]{1,2}[).:])\s+(.*)$/i);
    if (m) { parts.push(m[1]); continue; }
    // inline "a) x, b) y" or "1. x 2. y"
    const inl = line.split(/\s(?=\(?[a-z0-9]{1,2}[).]\s)/i);
    if (inl.length > 1) { parts.push(...inl.map(s => s.replace(/^\(?[a-z0-9]{1,2}[).]\s*/i, ''))); continue; }
    parts.push(...line.split(/;|\band\b(?=[^,]*,)|,\s(?=\w+\s\w+)/i).map(s => s.trim()));
  }
  parts = parts.map(p => p.replace(/^(and|then|also)\s+/i, '').trim()).filter(p => tokenize(p).length >= 1);
  // de-dupe, cap
  const seen = new Set(); const out = [];
  for (const p of parts) { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out.slice(0, 8);
}

// Rank items for a whole brief: per-requirement searches merged with a whole-brief search.
export function rankForBrief(index, brief, opts = {}) {
  const n = opts.n || 40;
  const reqs = splitRequirements(brief);
  const buckets = new Map(); // id -> {item, score, hits:Set(reqIdx)}
  const add = (res, w, reqIdx) => res.forEach((r, rank) => {
    const b = buckets.get(r.item.id) || { item: r.item, score: 0, hits: new Set() };
    b.score += w * r.score / (1 + rank * 0.05);
    if (reqIdx != null) b.hits.add(reqIdx);
    buckets.set(r.item.id, b);
  });
  add(index.search(brief, n, opts.boost), 1.0, null);
  reqs.forEach((r, i) => add(index.search(r, 15, opts.boost), 1.5, i));
  // primary: how many distinct requirements it hits; secondary: blended score
  const ranked = [...buckets.values()].sort((a, b) => (b.hits.size - a.hits.size) || (b.score - a.score));
  return { requirements: reqs, ranked: ranked.slice(0, n) };
}

export const itemText = it => [it.upstream || it.id, it.description, it.analysis, (it.keywords || []).join(' '), (it.topics || []).join(' '),
  (it.use_cases || []).map(u => u.title + ' ' + (u.keywords || []).join(' ')).join(' '), it.note, it.domain_label, it.form_label, it.language].join(' \n ');
export const compactText = c => [c.id, c.one, (c.kw || []).join(' '), (c.uc || []).join(' '), c.note, c.d, c.f, c.l].join(' \n ');
