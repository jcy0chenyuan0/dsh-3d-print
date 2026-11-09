/**
 * Environment detection: OpenSCAD, Blender, slicer CLIs.
 *
 * Why this module returns result objects instead of throwing: `print3d_doctor`
 * is the tool a model calls when nothing works yet, so it must survive a machine
 * with no OpenSCAD, no Blender and an unfinished sibling module. Every detector
 * therefore resolves to `{found:false, reasons:[...]}` and never to an exception.
 *
 * Two detection quirks are deliberate:
 * - Discovery is filesystem-first. A Harness launched from the GUI inherits a
 *   PATH that frequently omits a freshly installed OpenSCAD/Blender, so the
 *   usual install roots are checked by name, and Blender's versioned folders
 *   (`Blender 4.3`) are sorted by version so the newest one wins.
 * - The slicer probe is a dynamic `import()` behind try/catch. `core/slicers.js`
 *   is written by another owner and may be absent; when it is, a small built-in
 *   scan still tells the user what is actually on disk, because "module missing"
 *   is a fact about our source tree, not about their machine.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createOpenscad } from "./openscad.js";

const isWindows = process.platform === "win32";

/** A readable environment variable, or undefined when unset/empty. */
function env(name) {
	const value = process.env[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** An existing regular file? */
export function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * A guaranteed-existing working directory for version probes.
 * Why: spawning with a `cwd` that does not exist fails with ENOENT before the
 * program ever runs, and a version probe must never depend on where the session
 * happens to be anchored (tests pass `--cwd /tmp/whatever` on Windows, where that
 * path does not exist). `process.cwd()` of the Harness itself always exists.
 */
export function safeWorkingDir() {
	try {
		const cwd = process.cwd();
		return statSync(cwd).isDirectory() ? cwd : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Ask a program for its version, retrying with an explicit working directory
 * when the first attempt produced nothing. `proc.version` never throws, so
 * "program present but no version" is exactly the ENOENT-with-bad-cwd shape.
 */
async function versionProbe(proc, argv, exec) {
	const options = { exec, timeoutMs: 20_000, maxBytes: 8_000 };
	const first = await proc.version(argv, options);
	if (typeof first === "string" && first.length > 0) return first;
	const cwd = safeWorkingDir();
	if (cwd === undefined) return undefined;
	return await proc.version(argv, { ...options, cwd });
}

/** Sub-directories of `root` whose name matches, with their absolute paths. */
function listSubdirs(root, pattern) {
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => ({ name: entry.name, path: join(root, entry.name) }));
}

/** "4.3" out of "Blender 4.3" / "Creality Print 7.3". */
function versionFromName(name) {
	const match = /(\d+(?:\.\d+){0,3})/u.exec(name);
	return match === null ? "0" : match[1];
}

function versionParts(text) {
	return String(text)
		.split(".")
		.map((part) => Number.parseInt(part, 10))
		.map((part) => (Number.isFinite(part) ? part : 0));
}

/** Sort newest version first; used for versioned install directories. */
function compareVersionDesc(a, b) {
	const left = versionParts(a);
	const right = versionParts(b);
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const delta = (right[index] ?? 0) - (left[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

/**
 * Detect OpenSCAD.
 * @param {object} proc - the process seam from core/proc.js
 * @param {object} settings - normalized plugin settings
 * @param {{openscad?: object, exec?: object}} [extra] - reuse the shared
 *   OpenSCAD driver (so a post-install reset() is visible here) and the call's
 *   exec for sandbox policy
 * @returns {Promise<{found: boolean, runnable: boolean, path?: string, version?: string, source?: string, reasons: string[], candidates: string[]}>}
 */
export async function detectOpenscad(proc, settings, extra = {}) {
	const driver = extra.openscad ?? createOpenscad(proc, settings);
	try {
		const resolved = await driver.resolve(extra.exec);
		// resolve() may return an empty version when its own probe could not run
		// (see safeWorkingDir); re-probe so "found but no version" is a real signal.
		const version = typeof resolved.version === "string" && resolved.version.length > 0 ? resolved.version : await versionProbe(proc, [resolved.path, "--version"], extra.exec);
		return {
			found: true,
			runnable: typeof version === "string" && version.length > 0,
			path: resolved.path,
			version,
			source: resolved.source,
			reasons: [],
			candidates: []
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const configured = typeof settings.openscadPath === "string" ? settings.openscadPath.trim() : "";
		return {
			found: false,
			runnable: false,
			reasons: [reason],
			candidates: configured.length > 0 ? [configured] : driver.candidatePaths()
		};
	}
}

/** Where Blender lands on each platform, newest version first. */
export function blenderCandidates() {
	const out = [];
	const local = env("LOCALAPPDATA");
	if (isWindows) {
		for (const root of [env("ProgramFiles"), env("ProgramFiles(x86)")].filter((value) => value !== undefined)) {
			const foundation = join(root, "Blender Foundation");
			const versioned = listSubdirs(foundation, /^blender\b/iu).sort((a, b) => compareVersionDesc(versionFromName(a.name), versionFromName(b.name)));
			for (const entry of versioned) out.push(join(entry.path, "blender.exe"));
			// An unversioned install ("Blender" folder) is what the msi/portable copy leaves.
			out.push(join(foundation, "Blender", "blender.exe"));
		}
		if (local !== undefined) out.push(join(local, "Programs", "Blender", "blender.exe"));
	} else if (process.platform === "darwin") {
		out.push("/Applications/Blender.app/Contents/MacOS/Blender", "/Applications/Blender/Blender.app/Contents/MacOS/Blender");
	} else {
		out.push("/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender", "/var/lib/flatpak/exports/bin/org.blender.Blender");
	}
	return [...new Set(out)];
}

/**
 * Detect Blender.
 * @param {object} proc
 * @param {object} settings
 * @param {{exec?: object}} [extra]
 * @returns {Promise<{found: boolean, runnable: boolean, path?: string, version?: string, source?: string, reasons: string[], candidates: string[]}>}
 */
export async function detectBlender(proc, settings, extra = {}) {
	const reasons = [];
	const configured = typeof settings.blenderPath === "string" ? settings.blenderPath.trim() : "";
	if (configured.length > 0) {
		if (isFile(configured)) return await blenderResult(proc, configured, "config", extra);
		reasons.push(`配置的 blenderPath 不存在：${configured}`);
	}
	const fromPath = proc.find("blender", []);
	if (fromPath !== undefined) return await blenderResult(proc, fromPath, "PATH", extra);
	const candidates = blenderCandidates();
	for (const candidate of candidates) {
		if (isFile(candidate)) return await blenderResult(proc, candidate, "install-root", extra);
	}
	reasons.push("PATH 上没有 blender，常见安装目录里也没有 blender.exe");
	return { found: false, runnable: false, reasons, candidates };
}

async function blenderResult(proc, path, source, extra) {
	// `blender --version` prints "Blender 4.3.0" as the first stdout line.
	const version = await versionProbe(proc, [path, "--version"], extra.exec);
	return {
		found: true,
		runnable: typeof version === "string" && version.length > 0,
		path,
		version,
		source,
		reasons: [],
		candidates: []
	};
}

/** `<ProgramFiles>\<...rest>` style layouts, resolved against env at call time. */
const ENV_ROOTS = {
	ProgramFiles: () => env("ProgramFiles"),
	LOCALAPPDATA: () => env("LOCALAPPDATA"),
	APPDATA: () => env("APPDATA")
};

function resolveRoot(parts) {
	const [alias, ...rest] = parts;
	const base = ENV_ROOTS[alias]?.();
	if (base === undefined) return undefined;
	return join(base, ...rest);
}

/**
 * Known slicer layouts (fallback only — core/slicers.js owns the real thing).
 * `cli` records whether the family has a usable command-line slice path.
 */
const SLICER_LAYOUTS = [
	{
		id: "creality-print",
		family: "creality",
		name: "Creality Print",
		exe: "CrealityPrint.exe",
		dirs: [["ProgramFiles", "Creality"]],
		pattern: "Creality Print *",
		cli: false,
		note: "Orca 系界面版；批量切片走工程文件/GUI，没有稳定 CLI"
	},
	{
		id: "orca-slicer",
		family: "orca",
		name: "OrcaSlicer",
		exe: "orca-slicer.exe",
		dirs: [["ProgramFiles", "OrcaSlicer"], ["LOCALAPPDATA", "Programs", "OrcaSlicer"]],
		cli: false,
		note: "有 --info 等参数，但切片仍以 GUI/3MF 为主"
	},
	{
		id: "bambu-studio",
		family: "bambu",
		name: "Bambu Studio",
		exe: "bambu-studio.exe",
		dirs: [["ProgramFiles", "Bambu Studio"], ["LOCALAPPDATA", "Programs", "Bambu Studio"]],
		cli: false,
		note: "同 Orca 系"
	},
	{
		id: "prusaslicer",
		family: "prusa",
		name: "PrusaSlicer",
		exe: "prusa-slicer.exe",
		dirs: [["ProgramFiles", "Prusa3D", "PrusaSlicer"], ["LOCALAPPDATA", "Programs", "PrusaSlicer"]],
		cli: true,
		note: "prusa-slicer-console --export-gcode 可无人值守"
	},
	{
		id: "cura",
		family: "cura",
		name: "Ultimaker Cura",
		exe: "Ultimaker Cura.exe",
		dirs: [["ProgramFiles"], ["LOCALAPPDATA", "Programs"]],
		pattern: "Ultimaker Cura *",
		cli: false,
		note: "切片靠 CuraEngine + JSON，不是一条命令行"
	},
	{
		id: "simplify3d",
		family: "simplify3d",
		name: "Simplify3D",
		exe: "Simplify3D.exe",
		dirs: [["ProgramFiles"]],
		pattern: "Simplify3D*",
		cli: false,
		note: "老牌商业切片器"
	}
];

/** Slicers that also ship a PATH command (macOS/Linux and a few Windows setups). */
const PATH_SLICERS = [
	{ command: "prusa-slicer", id: "prusaslicer", family: "prusa", name: "PrusaSlicer", cli: true },
	{ command: "orca-slicer", id: "orca-slicer", family: "orca", name: "OrcaSlicer", cli: false },
	{ command: "bambu-studio", id: "bambu-studio", family: "bambu", name: "Bambu Studio", cli: false },
	{ command: "cura", id: "cura", family: "cura", name: "Ultimaker Cura", cli: false },
	{ command: "slic3r", id: "slic3r", family: "slic3r", name: "Slic3r", cli: true }
];

/** Filesystem-only slicer scan used when core/slicers.js cannot be imported. */
function scanKnownSlicers(proc) {
	const items = [];
	const seen = new Set();
	const add = (item) => {
		if (item.exe === undefined || seen.has(item.exe)) return;
		seen.add(item.exe);
		items.push(item);
	};
	for (const layout of SLICER_LAYOUTS) {
		for (const parts of layout.dirs) {
			const dir = resolveRoot(parts);
			if (dir === undefined) continue;
			const direct = join(dir, layout.exe);
			if (isFile(direct)) {
				add({ id: layout.id, family: layout.family, name: layout.name, exe: direct, version: undefined, cli: layout.cli, note: layout.note });
			}
			if (layout.pattern === undefined) continue;
			const pattern = new RegExp(`^${layout.pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "iu");
			for (const sub of listSubdirs(dir, pattern)) {
				const exe = join(sub.path, layout.exe);
				if (isFile(exe)) add({ id: layout.id, family: layout.family, name: layout.name, exe, version: versionFromName(sub.name), cli: layout.cli, note: layout.note });
			}
		}
	}
	for (const entry of PATH_SLICERS) {
		const found = proc.find(entry.command, []);
		if (found !== undefined) add({ id: entry.id, family: entry.family, name: entry.name, exe: found, version: undefined, cli: entry.cli });
	}
	return items;
}

/** Accept either an array or a `{slicers:[...]}` result from the sibling module. */
function normalizeSlicers(raw) {
	const list = Array.isArray(raw)
		? raw
		: [raw?.slicers, raw?.items, raw?.detected, raw?.found].find((value) => Array.isArray(value)) ?? [];
	return list
		.filter((entry) => entry !== null && typeof entry === "object")
		.map((entry) => {
			// core/slicers.js nests scriptability in `aware.cli` and keeps notes in
			// `notes: string[]`; older/other shapes may use flat `cli`/`note`.
			const aware = entry.aware ?? {};
			const cli = aware.cli === true || entry.cli === true || entry.cliSupport === true || entry.scriptable === true;
			const notes = entry.notes ?? entry.note;
			const note = Array.isArray(notes) ? notes.filter((value) => typeof value === "string").join("；") : typeof notes === "string" ? notes : "";
			return {
				id: String(entry.id ?? entry.family ?? entry.name ?? "slicer"),
				family: String(entry.family ?? entry.id ?? "unknown"),
				name: entry.name === undefined ? undefined : String(entry.name),
				exe: typeof (entry.exe ?? entry.path) === "string" ? entry.exe ?? entry.path : undefined,
				version: entry.version === undefined ? undefined : String(entry.version),
				cli,
				note: note.length > 0 ? note : undefined
			};
		});
}

/**
 * Detect slicer CLIs through `core/slicers.js`, with a built-in fallback scan.
 * @param {object} proc
 * @param {object} settings
 * @param {{exec?: object}} [extra]
 * @returns {Promise<{available: boolean, source: string, reason?: string, items: Array<object>}>}
 */
export async function detectSlicers(proc, settings, extra = {}) {
	// 1) Preferred: the sibling module. Dynamic import so a missing file is a
	//    caught error, not a module-load failure that kills the whole plugin.
	let detect;
	let importError;
	try {
		const module = await import("./slicers.js");
		detect = module.detectSlicers ?? module.default?.detectSlicers;
		if (typeof detect !== "function") throw new Error("slicers.js 里没有 detectSlicers 导出");
	} catch (error) {
		importError = error instanceof Error ? error.message : String(error);
	}
	if (detect === undefined) {
		const items = scanKnownSlicers(proc);
		return {
			available: items.length > 0,
			source: "builtin-fallback",
			reason: `slicer module missing: ${importError}；以下结果来自内置兜底扫描（只认已知安装位置）`,
			items
		};
	}
	try {
		// `detectSlicers(proc, settings, exec)` — exec is forwarded so the session's
		// sandbox policy applies to every slicer version probe.
		const items = normalizeSlicers(await detect(proc, settings, extra.exec));
		return { available: items.length > 0, source: "lib/core/slicers.js", items };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const items = scanKnownSlicers(proc);
		return {
			available: items.length > 0,
			source: "builtin-fallback",
			reason: `slicers.js 的 detectSlicers 调用失败：${message}；以下结果来自内置兜底扫描`,
			items
		};
	}
}

/**
 * Run every detector concurrently; the doctor prints all of it in one report.
 * @param {object} proc
 * @param {object} settings
 * @param {{openscad?: object, exec?: object}} [extra]
 * @returns {Promise<{openscad: object, blender: object, slicers: object}>}
 */
export async function snapshot(proc, settings, extra = {}) {
	const [openscad, blender, slicers] = await Promise.all([
		detectOpenscad(proc, settings, extra),
		detectBlender(proc, settings, extra),
		detectSlicers(proc, settings, extra)
	]);
	return { openscad, blender, slicers };
}
