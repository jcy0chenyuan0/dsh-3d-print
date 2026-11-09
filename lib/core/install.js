/**
 * Automatic OpenSCAD install, with source selection.
 *
 * Why this exists: the ask was "install it yourself and pick a source yourself".
 * A single hardcoded URL is exactly how installers rot — on a network where
 * github.com release objects stall, a mirror answers in two seconds; on a
 * machine that already has winget, winget is *better* than a raw download
 * because it verifies the signature and writes the uninstall registry entry.
 * So this module enumerates every source, measures them concurrently with a
 * short deadline, keeps the fastest *available* one, and puts package managers
 * ahead of downloads at equal availability.
 *
 * Two hard rules:
 * - Nothing installs unless `confirm === true`; the default path returns a plan.
 * - Nothing elevates. We never call sudo/runas and never pre-authorise UAC:
 *   a silent NSIS install into Program Files still raises the UAC prompt, which
 *   is the user's decision and cannot be detected from here. Success is decided
 *   by whether OpenSCAD actually resolves afterwards, never by exit codes alone.
 */
import {
	closeSync,
	createWriteStream,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";
import { createOpenscad } from "./openscad.js";
import { detectBlender, safeWorkingDir } from "./tools-detect.js";

const isWindows = process.platform === "win32";
const USER_AGENT = "dsh-3d-print/setup (+https://openscad.org)";
/** Short deadline for liveness probes: a source that cannot answer in 6 s is not a source. */
const PROBE_TIMEOUT_MS = 6_000;
const PROBE_RANGE = "bytes=0-1023";

/** Where the newest release is announced. */
export const GITHUB_RELEASE_API = "https://api.github.com/repos/openscad/openscad/releases/latest";
/**
 * Last-resort download when the API is unreachable. 2021.01 is the current
 * stable release, so pinning it is not stale in the "will not install" sense.
 */
const FALLBACK_ASSET = "https://github.com/openscad/openscad/releases/download/openscad-2021.01/OpenSCAD-2021.01-x86-64-Installer.exe";

/**
 * GitHub download accelerators, as "prefix + full github.com URL".
 * All four are the ones users in mainland China actually reach for; probe them
 * instead of trusting them, because they appear and disappear.
 */
export const MIRRORS = [
	{ id: "mirror-ghfast", prefix: "https://ghfast.top/", host: "ghfast.top" },
	{ id: "mirror-gh-proxy", prefix: "https://gh-proxy.com/", host: "gh-proxy.com" },
	{ id: "mirror-ghproxy", prefix: "https://ghproxy.net/", host: "ghproxy.net" },
	{ id: "mirror-ghproxy-legacy", prefix: "https://mirror.ghproxy.com/", host: "mirror.ghproxy.com" }
];

/** Text help for the case where every automatic source fails. */
export const OPENSCAD_DOWNLOAD_HINT = [
	"手动安装 OpenSCAD 的入口（任选其一）：",
	"- 官网下载页：https://openscad.org/downloads.html（Windows 选 .exe 安装包）",
	"- GitHub releases：https://github.com/openscad/openscad/releases",
	"- winget：winget install --id OpenSCAD.OpenSCAD -e",
	"- Chocolatey：choco install openscad -y",
	"- Scoop：scoop install openscad",
	"装完不用重启 Harness：重新跑 print3d_doctor 即可（发现逻辑会扫常见安装目录）。",
	"装在非默认盘时，把 exe 路径写进插件配置的 openscadPath。"
].join("\n");

const zipInstallDir = () => {
	// An auto-install may only write where the session's sandbox allows it, so the
	// caller can redirect the portable copy (normally inside the workspace).
	const override = process.env.DSH_3DPRINT_INSTALL_DIR;
	if (typeof override === "string" && override.length > 0) return override;
	const local = process.env.LOCALAPPDATA ?? tmpdir();
	return join(local, "Programs", "OpenSCAD");
};

function env(name) {
	const value = process.env[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Last lines of process output, for a model-facing failure reason. */
function tailText(value, lines = 8) {
	const parts = String(value ?? "")
		.replace(/\r/gu, "")
		.split("\n")
		.filter((line) => line.trim().length > 0);
	return parts.slice(-lines).join("\n");
}

/** Extra directories that GUI-launched processes routinely omit from PATH. */
function managerExtraDirs() {
	const dirs = [];
	const programData = env("ProgramData");
	if (programData !== undefined) dirs.push(join(programData, "chocolatey", "bin"));
	const home = env("USERPROFILE") ?? env("HOME");
	if (home !== undefined) dirs.push(join(home, "scoop", "shims"));
	return dirs;
}

/**
 * Package managers, in preference order. Each carries both the argv we would
 * run and the human-readable command shown in a plan.
 */
const MANAGER_SOURCES = [
	{
		id: "winget",
		kind: "package-manager",
		label: "winget（Windows 包管理器）",
		binary: "winget",
		versionArgs: ["--version"],
		args: ["install", "--id", "OpenSCAD.OpenSCAD", "-e", "--accept-package-agreements", "--accept-source-agreements", "--silent"],
		pretty: "winget install --id OpenSCAD.OpenSCAD -e --accept-package-agreements --accept-source-agreements --silent",
		detail: "首选：校验签名、写卸载项，不需要我们猜安装目录"
	},
	{
		id: "choco",
		kind: "package-manager",
		label: "Chocolatey（choco）",
		binary: "choco",
		versionArgs: ["--version"],
		args: ["install", "openscad", "-y"],
		pretty: "choco install openscad -y",
		detail: "备选：choco 自己会提权，所以系统会弹 UAC"
	},
	{
		id: "scoop",
		kind: "package-manager",
		label: "Scoop",
		binary: "scoop",
		versionArgs: ["--version"],
		args: ["install", "openscad"],
		pretty: "scoop install openscad",
		detail: "备选：用户级安装，不需要管理员"
	}
];

const BLENDER_MANAGER_SOURCE = {
	id: "winget",
	kind: "package-manager",
	label: "winget（Blender）",
	binary: "winget",
	versionArgs: ["--version"],
	args: ["install", "--id", "BlenderFoundation.Blender", "-e", "--accept-package-agreements", "--accept-source-agreements", "--silent"],
	pretty: "winget install --id BlenderFoundation.Blender -e --accept-package-agreements --accept-source-agreements --silent",
	detail: "Blender 只有 winget 一条自动路线（体积约 350 MB）"
};

/** Run a .cmd/.bat shim through cmd.exe; CreateProcess cannot execute it directly. */
function buildArgv(command, args) {
	if (isWindows && /\.(cmd|bat)$/iu.test(command)) return ["cmd.exe", "/c", command, ...args];
	return [command, ...args];
}

/** Ask one package manager whether it is usable, and how slow it is. */
async function detectManager(proc, source, exec) {
	const base = {
		id: source.id,
		kind: source.kind,
		label: source.label,
		detail: source.detail,
		pretty: source.pretty,
		available: false
	};
	// `proc.find` misses Windows app-execution aliases: stat() on
	// `%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe` returns EACCES, yet
	// CreateProcess resolves the bare name fine. So try the resolved path first,
	// then the bare name, and let actually running it be the test.
	const found = proc.find(source.binary, managerExtraDirs());
	const commands = found === undefined ? [source.binary] : [found, source.binary];
	let lastError;
	let latencyMs;
	for (const command of commands) {
		const startedAt = Date.now();
		const result = await proc.run(buildArgv(command, source.versionArgs), { timeoutMs: 8_000, maxBytes: 8_000, exec, cwd: safeWorkingDir() });
		latencyMs = Date.now() - startedAt;
		if (result.code === 0) {
			return {
				...base,
				available: true,
				latencyMs,
				command,
				argv: buildArgv(command, source.args)
			};
		}
		lastError = `exit ${result.code}${result.timedOut ? "（超时）" : ""}${tailText(result.stderr) === "" ? "" : `：${tailText(result.stderr, 2)}`}`;
	}
	return {
		...base,
		latencyMs,
		error: `${source.binary} 不在 PATH 上或跑不起来（${lastError ?? "找不到"}）`
	};
}

/** Download routes: the plain GitHub URL plus every mirror prefix. */
function downloadSources() {
	const direct = {
		id: "github",
		kind: "download",
		label: "GitHub releases 直链",
		detail: "从 github.com 直接下 Windows 安装包（境外网络通常最快，国内常卡住）",
		available: true
	};
	const mirrors = MIRRORS.map((mirror) => ({
		id: mirror.id,
		kind: "mirror",
		label: `镜像 ${mirror.host}`,
		detail: `${mirror.prefix} + GitHub 直链`,
		available: true,
		prefix: mirror.prefix
	}));
	return [direct, ...mirrors];
}

/**
 * Enumerate every way this machine could get OpenSCAD, cheapest-first.
 * No network here: "available" for a download route means "worth probing", and
 * `probeSources` is what turns that into a measured yes/no.
 * @param {{proc: object, settings?: object, exec?: object}} options
 * @returns {Promise<Array<{id: string, kind: string, label: string, detail: string, available: boolean}>>}
 */
export async function planInstall({ proc, settings, exec } = {}) {
	void settings;
	const managers = await Promise.all(MANAGER_SOURCES.map((source) => detectManager(proc, source, exec)));
	return [...managers, ...downloadSources()].map((source) => ({
		id: source.id,
		kind: source.kind,
		label: source.label,
		detail: source.detail,
		available: source.available,
		...(source.latencyMs !== undefined ? { latencyMs: source.latencyMs } : {}),
		...(source.error !== undefined ? { error: source.error } : {}),
		// Internal fields used by probeSources/installOpenscad; the tools trim them.
		...(source.argv !== undefined ? { argv: source.argv } : {}),
		...(source.pretty !== undefined ? { pretty: source.pretty } : {}),
		...(source.prefix !== undefined ? { prefix: source.prefix } : {})
	}));
}

/** Pick the Windows asset we want out of a release's asset list. */
export function pickWindowsAsset(assets) {
	const usable = assets.filter((asset) => {
		const name = typeof asset.name === "string" ? asset.name : "";
		return /\.(exe|zip)$/iu.test(name) && /(x86[-_]64|amd64|win64)/iu.test(name) && !/AppImage|\.dmg$/iu.test(name);
	});
	// An automatic, non-elevated install must take the zip: the NSIS installer needs
	// admin rights to touch Program Files, so choosing it would only waste a
	// download before dying on a UAC prompt nobody sees.
	if (env("DSH_3DPRINT_INSTALL_DIR") !== undefined) {
		return usable.find((asset) => /\.zip$/iu.test(asset.name)) ?? usable.find((asset) => /installer\.exe$/iu.test(asset.name)) ?? usable[0];
	}
	return usable.find((asset) => /installer\.exe$/iu.test(asset.name)) ?? usable.find((asset) => /\.zip$/iu.test(asset.name)) ?? usable[0];
}

/** One GET for the release JSON; throws so the caller can fall back honestly. */
async function fetchRelease({ timeoutMs = 8_000 } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(GITHUB_RELEASE_API, {
			redirect: "follow",
			signal: controller.signal,
			headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" }
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve the newest Windows installer URL, with a pinned fallback for when the
 * API itself is what is unreachable (a mirror can still fetch the pinned URL).
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{url: string, name: string, tag: string, bytes?: number, resolvedFrom: string, reason?: string}>}
 */
export async function resolveDownloadAsset({ timeoutMs = 8_000 } = {}) {
	let apiError;
	try {
		const release = await fetchRelease({ timeoutMs });
		const asset = pickWindowsAsset(Array.isArray(release.assets) ? release.assets : []);
		if (asset === undefined) throw new Error(`release ${release.tag_name ?? "?"} 里没有 Windows 资产`);
		return {
			url: asset.browser_download_url,
			name: asset.name,
			tag: String(release.tag_name ?? ""),
			...(typeof asset.size === "number" ? { bytes: asset.size } : {}),
			resolvedFrom: "github-api"
		};
	} catch (error) {
		apiError = error instanceof Error ? error.message : String(error);
	}
	return {
		url: FALLBACK_ASSET,
		name: basename(FALLBACK_ASSET),
		tag: "openscad-2021.01",
		resolvedFrom: "fallback",
		reason: apiError
	};
}

/**
 * Do a ranged GET and read one chunk: headers *and* bytes must arrive before a
 * download source counts as alive. A proxy that answers 200 with an HTML error
 * page is exactly the failure mode a status-code-only probe misses.
 */
async function probeUrl(url, timeoutMs = PROBE_TIMEOUT_MS) {
	const startedAt = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: { "user-agent": USER_AGENT, range: PROBE_RANGE, accept: "*/*" }
		});
		let probedBytes = 0;
		if (response.body !== null) {
			const reader = response.body.getReader();
			const chunk = await reader.read();
			probedBytes = chunk.value?.byteLength ?? 0;
			await reader.cancel();
		}
		return {
			available: response.ok && probedBytes > 0,
			latencyMs: Date.now() - startedAt,
			probedBytes,
			...(response.ok ? {} : { error: `HTTP ${response.status}` })
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			available: false,
			latencyMs: Date.now() - startedAt,
			error: error instanceof Error && error.name === "AbortError" ? `超时 ${timeoutMs} ms` : message
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Available package managers first, then available downloads by latency. */
function sortSources(sources) {
	const available = sources.filter((source) => source.available);
	const unavailable = sources.filter((source) => !source.available);
	const managers = available.filter((source) => source.kind === "package-manager");
	const downloads = available
		.filter((source) => source.kind !== "package-manager")
		.sort((a, b) => (a.latencyMs ?? Number.MAX_SAFE_INTEGER) - (b.latencyMs ?? Number.MAX_SAFE_INTEGER));
	return [...managers, ...downloads, ...unavailable];
}

/**
 * Concurrently measure every source: package managers by running their version
 * call, download routes with a 1 KiB ranged GET through the resolved asset URL.
 * @param {{proc: object, settings?: object, exec?: object, timeoutMs?: number}} options
 * @returns {Promise<{sources: Array<object>, recommended?: string, asset?: object, assetReason?: string, elapsedMs: number}>}
 */
export async function probeSources({ proc, settings, exec, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	const startedAt = Date.now();
	const planned = await planInstall({ proc, settings, exec });
	let asset;
	let assetReason;
	if (planned.some((source) => source.kind === "download" || source.kind === "mirror")) {
		try {
			asset = await resolveDownloadAsset({ timeoutMs: Math.min(8_000, Math.max(timeoutMs, 2_000)) });
		} catch (error) {
			assetReason = error instanceof Error ? error.message : String(error);
		}
	}
	const probed = await Promise.all(
		planned.map(async (source) => {
			if (source.kind === "package-manager") return source;
			if (asset === undefined) {
				return { ...source, available: false, error: assetReason ?? "拿不到下载地址（GitHub API 不可达）" };
			}
			const url = source.kind === "mirror" ? `${source.prefix}${asset.url}` : asset.url;
			const measured = await probeUrl(url, timeoutMs);
			return {
				...source,
				...measured,
				detail: `${source.detail}；探测资产 ${asset.name}${asset.reason === undefined ? "" : `（API 不可达，用固定版本：${asset.reason}）`}`
			};
		})
	);
	const sources = sortSources(probed);
	return {
		sources,
		recommended: sources.find((source) => source.available)?.id,
		...(asset !== undefined ? { asset } : {}),
		...(assetReason !== undefined ? { assetReason } : {}),
		elapsedMs: Date.now() - startedAt
	};
}

/* ------------------------------------------------------------------ *
 * Real installation
 * ------------------------------------------------------------------ */

/**
 * Download `url` to `filePath`, aborting if it stalls or blows the byte cap.
 * Exported as a test seam: the HTTP half of the install path is otherwise only
 * reachable with `confirm=true`, which tests must never do.
 */
export async function downloadTo(url, filePath, { timeoutMs = 900_000, maxBytes = 400 * 1024 * 1024 } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let bytes = 0;
	try {
		const response = await fetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: { "user-agent": USER_AGENT, accept: "*/*" }
		});
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
		if (response.body === null) throw new Error("响应没有正文（可能是代理返回的空页）");
		const source = Readable.fromWeb(response.body);
		source.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > maxBytes) controller.abort();
		});
		await pipeline(source, createWriteStream(filePath));
		return { bytes, contentType: response.headers.get("content-type") ?? "" };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`下载超时或被截断（${Math.round(bytes / 1024)} KiB 后停止）：${url}`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/** First four bytes, to tell a real installer from an HTML error page. */
function sniffMagic(filePath) {
	const buffer = Buffer.alloc(4);
	const fd = openSync(filePath, "r");
	try {
		readSync(fd, buffer, 0, 4, 0);
	} finally {
		closeSync(fd);
	}
	return buffer;
}

function isZipFile(filePath) {
	const magic = sniffMagic(filePath);
	return magic[0] === 0x50 && magic[1] === 0x4b;
}

function isExeFile(filePath) {
	const magic = sniffMagic(filePath);
	return magic[0] === 0x4d && magic[1] === 0x5a;
}

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;

function findEndOfCentralDirectory(buffer) {
	const floor = Math.max(0, buffer.length - 66_000);
	for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
		if (buffer.readUInt32LE(offset) === ZIP_EOCD) return offset;
	}
	throw new Error("不是有效的 zip（找不到中央目录结尾）");
}

function safeTarget(destDir, entryName) {
	const root = resolve(destDir);
	const target = resolve(root, entryName);
	if (target !== root && !target.startsWith(root + sep)) throw new Error(`zip 条目不安全（越界路径）：${entryName}`);
	return target;
}

/**
 * Minimal zip extractor on node:zlib — no npm dependency, no external unzip.
 * Handles stored (0) and deflated (8) entries, which is what release archives use.
 */
export function unzipBuffer(buffer, destDir) {
	const eocd = findEndOfCentralDirectory(buffer);
	const count = buffer.readUInt16LE(eocd + 10);
	let cursor = buffer.readUInt32LE(eocd + 16);
	const written = [];
	for (let index = 0; index < count; index += 1) {
		if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL) throw new Error(`zip 中央目录损坏（第 ${index + 1} 项）`);
		const flags = buffer.readUInt16LE(cursor + 8);
		const method = buffer.readUInt16LE(cursor + 10);
		const compressedSize = buffer.readUInt32LE(cursor + 20);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		cursor += 46 + nameLength + extraLength + commentLength;
		if (name.length === 0 || name.endsWith("/")) continue;
		if ((flags & 0x0001) !== 0) throw new Error("加密的 zip 条目不受支持");
		if (localOffset === 0xffffffff || compressedSize === 0xffffffff) throw new Error("zip64 归档不支持，请改用 .exe 安装包");
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		let data;
		if (method === 0) data = raw;
		else if (method === 8) data = inflateRawSync(raw);
		else throw new Error(`不支持的 zip 压缩方式 ${method}（${name}）`);
		const target = safeTarget(destDir, name);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
		written.push(target);
	}
	return written;
}

function findFileRecursive(root, name, depth = 0) {
	const direct = join(root, name);
	if (isFile(direct)) return direct;
	if (depth >= 3) return undefined;
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const found = findFileRecursive(join(root, entry.name), name, depth + 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * Release zips wrap everything in a versioned folder. Move the payload up so
 * `<LOCALAPPDATA>\Programs\OpenSCAD\openscad.exe` is the real layout — which is
 * exactly where core/openscad.js looks. Exported for tests.
 */
export function flattenInstallDir(destDir) {
	if (isFile(join(destDir, "openscad.exe"))) return destDir;
	const found = findFileRecursive(destDir, "openscad.exe");
	if (found === undefined) throw new Error("解压完成但里面没有 openscad.exe");
	const inner = dirname(found);
	if (resolve(inner) !== resolve(destDir)) {
		for (const entry of readdirSync(inner)) {
			const from = join(inner, entry);
			const to = join(destDir, entry);
			rmSync(to, { recursive: true, force: true });
			renameSync(from, to);
		}
		rmSync(inner, { recursive: true, force: true });
	}
	return destDir;
}

/** Try to resolve OpenSCAD, swallowing the "not installed" error. */
async function tryResolve(driver, exec) {
	try {
		return await driver.resolve(exec);
	} catch {
		return undefined;
	}
}

/** Trim a detector result down to the fields the tools advertise. */
function verifyOf(result) {
	return {
		found: result?.found === true,
		runnable: result?.runnable === true,
		...(result?.path !== undefined ? { path: result.path } : {}),
		...(typeof result?.version === "string" && result.version.length > 0 ? { version: result.version } : {}),
		...(result?.source !== undefined ? { source: result.source } : {})
	};
}

/** What an install *would* run, for a dry-run plan. */
function describeCommand(source, asset) {
	if (source.kind === "package-manager") return source.pretty ?? source.label;
	const unresolved = source.kind === "mirror" ? `${source.prefix} + GitHub releases 最新 Windows 资产（运行时解析）` : "GitHub releases 最新 Windows 资产（运行时解析）";
	const url = asset === undefined ? unresolved : source.kind === "mirror" ? `${source.prefix}${asset.url}` : asset.url;
	return `下载 ${url} 到临时目录；.exe → 静默安装（NSIS /S，失败再试 --silent）；.zip → 解压到 ${zipInstallDir()}`;
}

/**
 * Install OpenSCAD. With `confirm !== true` this only returns a plan.
 * @param {{proc: object, settings: object, exec?: object, sourceId?: string,
 *          confirm?: boolean, openscad?: object}} options
 * @returns {Promise<{installed: boolean, dryRun: boolean, sourceId: string, command: string,
 *          steps: Array<{step: string, ok: boolean, detail: string}>, verify: object,
 *          message: string, hint: string, nextSteps: string[], asset?: object}>}
 */
export async function installOpenscad({ proc, settings = {}, exec, sourceId, confirm, openscad } = {}) {
	const driver = openscad ?? createOpenscad(proc, settings);
	const steps = [];
	const push = (step, ok, detail) => steps.push({ step, ok, detail: String(detail ?? "") });
	const nextSteps = [
		"装好后重跑 print3d_doctor 确认它真的能被发现",
		"然后直接 print3d_render 建模，不需要重启 Harness",
		"装在非默认目录时，把 exe 的完整路径写进插件配置 openscadPath"
	];

	// Already there? Do not touch a working install.
	const existing = await tryResolve(driver, exec);
	if (existing !== undefined) {
		push("检测", true, `已安装：${existing.path}（${existing.version ?? "版本未知"}，来源 ${existing.source}）`);
		if (sourceId !== undefined) push("指定源", false, `收到 source="${sourceId}"，但本机已经装好，不再动系统（免得把好的安装覆盖成坏的）`);
		return {
			installed: true,
			// Nothing was changed, so this stays a dry run whatever `confirm` said.
			dryRun: true,
			sourceId: "already-installed",
			command: "（无需安装）",
			steps,
			verify: verifyOf({ found: true, runnable: true, ...existing }),
			message: "OpenSCAD 已经可用，没有做任何改动。要重装请先手动卸载/挪走现有安装。",
			hint: OPENSCAD_DOWNLOAD_HINT,
			nextSteps: ["直接调用 print3d_render 建模（不需要安装/重启）", "换机或重装时再跑 {\"action\":\"probe\"} 选一个能通的源", "装在非默认目录时把 exe 路径写进插件配置 openscadPath"]
		};
	}

	// Pick a source. A dry-run stays offline and says so; a real install probes.
	let chosen;
	let asset;
	let sourceReason = "";
	if (sourceId !== undefined) {
		const planned = await planInstall({ proc, settings, exec });
		chosen = planned.find((source) => source.id === sourceId);
		if (chosen === undefined) throw new Error(`未知安装源 "${sourceId}"。可选：${planned.map((source) => source.id).join(", ")}`);
		if (chosen.available !== true) {
			throw new Error(`安装源 "${sourceId}" 不可用：${chosen.error ?? "未通过可用性检查"}。改用 {action:"probe"} 看哪几个源通。`);
		}
	} else if (confirm === true) {
		const probe = await probeSources({ proc, settings, exec });
		chosen = probe.sources.find((source) => source.available);
		asset = probe.asset;
		sourceReason = "自动探活后选出";
		push(
			"测活",
			chosen !== undefined,
			probe.sources.map((source) => `${source.id}=${source.available ? `${source.latencyMs ?? "?"}ms` : `不可用(${source.error ?? "?"})`}`).join("；")
		);
		if (chosen === undefined) {
			push("选源", false, "所有源都不可用");
			return {
				installed: false,
				dryRun: false,
				sourceId: "none",
				command: "（无可用源）",
				steps,
				verify: { found: false, runnable: false },
				message: "没有任何安装源可用：本地包管理器没装，GitHub API 与四个镜像也都不通。请按 hint 里的官网链接手动安装。",
				hint: OPENSCAD_DOWNLOAD_HINT,
				nextSteps: ["联网后重试 {action:\"probe\"}", "或手动安装后在配置里写 openscadPath"]
			};
		}
	} else {
		const planned = await planInstall({ proc, settings, exec });
		chosen = planned.find((source) => source.available);
		sourceReason = "计划阶段只按本地可用性排序，未测延迟";
		if (chosen === undefined) throw new Error("本机没有可用的安装源（连 winget/choco/scoop 都没有）。手动装：https://openscad.org/downloads.html");
	}

	if (confirm !== true) {
		push("计划", true, `${chosen.label} — ${chosen.detail}`);
		return {
			installed: false,
			dryRun: true,
			sourceId: chosen.id,
			command: describeCommand(chosen, asset),
			steps,
			verify: { found: false, runnable: false },
			message: `未执行任何安装（dry-run）。${sourceReason === "" ? "" : `${sourceReason}。`}确认要装请调用 {"action":"install","source":"${chosen.id}","confirm":true}；也可以先 {"action":"probe"} 看每个源的延迟。`,
			hint: OPENSCAD_DOWNLOAD_HINT,
			nextSteps
		};
	}

	// Real install: package manager route.
	if (chosen.kind === "package-manager") {
		const argv = chosen.argv;
		if (argv === undefined) throw new Error(`安装源 "${chosen.id}" 没有可执行的命令行（内部错误）`);
		push("执行", true, chosen.pretty ?? argv.join(" "));
		const result = await proc.run(argv, { timeoutMs: Math.max(settings.timeoutMs ?? 300_000, 900_000), maxBytes: 60_000, exec, cwd: safeWorkingDir() });
		const output = tailText(`${result.stdout}\n${result.stderr}`, 10);
		push("包管理器", result.code === 0, `exit ${result.code}${result.timedOut ? "（超时：安装器可能在等 UAC 或网络）" : ""}${output === "" ? "" : `\n${output}`}`);
		// winget exits non-zero for "already installed"; let verification decide.
	} else {
		// Real install: download route.
		if (asset === undefined) {
			try {
				asset = await resolveDownloadAsset({ timeoutMs: 10_000 });
			} catch (error) {
				asset = undefined;
				push("解析下载地址", false, error instanceof Error ? error.message : String(error));
			}
		}
		if (asset === undefined) {
			return {
				installed: false,
				dryRun: false,
				sourceId: chosen.id,
				command: describeCommand(chosen),
				steps,
				verify: { found: false, runnable: false },
				message: "拿不到下载地址（GitHub API 不可达，固定回退地址也没用）。请手动安装。",
				hint: OPENSCAD_DOWNLOAD_HINT,
				nextSteps
			};
		}
		push("解析下载地址", true, `${asset.name}（${asset.tag}，来源 ${asset.resolvedFrom}${asset.reason === undefined ? "" : `；API 失败：${asset.reason}`}）`);
		const url = chosen.kind === "mirror" ? `${chosen.prefix}${asset.url}` : asset.url;
		// The staging copy must live where the sandbox allows writes; %TEMP% is not
		// writable in a workspace-write session, and a failed download there looks
		// like a dead mirror.
		const stageRoot = env("DSH_3DPRINT_STAGE_DIR") ?? tmpdir();
		mkdirSync(stageRoot, { recursive: true });
		const dir = mkdtempSync(join(stageRoot, "dsh-3dprint-install-"));
		const file = join(dir, asset.name);
		const startedAt = Date.now();
		let downloaded;
		try {
			downloaded = await downloadTo(url, file, { timeoutMs: 900_000 });
			push("下载", true, `${downloaded.bytes} 字节，${Date.now() - startedAt} ms，${url}`);
		} catch (error) {
			push("下载", false, `${error instanceof Error ? error.message : String(error)}（源：${url}）`);
			return {
				installed: false,
				dryRun: false,
				sourceId: chosen.id,
				command: describeCommand(chosen, asset),
				steps,
				verify: { found: false, runnable: false },
				asset: { name: asset.name, url, tag: asset.tag, resolvedFrom: asset.resolvedFrom },
				message: "下载失败，没有改动系统。换一个源重试（{\"action\":\"probe\"} 看哪个通），或按 hint 手动装。",
				hint: OPENSCAD_DOWNLOAD_HINT,
				nextSteps
			};
		}

		if (!isZipFile(file) && !isExeFile(file)) {
			push("校验", false, `下载物既不是 zip 也不是 exe（前四字节 ${sniffMagic(file).toString("hex")}），大概率是代理的错误页`);
			return {
				installed: false,
				dryRun: false,
				sourceId: chosen.id,
				command: describeCommand(chosen, asset),
				steps,
				verify: { found: false, runnable: false },
				asset: { name: asset.name, url, tag: asset.tag, resolvedFrom: asset.resolvedFrom },
				message: "这个源返回的不是安装包（镜像错误页）。换源重试。",
				hint: OPENSCAD_DOWNLOAD_HINT,
				nextSteps
			};
		}

		if (isZipFile(file)) {
			const target = zipInstallDir();
			push("解压", true, `→ ${target}`);
			try {
				mkdirSync(target, { recursive: true });
				unzipBuffer(readFileSync(file), target);
				flattenInstallDir(target);
			} catch (error) {
				push("解压", false, error instanceof Error ? error.message : String(error));
				return {
					installed: false,
					dryRun: false,
					sourceId: chosen.id,
					command: describeCommand(chosen, asset),
					steps,
					verify: { found: false, runnable: false },
					asset: { name: asset.name, url, tag: asset.tag, resolvedFrom: asset.resolvedFrom },
					message: `解压失败，${target} 可能不完整。可以手动解压到那里，或改用 .exe 安装包。`,
					hint: OPENSCAD_DOWNLOAD_HINT,
					nextSteps
				};
			}
		} else {
			// NSIS wants /S; Qt-IFW style installers want --silent. Try in that order.
			const attempts = [];
			for (const args of [["/S"], ["--silent"]]) {
				push("运行安装器", true, `${basename(file)} ${args.join(" ")}`);
				const result = await proc.run([file, ...args], { timeoutMs: Math.max(settings.timeoutMs ?? 300_000, 900_000), maxBytes: 40_000, exec, cwd: safeWorkingDir() });
				attempts.push(result);
				push("安装器返回", result.code === 0, `exit ${result.code}（${args.join(" ")}）${result.timedOut ? " 超时" : ""}${result.stderr.trim() === "" ? "" : `\n${tailText(result.stderr, 4)}`}`);
				if (result.code === 0) break;
			}
			if (attempts.every((result) => result.code !== 0)) {
				push("提示", false, "两种静默参数都没返回 0。若是 UAC 被拒，安装器根本没提权；这一步只能在桌面上由你确认。");
			}
		}
	}

	// Verification is the only success criterion.
	driver.reset();
	const verified = await tryResolve(driver, exec);
	if (verified !== undefined) {
		push("验证", true, `${verified.path}（${verified.version ?? "版本未知"}）`);
		return {
			installed: true,
			dryRun: false,
			sourceId: chosen.id,
			command: describeCommand(chosen, asset),
			steps,
			verify: verifyOf({ found: true, runnable: true, ...verified }),
			...(asset !== undefined ? { asset: { name: asset.name, url: chosen.kind === "mirror" ? `${chosen.prefix}${asset.url}` : asset.url, tag: asset.tag, resolvedFrom: asset.resolvedFrom } } : {}),
			message: "OpenSCAD 安装完成并通过版本验证，可以直接建模。",
			hint: OPENSCAD_DOWNLOAD_HINT,
			nextSteps
		};
	}

	push("验证", false, "reset 后仍然 resolve 不到 OpenSCAD");
	return {
		installed: false,
		dryRun: false,
		sourceId: chosen.id,
		command: describeCommand(chosen, asset),
		steps,
		verify: { found: false, runnable: false },
		message: [
			"安装流程跑完了，但 OpenSCAD 仍然无法被解析，所以不认为装成功。",
			`常见原因：UAC 被拒（静默安装到 Program Files 需要提权，这一条我们检测不到）、安装器还在后台跑、或装到了非默认目录。`,
			"下一步：看上面每一步的 exit code；确认没有 UAC 弹窗后重跑 print3d_doctor；手动装则把路径写进 openscadPath。"
		].join(""),
		hint: OPENSCAD_DOWNLOAD_HINT,
		nextSteps: ["重跑 print3d_doctor 看是否已能发现", "手动安装后把 exe 路径写进配置 openscadPath", "用 {action:\"probe\"} 换一个源重试"]
	};
}

/**
 * One winget liveness check for Blender, so `probe` has something to report even
 * though Blender has exactly one automatic route.
 * @param {{proc: object, settings: object, exec?: object}} options
 */
export async function probeBlender({ proc, settings = {}, exec } = {}) {
	const detected = await detectBlender(proc, settings, { exec });
	const manager = await detectManager(proc, BLENDER_MANAGER_SOURCE, exec);
	return {
		detected,
		sources: [
			{
				id: "winget",
				kind: "package-manager",
				label: BLENDER_MANAGER_SOURCE.label,
				detail: BLENDER_MANAGER_SOURCE.detail,
				available: manager.available,
				...(manager.latencyMs !== undefined ? { latencyMs: manager.latencyMs } : {}),
				...(manager.error !== undefined ? { error: manager.error } : {})
			}
		]
	};
}

/**
 * Install Blender through winget. Same confirm gate as OpenSCAD, because Blender
 * is a ~350 MB download that the plugin never needs to render a part.
 * @param {{proc: object, settings: object, exec?: object, confirm?: boolean, sourceId?: string}} options
 */
export async function installBlender({ proc, settings = {}, exec, confirm, sourceId } = {}) {
	const steps = [];
	const push = (step, ok, detail) => steps.push({ step, ok, detail: String(detail ?? "") });
	if (sourceId !== undefined && sourceId !== "winget") throw new Error(`Blender 只支持 winget 安装（source="winget"），收到 "${sourceId}"`);
	const detected = await detectBlender(proc, settings, { exec });
	if (detected.found) {
		push("检测", true, `已安装：${detected.path}（${detected.version ?? "版本未知"}，来源 ${detected.source}）`);
		return {
			installed: true,
			dryRun: confirm !== true,
			sourceId: "winget",
			command: "（无需安装）",
			steps,
			verify: verifyOf(detected),
			message: "Blender 已经可用，没有做任何改动。",
			hint: "Blender 手动下载：https://www.blender.org/download/",
			nextSteps: ["需要转换网格时调用 print3d_blender"]
		};
	}
	const command = BLENDER_MANAGER_SOURCE.pretty;
	if (confirm !== true) {
		const manager = await detectManager(proc, BLENDER_MANAGER_SOURCE, exec);
		push("计划", manager.available, manager.available ? `${command}（winget 可用，${manager.latencyMs ?? "?"} ms）` : `winget 不可用：${manager.error ?? "未知"}`);
		return {
			installed: false,
			dryRun: true,
			sourceId: "winget",
			command,
			steps,
			verify: { found: false, runnable: false },
			message: "Blender 默认只在计划里，不自动安装（约 350 MB，插件渲染不需要它）。要装请显式 confirm=true。",
			hint: "Blender 手动下载：https://www.blender.org/download/",
			nextSteps: ["需要的话再调用 {\"target\":\"blender\",\"action\":\"install\",\"confirm\":true}", "或直接手动安装后重跑 print3d_doctor"]
		};
	}
	const manager = await detectManager(proc, BLENDER_MANAGER_SOURCE, exec);
	if (!manager.available || manager.argv === undefined) {
		throw new Error(`winget 不可用（${manager.error ?? "未知原因"}），无法自动安装 Blender。手动下载：https://www.blender.org/download/`);
	}
	push("执行", true, command);
	const result = await proc.run(manager.argv, { timeoutMs: Math.max(settings.timeoutMs ?? 300_000, 1_800_000), maxBytes: 60_000, exec, cwd: safeWorkingDir() });
	push("winget", result.code === 0, `exit ${result.code}${result.timedOut ? "（超时）" : ""}${result.stdout.trim() === "" ? "" : `\n${tailText(result.stdout, 6)}`}`);
	const verified = await detectBlender(proc, settings, { exec });
	if (verified.found) {
		push("验证", true, `${verified.path}（${verified.version ?? "版本未知"}）`);
		return {
			installed: true,
			dryRun: false,
			sourceId: "winget",
			command,
			steps,
			verify: verifyOf(verified),
			message: "Blender 安装完成并通过版本验证。",
			hint: "Blender 手动下载：https://www.blender.org/download/",
			nextSteps: ["调用 print3d_blender 做格式转换"]
		};
	}
	return {
		installed: false,
		dryRun: false,
		sourceId: "winget",
		command,
		steps,
		verify: { found: false, runnable: false },
		message: "winget 跑完但 Blender 仍无法被发现（可能还在安装、或 UAC 被拒）。重跑 print3d_doctor 确认。",
		hint: "Blender 手动下载：https://www.blender.org/download/",
		nextSteps: ["重跑 print3d_doctor", "手动安装后把 blender.exe 路径写进配置 blenderPath"]
	};
}
