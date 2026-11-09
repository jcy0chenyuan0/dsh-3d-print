/**
 * Test harness: a fake Cordis context good enough to drive the tools directly.
 *
 * The real Harness supplies `ctx.subprocess` (sandbox-aware) and `ctx.tools`.
 * For development and CI we need the same shapes without booting the Harness, so
 * this module implements both on top of `node:child_process`.
 *
 * Usage:
 *   node tests/run-tool.mjs print3d_render '{"source":"..."}'
 */
import { spawn as spawnChild } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A workspace directory under the system temp dir, created once per process. */
export function makeWorkspace() {
	const dir = mkdtempSync(join(tmpdir(), "dsh-3dprint-test-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

function collect(stream, maxBytes) {
	const chunks = [];
	let bytes = 0;
	stream?.on("data", (chunk) => {
		if (bytes >= maxBytes) return;
		chunks.push(chunk);
		bytes += chunk.length;
	});
	return chunks;
}

/**
 * Build a fake context.
 * @param {{cwd?: string}} options
 */
export function createFakeContext(options = {}) {
	const registered = new Map();
	const effects = [];
	const cwd = options.cwd ?? makeWorkspace();
	const ctx = {
		tools: {
			register(definition) {
				registered.set(definition.name, definition);
				return () => registered.delete(definition.name);
			},
			get(name) {
				return registered.get(name);
			},
			schemas() {
				return [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
			}
		},
		effect(fn) {
			const dispose = fn();
			effects.push(dispose);
			return dispose;
		},
		get() {
			// No sandbox policy in tests: the plugin then runs unconfined, which is
			// exactly what the fake executor below does.
			return undefined;
		},
		subprocess: {
			async resolveExecutable(name) {
				return name;
			},
			spawn({ argv, cwd: cwdOf, stdio, env, graceMs }) {
				// The real SubprocessSpawnSpec requires cwd; a fake that defaults it would
				// hide exactly the bug this harness exists to catch.
				if (typeof cwdOf !== "string" || cwdOf.length === 0) throw new Error("harness: spawn spec requires an explicit cwd (SubprocessSpawnSpec.cwd is not optional)");
				const child = spawnChild(argv[0], argv.slice(1), {
					cwd: cwdOf,
					env: env ?? process.env,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true
				});
				if (stdio?.stdin?.data !== undefined) child.stdin?.end(stdio.stdin.data);
				else child.stdin?.end();
				const outChunks = collect(child.stdout, stdio?.stdout?.maxBytes ?? 1_000_000);
				const errChunks = collect(child.stderr, stdio?.stderr?.maxBytes ?? 1_000_000);
				let terminated = false;
				const done = new Promise((resolve) => {
					child.on("error", (error) => resolve({ exitCode: 127, signal: null, error }));
					child.on("close", (exitCode, signal) => {
						void graceMs;
						void terminated;
						resolve({ exitCode, signal });
					});
				});
				// Mirrors the real contract: collected streams are offset readers, not
				// `{text}` snapshots. Anything reading `.text` must fail here too.
				const collected = {
					stdout: {
						readFrom(from) {
							const text = Buffer.concat(outChunks).toString("utf8");
							return { text: text.slice(from), nextOffset: Buffer.byteLength(text), lossy: false };
						}
					},
					stderr: {
						readFrom(from) {
							const text = Buffer.concat(errChunks).toString("utf8");
							return { text: text.slice(from), nextOffset: Buffer.byteLength(text), lossy: false };
						}
					}
				};
				return {
					done,
					collected,
					terminate() {
						terminated = true;
						try {
							child.kill();
						} catch {
							/* already gone */
						}
					},
					pid: child.pid
				};
			}
		},
		/** convenience for tests */
		listTools() {
			return [...registered.keys()];
		},
		cwd
	};
	return ctx;
}

/** Write a file into a workspace. */
export function writeFixture(workspace, relativePath, content) {
	const target = join(workspace, relativePath);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content, "utf8");
	return target;
}

/** A minimal exec object: what a tool's execute(args, exec) receives. */
export function makeExec(workspace) {
	return {
		callId: "test-call",
		name: "test",
		arguments: {},
		signal: new AbortController().signal,
		agent: { id: "test-agent", session: { header: { cwd: workspace } } },
		deferContext() {},
		concludeTurn() {}
	};
}
