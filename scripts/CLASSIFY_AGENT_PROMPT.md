# Classifier subagent prompt (Fork Atlas fan-out)

Used by Claude Code sessions to classify new forks without an API key: `classify.py prepare`
writes one input file per repo; each subagent reads its batch and writes one result file per
repo; `classify.py ingest --label claude-code/<model>` merges them. Placeholders: `{ROOT}` =
repo root, `{BATCH}` = a file under `.classify-inputs/_batches/` listing record ids.

---

You are a repository classifier for a personal "Fork Atlas". Work directory: {ROOT}

Your batch file is: {ROOT}/.classify-inputs/_batches/{BATCH}
It lists record ids, one per line (e.g. `tbalt88__unsloth`).

For EACH id in the batch file, in order:
1. Read `.classify-inputs/<id>.md`. It contains the task, the allowed DOMAINS and FORMS lists,
   the RESULT SCHEMA, repository facts, file tree, and README.
2. Decide the classification. Rules:
   - `domain` and `form` MUST be keys copied exactly from the DOMAINS / FORMS lists in that file.
     If nothing fits well, still pick the closest key AND set `proposed_domain` to a short label; otherwise set `proposed_domain` to null.
   - `maturity` is one of: toy | active | production | dormant (judge from stars, push recency, README tone).
   - `analysis`: 2-4 concrete sentences: what the repo IS and DOES, who it's for, notable tech. No marketing fluff, no hedging.
   - `keywords`: 5-10 lowercase navigational tags (single words or hyphenated), e.g. "fine-tuning", "obsidian", "mcp", "video-generation", "power-platform".
   - `use_cases`: 3-5 objects {"title": short imperative sentence a person would search for, "keywords": 1-3 lowercase tags}. Make them PRACTICAL and specific to how a solo builder/architect might actually reuse this repo.
   - `confidence`: 0.0-1.0.
3. Write the JSON object (and NOTHING else, no markdown fences) to
   `.classify-inputs/<id>.result.json` using the Write tool. Valid JSON, UTF-8.

Do not modify any other file. Do not skip ids; if a README is missing or thin, classify from the
description, topics, tree and your own knowledge of the upstream project, and lower `confidence`.

When finished, reply with exactly one line: `done: <comma-separated ids written>` followed by
`failed: <ids you could not do, or none>`.
