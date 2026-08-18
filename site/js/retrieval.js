// retrieval.js — BM25 lexical index over atlas items + requirement splitting.
// No dependencies. Used by agent.js (and reusable by index.html later).

const STOP = new Set(('a an the and or of to for in on with by from at as is are be this that it its into your our we i you ' +
  'want need build make create app application project using use used which what how can should would like give me some ' +
  'via per over under about than then also more most very just really so do does done have has had will not no yes ' +
  'common ability able throughout multiple several various across between different new good best simple easy full whole ' +
  'entire every all each other own way ways thing things kind sort lot lots need needs able allow allows let lets ' +
  'get gets set sets put take takes without within around out up down there here where when while whether if any').split(' '));

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

// Query-side expansion only (documents are never expanded): concept words a person types map to the
// vocabulary the catalog actually uses. Keeps BM25 honest for briefs like "context fabric" that never
// say "memory". Small on purpose; extend when a real miss shows up.
const EXPAND = {
  context: ['memory', 'context-persistence', 'knowledge-base'],
  fabric: ['memory', 'sync', 'cross-surface', 'mcp', 'knowledge-base'],
  knowledge: ['memory', 'knowledge-base', 'rag', 'vault', 'notes'],
  share: ['shared', 'sync', 'multi-agent', 'team'],
  shared: ['sync', 'multi-agent', 'team', 'memory'],
  agents: ['agent', 'multi-agent', 'mcp'],
  agent: ['agents', 'multi-agent', 'mcp'],
  computers: ['machines', 'cross-machine', 'sync', 'remote', 'self-hosted'],
  machines: ['computers', 'cross-machine', 'sync', 'remote'],
  remember: ['memory', 'persistence'],
  persistent: ['memory', 'persistence', 'storage'],
  voice: ['speech', 'tts', 'stt', 'transcription', 'audio'],
  speech: ['voice', 'tts', 'stt', 'transcription'],
  transcribe: ['transcription', 'stt', 'whisper', 'speech'],
  video: ['video-generation', 'diffusion', 'ffmpeg'],
  image: ['image-generation', 'diffusion', 'vision'],
  scrape: ['scraping', 'crawler', 'extraction'],
  scrapes: ['scraping', 'crawler', 'extraction'],
  email: ['smtp', 'newsletter', 'mail'],
  chatbot: ['chat', 'assistant', 'llm', 'agent'],
  dashboard: ['ui', 'web-ui', 'analytics', 'visualization'],
  automate: ['automation', 'workflow', 'orchestration'],
  automation: ['workflow', 'orchestration', 'n8n'],
  finetune: ['fine-tuning', 'training', 'lora'],
  train: ['training', 'fine-tuning'],
  security: ['pentest', 'vulnerability', 'scanning', 'auth'],
  crm: ['dynamics', 'dataverse', 'power-platform', 'sales'],
  seo: ['keyword-research', 'marketing', 'backlinks'],
};
// index EXPAND by stemmed key so lookups match tokenizer output
const EXPAND_STEMMED = new Map();
for (const [k, vals] of Object.entries(EXPAND)) {
  const key = tokenize(k)[0]; if (!key) continue;
  const set = EXPAND_STEMMED.get(key) || new Set();
  vals.forEach(v => tokenize(v).forEach(s => set.add(s)));
  EXPAND_STEMMED.set(key, set);
}
export function expandQuery(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) (EXPAND_STEMMED.get(t) || []).forEach(s => out.add(s));
  return [...out];
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
  score(queryTokens, i) { return this.scoreW(queryTokens, () => 1, i); }
  scoreW(queryTokens, weight, i) {
    const tf = this.tf[i], dl = this.docs[i].length; let s = 0;
    for (const t of queryTokens) {
      const f = tf.get(t); if (!f) continue;
      s += weight(t) * this.idf(t) * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * dl / this.avgdl));
    }
    return s;
  }
  search(query, n = 40, boost = null) {
    const base = [...new Set(tokenize(query))];
    if (!base.length) return [];
    // expanded terms get half weight so they widen recall without outranking literal matches
    const q = expandQuery(base);
    const w = t => (base.includes(t) ? 1 : 0.5);
    const scored = this.items.map((it, i) => ({ item: it, score: this.scoreW(q, w, i) * (boost ? boost(it) : 1) }))
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
    // inline "a) x, b) y" or "1. x 2. y" — the text before the first marker is preamble, not a requirement
    const inl = line.split(/\s(?=\(?[a-z0-9]{1,2}[).]\s)/i);
    if (inl.length > 1) {
      const segs = inl.filter(s => /^\(?[a-z0-9]{1,2}[).]\s/i.test(s));
      if (segs.length >= 2) { parts.push(...segs.map(s => s.replace(/^\(?[a-z0-9]{1,2}[).]\s*/i, '').replace(/[,;.]\s*$/, ''))); continue; }
    }
    parts.push(...line.split(/;|\band\b(?=[^,]*,)|,\s(?=\w+\s\w+)/i).map(s => s.trim()));
  }
  parts = parts.map(p => p.replace(/^(and|then|also)\s+/i, '').trim()).filter(p => tokenize(p).length >= 1);
  // Questions and meta-asks ("which direction should I take", "what do you think?") are intent, not
  // deliverables — the plan must not grow an item for them. Kept only when the brief is nothing else.
  // a trailing question sentence glued to a real requirement ("RAG over my notes. Which direction should I take?") is cut off, not fatal
  parts = parts.map(p => p.replace(/[.!]\s+[^.!?]*\?\s*$/, '').trim()).filter(Boolean);
  const isMeta = p => /\?\s*$/.test(p) || /^(which|what|how|should|could|would|can|do|does|is|are|where|why|any|please)\b/i.test(p) && /\b(i|we|you|me|my|us|direction|think|recommend|suggest|best|approach|option|way)\b/i.test(p);
  const concrete = parts.filter(p => !isMeta(p));
  if (concrete.length) parts = concrete;
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
