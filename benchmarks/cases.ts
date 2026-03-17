import type { BashDisciplineResult } from "../index.ts";

export type BenchmarkCase = {
	name: string;
	command: string;
	expected: BashDisciplineResult;
	modelId?: string | null;
	activeTools?: string[];
	existingPaths?: string[];
};

export const DEFAULT_MODEL_ID = "gpt-5.4";
export const DEFAULT_TOOLS = ["read", "edit", "write", "grep", "find", "ls"];
export const DEFAULT_EXISTING_PATHS = [
	"README.md",
	"package.json",
	"src/index.ts",
	"config.json",
	"notes.txt",
];

const noBlock: BashDisciplineResult = { block: false };
const blockInspection = (sampleTarget?: string): BashDisciplineResult => ({
	block: true,
	category: "inspection",
	reason: sampleTarget
		? `Scripted file inspection is blocked for \`${sampleTarget}\` because it routes file reads through bash or runtime wrappers instead of the built-in \`read\` tool. Use \`read\` directly for file contents.`
		: "Bash-based workspace inspection is blocked because it bypasses the built-in inspection tools. Use `ls` for directory listings, `find` for file discovery, `grep` for content search, and `read` for file contents.",
	sampleTarget,
});
const blockMutation = (sampleTarget: string): BashDisciplineResult => ({
	block: true,
	category: "mutation",
	reason: `Bash file mutation is blocked for \`${sampleTarget}\` because it bypasses the built-in file tools. Use \`read\` to inspect, \`edit\` for localized changes to existing files, and \`write\` for new files or full rewrites.`,
	sampleTarget,
});

type Wrapper = {
	name: string;
	wrap: (command: string) => string;
};

const WRAPPERS: Wrapper[] = [
	{ name: "bash -lc", wrap: (command) => `bash -lc ${JSON.stringify(command)}` },
	{ name: "sh -lc", wrap: (command) => `sh -lc ${JSON.stringify(command)}` },
	{ name: "zsh -lc", wrap: (command) => `zsh -lc ${JSON.stringify(command)}` },
	{ name: "powershell -Command", wrap: (command) => `powershell -Command ${JSON.stringify(command)}` },
];

function wrapCases(cases: BenchmarkCase[], wrappers = WRAPPERS): BenchmarkCase[] {
	return cases.flatMap((testCase) => wrappers.map((wrapper) => ({
		...testCase,
		name: `${testCase.name} [${wrapper.name}]`,
		command: wrapper.wrap(testCase.command),
	})));
}

const directInspectionCases: BenchmarkCase[] = [
	{ name: "inspection ls", command: "ls -la", expected: blockInspection() },
	{ name: "inspection tree", command: "tree src", expected: blockInspection() },
	{ name: "inspection find", command: "find src -name '*.ts'", expected: blockInspection() },
	{ name: "inspection fd", command: "fd TODO src", expected: blockInspection() },
	{ name: "inspection rg", command: "rg TODO src", expected: blockInspection() },
	{ name: "inspection grep", command: "grep -R TODO src", expected: blockInspection() },
	{ name: "inspection cat", command: "cat README.md", expected: blockInspection() },
	{ name: "inspection head", command: "head -n 20 README.md", expected: blockInspection() },
	{ name: "inspection tail", command: "tail -n 20 README.md", expected: blockInspection() },
	{ name: "inspection sed", command: "sed -n '1,20p' README.md", expected: blockInspection() },
	{ name: "inspection awk", command: "awk 'NR<=20' README.md", expected: blockInspection() },
	{ name: "inspection ls with stderr dup", command: "ls 2>&1", expected: blockInspection() },
];

const wrappedInspectionSeeds: BenchmarkCase[] = [
	{ name: "wrapped inspection cat", command: "cat README.md", expected: blockInspection() },
	{ name: "wrapped inspection head", command: "head -n 10 README.md", expected: blockInspection() },
	{ name: "wrapped inspection find", command: "find src -name '*.ts'", expected: blockInspection() },
	{ name: "wrapped inspection rg", command: "rg TODO src", expected: blockInspection() },
	{ name: "wrapped inspection ls", command: "ls -la", expected: blockInspection() },
];

const scriptedReadCases: BenchmarkCase[] = [
	{ name: "python pathlib read_text", command: 'python3 -c "from pathlib import Path; print(Path(\"README.md\").read_text())"', expected: blockInspection("README.md") },
	{ name: "python open read", command: 'python3 -c "print(open(\"README.md\").read())"', expected: blockInspection("README.md") },
	{ name: "python json load", command: 'python3 -c "import json; print(json.load(open(\"package.json\")))"', expected: blockInspection("package.json") },
	{ name: "node readFileSync", command: "node -e \"console.log(require('fs').readFileSync('README.md', 'utf8'))\"", expected: blockInspection("README.md") },
	{ name: "node promises readFile", command: "node -e \"require('fs').promises.readFile('README.md', 'utf8').then(console.log)\"", expected: blockInspection("README.md") },
	{ name: "bun file text", command: 'bun -e "await Bun.file(\"README.md\").text()"', expected: blockInspection("README.md") },
	{ name: "deno readTextFile", command: 'deno eval "console.log(await Deno.readTextFile(\"README.md\"))"', expected: blockInspection("README.md") },
];

const mutationCases: BenchmarkCase[] = [
	{ name: "redirection existing", command: "echo hi > README.md", expected: blockMutation("README.md") },
	{ name: "redirection new", command: "echo hi > new-file.txt", expected: blockMutation("new-file.txt") },
	{ name: "tee existing", command: "printf hi | tee README.md", expected: blockMutation("README.md") },
	{ name: "tee append new", command: "printf hi | tee -a generated.txt", expected: blockMutation("generated.txt") },
	{ name: "sed inplace", command: "sed -i 's/a/b/' README.md", expected: blockMutation("README.md") },
	{ name: "perl inplace", command: "perl -pi -e 's/a/b/' README.md", expected: blockMutation("README.md") },
	{ name: "ruby inplace", command: "ruby -pi -e 'gsub(/a/, \"b\")' README.md", expected: blockMutation("README.md") },
	{ name: "python pathlib write_text", command: 'python3 -c "from pathlib import Path; Path(\"README.md\").write_text(\"x\")"', expected: blockMutation("README.md") },
	{ name: "python json dump", command: 'python3 -c "import json; json.dump({\"a\":1}, open(\"config.generated.json\", \"w\"))"', expected: blockMutation("config.generated.json") },
	{ name: "python shutil copy", command: 'python3 -c "import shutil; shutil.copy(\"README.md\", \"README.copy.md\")"', expected: blockMutation("README.copy.md") },
	{ name: "python os replace", command: 'python3 -c "import os; os.replace(\"README.md\", \"README.next.md\")"', expected: blockMutation("README.next.md") },
	{ name: "node writeFileSync", command: "node -e \"require('fs').writeFileSync('README.md', 'x')\"", expected: blockMutation("README.md") },
	{ name: "bun write", command: 'bun -e "await Bun.write(\"generated.ts\", \"export const x = 1\\n\")"', expected: blockMutation("generated.ts") },
	{ name: "deno writeTextFile", command: 'deno eval "await Deno.writeTextFile(\"generated.ts\", \"x\")"', expected: blockMutation("generated.ts") },
];

const wrappedMutationSeeds: BenchmarkCase[] = [
	{ name: "wrapped mutation redirection", command: "echo hi > README.md", expected: blockMutation("README.md") },
	{ name: "wrapped mutation tee", command: "printf hi | tee generated.txt", expected: blockMutation("generated.txt") },
	{ name: "wrapped mutation python write_text", command: 'python3 -c "from pathlib import Path; Path(\"README.md\").write_text(\"x\")"', expected: blockMutation("README.md") },
	{ name: "wrapped mutation node writeFileSync", command: "node -e \"require('fs').writeFileSync('README.md', 'x')\"", expected: blockMutation("README.md") },
	{ name: "wrapped mutation sed", command: "sed -i 's/a/b/' README.md", expected: blockMutation("README.md") },
];

const safeMutatorCases: BenchmarkCase[] = [
	{ name: "allow prettier", command: "prettier --write README.md", expected: noBlock },
	{ name: "allow biome", command: "biome format --write README.md", expected: noBlock },
	{ name: "allow eslint fix", command: "eslint src --fix", expected: noBlock },
	{ name: "allow oxlint fix", command: "oxlint . --fix", expected: noBlock },
	{ name: "allow ruff format", command: "ruff format .", expected: noBlock },
	{ name: "allow black", command: "black .", expected: noBlock },
	{ name: "allow gofmt", command: "gofmt -w .", expected: noBlock },
	{ name: "allow cargo fmt", command: "cargo fmt", expected: noBlock },
	{ name: "allow clang-format", command: "clang-format -i src.c", expected: noBlock },
	{ name: "allow terraform fmt", command: "terraform fmt -recursive", expected: noBlock },
	{ name: "allow jscodeshift", command: "jscodeshift -t codemod.js src", expected: noBlock },
	{ name: "allow ast-grep", command: "ast-grep --pattern foo --rewrite bar src", expected: noBlock },
];

const legitShellCases: BenchmarkCase[] = [
	{ name: "allow pwd", command: "pwd", expected: noBlock },
	{ name: "allow git diff", command: "git diff --stat", expected: noBlock },
	{ name: "allow npm test", command: "npm test", expected: noBlock },
	{ name: "allow python compute", command: 'python3 -c "print(1 + 1)"', expected: noBlock },
	{ name: "allow node compute", command: 'node -e "console.log(process.version)"', expected: noBlock },
	{ name: "allow node arrow function", command: 'node -e "const f=(x)=>x; console.log(f(1))"', expected: noBlock },
	{ name: "allow stdout awk", command: "printf 'a\\nb\\n' | awk 'NR==1'", expected: noBlock },
	{ name: "allow mixed npm and cat", command: "npm test && cat README.md", expected: noBlock },
	{ name: "allow ls mixed with pwd", command: "ls && pwd", expected: noBlock },
	{ name: "allow rg mixed with pwd", command: "rg TODO src && pwd", expected: noBlock },
	{ name: "allow git grep", command: "git grep TODO", expected: noBlock },
	{ name: "allow cat outside workspace", command: "cat /etc/hosts", expected: noBlock },
	{ name: "allow head outside workspace", command: "head -n 20 /etc/hosts", expected: noBlock },
	{ name: "allow tail outside workspace", command: "tail -n 20 /etc/hosts", expected: noBlock },
	{ name: "allow grep outside workspace", command: "grep root /etc/hosts", expected: noBlock },
	{ name: "allow rg outside workspace", command: "rg root /tmp/pi-gpt-discipline.log", expected: noBlock },
	{ name: "allow ls outside workspace", command: "ls /tmp", expected: noBlock },
	{ name: "allow find outside workspace", command: "find /tmp -name '*.log'", expected: noBlock },
	{ name: "allow write outside workspace redirection", command: "echo hi > /tmp/pi-gpt-discipline.txt", expected: noBlock },
	{ name: "allow tee outside workspace", command: "printf hi | tee /tmp/pi-gpt-discipline.txt", expected: noBlock },
	{ name: "allow scripted read outside workspace", command: 'python3 -c "from pathlib import Path; print(Path(\"/tmp/pi-gpt-discipline.txt\").read_text())"', expected: noBlock },
	{ name: "allow scripted write outside workspace", command: 'python3 -c "from pathlib import Path; Path(\"/tmp/pi-gpt-discipline.txt\").write_text(\"x\")"', expected: noBlock },
	{ name: "allow stderr redirection only", command: "echo hi 2>&1", expected: noBlock },
];

const wrappedLegitOutsideWorkspaceSeeds: BenchmarkCase[] = [
	{ name: "wrapped allow cat outside workspace", command: "cat /etc/hosts", expected: noBlock },
	{ name: "wrapped allow head outside workspace", command: "head -n 20 /etc/hosts", expected: noBlock },
	{ name: "wrapped allow grep outside workspace", command: "grep root /etc/hosts", expected: noBlock },
	{ name: "wrapped allow ls outside workspace", command: "ls /tmp", expected: noBlock },
	{ name: "wrapped allow find outside workspace", command: "find /tmp -name '*.log'", expected: noBlock },
	{ name: "wrapped allow node arrow function", command: 'node -e "const f=(x)=>x; console.log(f(1))"', expected: noBlock },
	{ name: "wrapped allow temp write", command: "echo hi > /tmp/pi-gpt-discipline.txt", expected: noBlock },
	{ name: "wrapped allow temp scripted read", command: 'python3 -c "from pathlib import Path; print(Path(\"/tmp/pi-gpt-discipline.txt\").read_text())"', expected: noBlock },
];

const configurationCases: BenchmarkCase[] = [
	{ name: "allow escape hatch write", command: 'PI_ALLOW_SHELL_FILE_EDIT=1 python3 -c "from pathlib import Path; Path(\"README.md\").write_text(\"x\")"', expected: noBlock },
	{ name: "allow non-target model mutation", command: "echo hi > README.md", expected: noBlock, modelId: "gpt-4.1" },
	{ name: "allow non-target model inspection", command: "cat README.md", expected: noBlock, modelId: "gpt-4.1" },
	{ name: "allow mutation without edit write tools", command: "echo hi > README.md", expected: noBlock, activeTools: ["read", "grep", "find", "ls"] },
	{ name: "allow cat without read tool", command: "cat README.md", expected: noBlock, activeTools: ["edit", "write", "grep", "find", "ls"] },
	{ name: "allow rg without grep tool", command: "rg TODO src", expected: noBlock, activeTools: ["read", "edit", "write", "find", "ls"] },
	{ name: "allow find without find tool", command: "find src -name '*.ts'", expected: noBlock, activeTools: ["read", "edit", "write", "grep", "ls"] },
	{ name: "allow ls without ls tool", command: "ls -la", expected: noBlock, activeTools: ["read", "edit", "write", "grep", "find"] },
	{ name: "allow scripted read without read tool", command: 'node -e "console.log(require(\"fs\").readFileSync(\"README.md\", \"utf8\"))"', expected: noBlock, activeTools: ["edit", "write", "grep", "find", "ls"] },
	{ name: "allow missing model id", command: "echo hi > README.md", expected: noBlock, modelId: null },
];

export const benchmarkCases: BenchmarkCase[] = [
	...directInspectionCases,
	...wrapCases(wrappedInspectionSeeds),
	...scriptedReadCases,
	...wrapCases(scriptedReadCases),
	...mutationCases,
	...wrapCases(wrappedMutationSeeds),
	...safeMutatorCases,
	...wrapCases(safeMutatorCases.slice(0, 6)),
	...legitShellCases,
	...wrapCases(wrappedLegitOutsideWorkspaceSeeds),
	...configurationCases,
];
