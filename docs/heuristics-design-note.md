# GPT-5 Discipline Heuristics Design Note

## Goal
Push GPT-5/Codex-parity models toward pi-native tools (`read`, `edit`, `write`, `grep`, `find`, `ls`) and away from generic shell/Python detours when the structured tool already exists.

## Why this extension exists
Research from the OpenAI Codex docs and public issue tracker points to the same pattern:

- Codex is optimized around a **computer environment** and a strong **shell** primitive.
- GPT-5/Codex prompting still says to prefer tools when they exist, but the runtime affordance is biased toward shell/Python.
- Public Codex issues ask for dedicated `read` / `write` / `edit` / `grep` / `glob` tools because shell-only workflows create quoting, truncation, encoding, CRLF/LF, and cross-platform problems.

This means prompt text alone is not enough. Runtime guardrails are needed.

## Heuristic changes implemented

### 1) Wrapped shell commands are now inspected
Before:
- `cat README.md` was blocked
- `bash -lc 'cat README.md'` could slip through

Now:
- common wrappers like `bash -lc`, `sh -lc`, `zsh -lc`, and `powershell -Command` are unwrapped before evaluation

### 2) Scripted file reads are now blocked
Before:
- only shell inspection pipelines were blocked
- `python3 -c 'print(Path("foo").read_text())'` could slip through
- `node -e 'fs.readFileSync(...)'` could slip through

Now:
- Python reads: `Path(...).read_text()`, `open(...).read()`, `json.load(open(...))`, etc.
- JS runtime reads: `fs.readFileSync`, `fs.promises.readFile`, `Deno.readTextFile`, `Bun.file(...).text()`
- these are blocked when `read` is active and the target resolves inside the workspace

### 3) Inspection is path-aware
Before:
- inspection blocking was command-name based
- absolute outside-workspace paths like `/etc/hosts` could be overblocked
- mixed chains like `ls && pwd` could be overblocked if only part of the chain was replaceable

Now:
- current-directory and relative-path inspection is blocked
- explicit absolute paths outside `cwd` are allowed
- an inspection chain only blocks when **every** inspection segment has an active pi-native replacement

### 4) Mutation coverage is broader and safer
Before:
- redirection and some runtime writes were blocked
- `tee -a foo.txt` was not reliably caught
- `shutil.copy(..., target)` / `os.replace(..., target)` had suspicious-write detection but weak target extraction
- regex-based redirection detection could misread unrelated syntax such as JS arrow functions (`=>`)

Now:
- `tee` and `tee -a`
- Python move/copy/replace target extraction
- Bun/Deno write APIs
- better target extraction for `sed -i`, `perl -pi`, and `ruby -pi`
- shell-token-based redirection detection, which avoids `=>`-style false positives and ignores special sinks like `&1` / `/dev/null`

## Benchmark suite
Command:

```bash
bun run bench
```

Latest result:

- **202 / 202 cases passing**
- direct shell inspection cases
- wrapped shell inspection cases
- path-aware outside-workspace allow-cases
- scripted read cases
- mutation cases
- safe-mutator allowlist cases
- model/tool gating cases
- escape-hatch cases
- false-positive regression cases (`2>&1`, JS `=>`, mixed replaceable/non-replaceable chains)

## Live trace capture
For production hardening, the extension now supports opt-in JSONL trace logging:

```bash
export PI_GPT_DISCIPLINE_TRACE_FILE=/tmp/pi-gpt-discipline-trace.jsonl
```

Each trace record includes:
- timestamp
- model ID
- cwd
- active tools
- raw bash command
- allow/block decision

Summarize a captured trace with:

```bash
bun run replay-trace -- /tmp/pi-gpt-discipline-trace.jsonl
```

## Benchmark focus areas

### Must block
- `ls`, `find`, `fd`, `rg`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`
- `bash -lc 'cat file'`
- Python/Node/Bun/Deno file reads when `read` exists
- redirection writes
- `tee` writes
- `sed -i` / `perl -pi` / `ruby -pi`
- Python/Node/Bun/Deno file writes when `edit`/`write` exist

### Must allow
- formatters/fixers
- codemods
- normal execution commands (`npm test`, `git diff`, `python -c 'print(1+1)'`)
- non-target models
- cases where the equivalent pi tool is not active
- explicit escape hatch for shell-based file mutation
- absolute-path inspection outside the workspace root
- temp/log/output writes outside the workspace root
- stderr duplication and similar non-file sinks (`2>&1`, `/dev/null`)

## Current tradeoffs

### Intentional bias toward blocking
This extension is intentionally opinionated. If GPT-5 can do the job with a pi-native tool, the shell path should usually lose.

### Known conservative behavior
- scripted reads are currently workspace-scoped; `python -c 'open("/tmp/x").read()'` is allowed because the extension treats that as temp/outside-workspace shell usage
- some detection is still heuristic, even after moving the most error-prone inspection/redirection logic to token-based parsing

## Recommended next improvements

### High value
1. **Real trace benchmarking**
   - collect anonymized GPT-5 bash commands from actual pi sessions via `PI_GPT_DISCIPLINE_TRACE_FILE`
   - replay and summarize them with `bun run replay-trace -- <trace.jsonl>`
   - label false positives / false negatives and promote them into `benchmarks/cases.ts`

2. **Per-reason counters**
   - record whether a block came from shell inspection, scripted read, redirection write, in-place editor write, etc.
   - use that to identify the noisiest failure modes

3. **Strictness modes**
   - `default`: current behavior
   - `strict`: also block `cp`, `mv`, and maybe `git show file | ...`-style inspection when a native tool exists
   - `relaxed`: current allowlist plus fewer workspace-scoped inspection blocks

### Medium value
4. **More shell grammar awareness**
   - especially for complex pipelines, heredocs, and dense option syntax

5. **Optional outside-workspace policy**
   - configurable choice for whether `read` should also replace scripted reads and shell inspection of absolute paths outside `cwd`

6. **More runtime APIs**
   - add detection for more Bun/Deno/fs helper variants if real traces show drift there

## Recommended benchmark workflow
1. Add any newly observed GPT-5 shell misuse as a benchmark case first.
2. Make the smallest heuristic change that fixes it.
3. Re-run `bun run bench`.
4. Do not expand the heuristic unless it closes a real failure mode.

## Practical conclusion
The best architecture here is:

- **Prompt pressure** from pi’s system prompt
- **Runtime enforcement** from this extension
- **Benchmark replay** from a growing corpus of real GPT-5 commands

That combination is what keeps GPT-5 from falling back to generic bash/Python habits.
