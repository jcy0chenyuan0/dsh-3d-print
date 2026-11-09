/**
 * Process and executable discovery for this plugin.
 *
 * The Harness exposes a `subprocess` service, not `child_process`: it applies
 * the calling session's sandbox policy, collects bounded output and settles a
 * handle. Every external program this plugin runs (OpenSCAD, Blender, slicers,
 * installers) goes through here so a confining session behaves predictably.
 */
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const isWindows = process.platform === "win32";

/** PATH extensions to try for a bare command name on Windows. */
function pathExtensions() {
	const raw = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	return raw.split(";").map((ext) => ext.trim()).filter((ext) => ext.length > 0);
}

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolve a command name to an absolute path without spawning anything.
 * Absolute or relative paths are checked directly; bare names are searched on
 * PATH (and, on Windows, also through the usual install roots, because GUI
 * launched apps frequently carry a truncated PATH).
 */
export function findExecutable(command, extraDirs = []) {
	if (command === undefined || command === null || command === "") return undefined;
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		return isFile(command) ? command : undefined;
	}
	const names = isWindows && !/\.[a-z0-9]+$/iu.test(command)
		? pathExtensions().flatMap((ext) => [`${command}${ext}`, `${command}${ext.toLowerCase()}`])
		: [command];
	const dirs = [
		...(process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0),
		...extraDirs
	];
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (isFile(candidate)) return candidate;
		}
	}
	return undefined;
}

/** Candidate install roots that a GUI-launched process may not have on PATH. */
export function commonInstallDirs() {
	if (!isWindows) return [];
	const roots = [
		process.env.ProgramFiles,
		process.env["ProgramFiles(x86)"],
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : undefined
	].filter((value) => typeof value === "string" && value.length > 0);
	const dirs = [...roots];
	for (const root of roots) {
		try {
			for (const entry of readdirSync(root)) dirs.push(join(root, entry));
		} catch {
			/* unreadable root */
		}
	}
	return dirs;
}

/**
 * Read a captured stream.
 *
 * The Harness hands back an *offset reader* (`readFrom(0)` → `{text, lossy,
 * spillPath}`), not a `{text}` snapshot. Reading `.text` off a reader yields
 * undefined, which silently turns every version probe and every failure
 * diagnostic into an empty string — so accept both shapes.
 */
function readCollected(stream) {
	if (stream === undefined || stream === null) return { text: "", truncated: false, spillPath: undefined };
	if (typeof stream.readFrom === "function") {
		const read = stream.readFrom(0);
		return { text: typeof read?.text === "string" ? read.text : "", truncated: read?.lossy === true, spillPath: read?.spillPath };
	}
	if (typeof stream.text === "string") return { text: stream.text, truncated: stream.truncated === true, spillPath: stream.spillPath };
	return { text: "", truncated: false, spillPath: undefined };
}

/**
 * Create the process seam used by every tool.
 * @param {object} ctx - Cordis context (needs `subprocess`, optionally `sandbox`)
 * @param {{timeoutMs?: number, graceMs?: number, maxOutputBytes?: number}} settings
 */
export function createProc(ctx, settings = {}) {
	const defaultTimeoutMs = settings.timeoutMs ?? 300_000;
	const graceMs = settings.graceMs ?? 3_000;
	const maxOutputBytes = settings.maxOutputBytes ?? 200_000;
	/**
	 * Apply the session's sandbox policy to an argv, when the policy confines.
	 * A confining mode without a mounted sandbox provider fails closed: silently
	 * running unconfined would break the promise the session was started with.
	 */
	async function confine(argv, exec) {
		const policy = ctx.get("sandboxPolicy")?.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session });
		if (policy === undefined || policy.mode === "danger-full-access") return { argv };
		const confiner = ctx.get("sandbox");
		if (confiner === undefined) throw new Error(`3d-print: this session runs in ${policy.mode} mode but no sandbox provider is mounted; refusing to run unconfined`);
		const confined = await confiner.confine(argv, {
			mode: policy.mode,
			workspaceRoot: policy.workspaceRoot,
			...(policy.sessionId !== undefined ? { sessionId: policy.sessionId } : {})
		}, exec?.signal);
		return { argv: confined.argv, sandbox: { mode: policy.mode, enforcement: confined.enforcement } };
	}

	/**
	 * Run one program to completion.
	 * @param {string[]} argv
	 * @param {{cwd?: string, timeoutMs?: number, env?: Record<string,string>, stdin?: string, exec?: object, maxBytes?: number}} options
	 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, aborted: boolean, elapsedMs: number, stdout: string, stderr: string, sandbox?: object}>}
	 */
	async function run(argv, options = {}) {
		const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
		const startedAt = Date.now();
		const signal = options.exec?.signal;
		const prepared = await confine(argv, options.exec);
		const limit = options.maxBytes ?? maxOutputBytes;
		const env = options.env === undefined ? undefined : { ...process.env, ...options.env };
		// `SubprocessSpawnSpec.cwd` is required (not optional): the provider applies no
		// defaults and rejects an undefined cwd, so one is always resolved here.
		const cwd = options.cwd ?? options.exec?.agent?.session?.header?.cwd ?? settings.defaultCwd ?? process.cwd();
		const handle = ctx.subprocess.spawn({
			argv: prepared.argv,
			cwd,
			stdio: {
				stdin: options.stdin !== undefined ? { data: options.stdin } : "ignore",
				stdout: { maxBytes: limit, spill: { maxBytes: limit * 8 } },
				stderr: { maxBytes: limit, spill: { maxBytes: limit * 8 } }
			},
			graceMs,
			...(signal !== undefined ? { signal } : {}),
			...(env !== undefined ? { env } : {})
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				handle.terminate();
			} catch {
				/* already settled */
			}
		}, timeoutMs);
		let outcome;
		try {
			outcome = await handle.done;
		} finally {
			clearTimeout(timer);
		}
		const { stdout, stderr } = handle.collected;
		const out = readCollected(stdout);
		const err = readCollected(stderr);
		return {
			code: outcome.exitCode,
			signal: outcome.signal ?? null,
			timedOut,
			aborted: signal?.aborted === true,
			elapsedMs: Date.now() - startedAt,
			stdout: out.text,
			stderr: err.text,
			...(out.truncated || err.truncated ? { truncated: true, spillPath: out.spillPath ?? err.spillPath } : {}),
			...(prepared.sandbox !== undefined ? { sandbox: prepared.sandbox } : {})
		};
	}

	/**
	 * Run a program and throw a readable error when it fails.
	 * The message carries the tail of stderr, which is where these toolchains say
	 * everything useful.
	 */
	async function runOk(argv, options = {}) {
		const result = await run(argv, options);
		if (result.code !== 0) {
			const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/u).slice(-8).join("\n");
			throw new Error(`${argv[0].split(/[\\/]/u).pop()} exited with ${result.code}${result.timedOut ? " (timed out)" : ""}${detail.length > 0 ? `:\n${detail}` : ""}`);
		}
		return result;
	}

	/** Ask a program for its version string; never throws. */
	async function version(argv, options = {}) {
		try {
			const result = await run(argv, { ...options, timeoutMs: options.timeoutMs ?? 20_000, maxBytes: 20_000 });
			const text = `${result.stdout}\n${result.stderr}`.trim();
			const line = text.split(/\r?\n/u).find((entry) => entry.trim().length > 0) ?? "";
			return line.trim().slice(0, 120);
		} catch {
			return undefined;
		}
	}

	return { run, runOk, version, find: findExecutable, commonInstallDirs };
}

/** True when a path exists and is readable. */
export function canRead(path) {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}
