/**
 * Printer preset → slicer process parameters.
 *
 * Why this shape:
 *
 * - `core/printers.js` describes a *machine* (bed, nozzle, vendor family). A
 *   slicer needs a *process* (layer height, walls, infill, temperatures), and
 *   every family accepts that process in a different place: CuraEngine takes
 *   `-s key=value` overrides, PrusaSlicer/OrcaSlicer take `--load <ini>` preset
 *   files, and Creality Print takes `--load-settings "machine;process"` JSON
 *   presets from its own install tree.
 *
 * - The rule here is "never invent a switch". This module only emits arguments
 *   whose flag was either probed from the binary (`hints.flags`) or is part of
 *   the dialect we verified end-to-end. Everything else — nozzle diameter,
 *   filament temperature, which machine profile is selected — is written into
 *   `manual`, because those are choices only the user can confirm against the
 *   physical machine.
 *
 * - Preset *names* are vendor data, not plugin data: Creality Print ships
 *   `Creality Hi 0.4 nozzle.json` / `0.20mm Standard @Creality Hi 0.4 nozzle.json`
 *   under `<install>/resources/profiles/Creality/`. Discovery therefore reads
 *   the install tree instead of hard-coding a table that goes stale with the
 *   next slicer release.
 *
 * Zero npm dependencies, plain ESM, filesystem-read only.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** The conservative PLA baseline every family starts from. */
export const CONSERVATIVE = {
	layerHeight: 0.2,
	walls: 3,
	infill: 15,
	infillPattern: "gyroid",
	nozzleTemp: 205,
	bedTemp: 60,
	material: "PLA"
};

/** Nozzle-derived default layer height, used when the caller passes nothing. */
function defaultLayerHeight(nozzle) {
	if (!Number.isFinite(nozzle) || nozzle <= 0) return CONSERVATIVE.layerHeight;
	return Number((nozzle * 0.5).toFixed(2));
}

/** Clamp a numeric override to something a 0.4 mm machine can actually print. */
function numberOr(value, fallback, { min, max }) {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(value, min), max);
}

/** Immediate subdirectories of `root`, name-sorted. Never throws. */
function subdirs(root) {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/** Files inside `dir` with one of `extensions`. Never throws. */
function filesWith(dir, extensions) {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.filter((name) => extensions.includes(extname(name).toLowerCase()))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	} catch {
		return [];
	}
}

/**
 * Pick the file whose stem contains `needle` (case-insensitive).
 * `${name} ${nozzle} nozzle` is a strong enough discriminator that
 * "Creality Ender-5" cannot match "Creality Ender-5 Max".
 */
function findPreset(names, needle) {
	const lower = needle.toLowerCase();
	return names.find((name) => name.toLowerCase().includes(lower));
}

/** Numeric prefix of a process preset, e.g. "0.20mm Standard @…" → 0.2. */
function layerOf(name) {
	const match = String(name).match(/^(\d+(?:\.\d+)?)\s*mm/iu);
	return match === undefined || match === null ? undefined : Number(match[1]);
}

/**
 * Discover the vendor preset files that ship next to a slicer executable.
 *
 * Layout differs by vendor but is stable within a vendor:
 *   <install>/resources/profiles/<Vendor>/{machine,process,filament}/*.json
 *
 * @param {string} exe - slicer executable path
 * @param {{name: string, nozzle?: number}} printer - resolved printer preset
 * @param {{nozzle?: number, layerHeight?: number, vendor?: string}} [hints]
 * @returns {{root?: string, vendor?: string, machine?: string, process?: string,
 *   filament?: string, notes: string[]}}
 */
export function discoverPresets(exe, printer, hints = {}) {
	const notes = [];
	const nozzle = hints.nozzle ?? printer.nozzle ?? 0.4;
	const layerHeight = hints.layerHeight ?? defaultLayerHeight(nozzle);
	const profilesRoot = join(dirname(exe), "resources", "profiles");
	if (subdirs(profilesRoot).length > 0) {
		const vendors = subdirs(profilesRoot).filter((vendor) => subdirs(join(profilesRoot, vendor)).includes("machine"));
		const preferred = hints.vendor === undefined ? [] : vendors.filter((vendor) => vendor.toLowerCase() === hints.vendor.toLowerCase());
		for (const vendor of [...preferred, ...vendors.filter((entry) => !preferred.includes(entry))]) {
			const root = join(profilesRoot, vendor);
			const machines = filesWith(join(root, "machine"), [".json", ".ini"]);
			const processes = filesWith(join(root, "process"), [".json", ".ini"]);
			const filaments = filesWith(join(root, "filament"), [".json", ".ini"]);
			const machine = findPreset(machines, `${printer.name} ${nozzle} nozzle`);
			if (machine === undefined) continue;

			const exactProcess = `${layerHeight.toFixed(2)}mm Standard @${printer.name} ${nozzle} nozzle`;
			let process = processes.find((name) => name.toLowerCase().includes(exactProcess.toLowerCase()));
			if (process === undefined) {
				const candidates = processes.filter((name) => name.toLowerCase().includes(`@${printer.name} ${nozzle} nozzle`.toLowerCase()) && /standard/iu.test(name));
				process = candidates.sort((a, b) => Math.abs((layerOf(a) ?? 0) - layerHeight) - Math.abs((layerOf(b) ?? 0) - layerHeight))[0];
				if (process !== undefined) notes.push(`没有 ${layerHeight.toFixed(2)} mm 的标准 process preset，改用最接近的 \`${process}\`。`);
			}
			// Prefer the vendor-neutral "Generic PLA" preset over a branded one: the
			// branded preset carries a specific filament profile (flow, temps) the user
			// may not own.
			const plaPresets = filaments.filter((name) => /pla/iu.test(name));
			const filament = findPreset(plaPresets.filter((name) => /generic/iu.test(name)), `@${printer.name} ${nozzle} nozzle`)
				?? findPreset(plaPresets, `@${printer.name} ${nozzle} nozzle`);
			if (filament === undefined) notes.push(`没有找到 ${printer.name} 的 PLA 耗材 preset：CLI 会用默认耗材参数，温度请在切片器里核对。`);

			return {
				root,
				vendor,
				machine: machine === undefined ? undefined : join(root, "machine", machine),
				process: process === undefined ? undefined : join(root, "process", process),
				filament: filament === undefined ? undefined : join(root, "filament", filament),
				notes
			};
		}
		notes.push(`在 \`${profilesRoot}\` 里没有找到机型 \`${printer.name} ${nozzle} nozzle\` 的 preset，改用 CLI 参数兜底。`);
	}
	return { notes };
}

/**
 * Map a printer preset onto one slicer family's process parameters.
 *
 * @param {{id: string, name: string, family: string, bed: {x: number, y: number, z: number}, nozzle: number}} printer
 * @param {string} family - slicer family ("creality", "orca", "prusa", "cura", …)
 * @param {{nozzle?: number, layerHeight?: number, walls?: number, infill?: number,
 *   flags?: string[], loadSettings?: string[], presets?: {machine?: string, process?: string, filament?: string}}} [hints]
 * @returns {{family: string, keyValues: Record<string, string|number>, args: string[],
 *   notes: string[], manual: string[]}}
 */
export function profileFor(printer, family, hints = {}) {
	const nozzle = numberOr(hints.nozzle ?? printer.nozzle, printer.nozzle ?? 0.4, { min: 0.2, max: 1.2 });
	const layerHeight = numberOr(hints.layerHeight, defaultLayerHeight(nozzle), { min: 0.04, max: 0.8 });
	const walls = Math.round(numberOr(hints.walls, CONSERVATIVE.walls, { min: 0, max: 12 }));
	const infill = Math.round(numberOr(hints.infill, CONSERVATIVE.infill, { min: 0, max: 100 }));
	const flags = Array.isArray(hints.flags) ? hints.flags : [];
	const presets = hints.presets ?? {};
	const loadSettings = Array.isArray(hints.loadSettings) ? hints.loadSettings.filter((value) => typeof value === "string" && value.length > 0) : [];

	const keyValues = {
		material: CONSERVATIVE.material,
		layerHeight,
		walls,
		infill,
		infillPattern: CONSERVATIVE.infillPattern,
		nozzleTemp: CONSERVATIVE.nozzleTemp,
		bedTemp: CONSERVATIVE.bedTemp,
		nozzle,
		bed: `${printer.bed.x}×${printer.bed.y}×${printer.bed.z}`
	};

	const args = [];
	const notes = [];
	const manual = [
		`喷嘴直径 ${nozzle} mm：确认切片器里选的是同一个喷嘴（换过喷嘴就必须改）。`,
		`耗材温度 PLA ${CONSERVATIVE.nozzleTemp}/${CONSERVATIVE.bedTemp} °C 只是保守默认值：按你手里的耗材牌子和环境温度核对。`,
		`机型 profile \`${printer.name}\`：切片器里必须选中同一台机器（床尺寸 ${keyValues.bed} mm），否则起点原点会错。`,
		"支撑开关、brim/raft、首层温度这类跟模型几何相关的项，按 print3d_check 的悬垂结论在切片器里定。"
	];

	if (family === "curaengine" || family === "cura") {
		// CuraEngine is the only family with documented per-key CLI overrides.
		args.push("-s", `layer_height=${layerHeight}`);
		args.push("-s", `wall_line_count=${walls}`);
		args.push("-s", `infill_sparse_density=${infill}`);
		args.push("-s", `infill_pattern=${CONSERVATIVE.infillPattern}`);
		args.push("-s", `material_print_temperature=${CONSERVATIVE.nozzleTemp}`);
		args.push("-s", `material_bed_temperature=${CONSERVATIVE.bedTemp}`);
		args.push("-s", `machine_nozzle_size=${nozzle}`);
		args.push("-s", `machine_width=${printer.bed.x}`);
		args.push("-s", `machine_depth=${printer.bed.y}`);
		args.push("-s", `machine_height=${printer.bed.z}`);
		notes.push("CuraEngine 只能靠 `-s key=value` 覆盖参数；这里给的是键名与 Cura 5.x 一致的最小集合。");
		notes.push("CuraEngine 还需要机器定义 JSON（`-j <definition.json>`，在 Cura 安装目录 resources/definitions 下），缺了它只能用默认机，床尺寸设置会被忽略。");
		if (family === "cura") notes.push("UltiMaker Cura 本体没有可用的 CLI 切片入口，实际调用的是同目录的 CuraEngine。");
		return { family, keyValues, args, notes, manual };
	}

	if (family === "creality") {
		// Verified dialect: `--load-settings "<machine>;<process>"` plus
		// `--load-filaments <filament>`; both are JSON presets from the install tree.
		if (presets.machine !== undefined && presets.process !== undefined) {
			args.push("--load-settings", `${presets.machine};${presets.process}`);
			if (presets.filament !== undefined) args.push("--load-filaments", presets.filament);
			notes.push("机器与 process preset 直接取自 Creality Print 安装目录的 resources/profiles，层高由选中的 process preset 决定（这里要与 layerHeight 一致）。");
			if (layerOf(basename(presets.process)) !== undefined && Math.abs(layerOf(basename(presets.process)) - layerHeight) > 0.001) {
				notes.push(`注意：选中的 process preset 是 ${layerOf(basename(presets.process))} mm，与请求的 ${layerHeight} mm 不一致；以 preset 为准。`);
			}
		} else {
			notes.push("没找到可用的机器/process preset：Creality 的 CLI 必须带 `--load-settings \"<machine.json>;<process.json>\"`，否则会报 \"STL/OBJ slicing requires both machine and process settings\"。");
			notes.push("在 Creality Print 里把机型切到目标机器并导出 preset，或把 preset 路径通过 extraArgs 传进来（`--load-settings`、`--load-filaments`）。");
		}
		return { family, keyValues, args, notes, manual };
	}

	if (family === "prusa" || family === "superslicer") {
		if (loadSettings.length > 0) {
			for (const ini of loadSettings) args.push("--load", ini);
			notes.push("用 `--load <ini>` 应用 preset；多次出现时后者覆盖前者（先机器、后 process）。");
		} else if (flags.includes("--layer-height") && flags.includes("--fill-density") && flags.includes("--perimeters")) {
			// Only when the binary actually advertised these; PrusaSlicer does not.
			args.push("--layer-height", String(layerHeight), "--fill-density", `${infill}%`, "--perimeters", String(walls));
			notes.push("检测到当前版本支持逐项参数开关，已用 --layer-height/--fill-density/--perimeters 覆盖。");
		} else {
			notes.push("PrusaSlicer/SuperSlicer 的命令行**不接受**任意参数覆盖（没有 --layer-height 这类开关），process 只能靠 `--load <ini>` 指定。");
			notes.push("在切片器里存一个 process preset 并导出成 ini，然后用 extraArgs 传 `--load <你的.ini>`；否则会按切片器的默认 profile 切片。");
		}
		return { family, keyValues, args, notes, manual };
	}

	if (family === "orca" || family === "bambu") {
		if (loadSettings.length > 0) {
			for (const ini of loadSettings) args.push("--load", ini);
			notes.push("用 `--load <ini>` 应用 preset；Orca/Bambu 的 `--load` 与 PrusaSlicer 同源。");
		} else if (presets.machine !== undefined && presets.process !== undefined) {
			args.push("--load-settings", `${presets.machine};${presets.process}`);
			notes.push("机器与 process preset 取自安装目录的 resources/profiles；若该版本不认 `--load-settings`，改用 `--load <ini>`。");
		} else {
			notes.push("Orca/Bambu 的 CLI 不会自己挑机器和 process：必须给 `--load <ini>`（或 `--load-settings \"machine;process\"`），否则会报缺少设置或按错误机型切片。");
			notes.push("在 Orca/Bambu 里导出机器 + process preset 的 ini，用 extraArgs 传 `--load` 路径。");
		}
		return { family, keyValues, args, notes, manual };
	}

	notes.push(`家族 "${family}" 没有可用的 CLI 参数化入口；参数请在 GUI 里设。`);
	return { family, keyValues, args, notes, manual };
}
