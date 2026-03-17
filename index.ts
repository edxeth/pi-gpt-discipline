import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const ALLOW_SHELL_EDIT_MARKER = "PI_ALLOW_SHELL_FILE_EDIT=1";
const TRACE_FILE_ENV = "PI_GPT_DISCIPLINE_TRACE_FILE";
const TARGET_MODEL_IDS = new Set(["gpt-5.4", "gpt-5.3-codex"]);

const SAFE_MUTATORS = [
	/\bprettier\b/i,
	/\bbiome\b/i,
	/\beslint\b[\s\S]*\s--fix\b/i,
	/\boxlint\b[\s\S]*\s--fix\b/i,
	/\bruff\b[\s\S]*\b(format|check\b[\s\S]*\s--fix)\b/i,
	/\bblack\b/i,
	/\bisort\b/i,
	/\bgofmt\b/i,
	/\bgo\s+fmt\b/i,
	/\bcargo\s+fmt\b/i,
	/\brustfmt\b/i,
	/\bclang-format\b/i,
	/\bswiftformat\b/i,
	/\btaplo\s+fmt\b/i,
	/\bterraform\s+fmt\b/i,
	/\bjscodeshift\b/i,
	/\bcomby\b/i,
	/\bast-grep\b/i,
	/\bsg\b[\s\S]*\b(rewrite|run)\b/i,
];

const INSPECTION_COMMANDS = new Set([
	"pwd",
	"ls",
	"find",
	"fd",
	"tree",
	"rg",
	"grep",
	"cat",
	"head",
	"tail",
	"sed",
	"awk",
]);

export type BashDisciplineResult =
	| { block: false }
	| {
		block: true;
		category: "mutation" | "inspection";
		reason: string;
		sampleTarget?: string;
	};

export type BashDisciplineOptions = {
	modelId?: string | null;
	command: string;
	cwd: string;
	activeTools: Iterable<string>;
	pathExists?: (path: string) => boolean;
};

function isTargetModelId(modelId: string | null | undefined): boolean {
	return !!modelId && TARGET_MODEL_IDS.has(modelId);
}

function isTargetModel(ctx: ExtensionContext): boolean {
	return isTargetModelId(ctx.model?.id);
}

function isSafeMutator(command: string): boolean {
	return SAFE_MUTATORS.some((pattern) => pattern.test(command));
}

function unwrapShellWrapperCommand(command: string): string | undefined {
	const trimmed = command.trim();
	const patterns = [
		/^(?:env\s+)?(?:bash|sh|zsh)\s+-lc\s+(['"])([\s\S]*)\1$/i,
		/^(?:env\s+)?(?:pwsh|powershell)\s+-Command\s+(['"])([\s\S]*)\1$/i,
	];
	for (const pattern of patterns) {
		const match = trimmed.match(pattern);
		if (match?.[2]) {
			return match[2].trim().replace(/\\(["'`])/g, "$1");
		}
	}
	return undefined;
}

function normalizeCommand(command: string): string {
	let normalized = command.trim();
	for (let i = 0; i < 3; i += 1) {
		const unwrapped = unwrapShellWrapperCommand(normalized);
		if (!unwrapped || unwrapped === normalized) break;
		normalized = unwrapped;
	}
	return normalized;
}

function isSpecialFileTarget(target: string): boolean {
	return target === "-"
		|| /^&\d+$/.test(target)
		|| /^(?:[<>])\(.+\)$/.test(target)
		|| /^\/dev\/(?:stdout|stderr|null|fd\/\d+)$/.test(target)
		|| /^(?:\/proc|\/sys)\//.test(target);
}

function sanitizeTarget(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim().replace(/^["'`]+|["'`;,:`]+$/g, "");
	if (!trimmed) return undefined;
	if (/[`$*?]/.test(trimmed)) return undefined;
	if (isSpecialFileTarget(trimmed)) return undefined;
	return trimmed;
}

function pushMatches(targets: Set<string>, command: string, pattern: RegExp, group = 1) {
	for (const match of command.matchAll(pattern)) {
		const target = sanitizeTarget(match[group]);
		if (target) targets.add(target);
	}
}

function extractMutationTargets(command: string): string[] {
	const targets = new Set<string>();
	pushMatches(targets, command, /Path\(\s*["'`]([^"'`]+)["'`]\s*\)/gi);
	pushMatches(targets, command, /open\(\s*["'`]([^"'`]+)["'`]\s*,/gi);
	pushMatches(targets, command, /(?:writeFileSync|appendFileSync|writeFile|appendFile|writeTextFile)\(\s*["'`]([^"'`]+)["'`]/gi);
	pushMatches(targets, command, /(?:fs\.promises\.)?(?:writeFile|appendFile)\(\s*["'`]([^"'`]+)["'`]/gi);
	pushMatches(targets, command, /Deno\.(?:writeTextFile|writeTextFileSync|writeFile|writeFileSync)\(\s*["'`]([^"'`]+)["'`]/gi);
	pushMatches(targets, command, /Bun\.write\(\s*["'`]([^"'`]+)["'`]/gi);
	pushMatches(targets, command, /shutil\.(?:move|copy|copy2)\(\s*["'`][^"'`]+["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi);
	pushMatches(targets, command, /os\.(?:rename|replace)\(\s*["'`][^"'`]+["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi);
	for (const target of extractRedirectionTargets(command)) targets.add(target);
	pushMatches(targets, command, /\btee\b(?:\s+-[-\w]+)*\s+([^\s|&;]+)/gi);
	pushMatches(targets, command, /\bsed\s+-i(?:[^\n\s]*)?(?:\s+-e)?\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s|&;]+)/gi);
	pushMatches(targets, command, /\bperl\s+-pi(?:[^\n\s]*)?(?:\s+-e)?\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s|&;]+)/gi);
	pushMatches(targets, command, /\bruby\s+-pi(?:[^\n\s]*)?(?:\s+-e)?\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s|&;]+)/gi);
	return Array.from(targets);
}

function extractReadTargets(command: string): string[] {
	const targets = new Set<string>();
	pushMatches(targets, command, /Path\(\s*["'`]([^"'`]+)["'`]\s*\)/gi);
	pushMatches(targets, command, /open\(\s*["'`]([^"'`]+)["'`]/gi);
	pushMatches(targets, command, /(?:readFileSync|readFile|readTextFile|readFileUtf8)\(\s*["'`]([^"'`]+)["'`]/gi);
	pushMatches(targets, command, /(?:fs\.promises\.)?readFile\(\s*["'`]([^"'`]+)["'`]/gi);
	pushMatches(targets, command, /Deno\.(?:readTextFile|readTextFileSync|readFile|readFileSync)\(\s*["'`]([^"'`]+)["'`]/gi);
	pushMatches(targets, command, /Bun\.file\(\s*["'`]([^"'`]+)["'`]\s*\)/gi);
	return Array.from(targets);
}

function resolveWorkspaceTargets(targets: string[], cwd: string): string[] {
	return targets
		.map((target) => isAbsolute(target) ? target : resolve(cwd, target))
		.filter((resolved) => {
			const rel = relative(cwd, resolved);
			return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		});
}

function hasSuspiciousPythonWrite(command: string): boolean {
	return /\bpython\d*\b/i.test(command) && (
		/\.write_text\s*\(/i.test(command)
		|| /\.write_bytes\s*\(/i.test(command)
		|| /\.append_text\s*\(/i.test(command)
		|| /\.append_bytes\s*\(/i.test(command)
		|| /open\s*\([^\n)]*,\s*["'](?:w|a|x|wb|ab|xb)/i.test(command)
		|| /json\.dump\s*\(/i.test(command)
		|| /yaml\.dump\s*\(/i.test(command)
		|| /toml\.dump\s*\(/i.test(command)
		|| /shutil\.(move|copy|copy2)\s*\(/i.test(command)
		|| /os\.(rename|replace)\s*\(/i.test(command)
	);
}

function hasSuspiciousPythonRead(command: string): boolean {
	return /\bpython\d*\b/i.test(command) && (
		/\.read_text\s*\(/i.test(command)
		|| /\.read_bytes\s*\(/i.test(command)
		|| /open\s*\([^\n)]*(?:,\s*["'](?:r|rb)["'])?[^\n)]*\)\s*\.\s*read/i.test(command)
		|| /\bjson\.load\s*\(\s*open\s*\(/i.test(command)
		|| /\byaml\.(?:safe_)?load\s*\(\s*open\s*\(/i.test(command)
		|| /\btoml\.load\s*\(\s*open\s*\(/i.test(command)
	);
}

function hasSuspiciousJsRuntimeWrite(command: string): boolean {
	return /\b(node|bun|deno)\b/i.test(command) && (
		/writeFileSync\s*\(/i.test(command)
		|| /appendFileSync\s*\(/i.test(command)
		|| /fs\.promises\.writeFile\s*\(/i.test(command)
		|| /fs\.promises\.appendFile\s*\(/i.test(command)
		|| /\.writeFile\s*\(/i.test(command)
		|| /\.appendFile\s*\(/i.test(command)
		|| /Deno\.(?:writeTextFile|writeTextFileSync|writeFile|writeFileSync)\s*\(/i.test(command)
		|| /Bun\.write\s*\(/i.test(command)
	);
}

function hasSuspiciousJsRuntimeRead(command: string): boolean {
	return /\b(node|bun|deno)\b/i.test(command) && (
		/readFileSync\s*\(/i.test(command)
		|| /fs\.promises\.readFile\s*\(/i.test(command)
		|| /\.readFile\s*\(/i.test(command)
		|| /Deno\.(?:readTextFile|readTextFileSync|readFile|readFileSync)\s*\(/i.test(command)
		|| /Bun\.file\s*\([^\n)]*\)\s*\.\s*(?:text|json|arrayBuffer|bytes|stream)\s*\(/i.test(command)
	);
}

function hasSuspiciousInlineMutator(command: string): boolean {
	return /\bsed\s+-i(?:[\s'"=]|$)/i.test(command)
		|| /\bperl\s+-pi(?:[\s'"=]|$)/i.test(command)
		|| /\bruby\s+-pi(?:[\s'"=]|$)/i.test(command)
		|| /\bawk\b[\s\S]*\binplace\b/i.test(command);
}

function extractRedirectionTargets(command: string): string[] {
	const tokens = tokenizeShellWords(command);
	const targets = new Set<string>();

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token) continue;

		if (/^(?:\d+)?(?:>|>>)$/.test(token)) {
			const next = sanitizeTarget(tokens[i + 1]);
			if (next) targets.add(next);
			continue;
		}

		const inlineMatch = token.match(/^(?:\d+)?(>>?)(.+)$/);
		if (!inlineMatch) continue;
		const candidate = sanitizeTarget(inlineMatch[2]);
		if (candidate) targets.add(candidate);
	}

	return Array.from(targets);
}

function hasSuspiciousRedirection(command: string): boolean {
	return extractRedirectionTargets(command).length > 0;
}

function hasSuspiciousTeeWrite(command: string): boolean {
	return /\btee\b(?:\s+-[-\w]+)*\s+[^\s|&;]+/i.test(command);
}

function isSuspiciousShellEdit(command: string): boolean {
	if (command.includes(ALLOW_SHELL_EDIT_MARKER)) return false;
	if (isSafeMutator(command)) return false;
	return hasSuspiciousPythonWrite(command)
		|| hasSuspiciousJsRuntimeWrite(command)
		|| hasSuspiciousInlineMutator(command)
		|| hasSuspiciousRedirection(command)
		|| hasSuspiciousTeeWrite(command);
}

function isSuspiciousScriptedRead(command: string): boolean {
	if (isSafeMutator(command)) return false;
	return hasSuspiciousPythonRead(command) || hasSuspiciousJsRuntimeRead(command);
}

function splitCommandSegments(command: string): string[] {
	return command
		.split(/(?:&&|\|\||;|\n)+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function tokenizeShellWords(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const char of segment.trim()) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaped) current += "\\";
	if (current.length > 0) tokens.push(current);
	return tokens;
}

function looksLikeEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function extractPrimaryCommand(segment: string): string | undefined {
	const tokens = tokenizeShellWords(segment.replace(/^\(+/, ""));
	const command = tokens.find((token) => !looksLikeEnvAssignment(token));
	if (!command) return undefined;
	return command.replace(/^["'`]+|["'`]+$/g, "");
}

function getInspectionReplacementTool(commandName: string): "ls" | "find" | "grep" | "read" | undefined {
	if (commandName === "ls" || commandName === "tree") return "ls";
	if (commandName === "find" || commandName === "fd") return "find";
	if (commandName === "rg" || commandName === "grep") return "grep";
	if (commandName === "cat" || commandName === "head" || commandName === "tail" || commandName === "sed" || commandName === "awk") return "read";
	return undefined;
}

function stripAfterPipe(tokens: string[]): string[] {
	const pipeIndex = tokens.indexOf("|");
	return pipeIndex === -1 ? tokens : tokens.slice(0, pipeIndex);
}

function isInspectionControlToken(token: string): boolean {
	return token === "--" || token === "|" || token === ">" || token === ">>" || token === "<" || token === "<<" || token === "<<<";
}

function isLikelyInspectionPathToken(token: string): boolean {
	if (!token || token.startsWith("-")) return false;
	if (isInspectionControlToken(token)) return false;
	if (isSpecialFileTarget(token)) return false;
	return true;
}

function filterArgsSkippingOptionValues(args: string[], optionsWithValues: Set<string>): string[] {
	const filtered: string[] = [];
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (optionsWithValues.has(arg)) {
			skipNext = true;
			continue;
		}
		filtered.push(arg);
	}
	return filtered;
}

function extractExplicitInspectionTargets(commandName: string, tokens: string[]): string[] {
	const args = stripAfterPipe(tokens.slice(1));
	const grepLikeArgs = filterArgsSkippingOptionValues(args, new Set(["-e", "-f", "-g", "-m", "-A", "-B", "-C", "--glob", "--iglob", "--file", "--max-count", "--context"]));
	const headTailArgs = filterArgsSkippingOptionValues(args, new Set(["-n", "-c"]));
	const fdArgs = filterArgsSkippingOptionValues(args, new Set(["-e", "-E", "-t", "-x", "-X", "--extension", "--exclude", "--type", "--exec", "--exec-batch"]));
	const nonOptionArgs = args.filter((token) => !token.startsWith("-") && isLikelyInspectionPathToken(token));

	if (commandName === "ls" || commandName === "tree" || commandName === "cat") return nonOptionArgs;
	if (commandName === "head" || commandName === "tail") return headTailArgs.filter((token) => !token.startsWith("-") && isLikelyInspectionPathToken(token));
	if (commandName === "find") {
		const targets: string[] = [];
		for (const arg of args) {
			if (arg.startsWith("-") || arg === "(" || arg === ")" || arg === "!" || arg === "-o") break;
			if (isLikelyInspectionPathToken(arg)) targets.push(arg);
		}
		return targets;
	}
	if (commandName === "fd") {
		const pathArgs = fdArgs.filter((token) => !token.startsWith("-") && isLikelyInspectionPathToken(token));
		return pathArgs.slice(1);
	}
	if (commandName === "rg" || commandName === "grep") {
		const pathArgs = grepLikeArgs.filter((token) => !token.startsWith("-") && isLikelyInspectionPathToken(token));
		return pathArgs.slice(1);
	}
	if (commandName === "sed" || commandName === "awk") return nonOptionArgs.slice(1);
	return [];
}

function targetsWorkspace(targets: string[], cwd: string): boolean {
	if (targets.length === 0) return true;
	return targets.some((target) => resolveWorkspaceTargets([target], cwd).length > 0);
}

function shouldBlockInspectionCommand(command: string, activeTools: Set<string>, cwd: string): boolean {
	const segments = splitCommandSegments(command);
	if (segments.length === 0) return false;

	const parsedSegments = segments
		.map((segment) => {
			const tokens = tokenizeShellWords(segment.replace(/^\(+/, ""));
			const name = tokens.find((token) => !looksLikeEnvAssignment(token));
			return name ? { name, tokens } : undefined;
		})
		.filter((value): value is { name: string; tokens: string[] } => !!value);
	if (parsedSegments.length === 0) return false;
	if (!parsedSegments.every(({ name }) => INSPECTION_COMMANDS.has(name))) return false;

	if (!parsedSegments.every(({ name }) => {
		const replacement = getInspectionReplacementTool(name);
		return replacement ? activeTools.has(replacement) : false;
	})) {
		return false;
	}

	return parsedSegments.some(({ name, tokens }) => {
		const replacement = getInspectionReplacementTool(name);
		if (!replacement) return false;
		return targetsWorkspace(extractExplicitInspectionTargets(name, tokens), cwd);
	});
}

function formatSampleTarget(target: string, cwd: string): string {
	return target.replace(`${cwd}/`, "");
}

function writeTraceRecord(record: Record<string, unknown>) {
	const env = typeof globalThis === "object" && "process" in globalThis
		? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
		: undefined;
	const traceFile = env?.[TRACE_FILE_ENV];
	if (!traceFile) return;
	try {
		mkdirSync(dirname(traceFile), { recursive: true });
		appendFileSync(traceFile, `${JSON.stringify(record)}\n`);
	} catch {
		// Tracing must never break the guardrail itself.
	}
}

function evaluateMutationBlock(
	command: string,
	cwd: string,
	activeTools: Set<string>,
	pathExists: (path: string) => boolean,
): BashDisciplineResult | undefined {
	if (!isSuspiciousShellEdit(command)) return undefined;

	const canEdit = activeTools.has("edit");
	const canWrite = activeTools.has("write");
	if (!canEdit && !canWrite) return undefined;

	const workspaceTargets = resolveWorkspaceTargets(extractMutationTargets(command), cwd);
	if (workspaceTargets.length === 0) return undefined;

	const existingTargets = workspaceTargets.filter((target) => pathExists(target));
	const newTargets = workspaceTargets.filter((target) => !pathExists(target));
	const shouldBlockExisting = canEdit && existingTargets.length > 0;
	const shouldBlockNew = canWrite && newTargets.length > 0;
	if (!shouldBlockExisting && !shouldBlockNew) return undefined;

	const sampleTarget = formatSampleTarget(existingTargets[0] ?? newTargets[0] ?? "this file", cwd);
	return {
		block: true,
		category: "mutation",
		sampleTarget,
		reason:
			`Bash file mutation is blocked for \`${sampleTarget}\` because it bypasses the built-in file tools. `
			+ "Use `read` to inspect, `edit` for localized changes to existing files, and `write` for new files or full rewrites. "
			+ `If shell-based mutation is genuinely required, retry with \`${ALLOW_SHELL_EDIT_MARKER}\` and keep the command narrowly scoped.`,
	};
}

function evaluateInspectionBlock(command: string, cwd: string, activeTools: Set<string>): BashDisciplineResult | undefined {
	if (activeTools.has("read") && isSuspiciousScriptedRead(command)) {
		const workspaceTargets = resolveWorkspaceTargets(extractReadTargets(command), cwd);
		if (workspaceTargets.length > 0) {
			const sampleTarget = formatSampleTarget(workspaceTargets[0]!, cwd);
			return {
				block: true,
				category: "inspection",
				sampleTarget,
				reason:
					`Scripted file inspection is blocked for \`${sampleTarget}\` because it routes file reads through bash or runtime wrappers instead of the built-in \`read\` tool. `
					+ "Use `read` directly for file contents.",
			};
		}
	}

	if (!shouldBlockInspectionCommand(command, activeTools, cwd)) return undefined;
	return {
		block: true,
		category: "inspection",
		reason:
			"Bash-based workspace inspection is blocked because it bypasses the built-in inspection tools. "
			+ "Use `ls` for directory listings, `find` for file discovery, `grep` for content search, and `read` for file contents.",
	};
}

export function evaluateBashDiscipline(options: BashDisciplineOptions): BashDisciplineResult {
	const { modelId, cwd, activeTools: rawTools, pathExists = existsSync } = options;
	if (!isTargetModelId(modelId)) return { block: false };

	const command = normalizeCommand(options.command);
	if (!command) return { block: false };

	const activeTools = new Set(rawTools);

	return evaluateMutationBlock(command, cwd, activeTools, pathExists)
		?? evaluateInspectionBlock(command, cwd, activeTools)
		?? { block: false };
}

export default function gptDisciplineExtension(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isTargetModel(ctx) || event.toolName !== "bash") return;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!command) return;

		const activeTools = pi.getActiveTools();
		const decision = evaluateBashDiscipline({
			modelId: ctx.model?.id,
			command,
			cwd: ctx.cwd,
			activeTools,
		});
		writeTraceRecord({
			timestamp: new Date().toISOString(),
			modelId: ctx.model?.id,
			cwd: ctx.cwd,
			activeTools,
			command,
			decision,
		});
		if (!decision.block) return;

		return {
			block: true,
			reason: decision.reason,
		};
	});
}
