"""Shared helpers for Fork Atlas scripts (stdlib + PyYAML only)."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "catalog"
OVERRIDES = ROOT / "overrides"
INPUTS = ROOT / ".classify-inputs"  # gitignored scratch for classifier inputs
TAXONOMY = ROOT / "taxonomy.yaml"

API = "https://api.github.com"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def gh_token() -> str | None:
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok:
        return tok
    try:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=15)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return None


_TOKEN = None


def gh_get(path: str, params: dict | None = None, raw: bool = False, accept: str | None = None):
    """GET a GitHub API path. Returns parsed JSON (or text if raw). None on 404."""
    global _TOKEN
    if _TOKEN is None:
        _TOKEN = gh_token() or ""
    url = path if path.startswith("http") else API + path
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    req.add_header("Accept", accept or "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "fork-atlas")
    if _TOKEN:
        req.add_header("Authorization", f"Bearer {_TOKEN}")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                if raw:
                    return body.decode("utf-8", errors="replace")
                return json.loads(body) if body else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (403, 429):
                reset = e.headers.get("X-RateLimit-Reset")
                wait = 60
                if reset:
                    wait = max(5, min(900, int(reset) - int(time.time()) + 2))
                print(f"  rate-limited on {path}; sleeping {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            if e.code >= 500:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except urllib.error.URLError:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GitHub API failed after retries: {path}")


def gh_paginate(path: str, params: dict | None = None, per_page: int = 100):
    page = 1
    params = dict(params or {})
    while True:
        params.update({"per_page": per_page, "page": page})
        batch = gh_get(path, params)
        if not batch:
            return
        yield from batch
        if len(batch) < per_page:
            return
        page += 1


def record_id(full_name: str) -> str:
    return full_name.replace("/", "__")


def record_path(full_name: str) -> Path:
    return CATALOG / f"{record_id(full_name)}.json"


def load_record(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_record(rec: dict) -> Path:
    CATALOG.mkdir(exist_ok=True)
    p = record_path(rec["fork"]["full_name"])
    p.write_text(json.dumps(rec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return p


def all_records() -> list[dict]:
    if not CATALOG.exists():
        return []
    return [load_record(p) for p in sorted(CATALOG.glob("*.json"))]


def load_taxonomy() -> dict:
    return yaml.safe_load(TAXONOMY.read_text(encoding="utf-8"))


def load_overrides() -> dict[str, dict]:
    """Map fork full_name -> override dict. Files are overrides/<owner>__<repo>.yaml."""
    out = {}
    if not OVERRIDES.exists():
        return out
    for p in OVERRIDES.glob("*.yaml"):
        if p.name.startswith("_"):
            continue
        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        full = p.stem.replace("__", "/", 1)
        out[full] = data
    return out


def fetch_readme(full_name: str, max_chars: int = 12000) -> str | None:
    data = gh_get(f"/repos/{full_name}/readme")
    if not data or "content" not in data:
        return None
    try:
        text = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
    except Exception:
        return None
    return text[:max_chars]


def fetch_tree_summary(full_name: str, branch: str, max_entries: int = 120) -> list[str]:
    data = gh_get(f"/repos/{full_name}/git/trees/{urllib.parse.quote(branch)}", {"recursive": "0"})
    if not data or "tree" not in data:
        return []
    return [t["path"] + ("/" if t["type"] == "tree" else "") for t in data["tree"][:max_entries]]


SIGNAL_FILES = {
    "pyproject.toml": "python", "setup.py": "python", "requirements.txt": "python",
    "package.json": "node", "pnpm-lock.yaml": "node", "yarn.lock": "node", "bun.lockb": "node",
    "Cargo.toml": "rust", "go.mod": "go", "pom.xml": "java", "build.gradle": "java",
    "Dockerfile": "docker", "docker-compose.yml": "docker", "docker-compose.yaml": "docker", "compose.yaml": "docker",
    "SKILL.md": "claude-skill", "CLAUDE.md": "claude-md", ".mcp.json": "mcp",
    "Makefile": "make", "flake.nix": "nix", "Gemfile": "ruby", "mix.exs": "elixir",
    "next.config.js": "nextjs", "next.config.mjs": "nextjs", "vite.config.ts": "vite", "vite.config.js": "vite",
    "tsconfig.json": "typescript", "environment.yml": "conda", "model_index.json": "diffusers",
}


def signals_from_tree(tree: list[str]) -> list[str]:
    found = set()
    for entry in tree:
        name = entry.rstrip("/").split("/")[-1]
        if name in SIGNAL_FILES:
            found.add(SIGNAL_FILES[name])
        if entry.startswith(".github/workflows/"):
            found.add("gh-actions")
        if entry.startswith("skills/") or entry.startswith(".claude/skills/"):
            found.add("claude-skill")
    return sorted(found)
