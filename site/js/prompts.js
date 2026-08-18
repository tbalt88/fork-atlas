// prompts.js — system prompts + JSON schemas for the two stages.

export const SHORTLIST_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array', maxItems: 12,
      items: { type: 'object', properties: { id: { type: 'string' }, covers: { type: 'array', items: { type: 'string' } }, hint: { type: 'string' } }, required: ['id', 'covers', 'hint'] },
    },
    uncovered: { type: 'array', items: { type: 'string' } },
  },
  required: ['candidates', 'uncovered'],
};

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string' },
          recommended: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, role: { type: 'string' }, reason: { type: 'string' },
                caveats: { type: 'string' }, confidence: { type: 'number' },
              },
              required: ['id', 'role', 'reason', 'confidence'],
            },
          },
          alternatives: { type: 'array', items: { type: 'string' } },
        },
        required: ['requirement', 'recommended'],
      },
    },
    gaps: {
      type: 'array',
      items: { type: 'object', properties: { requirement: { type: 'string' }, why_uncovered: { type: 'string' }, github_search: { type: 'string' } }, required: ['requirement', 'why_uncovered', 'github_search'] },
    },
    architecture_note: { type: 'string' },
    next_actions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'plan', 'gaps', 'architecture_note', 'next_actions'],
};

export const SHORTLIST_SYSTEM = `You are the retrieval stage of "Fork Atlas", a personal catalog of GitHub repositories the owner has forked.
You receive a project brief (with requirements) and a list of CANDIDATE repos (id, domain/form, one-liner, keywords, use cases).
Pick at most 12 candidate ids that could genuinely help build the project. Prefer repos that cover a requirement well over loosely related ones.
For each pick, list which requirement labels it covers (use the requirement text or its letter/number) and a short hint (<= 12 words).
List requirement labels that NO candidate covers in "uncovered". Only use ids that appear in the candidate list. Return JSON only.`;

export const ANSWER_SYSTEM = `You are the Fork Atlas assistant — the owner's keeper of their forked GitHub repositories.
Given a project brief and the FULL RECORDS of shortlisted repos (plus any related project briefs), produce a grounded build recommendation.

Rules:
- FIRST check the owner's own PROJECT BOARD (below, all columns incl. shipped): if a listed project already covers part or all of the brief, say so explicitly in "summary" and in the relevant plan item's "role" (e.g. "already built: Dex Fabric (shipped)"), and recommend extending it rather than rebuilding it from forks. Never treat a gap as open if a board project covers it.
- The "plan" array must contain EXACTLY the REQUIREMENTS listed (same order, same wording, one item each). If only one requirement is listed, "plan" has one item. Never add plan items for schema fields (architecture_note, gaps, summary) — those have their own keys.
- Recommend only repos present in the records. Cite by id exactly (owner/repo). Never invent repos. Records marked relation "owner" are the owner's OWN repositories — prefer them when they fit.
- Confidence is fit, 0-1; reserve >0.9 for a repo whose analysis directly matches the requirement.
- For each requirement, give 1-3 recommendations: the role the repo plays, WHY (grounded in its analysis / use cases / maturity / language), and caveats (dormant, archived, license, heavy stack, overlap).
- If a requirement is not well covered, put it in "gaps" with a concrete GitHub search query the owner can run.
- "architecture_note": 2-4 sentences on how the picks fit together (data flow, what glues them, what to build yourself).
- "next_actions": 3-6 concrete steps.
- Be direct and specific. No marketing language. Confidence 0-1 reflects fit, not repo popularity.
Return JSON only, matching the schema.`;

export function shortlistUser(brief, requirements, candidates) {
  const reqs = requirements.map((r, i) => `${String.fromCharCode(97 + i)}) ${r}`).join('\n');
  const cands = candidates.map(c => `- ${c.id} [${c.d}/${c.f}${c.m ? ', ' + c.m : ''}${c.l ? ', ' + c.l : ''}] ${c.one}${c.kw?.length ? ' | kw: ' + c.kw.join(', ') : ''}${c.uc?.length ? ' | uses: ' + c.uc.join('; ') : ''}${c.note ? ' | note: ' + c.note : ''}`).join('\n');
  return `BRIEF:\n${brief}\n\nREQUIREMENTS:\n${reqs || '(none parsed — infer from brief)'}\n\nCANDIDATES:\n${cands}`;
}

export function answerUser(brief, requirements, records, projects, compact = false) {
  const reqs = requirements.map((r, i) => `${String.fromCharCode(97 + i)}) ${r}`).join('\n');
  const recs = records.map(r => JSON.stringify(compact ? {
    id: r.id, relation: r.relation || 'fork', stars: r.stars, language: r.language, domain: r.domain_label, form: r.form_label, maturity: r.maturity,
    archived: r.archived || r.upstream_deleted || undefined, analysis: (r.analysis || r.description || '').slice(0, 420),
    use_cases: (r.use_cases || []).slice(0, 3).map(u => u.title), keywords: (r.keywords || []).slice(0, 8), note: r.note || undefined,
  } : {
    id: r.id, relation: r.relation || 'fork', upstream: r.upstream, stars: r.stars, language: r.language, domain: r.domain_label, form: r.form_label,
    maturity: r.maturity, archived: r.archived, upstream_deleted: r.upstream_deleted, license: r.license, pushed_at: r.pushed_at,
    description: r.description, analysis: r.analysis, use_cases: r.use_cases, keywords: r.keywords, signals: r.signals, note: r.note,
  })).join('\n');
  const projs = projects.length ? '\n\nOWNER\'S PROJECT BOARD (all columns; check for "already built" before recommending forks):\n' + projects.map(p => `- ${p.name} [${p.column || p.status}] status=${p.status}${p.url ? ' · ' + p.url : ''}${p.uses?.length ? ' · uses: ' + p.uses.join(', ') : ''}${p.summary ? '\n  ' + p.summary : ''}${p.brief ? '\n  ' + p.brief.slice(0, 600) : ''}`).join('\n') : '';
  return `BRIEF:\n${brief}\n\nREQUIREMENTS (plan must have exactly these items):\n${reqs || 'a) ' + brief.slice(0, 200)}\n\nRECORDS (one JSON per line; "relation" = fork | owner):\n${recs}${projs}`;
}
