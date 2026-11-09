/**
 * Run one tool outside the Harness.
 *
 *   node tests/run-tool.mjs <toolName> ['<json args>'] [--cwd <dir>]
 *
 * The plugin's `apply()` is called with a fake context, so this exercises the
 * real registration path, the real execution path and the real process seam.
 */
import { apply } from "../lib/index.js";
import { createFakeContext, makeExec, makeWorkspace } from "./harness.mjs";

const argv = process.argv.slice(2);
const cwdFlag = argv.indexOf("--cwd");
const cwd = cwdFlag >= 0 ? argv[cwdFlag + 1] : makeWorkspace();
const positional = cwdFlag >= 0 ? argv.filter((_, index) => index !== cwdFlag && index !== cwdFlag + 1) : argv;
const [toolName, rawArgs] = positional;

if (toolName === undefined) {
	console.error("usage: node tests/run-tool.mjs <toolName> ['<json args>'] [--cwd <dir>]");
	process.exit(2);
}

const ctx = createFakeContext({ cwd });
apply(ctx, {});
const definition = ctx.tools.get(toolName);
if (definition === undefined) {
	console.error(`no such tool: ${toolName}\nregistered: ${ctx.listTools().join(", ")}`);
	process.exit(2);
}

let args = {};
if (rawArgs !== undefined && rawArgs.trim().length > 0) {
	try {
		args = JSON.parse(rawArgs);
	} catch (error) {
		console.error(`invalid JSON arguments: ${error.message}`);
		process.exit(2);
	}
}

try {
	const value = await definition.execute(args, makeExec(cwd));
	const blocks = definition.output.render(args, value);
	console.log(JSON.stringify(value, null, 2));
	console.log("--- rendered ---");
	for (const block of blocks) console.log(block.text);
} catch (error) {
	console.error(`[tool failed] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
