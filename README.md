# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nurulnr/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nurulnr/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. It applies AI-written edits to a tree of text files in all four formats models write — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls — to one written specification. It finds the lines an edit names at the first of three matching tiers (exact, trailing whitespace, then leading and trailing whitespace, re-indenting at the last tier), and it changes every file or none: a failed edit changes nothing, the edits after it still run, and when any edit failed no file is written. It also handles CRLF files, files without a final line break, moves and renames, `--check` dry runs, and `--strict` exact-only matching.

## Run it

```sh
node main.ts fix.patch
node main.ts --format=v4a - < patch.txt
node main.ts --check --strict edit.patch
```

`node main.ts [options] [PATCH]` with the working directory as the root of the tree; PATCH is the patch file, or `-` (or absent) to read it from standard input. `--format=unified|search-replace|v4a|json|auto` (default `auto`) picks the format, `--check` prints what would change without writing, `--strict` matches lines exactly. Exit 0 prints what changed (`A`/`D`/`M`/`R` lines, then `ok: <n> files`); exit 1 lists the edits that failed and why; exit 2 is a usage, missing-patch, format, or parse error.

Deterministic: the same patch gives the same exit code, stdout, and files every run. Node 22, standard library only, no network, no install step. Practice score 1000/1000 on the kit's 100 public practice checks.

This entry is MIT licensed.
