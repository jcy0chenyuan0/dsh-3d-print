/**
 * print3d_slice — hand a mesh to a slicer ("printer client" compatibility layer).
 *
 * Why this tool exists in this shape:
 *
 * - Slicing is the one step where "installed" and "usable from the command
 *   line" are different facts. OrcaSlicer, Bambu Studio, PrusaSlicer, Creality
 *   Print and CuraEngine all speak different argv dialects, and a mis-guessed
 *   dialect usually exits 0 while writing nothing. So `action=detect` reports
 *   what each installed binary *actually advertises* (probed, not assumed), and
 *   `action=slice` reports the exact argv it ran plus the real stderr, so a
 *   failure is actionable instead of mysterious.
 *
 * - The printer preset from `core/printers.js` only describes the machine. The
 *   process parameters come from `core/slicer-profiles.js`, which separates
 *   "arguments we pass" from "things only the user can confirm" (nozzle
 *   diameter, filament temperature, which machine profile is selected).
 *
 * - `action=open` exists because several clients (Simplify3D, IdeaMaker,
 *   Creality Print without CLI) can only be driven through their GUI. It hands
 *   the model over and says so plainly, instead of pretending to slice.
 */
import { statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import * as report from "../core/report.js";
import { detectSlicers, pickSlicer, slice as sliceWith, openInGui, SLICER_FAMILIES, INPUT_FORMATS } from "../core/slicers.js";
import { profileFor, discoverPresets } from "../core/slicer-profiles.js";

const ACTIONS = ["detect", "slice", "open"];

/** Vendor profile directory inside a slicer's `resources/profiles` tree. */
const VENDOR_DIR = { creality: "Creality", bambu: "BBL", prusa: "Prusa" };

const DESCRIPTION = `把 STL/3MF 交给本机的切片器（OrcaSlicer、Bambu Studio、PrusaSlicer、SuperSlicer、Creality Print、CuraEngine、Cura），或只做环境探测。

三种动作：
- detect（默认）：列出本机装了哪些切片器，并对每个**实际探测**它的 CLI 能力（读 --help / --cli --help，不猜）。没装的家族也会点名列出。
- slice：真的跑一次 CLI 切片，返回 argv、耗时、产物路径与大小、stderr 摘要；失败给出下一步。
- open：只把模型丢给 GUI 并明确告知"后续参数在切片器里设"，不做参数假设。

参数覆盖（layerHeight / infill / walls / nozzle）按家族翻译：Cura 用 -s key=value，
Creality 用 --load-settings "machine;process"（preset 从安装目录自动找），
Prusa/Orca 只能用 --load <ini>——该家族没有逐项开关，本工具不会硬造。
喷嘴直径、耗材温度、机型 profile 名这三项必须用户在切片器里核对，结果里会单独列出。`;

export function create(shared) {
	const { proc, paths, settings, printers } = shared;

	return {
		name: "print3d_slice",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: {
					type: "string",
					enum: ACTIONS,
					description: "detect = 探测本机切片器（默认）；slice = CLI 切片；open = 把模型交给 GUI。"
				},
				input: {
					type: "string",
					description: "模型路径（相对会话工作区），slice/open 需要。支持 .stl/.obj/.3mf，例如 \"3dprint/hook-rack/hook_rack.stl\"。"
				},
				slicer: {
					type: "string",
					description: "指定切片器：家族名（orca / bambu / creality / prusa / superslicer / cura / curaengine）、可执行文件名，或绝对路径。省略则自动选（优先机型同厂，其次 OrcaSlicer 系）。"
				},
				printer: {
					type: "string",
					description: "机型 id（print3d_doctor 会列出可用值），决定床尺寸与要加载的 preset。省略则用插件配置的默认机型。"
				},
				layerHeight: {
					type: "number",
					description: "层高覆盖（mm）。默认 0.2；Creality/Orca 会以 preset 为准并提示不一致。"
				},
				infill: {
					type: "number",
					description: "填充密度覆盖（%，0–100）。默认 15，图案固定 gyroid。"
				},
				walls: {
					type: "integer",
					description: "墙数覆盖。默认 3。"
				},
				nozzle: {
					type: "number",
					description: "喷嘴直径覆盖（mm）。默认取机型预设；也是挑选 installer preset 的依据。"
				},
				outputDir: {
					type: "string",
					description: "G-code 输出目录（相对会话工作区）。默认 <workspace>/<outDir>/gcode。"
				},
				timeoutMs: {
					type: "number",
					description: "切片超时毫秒数，默认取插件配置的 sliceTimeoutMs（30 分钟）。"
				},
				extraArgs: {
					type: "array",
					items: { type: "string" },
					description: "原样追加给切片器的参数，例如 [\"--load\",\"C:\\\\presets\\\\hi_0.4.ini\"]。Prusa/Orca 靠它传 preset。"
				}
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string", enum: ACTIONS },
					ok: { type: "boolean" },
					detected: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								family: { type: "string" },
								name: { type: "string" },
								exe: { type: "string" },
								version: { type: "string" },
								cli: { type: "boolean" },
								exports: { type: "array", items: { type: "string" } },
								flags: { type: "array", items: { type: "string" } },
								configRoot: { type: "string" },
								notes: { type: "array", items: { type: "string" } }
							},
							required: ["id", "name", "exe", "cli"]
						}
					},
					missing: { type: "array", items: { type: "string" } },
					selected: { type: "string" },
					slicer: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: { type: "string" },
							name: { type: "string" },
							family: { type: "string" },
							exe: { type: "string" },
							version: { type: "string" },
							cli: { type: "boolean" }
						},
						required: ["name", "family"]
					},
					printer: { type: "string" },
					input: { type: "string" },
					outputDir: { type: "string" },
					output: { type: "string" },
					outputs: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string" },
								bytes: { type: "number" },
								kind: { type: "string" }
							},
							required: ["path", "bytes"]
						}
					},
					bytes: { type: "number" },
					elapsedMs: { type: "number" },
					argv: { type: "array", items: { type: "string" } },
					command: { type: "string" },
					launched: { type: "boolean" },
					profile: {
						type: "object",
						additionalProperties: false,
						properties: {
							family: { type: "string" },
							keyValues: { type: "object", additionalProperties: true },
							args: { type: "array", items: { type: "string" } },
							notes: { type: "array", items: { type: "string" } },
							manual: { type: "array", items: { type: "string" } }
						},
						required: ["family"]
					},
					stderrTail: { type: "array", items: { type: "string" } },
					notes: { type: "array", items: { type: "string" } },
					nextSteps: { type: "array", items: { type: "string" } }
				},
				required: ["action", "ok"]
			},
			render: (_args, value) => [report.text(renderSummary(value))]
		},
		async execute(args, exec) {
			const action = typeof args.action === "string" && ACTIONS.includes(args.action) ? args.action : "detect";
			if (action === "detect") return await runDetect({ proc, exec, settings, printers });
			if (action === "open") return await runOpen({ args, exec, proc, paths, printers, settings });
			return await runSlice({ args, exec, proc, paths, settings, printers });
		},
		presentCall: (args) => ({
			card: "generic",
			title: `切片：${String(args.action ?? "detect")}`,
			kind: "execute",
			rawInput: { input: args.input, slicer: args.slicer, printer: args.printer }
		})
	};
}

/** The default printer, tolerating a broken configured id during detection. */
function safePrinter(printers, settings) {
	try {
		return printers.resolvePrinter(settings.printer, settings.printer);
	} catch {
		return undefined;
	}
}

/** Look up a model file, failing with a path the user can see and fix. */
function resolveInput(paths, exec, requested) {
	if (typeof requested !== "string" || requested.trim().length === 0) throw new Error("input 必须是非空字符串（相对会话工作区的模型路径）");
	const absolute = paths.inside(exec, requested);
	let size;
	try {
		size = statSync(absolute).size;
	} catch {
		throw new Error(`找不到模型文件：${requested}（相对会话工作区 ${paths.workspaceOf(exec)}）`);
	}
	if (size === 0) throw new Error(`模型文件是空的：${requested}`);
	const extension = extname(absolute).toLowerCase();
	if (!INPUT_FORMATS.includes(extension)) {
		throw new Error(`切片器只吃 ${INPUT_FORMATS.join("/")}，收到 ${extension || "(无扩展名)"}；先用 print3d_render 或 Blender 转成 STL。`);
	}
	return absolute;
}

/** Turn a detection entry into the flat row the tool's schema promises. */
function detectRow(slicer) {
	return {
		id: slicer.id,
		family: slicer.family,
		name: slicer.name,
		exe: slicer.exe,
		version: slicer.version,
		cli: slicer.aware.cli === true,
		exports: slicer.aware.exportFormats ?? [],
		flags: slicer.aware.flags ?? [],
		configRoot: slicer.configRoot,
		notes: slicer.notes ?? []
	};
}

/** ANSI-free, bounded few lines of process stderr, newest last. */
function stderrTail(text, lines = 10) {
	return String(text ?? "")
		.replace(/\r/gu, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(-lines);
}

/** action=detect */
async function runDetect({ proc, exec, settings, printers }) {
	const detected = await detectSlicers(proc, settings, exec);
	const printer = safePrinter(printers, settings);
	const selected = pickSlicer(detected, { vendor: printer?.family });
	const missing = SLICER_FAMILIES
		.filter((family) => !detected.some((slicer) => slicer.id === family.id))
		.map((family) => `${family.name}${family.dialect === "gui" ? "（仅 GUI）" : ""} — 没找到可执行文件`);

	const notes = [];
	const nextSteps = [];
	const cliCapable = detected.filter((slicer) => slicer.aware.cli === true);
	if (detected.length === 0) {
		notes.push("本机没有探测到任何受支持的切片器。");
		nextSteps.push("装一个能 CLI 切片的：OrcaSlicer（推荐，通用）、PrusaSlicer、Bambu Studio，或 Creality Print（有 --cli 方言）。");
		nextSteps.push("装完直接再跑一次 detect；如果装在非标准路径，用 slicer 参数传绝对路径给 action=slice。");
	} else if (cliCapable.length === 0) {
		notes.push("找到了切片器，但没有一个能被命令行驱动；只能用 action=open 交给 GUI。");
		nextSteps.push("用 action=open 打开 GUI 切片，或在切片器设置里确认它带命令行版本（Cura 需要 CuraEngine）。");
	} else {
		notes.push(`可以 CLI 切片：${cliCapable.map((slicer) => slicer.name).join("、")}。`);
		if (selected !== undefined) notes.push(`默认会选 \`${selected.name}\`（机型同族优先，其次 OrcaSlicer 系）。`);
	}
	if (detected.some((slicer) => slicer.aware.cli === true && slicer.family === "creality")) {
		nextSteps.push("Creality Print 的 CLI 是 Bambu 方言（--cli --slice --outputdir --need-gcode-file），不是 Orca 的 -g；本工具已按实测方言调用。");
	}

	return {
		action: "detect",
		ok: detected.length > 0,
		detected: detected.map(detectRow),
		missing,
		selected: selected?.id,
		notes,
		nextSteps
	};
}

/** Guess the family of an explicit executable path. */
function familyOfExecutable(exe) {
	const name = basename(exe).toLowerCase();
	if (name.includes("creality")) return "creality";
	if (name.includes("orca")) return "orca";
	if (name.includes("bambu")) return "bambu";
	if (name.includes("superslicer")) return "superslicer";
	if (name.includes("prusa")) return "prusa";
	if (name.includes("curaengine")) return "curaengine";
	if (name.includes("cura")) return "cura";
	if (name.includes("simplify")) return "simplify3d";
	if (name.includes("idea")) return "ideamaker";
	return undefined;
}

/**
 * Resolve the slicer for slice/open: explicit hint/path first, then detection.
 * @returns {{slicer: object|undefined, detected: Array<object>, error?: string}}
 */
async function resolveSlicer({ args, proc, exec, settings, printers }) {
	const hint = typeof args.slicer === "string" ? args.slicer.trim() : "";
	const looksLikePath = isAbsolute(hint) || hint.includes("/") || hint.includes("\\") || /\.(exe|app)$/iu.test(hint);
	if (looksLikePath) {
		let exists = false;
		try {
			exists = statSync(hint).isFile();
		} catch {
			exists = false;
		}
		if (!exists) return { slicer: undefined, detected: [], error: `指定的可执行文件不存在：${hint}` };
		const family = familyOfExecutable(hint);
		if (family === undefined) {
			return { slicer: undefined, detected: [], error: `认不出可执行文件 "${hint}" 属于哪个家族；slicer 参数里写家族名（orca / creality / prusa / curaengine）更稳。` };
		}
		return {
			slicer: { id: `custom-${family}`, family, name: basename(hint), exe: hint, version: undefined, aware: { cli: true, exportFormats: [], flags: [] }, configRoot: "", notes: [] },
			detected: []
		};
	}

	const detected = await detectSlicers(proc, settings, exec);
	const printer = safePrinter(printers, settings);
	const slicer = pickSlicer(detected, { hint: looksLikePath ? undefined : hint, vendor: printer?.family });
	if (hint.length > 0 && slicer === undefined && !looksLikePath) {
		return {
			slicer: undefined,
			detected,
			error: `指定了 slicer="${hint}"，但本机没有匹配的切片器。已探测到：${detected.map((entry) => `${entry.name}(${entry.family})`).join("、") || "（无）"}`
		};
	}
	return { slicer, detected };
}

/** action=slice */
async function runSlice({ args, exec, proc, paths, settings, printers }) {
	const input = resolveInput(paths, exec, args.input);
	const printer = printers.resolvePrinter(args.printer, settings.printer);
	const nozzle = Number.isFinite(args.nozzle) ? args.nozzle : printer.nozzle;
	const layerHeight = Number.isFinite(args.layerHeight) ? args.layerHeight : Number((nozzle * 0.5).toFixed(2));

	const { slicer, detected, error } = await resolveSlicer({ args, proc, exec, settings, printers });
	if (slicer === undefined) {
		const nextSteps = detected.length === 0
			? ["先跑 action=detect 确认本机装了哪个切片器（要 CLI 切片：OrcaSlicer / PrusaSlicer / Creality Print）。"]
			: ["用 action=detect 看清单，把 slicer 改成其中一个家族名；或 action=open 交给 GUI。"];
		return {
			action: "slice",
			ok: false,
			input: paths.display(exec, input),
			printer: printer.id,
			outputs: [],
			stderrTail: [],
			notes: [error ?? "没有可用的切片器。"],
			nextSteps
		};
	}

	if (slicer.aware.cli !== true) {
		return {
			action: "slice",
			ok: false,
			slicer: { id: slicer.id, name: slicer.name, family: slicer.family, exe: slicer.exe, version: slicer.version, cli: false },
			printer: printer.id,
			input: paths.display(exec, input),
			outputs: [],
			notes: [`${slicer.name} 没有可用的 CLI 切片入口，命令行出不了 G-code。`, ...(slicer.notes ?? [])],
			nextSteps: ["用 action=\"open\" 把模型交给它的 GUI，参数在切片器里设。", "想要无人值守切片：装 OrcaSlicer（或 Creality Print 7.x，它有 --cli）。"]
		};
	}

	// Vendor presets live next to the executable; only the families whose CLI takes
	// preset files need them.
	const presets = ["creality", "bambu", "orca"].includes(slicer.family)
		? discoverPresets(slicer.exe, { name: printer.name, nozzle }, { nozzle, layerHeight, vendor: VENDOR_DIR[slicer.family] })
		: { notes: [] };
	const profile = profileFor(printer, slicer.family, {
		nozzle,
		layerHeight,
		walls: args.walls,
		infill: args.infill,
		flags: slicer.aware.flags ?? [],
		presets
	});

	const outputDir = args.outputDir === undefined || args.outputDir === ""
		? paths.out(exec, "gcode")
		: paths.inside(exec, args.outputDir);

	const result = await sliceWith({
		proc,
		settings,
		exec,
		exe: slicer.exe,
		family: slicer.family,
		input,
		outputDir,
		profile,
		extraArgs: Array.isArray(args.extraArgs) ? args.extraArgs : [],
		timeoutMs: args.timeoutMs ?? settings.sliceTimeoutMs
	});

	const notes = [...(presets.notes ?? []), ...result.notes];
	const nextSteps = [];
	if (!result.ok) {
		const stderrText = result.stderr ?? "";
		if (/requires both machine and process settings|load[_-]settings|Setting file not found/iu.test(stderrText) || profile.args.length === 0) {
			nextSteps.push("缺机器/process preset：在切片器里导出 preset，用 extraArgs 传 `--load <ini>`（Prusa/Orca）或 `--load-settings \"<machine>;<process>\"`（Creality/Bambu）。");
		}
		if (/Unknown file format|No such file|Loading of a model file failed|has the wrong size/iu.test(stderrText)) {
			nextSteps.push("输入文件被拒：确认路径存在、STL 是二进制/ASCII 合法网格（print3d_check 能先验一遍）。");
		}
		if (/Relative extruder addressing|G92 E0/iu.test(stderrText)) {
			nextSteps.push("CLI 在用裸默认配置切片（层间没 G92 E0）：补上 preset，不要指望默认值。");
		}
		if (/timed? ?out/iu.test(stderrText) || result.timedOut === true) {
			nextSteps.push("超时：用 timeoutMs 加长，或先降 $fn / 简化网格（print3d_render 的 $fn 越大切片越慢）。");
		}
		if (nextSteps.length === 0) {
			nextSteps.push("按上面 stderr 改参数；换一个切片器（action=detect 有清单），或 action=open 交给 GUI。");
		}
	}

	const outputs = result.outputs.map((entry) => ({ path: paths.display(exec, entry.path), bytes: entry.bytes, kind: entry.kind }));
	return {
		action: "slice",
		ok: result.ok,
		slicer: {
			id: slicer.id,
			name: slicer.name,
			family: slicer.family,
			exe: slicer.exe,
			version: slicer.version,
			cli: true
		},
		printer: printer.id,
		input: paths.display(exec, input),
		outputDir: paths.display(exec, outputDir),
		output: result.output === undefined ? undefined : paths.display(exec, result.output),
		outputs,
		bytes: result.outputs[0]?.bytes,
		elapsedMs: result.elapsedMs,
		argv: result.argv,
		profile,
		stderrTail: stderrTail(result.stderr),
		notes,
		nextSteps
	};
}

/** action=open */
async function runOpen({ args, exec, proc, paths, printers, settings }) {
	const input = resolveInput(paths, exec, args.input);
	const { slicer, detected } = await resolveSlicer({ args, proc, exec, settings, printers });
	if (slicer === undefined) {
		return {
			action: "open",
			ok: false,
			input: paths.display(exec, input),
			notes: ["没有找到能打开的切片器。"],
			nextSteps: [detected.length === 0 ? "先装一个切片器（OrcaSlicer / PrusaSlicer / Cura / Creality Print），再跑 detect。" : "用 action=detect 看清单后指定 slicer。"]
		};
	}

	const result = await openInGui({ proc, exec, exe: slicer.exe, input });
	return {
		action: "open",
		ok: result.ok,
		launched: result.launched,
		slicer: { id: slicer.id, name: slicer.name, family: slicer.family, exe: slicer.exe, version: slicer.version, cli: slicer.aware?.cli === true },
		input: paths.display(exec, input),
		argv: result.argv,
		command: result.command,
		elapsedMs: result.elapsedMs,
		stderrTail: stderrTail(result.stderr),
		notes: [
			`GUI 已拉起（${slicer.name}）：后续参数——层高、墙数、填充、支撑、耗材温度——都在切片器里设，本工具不替你假装设过。`,
			...result.notes
		],
		nextSteps: ["在切片器里确认机型/喷嘴/耗材，然后导出 G-code 或直接打印；命令行切片改用 action=slice。"]
	};
}

/** Model-facing summary for any of the three actions. */
function renderSummary(value) {
	const lines = [];
	if (value.action === "detect") {
		lines.push(value.ok ? "**切片器探测** —— 找到可用的打印机客户端" : "**切片器探测** —— 没有找到任何切片器");
		if (value.detected.length > 0) {
			lines.push("", report.table(
				["切片器", "家族", "版本", "CLI", "导出", "可执行文件"],
				value.detected.map((entry) => [
					`${entry.name}${value.selected === entry.id ? " ←默认" : ""}`,
					entry.family,
					entry.version ?? "—",
					entry.cli ? "✓" : "✗ GUI",
					entry.exports.length > 0 ? entry.exports.join(" / ") : "—",
					entry.exe
				])
			));
			for (const entry of value.detected) {
				if (entry.notes.length === 0) continue;
				lines.push("", `**${entry.name}**`);
				for (const note of entry.notes) lines.push(`- ${note}`);
			}
		}
		if (value.missing.length > 0) {
			lines.push("", "未装 / 未找到：");
			for (const entry of value.missing) lines.push(`- ${entry}`);
		}
	} else if (value.action === "slice") {
		const slicerName = value.slicer?.name ?? "(未选)";
		const outputs = value.outputs ?? [];
		lines.push(
			value.ok
				? `**切片成功** —— ${slicerName} 出了 ${outputs.length} 个产物`
				: `**切片失败** —— ${slicerName}`,
			"",
			report.table(
				["项", "值"],
				[
					["模型", value.input],
					["切片器", `${slicerName}（${value.slicer?.family ?? "?"}）`],
					["机型", value.printer],
					["耗时", value.elapsedMs === undefined ? undefined : `${(value.elapsedMs / 1000).toFixed(1)} s`],
					["输出目录", value.outputDir],
					["产物", outputs.length === 0 ? "—" : outputs.map((entry) => `${entry.path}（${report.bytes(entry.bytes)}）`).join("<br>")],
					["命令", value.argv === undefined ? undefined : `\`${value.argv.join(" ")}\``]
				]
			)
		);
		if (value.profile !== undefined) {
			const keys = Object.entries(value.profile.keyValues ?? {});
			if (keys.length > 0) {
				lines.push("", "process 参数（key → 值）：", report.table(["项", "值"], keys.map(([key, entryValue]) => [key, String(entryValue)])));
			}
			if ((value.profile.args ?? []).length > 0) {
				lines.push("", `传给 CLI 的参数：\`${value.profile.args.join(" ")}\``);
			}
			for (const note of value.profile.notes ?? []) lines.push(`- ${note}`);
			if ((value.profile.manual ?? []).length > 0) {
				lines.push("", "**必须在切片器里自己确认**（本工具不猜这些）：");
				for (const entry of value.profile.manual) lines.push(`- ${entry}`);
			}
		}
		if ((value.stderrTail ?? []).length > 0) {
			lines.push("", "stderr 尾部：", "```", ...value.stderrTail, "```");
		}
	} else {
		lines.push(
			value.ok ? `**已交给 GUI** —— ${value.slicer?.name ?? "切片器"}` : `**打开失败** —— ${value.slicer?.name ?? "切片器"}`,
			"",
			report.table(
				["项", "值"],
				[
					["模型", value.input],
					["切片器", value.slicer === undefined ? undefined : `${value.slicer.name}（${value.slicer.family}）`],
					["命令", value.command === undefined ? undefined : `\`${value.command}\``],
					["进程", value.launched === true ? "已启动" : "未启动"]
				]
			)
		);
		if ((value.stderrTail ?? []).length > 0) lines.push("", "stderr 尾部：", "```", ...value.stderrTail, "```");
	}

	if ((value.notes ?? []).length > 0) {
		lines.push("", ...value.notes.map((note) => `- ${note}`));
	}
	if ((value.nextSteps ?? []).length > 0) {
		lines.push("", "**下一步**：");
		for (const step of value.nextSteps) lines.push(`- ${step}`);
	}
	return lines.join("\n");
}
