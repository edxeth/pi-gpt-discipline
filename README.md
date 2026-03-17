# pi-gpt-discipline

Model-specific discipline guardrails for GPT Codex-parity models in pi.

## Install

```bash
pi install git:github.com/edxeth/pi-gpt-discipline
```

## Scope
This extension only activates for model IDs:
- `gpt-5.4`
- `gpt-5.3-codex`

Provider is ignored. If the active model has one of those IDs, the guardrails apply.

## What it does
The extension watches `bash` tool calls and blocks two classes of behavior when better pi-native tools are available:

- **Shell-based file mutation**
  - Blocks Python/Node/Bun/Deno/sed/perl/ruby/redirection/`tee`-based file edits when `edit`/`write` should be used instead.
  - Existing files should go through `edit`.
  - New files and intentional full rewrites should go through `write`.
  - Unwraps common nested shell wrappers such as `bash -lc '...'` before evaluating the command.

- **Shell-based workspace inspection**
  - Blocks `bash` inspection pipelines when equivalent pi tools are active.
  - Blocks scripted file reads through Python/Node/Bun/Deno when `read` is available and the target resolves inside the workspace.
  - Path-aware behavior:
    - current-directory and relative-path inspection is blocked
    - absolute paths outside `cwd` are allowed
  - Uses this mapping:
    - `ls` → `ls`
    - `find` / `fd` → `find`
    - `rg` / `grep` → `grep`
    - `cat` / `head` / `tail` / `sed` / `awk` (read-only inspection) → `read`

- **Blocked `bash` command compaction in context**
  - Every blocked `bash` assistant tool call is replaced in future context with a tiny stub.
  - The stub only remembers what kind of action was attempted plus target/size metadata.
  - The matching `toolResult` remains responsible for explaining the error.

- **Oversized `bash` output compaction**
  - Large successful `bash` outputs are compacted before they are fed back to the model.
  - The compacted result keeps counts plus head/tail previews instead of full payloads.
  - This especially prevents generated source code dumped to stdout from bloating context.
  - Older oversized `bash` tool results are also compacted again in the `context` hook before future LLM calls.

- **Oversized `write` payload compaction in context**
  - After a large `write` succeeds, the matching assistant tool call is compacted in future context.
  - The model keeps the fact that the file was written, but not the entire file body in conversation history.
  - If contents are needed again later, the model should use `read`.

## What it still allows
The extension intentionally allows shell-based mutation when that is the right tool for the job.

Known allowed patterns include:
- formatters/fixers such as `prettier`, `biome`, `eslint --fix`, `ruff`, `black`, `cargo fmt`, `terraform fmt`
- codemod-style tools such as `jscodeshift`, `comby`, `ast-grep`, `sg rewrite`
- absolute-path inspection outside `cwd` such as `cat /etc/hosts`
- temp/log/output writes outside `cwd` such as `echo hi > /tmp/file.txt`
- all shell usage on non-target models
- normal shell workflows when no equivalent pi tool is active

## Escape hatch
If shell-based file mutation is genuinely required, allow it explicitly by including:

Runtime block messages intentionally do not advertise this escape hatch to the model, and non-user context is redacted before future LLM calls so the model does not learn it from prior assistant/tool messages.

```bash
PI_ALLOW_SHELL_FILE_EDIT=1
```

Example:

```bash
PI_ALLOW_SHELL_FILE_EDIT=1 python3 - <<'PY'
from pathlib import Path
Path('generated.ts').write_text('export const generated = true\n')
PY
```

## Example block messages
File mutation:

```text
bash file mutation is blocked in this environment for `foo.ts`. Use read to inspect, edit for localized changes to existing files, and write for new files or full rewrites.
```

Workspace inspection:

```text
bash-based workspace inspection is blocked in this environment when equivalent pi tools are available. Use `ls` for directory listings, `find` for file discovery, `grep` for content search, and `read` for file contents.
```

## Benchmarking
Run the benchmark suite with:

```bash
bun run bench
```

Current suite coverage:
- 202 cases
- direct shell inspection
- wrapped `bash -lc` / `sh -lc` / `zsh -lc` / `powershell -Command` inspection
- path-aware outside-workspace inspection allow-cases
- scripted reads via Python/Node/Bun/Deno
- shell/scripted mutation via redirection, `tee`, in-place editors, and JS/Python runtimes
- safe mutator allowlist coverage
- false-positive regression checks such as `2>&1` and JS arrow functions (`=>`)
- model/tool gating and escape-hatch coverage

## Live trace capture
Opt-in trace logging for real GPT-5 sessions:

```bash
export PI_GPT_DISCIPLINE_TRACE_FILE=/tmp/pi-gpt-discipline-trace.jsonl
```

Each target-model `bash` tool call is logged as JSONL with:
- timestamp
- model ID
- cwd
- active tools
- raw command
- allow/block decision

Summarize a captured trace with:

```bash
bun run replay-trace -- /tmp/pi-gpt-discipline-trace.jsonl
```

## Files
- `index.ts` — extension entrypoint and pure evaluation helper
- `benchmarks/cases.ts` — benchmark corpus
- `benchmarks/run.ts` — benchmark runner
- `benchmarks/replay.ts` — JSONL trace summarizer
- `package.json` — pi package manifest

## Notes
- This extension is intentionally narrow and model-gated.
- It does **not** append extra system-prompt text; it only enforces tool-call discipline at runtime.
- It works best alongside `gpt-5.4` / `gpt-5.3-codex` where shell-overuse tends to be most annoying.
