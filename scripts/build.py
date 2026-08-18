"""Merge catalog + overrides -> matrix.json, MATRIX.md, matrix.csv, site/matrix.json.

Overrides (overrides/<owner>__<repo>.yaml) may set any of:
  domain, form, maturity, note, keywords_add (list), hidden (bool), pinned (bool)
They win over LLM fields in the matrix but never modify catalog/ files.
"""
from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

from common import ROOT, all_records, load_overrides, load_taxonomy, now_iso

SITE = ROOT / "site"


def flatten(rec: dict, ov: dict, tax: dict) -> dict:
    c = rec.get("classification") or {}
    up = rec["upstream"]
    dom_labels = {d["key"]: d["label"] for d in tax["domains"]}
    form_labels = {f["key"]: f["label"] for f in tax["forms"]}
    domain = ov.get("domain") or c.get("domain") or "unclassified"
    form = ov.get("form") or c.get("form") or "unclassified"
    keywords = sorted(set(c.get("keywords", [])) | set(ov.get("keywords_add", [])))
    return {
        "id": rec["fork"]["full_name"],
        "name": rec["fork"]["full_name"].split("/", 1)[1],
        "fork_url": rec["fork"]["url"],
        "forked_at": rec["fork"]["created_at"],
        "upstream": up.get("full_name"),
        "upstream_url": up.get("url"),
        "upstream_deleted": bool(up.get("deleted")),
        "description": up.get("description") or "",
        "stars": up.get("stars", 0),
        "language": up.get("language"),
        "topics": up.get("topics", []),
        "pushed_at": up.get("pushed_at"),
        "archived": bool(up.get("archived")),
        "license": up.get("license"),
        "homepage": up.get("homepage"),
        "signals": rec["meta"].get("signals", []),
        "actions": rec["fork"].get("actions", {}),
        "status": rec.get("status"),
        "domain": domain,
        "domain_label": dom_labels.get(domain, "Unclassified" if domain == "unclassified" else domain),
        "form": form,
        "form_label": form_labels.get(form, "Unclassified" if form == "unclassified" else form),
        "maturity": ov.get("maturity") or c.get("maturity"),
        "analysis": c.get("analysis", ""),
        "use_cases": c.get("use_cases", []),
        "keywords": keywords,
        "confidence": c.get("confidence"),
        "proposed_domain": c.get("proposed_domain"),
        # an override on domain/form counts as "reviewed by human"
        "needs_review": not (ov.get("domain") or ov.get("form")) and (
            bool(c.get("proposed_domain")) or (c.get("confidence") is not None and c["confidence"] < 0.5)),
        "classified_at": c.get("classified_at"),
        "note": ov.get("note"),
        "pinned": bool(ov.get("pinned")),
        "overridden": bool(ov),
    }


def md_escape(s: str) -> str:
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()


def write_markdown(items: list[dict], tax: dict, generated: str):
    by_dom = defaultdict(list)
    for it in items:
        by_dom[it["domain"]].append(it)
    order = [d["key"] for d in tax["domains"]] + ["unclassified"]
    labels = {d["key"]: d["label"] for d in tax["domains"]}
    labels["unclassified"] = "Unclassified (awaiting one-shot LLM pass)"

    lines = ["# Fork Atlas — Matrix", "",
             f"_Generated {generated} · {len(items)} forks · "
             f"{sum(1 for i in items if i['status']=='classified')} classified · "
             f"{sum(1 for i in items if i['needs_review'])} need review_", "",
             "Interactive viewer: see `site/index.html` (GitHub Pages). "
             "LLM columns are write-once; edit `overrides/` to correct Domain/Form.", "",
             "## Contents", ""]
    for key in order:
        if by_dom.get(key):
            lines.append(f"- [{labels[key]}](#{key}) ({len(by_dom[key])})")
    lines.append("")

    for key in order:
        group = by_dom.get(key)
        if not group:
            continue
        group.sort(key=lambda i: (-i["pinned"], i["form"], -(i["stars"] or 0)))
        lines += [f'<a id="{key}"></a>', f"## {labels[key]}", "",
                  "| Repo | Form | ★ | What it is | Use cases | Keywords |",
                  "|---|---|---:|---|---|---|"]
        for it in group:
            repo = f"[{it['upstream'] or it['name']}]({it['upstream_url'] or it['fork_url']})"
            if it["needs_review"]:
                repo += " ⚠"
            if it["pinned"]:
                repo = "📌 " + repo
            ucs = "<br>".join("• " + md_escape(u["title"]) for u in it["use_cases"][:4])
            what = md_escape(it["analysis"] or it["description"])
            if len(what) > 260:
                what = what[:257] + "…"
            lines.append(f"| {repo} | {md_escape(it['form_label'])} | {it['stars'] or 0} | {what} | {ucs} | "
                         f"{md_escape(', '.join(it['keywords'][:8]))} |")
        lines.append("")
    (ROOT / "MATRIX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_csv(items: list[dict]):
    cols = ["id", "upstream", "upstream_url", "domain_label", "form_label", "maturity", "stars", "language",
            "analysis", "use_cases", "keywords", "topics", "signals", "forked_at", "pushed_at", "archived",
            "needs_review", "note"]
    with (ROOT / "matrix.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for it in items:
            row = {k: it.get(k) for k in cols}
            row["use_cases"] = " | ".join(u["title"] for u in it["use_cases"])
            row["keywords"] = ", ".join(it["keywords"])
            row["topics"] = ", ".join(it["topics"])
            row["signals"] = ", ".join(it["signals"])
            w.writerow(row)


def main() -> int:
    tax = load_taxonomy()
    ovs = load_overrides()
    generated = now_iso()
    items = []
    for rec in all_records():
        ov = ovs.get(rec["fork"]["full_name"], {})
        if ov.get("hidden") or rec.get("status") == "gone":
            continue
        items.append(flatten(rec, ov, tax))
    items.sort(key=lambda i: i["forked_at"] or "", reverse=True)

    kw_index = defaultdict(list)
    for it in items:
        for k in it["keywords"]:
            kw_index[k].append(it["id"])
    matrix = {
        "generated_at": generated,
        "taxonomy": tax,
        "counts": {
            "total": len(items),
            "classified": sum(1 for i in items if i["status"] == "classified"),
            "unclassified": sum(1 for i in items if i["status"] != "classified"),
            "needs_review": sum(1 for i in items if i["needs_review"]),
        },
        "keywords": {k: v for k, v in sorted(kw_index.items(), key=lambda kv: -len(kv[1]))},
        "items": items,
    }
    js = json.dumps(matrix, indent=1, ensure_ascii=False)
    (ROOT / "matrix.json").write_text(js + "\n", encoding="utf-8")
    SITE.mkdir(exist_ok=True)
    (SITE / "matrix.json").write_text(js + "\n", encoding="utf-8")
    write_markdown(items, tax, generated)
    write_csv(items)
    write_agent_artifacts(items, tax, generated)
    print(f"matrix built: {matrix['counts']}")
    return 0


# ---------------------------------------------------------------- agent artifacts

def load_projects() -> list[dict]:
    """projects/<slug>.md with YAML frontmatter -> list of dicts (body kept, truncated)."""
    out = []
    pdir = ROOT / "projects"
    if not pdir.exists():
        return out
    import yaml
    for p in sorted(pdir.glob("*.md")):
        if p.name.startswith("_"):
            continue
        text = p.read_text(encoding="utf-8")
        fm, body = {}, text
        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) >= 3:
                fm = yaml.safe_load(parts[1]) or {}
                body = parts[2].strip()
        out.append({
            "slug": p.stem,
            "name": fm.get("name", p.stem),
            "status": fm.get("status", "idea"),
            "summary": fm.get("summary", ""),
            "uses": fm.get("uses", []) or [],
            "tags": fm.get("tags", []) or [],
            "brief": body[:4000],
        })
    return out


def write_agent_artifacts(items: list[dict], tax: dict, generated: str):
    """Compact index (LLM shortlist stage), full-record JSONL (context stage), projects."""
    compact = []
    for it in items:
        one = (it["analysis"] or it["description"] or "").strip()
        # first sentence, capped
        cut = one.find(". ")
        one = one[: cut + 1] if 0 < cut < 220 else one[:220]
        compact.append({
            "id": it["id"], "d": it["domain"], "f": it["form"], "m": it["maturity"],
            "s": it["stars"], "l": it["language"], "one": one,
            "kw": it["keywords"][:10], "uc": [u["title"] for u in it["use_cases"][:4]],
            "note": it["note"] or None,
        })
    (SITE / "index.compact.json").write_text(
        json.dumps({"generated_at": generated, "items": compact}, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8")
    with (SITE / "atlas.jsonl").open("w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    projects = load_projects()
    (SITE / "projects.json").write_text(json.dumps({"generated_at": generated, "projects": projects},
                                                   ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (ROOT / "projects.json").write_text(json.dumps({"generated_at": generated, "projects": projects},
                                                   ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
