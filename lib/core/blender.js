/**
 * Blender discovery and headless execution.
 *
 * Blender is the only engine in this plugin that can *modify* geometry instead
 * of re-rendering it: boolean cuts, voxel remesh, decimation and orbiting
 * previews all need a real scene graph. It is also the slowest dependency (3–10 s
 * of startup before the script even begins) and the noisiest on stdout, so every
 * call funnels through exactly one shape:
 *
 *   <blender> -b --factory-startup --python-exit-code 1 [file.blend] \
 *             --python <script.py> -- <args>
 *
 * Three details are load-bearing and each one is a step that silently looks like
 * success when it goes wrong:
 *
 * 1. `--python-exit-code 1`. Without it a Python exception inside `--python` is
 *    printed and Blender still exits 0, so "the cut did nothing" would be
 *    reported as a successful cut. That flag is why `code !== 0` is meaningful
 *    here at all.
 * 2. `--factory-startup`. A user's startup file and third-party add-ons would
 *    otherwise decide whether `bpy.ops.export_scene.gltf` exists. Determinism
 *    beats convenience for a tool a model calls unattended.
 * 3. The `[dsh3d]` marker. Blender prints version banners, render progress and
 *    add-on chatter on both streams. The *only* trustworthy channel is the line
 *    a script writes as `[dsh3d] {json}`, and `parseMessages` is the single
 *    filter that extracts it — nothing in this plugin scrapes Blender's own
 *    output for facts.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable } from "./proc.js";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

/** The one prefix a headless script is trusted to emit. */
export const MARKER = "[dsh3d]";

/** `<repo>/blender` — scripts live beside the library, not inside it. */
export const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "blender");

/** A cold `blender -b` start is 3–10 s; the capability probe adds one start. */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * One interpreter start answers both "which version" and "can this build do the
 * five operations the bridge depends on". Asking Blender rather than guessing
 * from the version number matters: 4.2–4.3 moved STL I/O from `import_mesh.stl`
 * to `wm.stl_import`, and packaged builds occasionally drop an add-on.
 *
 * The engine list is *tested*, not enumerated: `RenderSettings.engine`'s enum
 * only advertises EEVEE, while Workbench and Cycles accept assignment at runtime
 * (they are registered dynamically). Enumerating it would report "no Workbench"
 * on a machine where `preview` renders with Workbench perfectly.
 */
const PROBE_EXPR = `import bpy, json, sys
scene = bpy.context.scene
original = scene.render.engine
engines = []
for name in ("BLENDER_WORKBENCH", "BLENDER_EEVEE_NEXT", "CYCLES"):
    try:
        scene.render.engine = name
        engines.append(name)
    except Exception:
        pass
scene.render.engine = original
print("[dsh3d] " + json.dumps({
    "ok": True,
    "version": bpy.app.version_string,
    "python": sys.version.split()[0],
    "stlImport": hasattr(bpy.ops.wm, "stl_import"),
    "stlExport": hasattr(bpy.ops.wm, "stl_export"),
    "objImport": hasattr(bpy.ops.wm, "obj_import"),
    "gltfExport": hasattr(bpy.ops.export_scene, "gltf"),
    "voxelRemesh": hasattr(bpy.ops.object, "voxel_remesh"),
    "engines": engines
}))`;


/** Absolute path of one headless script. */
export function scriptPath(name) {
	return join(SCRIPTS_DIR, name);
}

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function readDirectory(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * Absolute Windows PowerShell, for the ShellExecute-based GUI launch.
 * `process.env.SystemRoot` is set on every Windows since XP; PATH is not
 * trustworthy in a GUI-launched Harness, so the well-known location comes first.
 */
function joinPowershell() {
	const root = process.env.SystemRoot ?? "C:\\Windows";
	const direct = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	if (isFile(direct)) return direct;
	return findExecutable("powershell", []);
}

/** `Blender 4.3` → `[4, 3]`; unnumbered `Blender` → `[0]`. */
function versionTuple(name) {
	const match = /(\d+(?:\.\d+)*)/u.exec(name);
	if (match === null) return [0];
	return match[1].split(".").map((part) => Number(part));
}

function compareVersions(left, right) {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		if (a !== b) return a - b;
	}
	return 0;
}

/**
 * `C:\Program Files\Blender Foundation\Blender 4.3\blender.exe`, highest version
 * first. The directory name carries the version, so picking "the newest" is a
 * read of the listing rather than a call into Blender — important because the
 * whole point of this stage is a PATH that a GUI-launched Harness truncated.
 */
function windowsInstallCandidates() {
	const roots = [
		process.env.ProgramFiles,
		process.env["ProgramFiles(x86)"]
	].filter((root) => typeof root === "string" && root.length > 0);
	if (roots.length === 0) roots.push("C:\\Program Files");
	const versioned = [];
	for (const root of roots) {
		const foundation = join(root, "Blender Foundation");
		for (const entry of readDirectory(foundation)) {
			if (!entry.isDirectory() || !/^Blender(\s|$)/u.test(entry.name)) continue;
			versioned.push({
				path: join(foundation, entry.name, "blender.exe"),
				version: versionTuple(entry.name)
			});
		}
	}
	versioned.sort((left, right) => compareVersions(right.version, left.version));
	const local = process.env.LOCALAPPDATA;
	const home = process.env.USERPROFILE;
	const packageManaged = [
		typeof local === "string" ? join(local, "Microsoft", "WinGet", "Links", "blender.exe") : undefined,
		"C:\\ProgramData\\chocolatey\\bin\\blender.exe",
		typeof home === "string" ? join(home, "scoop", "shims", "blender.exe") : undefined
	].filter((path) => path !== undefined);
	return [...versioned.map((entry) => entry.path), ...packageManaged];
}

/** `/Applications/Blender.app/Contents/MacOS/Blender`, newest version first. */
function macInstallCandidates() {
	const roots = ["/Applications", join(process.env.HOME ?? "", "Applications")].filter((root) => root.length > 1);
	const found = [];
	for (const root of roots) {
		for (const entry of readDirectory(root)) {
			if (!/^Blender.*\.app$/u.test(entry.name)) continue;
			found.push({
				path: join(root, entry.name, "Contents", "MacOS", "Blender"),
				version: versionTuple(entry.name)
			});
		}
	}
	found.sort((left, right) => compareVersions(right.version, left.version));
	return found.map((entry) => entry.path);
}

function linuxInstallCandidates() {
	const home = process.env.HOME ?? "";
	const candidates = [
		"/usr/bin/blender",
		"/usr/local/bin/blender",
		"/snap/bin/blender",
		"/var/lib/flatpak/exports/bin/org.blender.Blender",
		home.length > 0 ? join(home, ".local", "bin", "blender") : undefined
	].filter((path) => path !== undefined);
	// `/opt/blender-4.3/blender.exe`-style manual installs.
	for (const root of ["/opt", "/usr/local"]) {
		for (const entry of readDirectory(root)) {
			if (/^blender/iu.test(entry.name)) candidates.push(join(root, entry.name, "blender"));
		}
	}
	return candidates;
}

/**
 * Every place Blender is known to land, in the order the platform prefers.
 * @returns {string[]}
 */
export function installCandidates() {
	if (isWindows) return windowsInstallCandidates();
	if (isMac) return macInstallCandidates();
	return linuxInstallCandidates();
}

/**
 * Split a process result into the `[dsh3d]` messages a script emitted.
 *
 * Both streams are scanned (a script's prints go to stdout, but a wrapper or a
 * crash handler can echo them to stderr) and every line is scanned, not just the
 * first match. Lines that merely *mention* the marker inside a traceback are
 * skipped unless the remainder parses as JSON, which is the only other case that
 * can be a real payload.
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {Array<{line: string, text: string, json?: object}>}
 */
export function parseMessages(stdout, stderr) {
	const messages = [];
	const text = `${stdout ?? ""}\n${stderr ?? ""}`.replace(/\r/gu, "");
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const start = line.indexOf(MARKER);
		if (start < 0) continue;
		const payload = line.slice(start + MARKER.length).trim();
		if (payload.length === 0) continue;
		let json;
		if (start === 0 || payload.startsWith("{") || payload.startsWith("[")) {
			try {
				json = JSON.parse(payload);
			} catch {
				json = undefined;
			}
		}
		if (start !== 0 && json === undefined) continue;
		messages.push({ line: raw, text: payload, ...(json !== undefined ? { json } : {}) });
	}
	return messages;
}

/** Just the parsed payloads, in emission order. */
export function jsonMessages(messages) {
	return messages.filter((message) => message.json !== undefined).map((message) => message.json);
}

/**
 * The actionable tail of a failed headless run.
 *
 * A Blender traceback is 30 lines of `bpy` frames around one real reason, so the
 * report keeps the last frames plus the exception line instead of the dump. This
 * is what the model gets instead of "exit 1".
 *
 * @returns {string[]}
 */
export function diagnose(result) {
	const stderr = String(result?.stderr ?? "").replace(/\r/gu, "");
	const lines = stderr.split("\n");
	const traceAt = lines.findIndex((line) => line.includes("Traceback (most recent call last)"));
	if (traceAt >= 0) {
		// Blender follows a Python exception with its own
		// `Error: script failed, file: '...', exiting.` line, so "the last line" is
		// that wrapper and not the reason. Strip the wrapper before taking the
		// reason, or the report loses the one line that says what went wrong.
		const block = lines
			.slice(traceAt)
			.map((line) => line.trimEnd())
			.filter((line) => line.trim().length > 0 && !/^Error: script failed/iu.test(line.trim()));
		const frames = block.filter((line) => /file "/iu.test(line)).slice(-3);
		const reason = block[block.length - 1] ?? "";
		return [...frames, reason].filter((line) => line.length > 0);
	}
	const noisy = lines.filter((line) => /error|cannot|no such file|not found|exception/iu.test(line));
	if (noisy.length > 0) return noisy.slice(-6).map((line) => line.trim());
	const tail = lines.map((line) => line.trim()).filter((line) => line.length > 0).slice(-6);
	if (tail.length > 0) return tail;
	return String(result?.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0).slice(-6);
}

/**
 * Probe one explicit path: version, Python, and which operations this build
 * actually exposes. Never throws — a broken install is a `found: true,
 * probe.ok: false` answer, which is more useful than an exception.
 *
 * @param {{run: Function}} proc
 * @param {string} path
 * @param {string} source
 */
async function probe(proc, path, source) {
	const startedAt = Date.now();
	const result = await proc.run([path, "-b", "--factory-startup", "--python-exit-code", "1", "--python-expr", PROBE_EXPR], {
		timeoutMs: PROBE_TIMEOUT_MS,
		maxBytes: 80_000
	});
	const elapsedMs = Date.now() - startedAt;
	const payload = jsonMessages(parseMessages(result.stdout, result.stderr)).find((entry) => entry?.ok === true);
	if (payload !== undefined) {
		return {
			found: true,
			path,
			version: String(payload.version ?? ""),
			source,
			probe: { ok: true, elapsedMs, ...payload, detail: diagnose(result) }
		};
	}
	// The executable started but our expression never ran: a broken install, a
	// wrapped/stub binary, or a build without Python. Report the version banner
	// if there is one so the message can still be specific.
	const banner = /Blender\s+(\d+\.\d+(?:\.\d+)?)/u.exec(`${result.stdout}\n${result.stderr}`);
	return {
		found: true,
		path,
		version: banner?.[1] ?? null,
		source,
		probe: {
			ok: false,
			elapsedMs,
			code: result.code,
			timedOut: result.timedOut === true,
			detail: diagnose(result)
		}
	};
}

/**
 * Find Blender, in the documented order: configured path → PATH → the platform's
 * install roots (newest first) → macOS `/Applications` → Linux package paths.
 *
 * @param {{run: Function}} proc - the process seam from core/proc.js
 * @param {{blenderPath?: string}} settings
 * @returns {Promise<{found: boolean, path: string|null, version: string|null, source: string|null,
 *   probe?: object, tried: Array<{path: string, source: string}>, reason?: string}>}
 */
export async function detectBlender(proc, settings = {}) {
	const tried = [];
	const configured = typeof settings.blenderPath === "string" ? settings.blenderPath.trim() : "";
	if (configured.length > 0) {
		tried.push({ path: configured, source: "config" });
		if (!isFile(configured)) {
			return {
				found: false,
				path: configured,
				version: null,
				source: "config",
				tried,
				reason: `配置的 blenderPath 指向一个不存在的文件：${configured}`
			};
		}
		return await probe(proc, configured, "config");
	}

	const fromPath = findExecutable("blender", []);
	if (fromPath !== undefined) {
		tried.push({ path: fromPath, source: "PATH" });
		return await probe(proc, fromPath, "PATH");
	}

	for (const candidate of installCandidates()) {
		tried.push({ path: candidate, source: "install-root" });
		if (isFile(candidate)) return await probe(proc, candidate, "install-root");
	}

	return {
		found: false,
		path: null,
		version: null,
		source: null,
		tried,
		reason: "PATH 上没有 blender，常见安装目录里也没有 blender.exe"
	};
}

/**
 * Run one headless Blender script.
 *
 * `--python-exit-code 1` turns a Python exception into a non-zero exit, and the
 * `[dsh3d]` messages carry the facts; both are returned so a caller can decide
 * whether "exit 0 with no payload" is a broken script or a silent no-op.
 *
 * @param {object} request
 * @param {{run: Function}} request.proc
 * @param {object} [request.exec] - session context, for the sandbox policy
 * @param {string} request.blender - absolute path of blender.exe
 * @param {string} request.scriptPath - absolute path of the .py to run
 * @param {string[]} [request.args] - passed after `--`
 * @param {number} [request.timeoutMs] - default 300000; startup alone is seconds
 * @param {string} [request.blendFile] - optional .blend opened before the script
 * @param {string} [request.cwd]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, elapsedMs: number,
 *   timedOut: boolean, argv: string[], messages: object[], details: string[]}>}
 */
export async function runScript(request) {
	const {
		proc,
		exec,
		blender,
		scriptPath: script,
		args = [],
		timeoutMs = 300_000,
		blendFile,
		cwd
	} = request;
	if (typeof script !== "string" || !isFile(script)) {
		throw new Error(`Blender 脚本不存在：${script}（预期在 ${SCRIPTS_DIR}）`);
	}
	const argv = [blender, "-b", "--factory-startup", "--python-exit-code", "1"];
	if (typeof blendFile === "string" && blendFile.length > 0) argv.push(blendFile);
	argv.push("--python", script, "--", ...args.map((arg) => String(arg)));
	const result = await proc.run(argv, {
		...(exec !== undefined ? { exec } : {}),
		...(cwd !== undefined ? { cwd } : {}),
		timeoutMs,
		maxBytes: 400_000,
		env: { DSH3D_SCRIPTS: SCRIPTS_DIR }
	});
	const messages = parseMessages(result.stdout, result.stderr);
	return {
		code: result.code,
		stdout: result.stdout,
		stderr: result.stderr,
		elapsedMs: result.elapsedMs,
		timedOut: result.timedOut === true,
		argv,
		messages,
		details: diagnose(result)
	};
}

/**
 * PIDs of running processes with this image name, via `tasklist`.
 * Used to tell "Blender is up" from "the launcher returned 0", which are not the
 * same thing: `cmd /c start` exits 0 the moment it hands off, whether or not the
 * GUI ever appears.
 */
async function processIds(proc, exec, imageName) {
	const comspec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
	try {
		const result = await proc.run(
			[comspec, "/c", "tasklist", "/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
			{ ...(exec !== undefined ? { exec } : {}), timeoutMs: 15_000, maxBytes: 40_000 }
		);
		const ids = new Set();
		for (const line of result.stdout.replace(/\r/gu, "").split("\n")) {
			const match = /^"([^"]+)","(\d+)"/u.exec(line.trim());
			if (match !== null && match[1].toLowerCase() === imageName.toLowerCase()) ids.add(Number(match[2]));
		}
		return ids;
	} catch {
		return new Set();
	}
}

/** Poll for a PID that was not running before the launch. */
async function waitForNewProcess(proc, exec, imageName, before, deadlineMs) {
	const until = Date.now() + deadlineMs;
	for (;;) {
		const current = await processIds(proc, exec, imageName);
		for (const id of current) if (!before.has(id)) return id;
		if (Date.now() >= until) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
}

/**
 * Launch the GUI and return without waiting for it to close.
 *
 * `proc.run` settles only when the child exits, so awaiting Blender here would
 * hold the tool call open for the whole editing session — and a caller's timeout
 * would then *terminate* the window the user is working in. Each platform
 * therefore gets a real detach: ShellExecute on Windows, `open` on macOS,
 * `setsid -f` on Linux.
 *
 * Windows uses PowerShell `Start-Process` rather than `cmd /c start`. Both hand
 * off, but `start` leaves the GUI inside the caller's process tree, and the
 * Harness reaps that tree when the spawn settles — the window appeared and then
 * vanished a second later, which is exactly the bug this action cannot afford to
 * hide. `Start-Process` goes through ShellExecute, so Blender is created outside
 * our job and survives.
 *
 * Whatever the platform, the answer is *verified*: a PID that did not exist
 * before must exist after. `launched: false` with the reason is more useful than
 * a cheerful lie.
 *
 * @param {object} request
 * @param {{run: Function, find: Function}} request.proc
 * @param {object} [request.exec]
 * @param {string} request.blender
 * @param {string} [request.file] - model or .blend to open
 * @returns {Promise<{launched: boolean, mode: string, pid?: number, argv: string[], elapsedMs: number, note: string}>}
 */
export async function openGui(request) {
	const { proc, exec, blender, file } = request;
	const files = typeof file === "string" && file.length > 0 ? [file] : [];
	const startedAt = Date.now();
	const options = { ...(exec !== undefined ? { exec } : {}), timeoutMs: 30_000, maxBytes: 40_000 };

	if (isWindows) {
		const imageName = blender.split(/[\\/]/u).pop() ?? "blender.exe";
		const before = await processIds(proc, exec, imageName);
		const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`;
		const powershell = joinPowershell();
		const argv = powershell !== undefined
			? [
				powershell,
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Start-Process -FilePath ${quote(blender)}${files.length > 0 ? ` -ArgumentList ${quote(files[0])}` : ""}`
			]
			: [process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", "/c", "start", "", blender, ...files];
		const result = await proc.run(argv, options);
		const pid = await waitForNewProcess(proc, exec, imageName, before, 8_000);
		return {
			launched: pid !== undefined,
			pid,
			mode: "detached",
			argv,
			elapsedMs: Date.now() - startedAt,
			note:
				pid !== undefined
					? `Blender 已启动，确认到新进程 PID ${pid}。窗口能否留在屏幕上取决于桌面会话——无 GPU 的远程会话里 Blender GUI 会自己退出，这种情况只能走 inspect/preview。`
					: `启动命令返回 ${result.code}，但 8 s 内没看到新的 ${imageName} 进程：窗口可能没弹出，或被安全软件/进程回收挡掉了${result.code !== 0 ? `（${diagnose(result).join(" / ")}）` : ""}`
		};
	}

	if (isMac) {
		// `/Applications/Blender.app/Contents/MacOS/Blender` → `/Applications/Blender.app`
		const app = /^(.*\.app)\//u.exec(blender)?.[1];
		const argv = app !== undefined ? ["/usr/bin/open", "-a", app, ...files] : ["/usr/bin/open", blender, ...files];
		const result = await proc.run(argv, { ...(exec !== undefined ? { exec } : {}), timeoutMs: 30_000, maxBytes: 40_000 });
		return {
			launched: result.code === 0,
			mode: "detached",
			argv,
			elapsedMs: Date.now() - startedAt,
			note: result.code === 0 ? "Blender 已通过 open 启动" : `启动失败：${diagnose(result).join(" / ") || `exit ${result.code}`}`
		};
	}

	const setsid = findExecutable("setsid", ["/usr/bin", "/bin"]);
	if (setsid !== undefined) {
		const argv = [setsid, "-f", blender, ...files];
		const result = await proc.run(argv, { ...(exec !== undefined ? { exec } : {}), timeoutMs: 30_000, maxBytes: 40_000 });
		return {
			launched: result.code === 0,
			mode: "detached",
			argv,
			elapsedMs: Date.now() - startedAt,
			note: result.code === 0 ? "Blender 已在独立会话里启动" : `启动失败：${diagnose(result).join(" / ") || `exit ${result.code}`}`
		};
	}

	const argv = [blender, ...files];
	const result = await proc.run(argv, { ...(exec !== undefined ? { exec } : {}), timeoutMs: 4_000, maxBytes: 40_000 });
	return {
		launched: result.code === 0 || result.timedOut === true,
		mode: "resident",
		argv,
		elapsedMs: Date.now() - startedAt,
		note: result.timedOut === true ? "Blender 仍在运行（GUI 常驻，本轮不等它退出）" : "Blender 已退出"
	};
}

/**
 * Detect once, then reuse: discovery costs one full Blender start, and a session
 * typically makes several calls. An explicit `settings.blenderPath` bypasses the
 * cache, matching core/openscad.js.
 */
export function createBlender(proc, settings) {
	let cached;
	async function resolve() {
		const configured = typeof settings.blenderPath === "string" ? settings.blenderPath.trim() : "";
		if (configured.length === 0 && cached !== undefined) return cached;
		const found = await detectBlender(proc, settings);
		if (configured.length === 0 && found.found) cached = found;
		return found;
	}
	function reset() {
		cached = undefined;
	}
	return {
		resolve,
		reset,
		runScript: (request) => runScript({ proc, ...request }),
		openGui: (request) => openGui({ proc, ...request }),
		detect: () => detectBlender(proc, settings)
	};
}
