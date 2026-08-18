// llm.js — provider adapters. Config lives ONLY in this browser's localStorage.
// Providers: ollama (localhost, auto-detected), anthropic (BYO key, browser-direct).
// Both return schema-validated JSON objects; both stream partial text via onToken.

const KEY = 'atlas.llm.v1';

export const DEFAULTS = {
  order: ['ollama', 'anthropic'],
  ollama: { url: 'http://localhost:11434', shortlistModel: '', reasonModel: '', enabled: true, numCtx: 8192 },
  anthropic: { key: '', shortlistModel: 'claude-haiku-4-5-20251001', reasonModel: 'claude-sonnet-5', enabled: true },
};

export function loadConfig() {
  try { return deepMerge(structuredClone(DEFAULTS), JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { return structuredClone(DEFAULTS); }
}
export function saveConfig(cfg) { localStorage.setItem(KEY, JSON.stringify(cfg)); }
function deepMerge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] || {}, b[k]); else a[k] = b[k]; } return a; }

// ---- Ollama -----------------------------------------------------------------
export async function probeOllama(url, timeoutMs = 700) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/api/tags', { signal: ctl.signal });
    if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
    const d = await r.json();
    return { ok: true, models: (d.models || []).map(m => ({ name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size })) };
  } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : (e.message || 'unreachable') }; }
  finally { clearTimeout(t); }
}

// Prefer chat/instruct models; skip embedding models; prefer bigger for reasoning.
export function pickOllamaModels(models) {
  const chat = models.filter(m => !/embed|bge|minilm|e5/i.test(m.name));
  const bySize = [...chat].sort((a, b) => (b.size || 0) - (a.size || 0));
  return { shortlist: (chat.find(m => (m.size || 0) < 6e9) || bySize.at(-1))?.name || '', reason: bySize[0]?.name || '' };
}

async function ollamaChat({ url, model, system, user, schema, numCtx, onToken, signal }) {
  const body = { model, stream: true, options: { temperature: 0.2, num_ctx: numCtx || 8192 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (schema) body.format = schema;
  const r = await fetch(url.replace(/\/$/, '') + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  let text = '';
  for await (const line of ndjson(r.body)) {
    const j = JSON.parse(line);
    if (j.message?.content) { text += j.message.content; onToken?.(j.message.content, text); }
    if (j.error) throw new Error(j.error);
  }
  return text;
}

// ---- Anthropic --------------------------------------------------------------
async function anthropicChat({ key, model, system, user, schema, onToken, signal, maxTokens = 4000 }) {
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], stream: true };
  if (schema) {
    body.tools = [{ name: 'emit', description: 'Emit the structured answer.', input_schema: schema }];
    body.tool_choice = { type: 'tool', name: 'emit' };
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  let text = '';
  for await (const evt of sse(r.body)) {
    if (evt.type === 'content_block_delta') {
      const d = evt.delta;
      const piece = d.type === 'input_json_delta' ? d.partial_json : d.type === 'text_delta' ? d.text : '';
      if (piece) { text += piece; onToken?.(piece, text); }
    } else if (evt.type === 'error') throw new Error(evt.error?.message || 'stream error');
  }
  return text;
}

// ---- unified ------------------------------------------------------------------
export async function complete({ provider, cfg, slot, system, user, schema, onToken, signal }) {
  const p = cfg[provider];
  const model = slot === 'reason' ? p.reasonModel : p.shortlistModel;
  if (!model) throw new Error(`${provider}: no ${slot} model configured`);
  const text = provider === 'ollama'
    ? await ollamaChat({ url: p.url, model, system, user, schema, numCtx: p.numCtx, onToken, signal })
    : await anthropicChat({ key: p.key, model, system, user, schema, onToken, signal });
  return schema ? parseJson(text) : text;
}

export function parseJson(text) {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('model returned no JSON object');
  return JSON.parse(t.slice(a, b + 1));
}

// Resolve which provider is usable right now, in configured order.
export async function resolveProvider(cfg) {
  const status = {};
  for (const name of cfg.order) {
    const p = cfg[name]; if (!p?.enabled) { status[name] = 'disabled'; continue; }
    if (name === 'ollama') {
      const pr = await probeOllama(p.url);
      status.ollamaModels = pr.ok ? pr.models : [];
      if (!pr.ok) { status[name] = 'unreachable (' + pr.reason + ')'; continue; }
      if (!p.shortlistModel || !p.reasonModel) { const pick = pickOllamaModels(pr.models); p.shortlistModel ||= pick.shortlist; p.reasonModel ||= pick.reason; }
      if (!p.reasonModel) { status[name] = 'no chat models installed'; continue; }
      status[name] = 'ready'; return { provider: name, status };
    }
    if (name === 'anthropic') {
      if (!p.key) { status[name] = 'no key'; continue; }
      status[name] = 'ready'; return { provider: name, status };
    }
  }
  return { provider: null, status };
}

// ---- stream helpers -----------------------------------------------------------
async function* ndjson(body) {
  const rd = body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) yield line; } }
  if (buf.trim()) yield buf.trim();
}
async function* sse(body) {
  const rd = body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (data && data !== '[DONE]') { try { yield JSON.parse(data); } catch { /* ignore */ } } } }
}
