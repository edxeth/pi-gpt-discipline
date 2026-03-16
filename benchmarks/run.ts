import { performance } from "node:perf_hooks";
import { evaluateBashDiscipline } from "../index.ts";
import { benchmarkCases, DEFAULT_EXISTING_PATHS, DEFAULT_MODEL_ID, DEFAULT_TOOLS } from "./cases.ts";

const cwd = "/repo";

function toAbsolute(relativePath: string): string {
	return `${cwd}/${relativePath}`;
}

function sameResult(actual: ReturnType<typeof evaluateBashDiscipline>, expected: ReturnType<typeof evaluateBashDiscipline>): boolean {
	if (actual.block !== expected.block) return false;
	if (!actual.block || !expected.block) return true;
	if (actual.category !== expected.category) return false;
	if (expected.sampleTarget && actual.sampleTarget !== expected.sampleTarget) return false;
	return true;
}

const startedAt = performance.now();
const failures: Array<{ name: string; command: string; expected: unknown; actual: unknown }> = [];
const stats = {
	total: 0,
	blocked: 0,
	allowed: 0,
	mutationBlocks: 0,
	inspectionBlocks: 0,
};

for (const testCase of benchmarkCases) {
	stats.total += 1;
	const existingPaths = new Set((testCase.existingPaths ?? DEFAULT_EXISTING_PATHS).map(toAbsolute));
	const actual = evaluateBashDiscipline({
		modelId: testCase.modelId === undefined ? DEFAULT_MODEL_ID : testCase.modelId,
		command: testCase.command,
		cwd,
		activeTools: testCase.activeTools ?? DEFAULT_TOOLS,
		pathExists: (path) => existingPaths.has(path),
	});

	if (actual.block) {
		stats.blocked += 1;
		if (actual.category === "mutation") stats.mutationBlocks += 1;
		if (actual.category === "inspection") stats.inspectionBlocks += 1;
	} else {
		stats.allowed += 1;
	}

	if (!sameResult(actual, testCase.expected)) {
		failures.push({
			name: testCase.name,
			command: testCase.command,
			expected: testCase.expected,
			actual,
		});
	}
}

const durationMs = performance.now() - startedAt;

console.log(`Benchmark cases: ${stats.total}`);
console.log(`Allowed: ${stats.allowed}`);
console.log(`Blocked: ${stats.blocked}`);
console.log(`- mutation blocks: ${stats.mutationBlocks}`);
console.log(`- inspection blocks: ${stats.inspectionBlocks}`);
console.log(`Duration: ${durationMs.toFixed(2)}ms`);

if (failures.length > 0) {
	console.error(`\nFailures: ${failures.length}`);
	for (const failure of failures) {
		console.error(`\n[${failure.name}]`);
		console.error(`command: ${failure.command}`);
		console.error(`expected: ${JSON.stringify(failure.expected)}`);
		console.error(`actual:   ${JSON.stringify(failure.actual)}`);
	}
	process.exitCode = 1;
} else {
	console.log("All benchmark cases passed.");
}
