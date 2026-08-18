# Fork Atlas

A living, self-updating matrix of every repository forked by [@tbalt88](https://github.com/tbalt88):
what each one *is*, grouped by **Domain × Form**, with a one-shot LLM abstraction and
potential use cases, keyword-tagged so a use case can be matched to a fork quickly.

- **Viewer (GitHub Pages):** `site/index.html` — search, Domain×Form matrix, keyword chips, cards/list, detail drawer.
- **Markdown view:** [`MATRIX.md`](MATRIX.md) — rendered directly on GitHub.
- **Data:** [`matrix.json`](matrix.json) (full), [`matrix.csv`](matrix.csv) (flat, for Sheets/Excel).

Nothing here depends on Claude or any specific LLM to *view*. Any tool can read the JSON.

## How it stays alive

| Piece | Runs where | Frequency | Touches LLM fields? |
|---|---|---|---|
| `scripts/discover.py` | GitHub Actions (nightly) or local | daily | **never** — stubs new forks as `unclassified`, refreshes stars/pushed_at/archived |
| `scripts/classify.py` | **local only** (needs `ANTHROPIC_API_KEY` in your shell) or a Claude Code session | when you want | writes once per repo; skips classified records unless `--force` |
| `scripts/build.py` | Actions + local | after either | merges `catalog/` + `overrides/` → `matrix.json`, `MATRIX.md`, `matrix.csv` |

The GitHub Action holds **no third-party secrets** — only the built-in `GITHUB_TOKEN`.

## Local usage

```bash
pip install pyyaml
python scripts/discover.py                  # sync catalog with GitHub (uses `gh auth token`)
python scripts/classify.py prepare          # gather README/tree for unclassified forks -> .classify-inputs/
python scripts/classify.py run              # ...or prepare + call Anthropic API (Haiku) and write results
python scripts/classify.py ingest --label claude-code   # merge externally produced *.result.json files
python scripts/build.py                     # regenerate matrix + markdown + csv
python -m http.server -d site 8080          # preview viewer at http://localhost:8080
```

Re-classify a single repo deliberately: `python scripts/classify.py run --only owner/repo --force`.

## Layout

```
catalog/<owner>__<repo>.json   one record per fork (API metadata + write-once classification)
overrides/<owner>__<repo>.yaml your corrections (domain/form/maturity/note/pinned/hidden)
taxonomy.yaml                  controlled vocab: domains, forms, maturity
scripts/                       discover / classify / build
site/                          static viewer (Pages) + matrix.json copy
MATRIX.md, matrix.json, matrix.csv   generated outputs (committed)
```

## Record schema (catalog)

```json
{
  "fork":     {"full_name","url","created_at","default_branch","pushed_at"},
  "upstream": {"full_name","url","description","stars","forks","language","topics","license",
               "homepage","default_branch","created_at","pushed_at","archived","deleted"},
  "meta":     {"discovered_at","metadata_refreshed_at","signals":[],"languages":{}},
  "classification": {"domain","form","maturity","analysis","keywords":[],
                     "use_cases":[{"title","keywords":[]}],"confidence",
                     "proposed_domain?","classified_at","model"},
  "status": "unclassified | classified | gone"
}
```

Records with `proposed_domain` or confidence < 0.5 show as **⚠ needs review** in the viewer.
