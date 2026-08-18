"""Discover forks for a GitHub user and keep catalog/ in sync.

- New forks  -> stub record with status "unclassified" (LLM fields empty).
- Known forks -> refresh cheap API metadata only (stars, pushed_at, archived, ...).
- Forks that vanished from GitHub -> status "gone" (record kept for history).

Never touches `classification` on existing records.

Usage: python scripts/discover.py [--user tbalt88] [--limit N]
"""
from __future__ import annotations

import argparse
import json
import sys

from common import (all_records, gh_get, gh_paginate, load_record, now_iso, record_path,
                    save_record, CATALOG)


def upstream_block(parent: dict | None) -> dict:
    if not parent:
        return {"deleted": True}
    return {
        "full_name": parent["full_name"],
        "url": parent["html_url"],
        "description": parent.get("description"),
        "stars": parent.get("stargazers_count", 0),
        "forks": parent.get("forks_count", 0),
        "watchers": parent.get("subscribers_count", parent.get("watchers_count", 0)),
        "open_issues": parent.get("open_issues_count", 0),
        "language": parent.get("language"),
        "topics": parent.get("topics", []),
        "license": (parent.get("license") or {}).get("spdx_id"),
        "homepage": parent.get("homepage") or None,
        "default_branch": parent.get("default_branch"),
        "created_at": parent.get("created_at"),
        "pushed_at": parent.get("pushed_at"),
        "archived": parent.get("archived", False),
        "deleted": False,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="tbalt88")
    ap.add_argument("--limit", type=int, default=0, help="stop after N forks (debug)")
    args = ap.parse_args()

    CATALOG.mkdir(exist_ok=True)
    existing = {r["fork"]["full_name"]: r for r in all_records()}
    seen = set()
    new = updated = 0

    print(f"Listing repos for {args.user} ...")
    for repo in gh_paginate(f"/users/{args.user}/repos", {"type": "owner", "sort": "created"}):
        if not repo.get("fork"):
            continue
        full = repo["full_name"]
        seen.add(full)
        if args.limit and (new + updated) >= args.limit:
            break

        # /users/:u/repos omits `parent`; fetch the repo itself to get upstream.
        detail = gh_get(f"/repos/{full}") or {}
        parent = detail.get("parent")
        # `parent` from /repos/:o/:r is not the full object (no topics/subscribers) -> fetch upstream directly.
        if parent:
            up_full = parent["full_name"]
            up = gh_get(f"/repos/{up_full}")
            parent = up or parent

        fork_block = {
            "full_name": full,
            "url": repo["html_url"],
            "created_at": repo["created_at"],
            "default_branch": repo.get("default_branch"),
            "pushed_at": repo.get("pushed_at"),
        }
        upstream = upstream_block(parent)
        if upstream.get("deleted") and detail.get("source"):
            # parent gone but source chain exists
            src = gh_get(f"/repos/{detail['source']['full_name']}")
            upstream = upstream_block(src)
            upstream["via_source"] = True

        if full in existing:
            rec = existing[full]
            before = json.dumps({k: v for k, v in rec.items() if k != "meta"}, sort_keys=True)
            rec["fork"] = fork_block
            # keep any previously seen upstream identity if it disappeared
            if upstream.get("deleted") and not rec["upstream"].get("deleted"):
                rec["upstream"]["deleted"] = True
                rec["upstream"]["deleted_at"] = now_iso()
            else:
                rec["upstream"] = upstream
            if rec.get("status") == "gone":
                rec["status"] = "classified" if rec.get("classification") else "unclassified"
            after = json.dumps({k: v for k, v in rec.items() if k != "meta"}, sort_keys=True)
            if before != after:
                # only touch the file when a real fact changed -> quiet daily diffs
                rec["meta"]["metadata_refreshed_at"] = now_iso()
                save_record(rec)
                updated += 1
        else:
            rec = {
                "fork": fork_block,
                "upstream": upstream,
                "meta": {
                    "discovered_at": now_iso(),
                    "metadata_refreshed_at": now_iso(),
                    "signals": [],
                    "languages": {},
                },
                "classification": None,
                "status": "unclassified",
            }
            save_record(rec)
            new += 1
            print(f"  + new fork: {full}  (upstream: {upstream.get('full_name', '?')})")

    gone = 0
    for full, rec in existing.items():
        if full not in seen and rec.get("status") != "gone":
            rec["status"] = "gone"
            rec["meta"]["gone_at"] = now_iso()
            save_record(rec)
            gone += 1
            print(f"  - fork no longer present: {full}")

    print(f"Done. new={new} changed={updated} gone={gone} total={len(seen)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
