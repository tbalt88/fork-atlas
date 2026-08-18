"""One-shot LLM classification of unclassified forks.

LLM fields (domain, form, analysis, use_cases, keywords, maturity) are WRITE-ONCE:
a record with status "classified" is skipped unless --force is given.

Three sub-commands:

  prepare            Gather README / tree / languages for eligible records into
                     .classify-inputs/<id>.md and update meta.signals. No LLM call.
  run                prepare + call the Anthropic API (needs ANTHROPIC_API_KEY in
                     your *local* environment; never store it in GitHub) and write results.
  ingest             Merge externally-produced .classify-inputs/<id>.result.json files
                     (e.g. written by a Claude Code session) into catalog records.

Common flags: --only owner/repo  --force  --limit N  --model MODEL
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

from common import (INPUTS, all_records, fetch_readme, fetch_tree_summary, gh_get,
                    load_taxonomy, now_iso, record_id, save_record, signals_from_tree)

DEFAULT_MODEL = "claude-haiku-4-5-20251001"

RESULT_SCHEMA_DOC = """{
  "domain": "<one key from DOMAINS>",
  "proposed_domain": "<optional: short label if none of DOMAINS fits well; else null>",
  "form": "<one key from FORMS>",
  "maturity": "<toy|active|production|dormant>",
  "analysis": "<2-4 sentences: what this repo IS and DOES, who it's for, notable tech. Plain, concrete.>",
  "keywords": ["<5-10 lowercase navigational tags, e.g. 'fine-tuning', 'obsidian', 'mcp'>"],
  "use_cases": [
    {"title": "<short imperative use case>", "keywords": ["<1-3 tags>"]}
  ],
  "confidence": <0.0-1.0>
}"""


def eligible(recs, only=None, force=False):
    for r in recs:
        if r.get("status") == "gone":
            continue
        if only and r["fork"]["full_name"] != only and r["upstream"].get("full_name") != only:
            continue
        if r.get("classification") and not force:
            continue
        yield r


def prepare_one(rec: dict) -> str:
    """Fetch inputs, update meta, write input markdown. Returns the markdown."""
    tax = load_taxonomy()
    up = rec["upstream"]
    target = up.get("full_name") if not up.get("deleted") else rec["fork"]["full_name"]
    branch = up.get("default_branch") or rec["fork"].get("default_branch") or "main"

    readme = fetch_readme(target) or fetch_readme(rec["fork"]["full_name"]) or "(no README found)"
    tree = fetch_tree_summary(target, branch)
    langs = gh_get(f"/repos/{target}/languages") or {}
    rec["meta"]["signals"] = signals_from_tree(tree)
    rec["meta"]["languages"] = langs
    rec["meta"]["inputs_prepared_at"] = now_iso()
    save_record(rec)

    dom_lines = "\n".join(f"- {d['key']}: {d['label']} — {d['hint']}" for d in tax["domains"])
    form_lines = "\n".join(f"- {f['key']}: {f['label']}" for f in tax["forms"])
    md = f"""# Classification input: {rec['fork']['full_name']}

## Task
Classify this GitHub repository for a personal "fork atlas". Return ONLY a JSON object
matching RESULT SCHEMA. Choose `domain` and `form` strictly from the lists below.

## DOMAINS
{dom_lines}

## FORMS
{form_lines}

## RESULT SCHEMA
{RESULT_SCHEMA_DOC}

## Repository facts
- Upstream: {up.get('full_name')}  ({up.get('url')})
- Description: {up.get('description')}
- Primary language: {up.get('language')}   Languages: {json.dumps(langs)}
- Topics: {', '.join(up.get('topics') or []) or '(none)'}
- Stars: {up.get('stars')}  Forks: {up.get('forks')}  Archived: {up.get('archived')}
- Created: {up.get('created_at')}  Last push: {up.get('pushed_at')}
- Homepage: {up.get('homepage')}
- Stack signals from tree: {', '.join(rec['meta']['signals']) or '(none)'}

## Top-level tree (first {len(tree)} entries)
{chr(10).join(tree) or '(unavailable)'}

## README (truncated)
{readme}
"""
    INPUTS.mkdir(exist_ok=True)
    (INPUTS / f"{record_id(rec['fork']['full_name'])}.md").write_text(md, encoding="utf-8")
    return md


def validate(result: dict, tax: dict) -> dict:
    dom_keys = {d["key"] for d in tax["domains"]}
    form_keys = {f["key"] for f in tax["forms"]}
    out = dict(result)
    if out.get("domain") not in dom_keys:
        out["proposed_domain"] = out.get("proposed_domain") or out.get("domain")
        out["domain"] = "misc"
    if out.get("form") not in form_keys:
        out["form"] = "app"
    if out.get("maturity") not in tax["maturity"]:
        out["maturity"] = "active"
    out["keywords"] = sorted({str(k).strip().lower() for k in out.get("keywords", []) if str(k).strip()})[:12]
    ucs = []
    for uc in out.get("use_cases", [])[:6]:
        if isinstance(uc, str):
            uc = {"title": uc, "keywords": []}
        ucs.append({"title": str(uc.get("title", "")).strip(),
                    "keywords": sorted({str(k).strip().lower() for k in uc.get("keywords", [])})[:3]})
    out["use_cases"] = [u for u in ucs if u["title"]]
    out["analysis"] = str(out.get("analysis", "")).strip()
    try:
        out["confidence"] = float(out.get("confidence", 0.7))
    except Exception:
        out["confidence"] = 0.7
    if not out.get("proposed_domain"):
        out.pop("proposed_domain", None)
    return out


def apply_result(rec: dict, result: dict, model: str, tax: dict):
    c = validate(result, tax)
    c["classified_at"] = now_iso()
    c["model"] = model
    rec["classification"] = c
    rec["status"] = "classified"
    save_record(rec)


def call_anthropic(prompt: str, model: str) -> dict:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("ANTHROPIC_API_KEY not set in local environment (do not put it in GitHub).")
    body = {
        "model": model,
        "max_tokens": 1500,
        "system": "You classify GitHub repositories. Reply with a single JSON object and nothing else.",
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(),
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    text = "".join(b.get("text", "") for b in data.get("content", []))
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{"):]
    return json.loads(text[text.find("{"): text.rfind("}") + 1])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prepare", "run", "ingest"])
    ap.add_argument("--only")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--label", default=None, help="model label recorded for ingest (e.g. 'claude-code/haiku')")
    args = ap.parse_args()

    tax = load_taxonomy()
    recs = list(eligible(all_records(), args.only, args.force))
    if args.limit:
        recs = recs[: args.limit]
    print(f"{len(recs)} record(s) eligible")

    if args.cmd in ("prepare", "run"):
        for i, rec in enumerate(recs, 1):
            print(f"[{i}/{len(recs)}] {rec['fork']['full_name']}")
            md = prepare_one(rec)
            if args.cmd == "run":
                result = call_anthropic(md, args.model)
                apply_result(rec, result, args.model, tax)
        return 0

    # ingest
    n = 0
    for rec in recs:
        p = INPUTS / f"{record_id(rec['fork']['full_name'])}.result.json"
        if not p.exists():
            continue
        try:
            result = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  ! bad JSON for {rec['fork']['full_name']}: {e}")
            continue
        apply_result(rec, result, args.label or args.model, tax)
        n += 1
    print(f"ingested {n} result(s)")
    missing = [r["fork"]["full_name"] for r in recs
               if not (INPUTS / f"{record_id(r['fork']['full_name'])}.result.json").exists()]
    if missing:
        print(f"still unclassified ({len(missing)}): " + ", ".join(missing[:20]) + (" ..." if len(missing) > 20 else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
