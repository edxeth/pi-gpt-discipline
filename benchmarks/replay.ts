export {};

declare const Bun: {
	argv: string[];
	file: (path: string) => { text: () => Promise<string> };
};

type TraceDecision =
	| { block: false }
	| { block: true; category: "mutation" | "inspection"; sampleTarget?: string };

type TraceRecord = {
	timestamp?: string;
	modelId?: string;
	cwd?: string;
	activeTools?: string[];
	command?: string;
	decision?: TraceDecision;
};

const traceFile = Bun.argv[2];
if (!traceFile) {
	throw new Error("Usage: bun run benchmarks/replay.ts <trace.jsonl>");
}

const text = await Bun.file(traceFile).text();
const lines = text.split(/\r?\n/).filter(Boolean);
const records: TraceRecord[] = [];
for (const line of lines) {
	try {
		records.push(JSON.parse(line) as TraceRecord);
	} catch {
		console.warn(`Skipping invalid JSONL line: ${line.slice(0, 120)}`);
	}
}

const stats = {
	total: records.length,
	blocked: 0,
	allowed: 0,
	mutation: 0,
	inspection: 0,
};

const blockedExamples = new Map<string, number>();
for (const record of records) {
	if (record.decision?.block) {
		stats.blocked += 1;
		if (record.decision.category === "mutation") stats.mutation += 1;
		if (record.decision.category === "inspection") stats.inspection += 1;
		const key = `${record.decision.category}: ${record.command ?? "<missing command>"}`;
		blockedExamples.set(key, (blockedExamples.get(key) ?? 0) + 1);
	} else {
		stats.allowed += 1;
	}
}

console.log(`Trace file: ${traceFile}`);
console.log(`Records: ${stats.total}`);
console.log(`Allowed: ${stats.allowed}`);
console.log(`Blocked: ${stats.blocked}`);
console.log(`- mutation: ${stats.mutation}`);
console.log(`- inspection: ${stats.inspection}`);

const topBlocked = Array.from(blockedExamples.entries())
	.sort((a, b) => b[1] - a[1])
	.slice(0, 20);

if (topBlocked.length > 0) {
	console.log("\nTop blocked commands:");
	for (const [command, count] of topBlocked) {
		console.log(`${count}x  ${command}`);
	}
}
