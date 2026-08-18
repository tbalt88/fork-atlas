# Fork Atlas — Runbook

*Read this if you've forgotten how any of it works. Written 2026-08-18 so nothing here depends on memory.*

## What this is

- **Matrix:** https://tbalt88.github.io/fork-atlas/ — every repo `tbalt88` has forked, classified Domain × Form, with a one-shot LLM analysis, use cases and keywords. Search it when you have a use case and want to know what you already own.
- **Assistant (homepage):** https://tbalt88.github.io/fork-atlas/agent.html — "I want to build X that does a, b, c" → grounded recommendations from your forks, with reasons, caveats and gaps. Also shows the **Keeper** (health of the catalog) and your vault **Project board**.
- **Repo:** https://github.com/tbalt88/fork-atlas (public). All scripts run from the root of your local clone.

## What runs by itself

| Thing | How | When | Where to look if it stops |
|---|---|---|---|
| Discover new forks, refresh stars/pushed/archived, rebuild matrix + MATRIX.md + CSV, deploy Pages | GitHub Action `atlas.yml` (holds only `GITHUB_TOKEN`) | nightly 06:17 UTC, on every push, or **Actions → Run workflow** | https://github.com/tbalt88/fork-atlas/actions — GitHub emails you on failure |
| Board snapshot push (`site/board.snapshot.json`) | Mac mini `~/.config/obsidian-second-brain/vault-autopush.sh` → `push_board_snapshot()` (Claude Code SessionEnd hook + launchd `io.dexevo.secondbrain.autopush` daily 22:40; skips when board sha unchanged, state in `fork-atlas-board.sha`; done 2026-08-18, Memory Bridge `7375ade0…` archived) | after board regeneration | `/tmp/vault-autopush.log` on the Mac mini; assistant page label `snapshot · <date>` goes stale → see prompts below |
| Provider auto-detect (Ollama on the machine you're on) | the page, on load | every load | ⚙ Providers → Detect models |
| Private repos merged into search (if a token is saved in that browser) | the page, on load, GitHub API + ETag cache | every load | keeper tile *private repos (live)* + hint |

## What needs a human (and the exact words)

The assistant page shows these prompts itself when they're needed (amber boxes with a *copy* button). Say them to Claude Code in an interactive session in the `fork-atlas` folder:

| Situation (the page tells you) | Prompt |
|---|---|
| Keeper shows *N forks running upstream crons* | **In fork-atlas, list forks whose upstream scheduled workflows run on my account and disable GitHub Actions on them (gh api PUT repos/<fork>/actions/permissions enabled=false), then rebuild.** |
| Keeper shows *N unclassified* | **Classify unclassified forks in fork-atlas (prepare → Sonnet fan-out → ingest → build → push).** |
| Project board label is a stale *snapshot* and you don't want a browser token | **Refresh the fork-atlas Project board snapshot from vault-bridge (Boards/Projects.md) and push.** |
| *Catalog last built N days ago* | **Check why the fork-atlas nightly Action stopped building (gh run list in tbalt88/fork-atlas) and fix it.** |
| A repo is filed wrong / needs a note | **In fork-atlas, mark `<owner/repo>` as `<domain>` (reviewed) with note "…" and push.** — or hand-edit `overrides/<owner>__<repo>.yaml` |
| You want the LLM to redo one repo | `python scripts/classify.py run --only owner/repo --force` (needs local `ANTHROPIC_API_KEY`) |

Manual equivalents (no Claude): `python scripts/discover.py` · `python scripts/classify.py prepare|run|ingest` · `python scripts/build.py` · `python scripts/stats.py`.

## Per-device setup (once per browser)

Open the assistant → **⚙ Providers**:

1. **Ollama** — auto-detected at `http://localhost:11434`. Ollama must allow the Pages origin: set `OLLAMA_ORIGINS=https://tbalt88.github.io` (Windows: env var; Mac: `launchctl setenv OLLAMA_ORIGINS https://tbalt88.github.io` — session-only) and restart Ollama. Pick a small model for *shortlist* and the best you can run for *reasoning* (on a 4 GB GPU use the smallest for both).
   - **Mac mini, reboot-proof (done 2026-08-18):** the var lives in `~/Library/LaunchAgents/homebrew.mxcl.ollama.plist` → `EnvironmentVariables`. `brew services start|restart ollama` regenerates that plist and drops it; re-add with `/usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:OLLAMA_ORIGINS string https://tbalt88.github.io' ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`, then `launchctl bootout gui/$(id -u)/homebrew.mxcl.ollama && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist`.
   - **Safari cannot use local Ollama** from this https page: WebKit treats `http://localhost` as mixed content and blocks the fetch before CORS is even consulted; no setting changes it. Use Chrome, Firefox or Edge (they exempt localhost), or serve the page locally over http.
2. **Anthropic (optional)** — paste an API key with a spend cap; used only when Ollama isn't reachable. Cents per question.
3. **Project board (optional)** — a **fine-grained GitHub token**, repository access `second-brain` only, permission **Contents: Read-only**. Makes the board live instead of snapshot.
4. **Private repos in search (optional)** — a *separate* fine-grained token, **All repositories**, **Metadata + Contents: Read-only**. The pages list your private repos live from GitHub on each load and merge them into search (tag *private · live*); READMEs are fetched on demand for shortlisted ones. Nothing about private repos is ever written to this repo or Pages — no LLM classification is stored for them (they sit in "Private (live)"). Want Domain/Form/use cases for private repos too? That is the "private overlay" design (a separate private repo), not built.

Everything in ⚙ lives in that browser's localStorage. **Nothing here is ever committed to the repo.**

## Rules that must not drift

1. **No third-party or vault-reading secrets in this public repo or its Actions.** Only `GITHUB_TOKEN`.
2. **LLM fields are write-once per repo.** Automation never overwrites `classification`; corrections go in `overrides/`.
3. **The viewer never depends on Claude.** Static files; any LLM (or none) can read `matrix.json`.
4. **The Project board's source of truth is the vault** (`Boards/Projects.md`, generated from `Projects/*.md` frontmatter). This repo only mirrors it. *The Watch* is a different note (state log), not the board.

## Where the memory lives (for agents)

- **Memory Bridge:** project entry `4eee11a1-d54a-418d-a08a-0af4ce155eb4` (facts, decisions, prompts) · Mac-mini task `7375ade0-c55d-4f2f-93fe-9724d255a2b3` (board snapshot automation — done + receipted 2026-08-18, archived).
- **Vault:** `Projects/Fork Atlas.md` (project note, on the board) · `Debriefs/2026-08-18 - fork-atlas-build-debrief.md`.
- **Local Claude Code memory (win):** Claude Code auto-memory for the project folder on each machine (`~/.claude/projects/<folder>/memory/fork-atlas-project.md`).

## Layout

```
catalog/      one JSON per repo: forks + my own public repos, `relation: fork|owner` (API metadata + write-once classification)
overrides/    your corrections (domain/form/maturity/note/keywords_add/pinned/hidden)
projects/     optional atlas-only briefs (the vault board is the real project list)
taxonomy.yaml 20 domains × 8 forms × 4 maturity levels
scripts/      discover · classify · build · stats
site/         index.html (matrix) · agent.html (assistant) · js/ · matrix.json · index.compact.json · atlas.jsonl · board.snapshot.json
.github/workflows/atlas.yml
```

## Deferred on purpose

- **atlas-mcp** — same retrieval as the page, exposed as MCP tools so dev agents (Claude Code, Gemini CLI) can query the atlas on your subscription. Build when a dev agent needs it.
- Owned + starred repos in the catalog (a flag in `discover.py`); PAT write-back of overrides/briefs from the browser; Cloudflare Access if the site ever needs to be private.
