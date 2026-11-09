/**
 * OpenSCAD discovery and invocation.
 *
 * OpenSCAD is the modeling engine: the tools never write STL themselves, they
 * drive `openscad.exe -o out.stl model.scad`, which keeps every part parametric
 * and reproducible from source. Discovery is deliberately filesystem-first
 * (PATH plus the usual install roots) because a GUI-launched Harness often
 * carries a PATH that omits a freshly installed OpenSCAD.
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findExecutable } from "./proc.js";

const isWindows = process.platform === "win32";

/**
 * Where an automatic install puts a portable copy.
 *
 * Inside the session workspace on purpose: a confining session denies writes
 * everywhere else, and an auto-install that needs a UAC prompt or a writable
 * `%LOCALAPPDATA%` is not an auto-install. `print3d_setup` still offers the
 * machine-wide routes for users who run it deliberately.
 */
function managedInstallDir(exec, settings) {
	const workspace = exec?.agent?.session?.header?.cwd ?? process.cwd();
	return join(workspace, settings.outDir ?? "3dprint", "_tools", "openscad");
}

function managedBinary(exec, settings) {
	return join(managedInstallDir(exec, settings), isWindows ? "openscad.exe" : "openscad");
}

/** Where OpenSCAD lands on each platform, most likely first. */
function candidatePaths() {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	const local = process.env.LOCALAPPDATA ?? "";
	const roaming = process.env.APPDATA ?? "";
	const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
	const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	if (isWindows) {
		return [
			join(local, "Programs", "OpenSCAD", "openscad.exe"),
			join(programFiles, "OpenSCAD", "openscad.exe"),
			join(programFilesX86, "OpenSCAD", "openscad.exe"),
			join(local, "Microsoft", "WinGet", "Links", "openscad.exe"),
			"C:\\ProgramData\\chocolatey\\bin\\openscad.exe",
			join(home, "scoop", "shims", "openscad.exe"),
			join(roaming, "OpenSCAD", "openscad.exe")
		];
	}
	if (process.platform === "darwin") {
		return ["/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD", "/usr/local/bin/openscad", "/opt/homebrew/bin/openscad"];
	}
	return ["/usr/bin/openscad", "/usr/local/bin/openscad", "/snap/bin/openscad", "/var/lib/flatpak/exports/bin/org.openscad.OpenSCAD"];
}

/** Export formats OpenSCAD can write, and which of them are meshes. */
export const EXPORT_FORMATS = {
	stl: { mesh: true, note: "网格，切片通用" },
	"3mf": { mesh: true, note: "带单位/多体的网格容器" },
	off: { mesh: true, note: "几何交换" },
	amf: { mesh: true, note: "老式多体格式" },
	csg: { mesh: false, note: "CSG 树（可复现建模过程）" },
	dxf: { mesh: false, note: "2D 轮廓" },
	svg: { mesh: false, note: "2D 轮廓" },
	png: { mesh: false, note: "预览渲染" }
};

export function createOpenscad(proc, settings) {
	/** Cached discovery result per process, invalidated by an explicit path. */
	let cached;

	/**
	 * Resolve the OpenSCAD executable.
	 * @returns {Promise<{path: string, version?: string, source: string}>}
	 */
	async function resolve(exec) {
		const configured = settings.openscadPath;
		if (configured !== undefined && configured.length > 0) {
			if (!isFile(configured)) throw new Error(`配置的 openscadPath 不存在: ${configured}`);
			cached ??= { path: configured, version: await proc.version([configured, "--version"]), source: "config" };
			return cached;
		}
		if (cached !== undefined) return cached;
		// A portable copy this plugin installed earlier, inside the workspace. This
		// survives restarts, so it is checked before pretending the machine has none.
		const managed = managedBinary(exec, settings);
		if (isFile(managed)) {
			cached = { path: managed, version: await proc.version([managed, "--version"]), source: "workspace-portable" };
			return cached;
		}
		// Test/demo seam: hides *system* discovery so the auto-provision path can be
		// exercised on a machine that already has OpenSCAD, without uninstalling it.
		if (process.env.DSH_3DPRINT_IGNORE_OPENSCAD === "1") {
			throw new Error("OpenSCAD 被 DSH_3DPRINT_IGNORE_OPENSCAD=1 隐藏（仅用于自测自动安装路径）");
		}
		const fromPath = findExecutable("openscad", []);
		if (fromPath !== undefined) {
			cached = { path: fromPath, version: await proc.version([fromPath, "--version"]), source: "PATH" };
			return cached;
		}
		for (const candidate of candidatePaths()) {
			if (isFile(candidate)) {
				cached = { path: candidate, version: await proc.version([candidate, "--version"]), source: "install-root" };
				return cached;
			}
		}
		throw new Error("没有找到 OpenSCAD。调用 `print3d_setup` 自动安装，或把安装路径写进插件配置的 openscadPath。");
	}

	/** Forget a cached path (used after installing). */
	function reset() {
		cached = undefined;
	}

	/** One in-flight auto-provision attempt, shared by concurrent calls. */
	let provisioning;

	/**
	 * Resolve OpenSCAD, installing it when the machine has none.
	 *
	 * A missing toolchain must not be a dead end: when `autoInstall` is on, the
	 * first render provisions OpenSCAD itself. Download routes (GitHub + mirrors)
	 * are tried before package managers, because they need no elevation — an
	 * automatic install must never hang on a UAC dialog nobody clicks.
	 *
	 * @param {object} [exec] - execution context, forwarded to the installer
	 * @returns {Promise<{path: string, version?: string, source: string, provisioned?: boolean, install?: object}>}
	 */
	async function ensure(exec) {
		try {
			return await resolve(exec);
		} catch (missing) {
			if (settings.autoInstall !== true) throw missing;
			provisioning ??= provision(exec, missing);
			return await provisioning;
		}
	}

	/** Try every source that probed alive, no-admin routes first. */
	async function provision(exec, missing) {
		const install = await import("./install.js");
		const attempts = [];
		let probed;
		try {
			probed = await install.probeSources({ proc, settings, exec });
		} catch (error) {
			throw new Error(`没有找到 OpenSCAD，且安装源探测失败：${messageOf(error)}\n原始错误：${messageOf(missing)}`);
		}
		const rank = { mirror: 0, download: 1, "package-manager": 2 };
		const usable = probed.sources.filter((source) => source.available).sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3));
		// Confining sessions may only write inside the workspace, so the portable copy
		// goes there; the installer reads this override instead of %LOCALAPPDATA%.
		const previous = process.env.DSH_3DPRINT_INSTALL_DIR;
		const previousStage = process.env.DSH_3DPRINT_STAGE_DIR;
		const target = managedInstallDir(exec, settings);
		mkdirSync(target, { recursive: true });
		process.env.DSH_3DPRINT_INSTALL_DIR = target;
		process.env.DSH_3DPRINT_STAGE_DIR = join(target, "..", "_stage");
		try {
			for (const source of usable) {
				let outcome;
				try {
					outcome = await install.installOpenscad({ proc, settings, exec, confirm: true, sourceId: source.id, openscad: api });
				} catch (error) {
					attempts.push({ source: source.id, ok: false, detail: messageOf(error) });
					continue;
				}
				const verified = outcome.verified === true || outcome.verify?.runnable === true || outcome.installed === true;
				attempts.push({ source: source.id, ok: verified, detail: outcome.message ?? outcome.command ?? "" });
				if (!verified) continue;
				// Trust the path the installer verified over a second discovery pass: a
				// fresh install may land somewhere the candidate list does not know yet.
				const installedPath = outcome.verify?.path ?? outcome.path;
				reset();
				if (typeof installedPath === "string" && isFile(installedPath)) {
					cached = {
						path: installedPath,
						version: outcome.verify?.version ?? (await proc.version([installedPath, "--version"])),
						source: "auto-install"
					};
					return { ...cached, provisioned: true, install: { source: source.id, attempts, nextSteps: outcome.nextSteps ?? [] } };
				}
				const found = await resolve(exec);
				return { ...found, provisioned: true, install: { source: source.id, attempts, nextSteps: outcome.nextSteps ?? [] } };
			}
		} finally {
			if (previous === undefined) delete process.env.DSH_3DPRINT_INSTALL_DIR;
			else process.env.DSH_3DPRINT_INSTALL_DIR = previous;
			if (previousStage === undefined) delete process.env.DSH_3DPRINT_STAGE_DIR;
			else process.env.DSH_3DPRINT_STAGE_DIR = previousStage;
		}
		throw new Error(
			`没有找到 OpenSCAD，自动安装也没成功：\n${attempts.map((entry) => `- ${entry.source}：${entry.ok ? "ok" : tail(entry.detail)}`).join("\n")}\n` +
				`手动装：https://openscad.org/downloads.html ，然后把 exe 路径写进插件配置 openscadPath。\n原始错误：${messageOf(missing)}`
		);
	}

	/**
	 * Render one .scad file.
	 * @param {{source: string, output: string, params?: Record<string, string|number|boolean>, format?: string,
	 *          exec?: object, timeoutMs?: number, extraArgs?: string[]}} request
	 */
	async function build(request) {
		const openscad = await ensure(request.exec);
		const format = (request.format ?? request.output.split(".").pop() ?? "stl").toLowerCase();
		const argv = [openscad.path, "-o", request.output];
		if (format === "stl") argv.push("--export-format", "binstl");
		for (const [key, value] of Object.entries(request.params ?? {})) {
			argv.push("-D", `${key}=${formatParam(value)}`);
		}
		if (request.extraArgs !== undefined) argv.push(...request.extraArgs);
		argv.push(request.source);
		const startedAt = Date.now();
		const result = await proc.run(argv, { exec: request.exec, timeoutMs: request.timeoutMs ?? settings.renderTimeoutMs, maxBytes: 200_000 });
		const errors = collectDiagnostics(result.stderr);
		if (result.code !== 0 || !isFile(request.output) || statSync(request.output).size === 0) {
			throw new Error(`OpenSCAD 渲染失败（exit ${result.code}）：\n${errors.join("\n") || result.stderr.trim().split(/\r?\n/u).slice(-10).join("\n") || "(无输出)"}`);
		}
		return {
			openscad: openscad.path,
			...(openscad.provisioned === true ? { provisioned: true, install: openscad.install } : {}),
			output: request.output,
			bytes: statSync(request.output).size,
			elapsedMs: Date.now() - startedAt,
			diagnostics: errors,
			warnings: collectDiagnostics(result.stderr, "WARNING")
		};
	}

	/**
	 * Render a PNG preview with an explicit camera.
	 * @param {{source: string, output: string, exec?: object, imgsize?: string, camera?: string,
	 *          projection?: "p"|"o", colorscheme?: string, timeoutMs?: number, params?: object}} request
	 */
	async function preview(request) {
		const extraArgs = [
			`--imgsize=${request.imgsize ?? settings.previewSize}`,
			`--camera=${request.camera ?? settings.previewCamera}`,
			`--projection=${request.projection ?? "p"}`,
			`--colorscheme=${request.colorscheme ?? "Tomorrow"}`,
			"--viewall",
			"--autocenter",
			"--render"
		];
		return await build({
			source: request.source,
			output: request.output,
			format: "png",
			params: request.params,
			exec: request.exec,
			timeoutMs: request.timeoutMs ?? settings.renderTimeoutMs,
			extraArgs
		});
	}

	const api = { resolve, ensure, reset, build, preview, candidatePaths, EXPORT_FORMATS };
	return api;
}

/** One-line message for anything thrown. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** First non-empty line of a failure, so an attempts table stays readable. */
function tail(detail) {
	const line = String(detail ?? "").split(/\r?\n/u).map((part) => part.trim()).find((part) => part.length > 0) ?? "失败";
	return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** OpenSCAD `-D` accepts strings, numbers and booleans; strings need quotes. */
function formatParam(value) {
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	const textValue = String(value);
	if (/^-?\d+(\.\d+)?$/u.test(textValue) || textValue === "true" || textValue === "false") return textValue;
	return JSON.stringify(textValue);
}

/** Pull `ERROR:` / `WARNING:` lines out of OpenSCAD's stderr. */
export function collectDiagnostics(stderr, kind) {
	const lines = String(stderr ?? "").replace(/\r/gu, "").split("\n");
	const wanted = kind === undefined ? ["ERROR"] : [kind];
	return lines
		.filter((line) => wanted.some((prefix) => line.includes(prefix)))
		.map((line) => line.trim())
		.slice(0, 40);
}

/** Where a freshly rendered mesh is written for a source file. */
export function outputPath(outDir, name, extension) {
	return join(outDir, `${name}.${extension}`);
}

/** Convenience: is this an existing file? */
export { isFile };
