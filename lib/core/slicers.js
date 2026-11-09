/**
 * Slicer compatibility layer — discovery, capability probing and invocation.
 *
 * Why this shape:
 *
 * - Every vendor ships a differently named binary in a differently shaped
 *   install tree, and the CLI dialects are **not** interchangeable:
 *   PrusaSlicer/SuperSlicer want `-g --output <dir>`, OrcaSlicer and Bambu
 *   Studio accept both `--slice 0 --outputdir <dir>` and `-g --output`, and
 *   Creality Print answers only to its own `--cli` sub-command. Guessing from
 *   the file name produces an exit code 0 with no G-code, which is worse than
 *   a clean failure, so this module probes the binary and records what it
 *   actually advertises.
 *
 * - The probe has to be cheap and must never pop a GUI. A plain `--help` on
 *   Creality Print 7.3 is swallowed by the wxWidgets front-end (it boots the
 *   OpenGL surface, downloads the home page and hangs), while
 *   `--cli --help` answers in well under a second. So Creality gets its own
 *   probe (`bambu-cli` dialect) and a timeout is always treated as "no CLI",
 *   never as success.
 *
 * - Discovery is filesystem-first: a Harness launched from a desktop shortcut
 *   frequently carries a PATH that omits a freshly installed slicer, so the
 *   well-known install roots are searched as well as PATH.
 *
 * - Slicing itself is one `proc.run` call: argv is built here (dialect, not
 *   guessing), the produced files are discovered by mtime, and a failure
 *   carries the real stderr so the model can act on it.
 *
 * Zero npm dependencies and no `@deepseek-ai/*` imports: the plugin is mounted
 * by absolute path from a workspace, where neither is reachable.
 */
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { findExecutable } from "./proc.js";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

/** File extensions a slicing run can plausibly leave behind. */
const OUTPUT_EXTENSIONS = [".gcode", ".gco", ".g", ".3mf"];

/** Input formats every supported CLI accepts. */
export const INPUT_FORMATS = [".stl", ".obj", ".3mf"];

/** Creality Print's verified CLI surface (`--cli --help` returns 0, `--help` does not). */
const CREALITY_FLAGS = ["--cli", "--slice", "--outputdir", "--need-gcode-file", "--load-settings", "--load-filaments"];

/** Family id → argument dialect. A family without a CLI maps to "gui". */
const DIALECTS = {
	orca: "orca",
	bambu: "orca",
	prusa: "prusa",
	superslicer: "prusa",
	creality: "bambu-cli",
	curaengine: "cura-engine",
	cura: "gui",
	simplify3d: "gui",
	ideamaker: "gui"
};

/** Vendor family (from core/printers.js) → slicer family that natively serves it. */
const VENDOR_PREFERENCE = {
	creality: "creality",
	bambu: "bambu",
	prusa: "prusa"
};

/** Resolution order when several slicers are installed and the caller has no preference. */
const PRIORITY = ["orca", "bambu", "creality", "prusa", "superslicer", "curaengine", "cura", "simplify3d", "ideamaker"];

/** Environment roots, resolved once per call so tests can fake them. */
function envPaths() {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
	return {
		home,
		local: process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
		roaming: process.env.APPDATA ?? join(home, "AppData", "Roaming"),
		programFiles: process.env.ProgramFiles ?? "C:\\Program Files",
		programFilesX86: process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
	};
}

/** Immediate subdirectories of `root` whose name matches `pattern`. Never throws. */
function subdirs(root, pattern) {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && pattern.test(entry.name))
			.map((entry) => join(root, entry.name));
	} catch {
		return [];
	}
}

/** Does this path name an existing regular file? */
function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Does this path name an existing directory? */
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The slicer families this layer knows about, in probe order.
 * `dialect` says how to talk to the binary; `none` families are detection-only.
 * @type {Array<{id: string, family: string, name: string, dialect: string, pathNames: string[],
 *   candidates: (env: object) => string[], configRoot: (env: object) => string, note?: string}>}
 */
const FAMILIES = [
	{
		id: "orca",
		family: "orca",
		name: "OrcaSlicer",
		dialect: "orca",
		pathNames: ["orca-slicer", "orcaslicer"],
		candidates: (p) => isWindows
			? [
				join(p.local, "Programs", "OrcaSlicer", "orca-slicer.exe"),
				join(p.programFiles, "OrcaSlicer", "orca-slicer.exe"),
				join(p.programFilesX86, "OrcaSlicer", "orca-slicer.exe"),
				...subdirs(p.programFiles, /orca/i).flatMap((dir) => [join(dir, "orca-slicer.exe"), join(dir, "OrcaSlicer.exe")])
			]
			: isMac
				? ["/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer", join(p.home, "Applications", "OrcaSlicer.app", "Contents", "MacOS", "OrcaSlicer")]
				: ["/usr/bin/orca-slicer", "/usr/local/bin/orca-slicer", join(p.home, ".local", "bin", "orca-slicer"), "/var/lib/flatpak/exports/bin/com.orcaslicer.OrcaSlicer"],
		configRoot: (p) => isWindows ? join(p.roaming, "OrcaSlicer") : isMac ? join(p.home, "Library", "Application Support", "OrcaSlicer") : join(p.home, ".config", "OrcaSlicer")
	},
	{
		id: "bambu",
		family: "bambu",
		name: "Bambu Studio",
		dialect: "orca",
		pathNames: ["bambu-studio", "BambuStudio"],
		candidates: (p) => isWindows
			? [
				join(p.programFiles, "Bambu Studio", "bambu-studio.exe"),
				join(p.local, "Programs", "Bambu Studio", "bambu-studio.exe"),
				...subdirs(p.programFiles, /bambu/i).flatMap((dir) => [join(dir, "bambu-studio.exe"), join(dir, "BambuStudio.exe")]),
				...subdirs(join(p.local, "Programs"), /bambu/i).flatMap((dir) => [join(dir, "bambu-studio.exe")])
			]
			: isMac
				? ["/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"]
				: ["/usr/bin/bambu-studio", "/usr/local/bin/bambu-studio", "/var/lib/flatpak/exports/bin/com.bambulab.BambuStudio"],
		configRoot: (p) => isWindows ? join(p.roaming, "BambuStudio") : isMac ? join(p.home, "Library", "Application Support", "BambuStudio") : join(p.home, ".config", "BambuStudio")
	},
	{
		id: "creality",
		family: "creality",
		name: "Creality Print",
		dialect: "bambu-cli",
		pathNames: ["CrealityPrint"],
		candidates: (p) => isWindows
			? [
				...subdirs(join(p.programFiles, "Creality"), /creality\s*print/i).flatMap((dir) => [join(dir, "CrealityPrint.exe")]),
				...subdirs(join(p.programFilesX86, "Creality"), /creality\s*print/i).flatMap((dir) => [join(dir, "CrealityPrint.exe")]),
				...subdirs(join(p.local, "Programs"), /creality\s*print/i).flatMap((dir) => [join(dir, "CrealityPrint.exe")]),
				join(p.local, "Programs", "Creality Print", "CrealityPrint.exe")
			]
			: isMac
				? ["/Applications/CrealityPrint.app/Contents/MacOS/CrealityPrint"]
				: ["/usr/bin/CrealityPrint", "/opt/CrealityPrint/CrealityPrint"],
		configRoot: (p) => {
			const root = isWindows ? join(p.roaming, "Creality", "Creality Print") : isMac ? join(p.home, "Library", "Application Support", "Creality", "Creality Print") : join(p.home, ".config", "Creality", "Creality Print");
			// Assets live in a per-version subdirectory; report the newest that exists.
			const versions = subdirs(root, /^\d+(\.\d+)*$/u).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
			return versions[0] ?? root;
		}
	},
	{
		id: "prusa",
		family: "prusa",
		name: "PrusaSlicer",
		dialect: "prusa",
		pathNames: ["prusa-slicer", "prusa-slicer-console"],
		candidates: (p) => isWindows
			? [
				join(p.programFiles, "Prusa3D", "PrusaSlicer", "prusa-slicer.exe"),
				join(p.local, "Programs", "PrusaSlicer", "prusa-slicer.exe"),
				...subdirs(join(p.programFiles, "Prusa3D"), /prusa/i).flatMap((dir) => join(dir, "prusa-slicer.exe"))
			]
			: isMac
				? ["/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer", join(p.home, "Applications", "PrusaSlicer.app", "Contents", "MacOS", "PrusaSlicer")]
				: ["/usr/bin/prusa-slicer", "/usr/local/bin/prusa-slicer", "/var/lib/flatpak/exports/bin/com.prusa3d.PrusaSlicer"],
		configRoot: (p) => isWindows ? join(p.roaming, "PrusaSlicer") : isMac ? join(p.home, "Library", "Application Support", "PrusaSlicer") : join(p.home, ".config", "PrusaSlicer")
	},
	{
		id: "superslicer",
		family: "superslicer",
		name: "SuperSlicer",
		dialect: "prusa",
		pathNames: ["superslicer", "SuperSlicer"],
		candidates: (p) => isWindows
			? [
				join(p.programFiles, "SuperSlicer", "superslicer.exe"),
				join(p.local, "Programs", "SuperSlicer", "superslicer.exe"),
				...subdirs(p.programFiles, /superslicer/i).flatMap((dir) => join(dir, "superslicer.exe"))
			]
			: isMac
				? ["/Applications/SuperSlicer.app/Contents/MacOS/SuperSlicer"]
				: ["/usr/bin/superslicer", "/usr/local/bin/superslicer"],
		configRoot: (p) => isWindows ? join(p.roaming, "SuperSlicer") : isMac ? join(p.home, "Library", "Application Support", "SuperSlicer") : join(p.home, ".config", "SuperSlicer")
	},
	{
		id: "cura",
		family: "cura",
		name: "UltiMaker Cura",
		dialect: "gui",
		pathNames: ["UltiMaker-Cura", "Ultimaker-Cura", "cura"],
		candidates: (p) => isWindows
			? subdirs(p.programFiles, /cura/i).flatMap((dir) => [join(dir, "UltiMaker-Cura.exe"), join(dir, "Ultimaker-Cura.exe"), join(dir, "cura.exe")])
			: isMac
				? ["/Applications/UltiMaker Cura.app/Contents/MacOS/UltiMaker-Cura", "/Applications/Ultimaker Cura.app/Contents/MacOS/Ultimaker-Cura"]
				: ["/usr/bin/cura", "/usr/local/bin/cura", "/var/lib/flatpak/exports/bin/com.ultimaker.cura"],
		configRoot: (p) => isWindows ? join(p.roaming, "cura") : isMac ? join(p.home, "Library", "Application Support", "cura") : join(p.home, ".local", "share", "cura"),
		note: "Cura 本体是 GUI 程序；命令行切片请用 CuraEngine（同一安装目录里通常带着）。"
	},
	{
		id: "curaengine",
		family: "curaengine",
		name: "CuraEngine",
		dialect: "cura-engine",
		pathNames: ["CuraEngine"],
		candidates: (p) => isWindows
			? subdirs(p.programFiles, /cura/i).flatMap((dir) => [join(dir, "CuraEngine.exe")])
			: isMac
				? ["/Applications/UltiMaker Cura.app/Contents/MacOS/CuraEngine", "/usr/bin/CuraEngine"]
				: ["/usr/bin/CuraEngine", "/usr/local/bin/CuraEngine", "/usr/lib/cura/plugins/CuraEngineBackend/CuraEngine"],
		configRoot: (p) => isWindows ? join(p.roaming, "cura") : isMac ? join(p.home, "Library", "Application Support", "cura") : join(p.home, ".local", "share", "cura"),
		note: "CuraEngine 需要一个机器定义 JSON（-j，在 Cura 安装目录的 resources/definitions 下），否则只能跑默认机。"
	},
	{
		id: "simplify3d",
		family: "simplify3d",
		name: "Simplify3D",
		dialect: "gui",
		pathNames: [],
		candidates: (p) => isWindows
			? [join(p.programFiles, "Simplify3D", "Simplify3D.exe"), join(p.programFilesX86, "Simplify3D", "Simplify3D.exe")]
			: isMac
				? ["/Applications/Simplify3D.app/Contents/MacOS/Simplify3D"]
				: ["/opt/Simplify3D/Simplify3D"],
		configRoot: (p) => isWindows ? join(p.roaming, "Simplify3D") : join(p.home, ".config", "Simplify3D"),
		note: "Simplify3D 没有公开的 CLI 切片入口，只能通过 GUI 出 G-code。"
	},
	{
		id: "ideamaker",
		family: "ideamaker",
		name: "IdeaMaker",
		dialect: "gui",
		pathNames: [],
		candidates: (p) => isWindows
			? [
				...subdirs(join(p.programFiles, "raise3d"), /idea/i).flatMap((dir) => join(dir, "ideaMaker.exe")),
				...subdirs(p.programFiles, /idea/i).flatMap((dir) => join(dir, "ideaMaker.exe"))
			]
			: isMac
				? ["/Applications/ideaMaker.app/Contents/MacOS/ideaMaker"]
				: ["/opt/ideaMaker/ideaMaker"],
		configRoot: (p) => isWindows ? join(p.roaming, "ideaMaker") : join(p.home, ".config", "ideaMaker"),
		note: "IdeaMaker 以 GUI 为主，没有文档化的命令行切片接口。"
	}
];

/** Public catalog of known families (used by detect reports and error messages). */
export const SLICER_FAMILIES = FAMILIES.map(({ id, family, name, dialect, note }) => ({ id, family, name, dialect, note }));

/** The argument dialect for a family id. */
export function dialectFor(family) {
	return DIALECTS[family] ?? "gui";
}

/** Locate the first existing executable for one family: PATH first, then install roots. */
function locate(entry, proc) {
	for (const name of entry.pathNames) {
		const fromPath = proc?.find?.(name) ?? findExecutable(name, []);
		if (fromPath !== undefined) return fromPath;
	}
	for (const candidate of entry.candidates(envPaths())) {
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

/** Run a probe without ever throwing; a failure is just an empty result. */
async function probeRun(proc, argv, exec, timeoutMs, maxBytes = 60_000) {
	try {
		const result = await proc.run(argv, { exec, timeoutMs, maxBytes });
		return {
			code: result.code,
			timedOut: result.timedOut === true,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			elapsedMs: result.elapsedMs ?? 0
		};
	} catch (error) {
		return { code: null, timedOut: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), elapsedMs: 0 };
	}
}

/** Every `--flag` / `-x` token a help text advertises, deduplicated. */
function parseFlags(text) {
	const flags = new Set();
	for (const match of String(text ?? "").matchAll(/(?:^|[\s,;:("'])(--[a-z0-9][a-z0-9_-]*)/giu)) flags.add(match[1].toLowerCase());
	for (const match of String(text ?? "").matchAll(/(?:^|[\s,;:("'])(-[a-z])(?=[\s,;:)]|$)/giu)) flags.add(match[1].toLowerCase());
	return [...flags].sort();
}

/** First plausible version token in a --version / help output. */
function parseVersion(text) {
	const match = String(text ?? "").match(/\b(\d+\.\d+(?:\.\d+)?(?:[+-][\w.]+)?)\b/u);
	return match?.[1];
}

/** Creality Print does not answer `--version`, so infer it from the install directory. */
function versionFromPath(exe) {
	const match = String(exe ?? "").match(/Creality\s*Print[\\/ ]*(\d+(?:\.\d+)+)/iu);
	return match?.[1];
}

/**
 * Probe one binary and describe what its CLI can actually do.
 * @returns {Promise<{cli: boolean, flags: string[], exportFormats: string[], version?: string, notes: string[]}>}
 */
async function probe(proc, exe, entry, exec) {
	const notes = [];

	if (entry.dialect === "gui") {
		return {
			cli: false,
			flags: [],
			exportFormats: [],
			notes: [
				entry.note ?? `${entry.name} 只能通过 GUI 出 G-code。`,
				"不主动启动 GUI 做探测：那会打断用户当前的窗口，且拿不到可靠的 CLI 能力信息。"
			]
		};
	}

	if (entry.dialect === "bambu-cli") {
		// Creality Print swallows a bare `--help` into its GUI (and loads the home page);
		// `--cli --help` is the cheap, non-GUI probe.
		const help = await probeRun(proc, [exe, "--cli", "--help"], exec, 15_000, 40_000);
		const cli = help.timedOut !== true && help.code === 0;
		if (cli) {
			notes.push("CLI 方言 = Bambu 风格：`--cli --slice 0 --outputdir <dir> --need-gcode-file --load-settings \"<machine>;<process>\" --load-filaments <filament> model.stl` → 输出 `plate_N.gcode`。");
			notes.push("不带 `--need-gcode-file` 时只做切片校验、不往 outputdir 写文件；裸 `--help` 会被 GUI 接管（会拉起界面并联网），探测与调用都不要用它。");
		} else {
			notes.push(help.timedOut === true
				? "`--cli --help` 超时未返回：该安装没有可用的 CLI 切片入口，只能开 GUI。"
				: `\`--cli --help\` 返回 ${help.code ?? "失败"}：该安装没有可用的 CLI 切片入口，只能开 GUI。`);
		}
		return { cli, flags: cli ? [...CREALITY_FLAGS] : [], exportFormats: cli ? ["gcode"] : [], version: versionFromPath(exe), notes };
	}

	if (entry.dialect === "cura-engine") {
		const help = await probeRun(proc, [exe, "--help"], exec, 15_000, 40_000);
		const text = `${help.stdout}\n${help.stderr}`.trim();
		const cli = help.timedOut !== true && text.length > 0 && /slice|engine/iu.test(text);
		if (cli) notes.push("CuraEngine 用法：`CuraEngine slice -v -j <definition.json> -s key=value -l model.stl -o out.gcode`；`-s` 是唯一的参数覆盖方式。");
		else notes.push("`--help` 没有给出可解析的用法：CuraEngine 不可用（或版本太老）。");
		return { cli, flags: cli ? ["slice", "-s", "-o", "-l", "-j", "-v"] : [], exportFormats: cli ? ["gcode"] : [], notes };
	}

	// PrusaSlicer family and Orca/Bambu: `--help` prints the parameter table and
	// that table is the source of truth for which switches exist.
	const help = await probeRun(proc, [exe, "--help"], exec, 20_000, 80_000);
	const text = `${help.stdout}\n${help.stderr}`;
	const flags = parseFlags(text);
	const cli = help.timedOut !== true && help.code === 0 && (flags.length > 0 || /usage/iu.test(text));
	if (help.timedOut === true) notes.push("`--help` 超时：疑似 GUI 接管了命令行，按没有 CLI 处理。");
	else if (!cli) notes.push("`--help` 没有列出命令行开关，按没有 CLI 处理。");

	const exportFormats = [];
	if (cli) {
		const hasGcode = entry.dialect === "prusa"
			? flags.includes("-g") || flags.includes("--output")
			: flags.includes("--slice") || flags.includes("--outputdir") || flags.includes("-g") || flags.includes("--output");
		if (hasGcode) exportFormats.push("gcode");
		if (flags.includes("--export-3mf")) exportFormats.push("3mf");
		if (entry.dialect === "prusa") notes.push("PrusaSlicer/SuperSlicer 用法：`-g --output <dir> [--load <ini> ...] model.stl`；参数覆盖只能靠 `--load` 传 ini，没有逐项 flag。");
		else notes.push("Orca/Bambu 用法：`--slice 0 --outputdir <dir>`（或 `-g --output <dir>`），`--export-3mf <file>` 可导出工程；机器/process/filament 走 `--load-settings`/`--load-filaments` 或 `--load <ini>`。");
	}

	let version = parseVersion(text);
	if (version === undefined) {
		const versionResult = await probeRun(proc, [exe, "--version"], exec, 10_000, 8_000);
		version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
	}
	return { cli, flags, exportFormats, version, notes };
}

/**
 * Find every installed slicer and describe its CLI surface.
 * Never throws: one broken family must not hide the others.
 *
 * @param {{run: Function, find?: Function}} proc - process seam from core/proc.js
 * @param {object} [settings] - plugin settings (reserved; discovery is environment-driven)
 * @param {object} [exec] - tool exec context, forwarded so the session's sandbox applies
 * @returns {Promise<Array<{id: string, family: string, name: string, exe: string, version?: string,
 *   aware: {cli: boolean, exportFormats: string[], flags: string[]}, configRoot: string, notes: string[]}>>}
 */
export async function detectSlicers(proc, settings = {}, exec) {
	void settings;
	const found = [];
	try {
		for (const entry of FAMILIES) {
			try {
				const exe = locate(entry, proc);
				if (exe === undefined) continue;
				if (found.some((other) => other.exe.toLowerCase() === exe.toLowerCase() && other.family === entry.family)) continue;
				const aware = await probe(proc, exe, entry, exec);
				found.push({
					id: entry.id,
					family: entry.family,
					name: entry.name,
					exe,
					version: aware.version,
					aware: { cli: aware.cli === true, exportFormats: aware.exportFormats ?? [], flags: aware.flags ?? [] },
					configRoot: entry.configRoot(envPaths()),
					notes: aware.notes ?? []
				});
			} catch (error) {
				// A single family failing must not abort detection; nothing to report per
				// family would be lost otherwise, so swallow with a console breadcrumb.
				console.error(`[dsh-3d-print] slicer probe failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} catch (error) {
		console.error(`[dsh-3d-print] slicer detection failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return found;
}

/**
 * Choose one slicer from a detection result.
 * An explicit hint that matches nothing returns undefined (the caller must say
 * so) instead of silently slicing with a different vendor's build.
 *
 * @param {Array<object>} detected
 * @param {{hint?: string, vendor?: string}} [preferences] - `vendor` is a printer family
 * @returns {object|undefined}
 */
export function pickSlicer(detected, preferences = {}) {
	if (!Array.isArray(detected) || detected.length === 0) return undefined;
	const hint = String(preferences.hint ?? "").trim().toLowerCase();
	if (hint.length > 0) {
		return detected.find((slicer) => {
			const names = [slicer.id, slicer.family, slicer.name, basename(slicer.exe), basename(slicer.exe, extname(slicer.exe))];
			return names.some((name) => String(name ?? "").toLowerCase() === hint) || basename(slicer.exe).toLowerCase().includes(hint);
		});
	}
	const preferredFamily = VENDOR_PREFERENCE[String(preferences.vendor ?? "").toLowerCase()];
	const ranked = [...detected].sort((a, b) => scoreOf(a, preferredFamily) - scoreOf(b, preferredFamily));
	return ranked[0];
}

/** Lower is better: a vendor-native slicer wins, then the fixed priority list. */
function scoreOf(slicer, preferredFamily) {
	const rank = PRIORITY.indexOf(slicer.family);
	const base = rank === -1 ? PRIORITY.length : rank;
	return (preferredFamily !== undefined && slicer.family === preferredFamily ? 0 : 100) + base;
}

/** Files a slicing run may have produced in `dir` since `sinceMs`, newest first. */
function collectOutputs(dir, sinceMs) {
	const outputs = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const path = join(dir, entry.name);
			const extension = extname(entry.name).toLowerCase();
			if (!OUTPUT_EXTENSIONS.includes(extension)) continue;
			let stat;
			try {
				stat = statSync(path);
			} catch {
				continue;
			}
			if (stat.mtimeMs < sinceMs) continue;
			outputs.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs, kind: extension === ".3mf" ? "3mf" : "gcode" });
		}
	} catch {
		// The output directory may not exist yet, or the slicer may not have written
		// anything; both are reported through an empty list.
	}
	outputs.sort((a, b) => b.mtimeMs - a.mtimeMs || b.bytes - a.bytes);
	return outputs;
}

/**
 * Slice one model with one slicer.
 *
 * Dialects (verified shapes):
 *  - PrusaSlicer/SuperSlicer: `-g --output <dir> [--load <ini>] model.stl`
 *  - OrcaSlicer/Bambu Studio: `--slice 0 --outputdir <dir> model.stl`
 *  - Creality Print: `--cli --slice 0 --outputdir <dir> --need-gcode-file ... model.stl`
 *  - CuraEngine: `slice -v -o out.gcode -l model.stl -s key=value ...`
 *
 * @param {{proc: object, settings?: object, exec?: object, exe: string, family: string,
 *   input: string, outputDir: string, profile?: {args?: string[]}, extraArgs?: string[],
 *   timeoutMs?: number}} request
 * @returns {Promise<{ok: boolean, output?: string, outputs: Array<{path: string, bytes: number, kind: string}>,
 *   stdout: string, stderr: string, argv: string[], elapsedMs: number, code: number|null,
 *   timedOut: boolean, notes: string[]}>}
 */
export async function slice(request) {
	const { proc, settings = {}, exec, exe, family, input, outputDir, profile, extraArgs = [], timeoutMs } = request;
	const startedAt = Date.now();
	const startedSince = startedAt - 2_000;
	const dialect = dialectFor(family);
	const profileArgs = Array.isArray(profile?.args) ? profile.args : [];
	const extra = Array.isArray(extraArgs) ? extraArgs.filter((value) => typeof value === "string") : [];

	if (dialect === "gui") {
		return {
			ok: false,
			outputs: [],
			stdout: "",
			stderr: "",
			argv: [exe, input],
			elapsedMs: 0,
			code: null,
			timedOut: false,
			notes: [`${family} 没有可用的 CLI 切片入口，无法在命令行里出 G-code；用 action="open" 把模型丢给 GUI。`]
		};
	}

	let argv;
	if (dialect === "prusa") {
		argv = [exe, "-g", "--output", outputDir, ...profileArgs, ...extra, input];
	} else if (dialect === "orca") {
		argv = [exe, "--slice", "0", "--outputdir", outputDir, ...profileArgs, ...extra, input];
	} else if (dialect === "bambu-cli") {
		// `--need-gcode-file` is what makes Creality write plate_N.gcode into outputdir;
		// without it the CLI only validates and leaves the directory empty.
		argv = [exe, "--cli", "--slice", "0", "--outputdir", outputDir, "--need-gcode-file", ...profileArgs, ...extra, input];
	} else {
		// cura-engine: the output file is named explicitly with -o.
		argv = [exe, "slice", "-v", "-o", join(outputDir, `${basename(input, extname(input))}.gcode`), "-l", input, ...profileArgs, ...extra];
	}

	try {
		if (!isDirectory(outputDir)) mkdirSync(outputDir, { recursive: true });
	} catch (error) {
		return {
			ok: false,
			outputs: [],
			stdout: "",
			stderr: "",
			argv,
			elapsedMs: Date.now() - startedAt,
			code: null,
			timedOut: false,
			notes: [`无法创建输出目录 ${outputDir}：${error instanceof Error ? error.message : String(error)}`]
		};
	}

	const timeout = timeoutMs ?? settings.sliceTimeoutMs ?? 1_800_000;
	let result;
	try {
		result = await proc.run(argv, { exec, timeoutMs: timeout, maxBytes: 400_000 });
	} catch (error) {
		return {
			ok: false,
			outputs: [],
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			argv,
			elapsedMs: Date.now() - startedAt,
			code: null,
			timedOut: false,
			notes: ["切片器进程没能跑起来（路径、权限或沙箱策略问题）。"]
		};
	}

	const outputs = collectOutputs(outputDir, startedSince);
	const notes = [];
	if (result.code === 0 && outputs.length === 0) {
		notes.push("退出码 0，但输出目录里没有出现 gcode/3mf：这个 CLI 可能只做了校验，或把文件写进了切片器自己的目录。");
	}
	if (result.timedOut === true) notes.push(`切片超过 ${Math.round(timeout / 1000)} s 被终止；大模型用 timeoutMs 加长。`);

	return {
		ok: result.code === 0 && outputs.length > 0,
		output: outputs[0]?.path,
		outputs,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		argv,
		elapsedMs: Date.now() - startedAt,
		code: result.code,
		timedOut: result.timedOut === true,
		notes
	};
}

/** Quote one argv element for a copy-pasteable command line. */
function quoteArg(value) {
	const text = String(value ?? "");
	return /[\s"'&<>|^]/u.test(text) ? `"${text.replace(/"/gu, '\\"')}"` : text;
}

/** A command line the user can paste; never executed by this module. */
export function commandLine(argv) {
	return argv.map(quoteArg).join(" ");
}

/**
 * Hand a model to a slicer's GUI.
 *
 * There is no portable "launch detached and forget" surface on the process
 * seam, so this starts `<exe> <input>` and accepts that the app stays resident:
 * the call resolves at the timeout and always also returns a paste-ready
 * command line, so a GUI that the timeout watchdog closed can be reopened.
 *
 * @param {{proc: object, exec?: object, exe: string, input: string, timeoutMs?: number}} request
 * @returns {Promise<{ok: boolean, launched: boolean, argv: string[], command: string,
 *   timedOut: boolean, stderr: string, elapsedMs: number, notes: string[]}>}
 */
export async function openInGui(request) {
	const { proc, exec, exe, input, timeoutMs = 5_000 } = request;
	const argv = isMac ? ["open", "-a", exe, input] : [exe, input];
	const command = commandLine([exe, input]);
	const notes = [];
	let result;
	try {
		result = await proc.run(argv, { exec, timeoutMs: isMac ? 15_000 : timeoutMs, maxBytes: 8_000 });
	} catch (error) {
		return {
			ok: false,
			launched: false,
			argv,
			command,
			timedOut: false,
			stderr: error instanceof Error ? error.message : String(error),
			elapsedMs: 0,
			notes: ["GUI 没能启动：检查可执行文件路径与权限，或直接运行返回的 command。"]
		};
	}
	const launched = result.timedOut === true || result.code === 0;
	if (result.timedOut === true) {
		notes.push("GUI 进程常驻，等待被超时看门狗结束；如果窗口没有留下，直接粘贴 command 重开。");
	}
	if (result.code !== 0 && result.code !== null) {
		notes.push(`GUI 退出码 ${result.code}；更像参数问题（有些版本不吃裸文件路径），可以用 command 手动确认。`);
	}
	return {
		ok: launched,
		launched,
		argv,
		command,
		timedOut: result.timedOut === true,
		stderr: (result.stderr ?? "").slice(0, 4_000),
		elapsedMs: result.elapsedMs ?? 0,
		notes
	};
}

export { isFile, isDirectory, envPaths };
