/**
 * print3d_doctor — environment probe.
 *
 * Why one tool instead of implicit failures: every other tool in this plugin is
 * a thin wrapper around an external binary, so "why did nothing work" has one of
 * a handful of answers (no OpenSCAD, no slicer, wrong printer id, a typo in
 * openscadPath). This tool answers all of them in a single call, names the tool
 * to call next, and never throws on a partially equipped machine.
 *
 * Detection itself lives in core/tools-detect.js: the doctor only formats what
 * it gets back, because formatting must not be able to hide a missing binary.
 */
import * as report from "../core/report.js";
import * as detect from "../core/tools-detect.js";

const DESCRIPTION = `体检本机 3D 打印环境：OpenSCAD、Blender、切片器 CLI、插件设置、可用机型，并指出下一步该调哪个工具。

会用到的关键词：OpenSCAD / Blender / slicer / STL / winget。
输出包括：
- OpenSCAD：路径、版本、发现来源（config / PATH / install-root）、能否跑（拿到版本就算能跑）
- Blender：同上（版本取 blender --version 首行，形如 "Blender 4.3.0"）
- 切片器：每个的 family、exe、是否支持命令行切片
- 插件设置生效值：outDir、默认机型、openscadPath、超时
- 缺什么 + 下一步该调哪个工具（例如没 OpenSCAD → print3d_setup）

只在内存里读环境，不修改任何东西。开始建模前先跑一次，比渲染失败再猜要省事。`;

/** The shape returned for OpenSCAD and Blender alike. */
function toolSchema() {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			found: { type: "boolean" },
			runnable: { type: "boolean" },
			path: { type: "string" },
			version: { type: "string" },
			source: { type: "string" },
			reasons: { type: "array", items: { type: "string" } },
			candidates: { type: "array", items: { type: "string" } }
		},
		required: ["found", "runnable", "reasons", "candidates"]
	};
}

export function create(shared) {
	const { settings, proc, printers, openscad } = shared;

	return {
		name: "print3d_doctor",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				verbose: {
					type: "boolean",
					description: "true 时列出每个缺失组件的候选路径（排查 openscadPath 写错时用）。默认 false。"
				}
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					verdict: { type: "string" },
					ready: { type: "boolean" },
					elapsedMs: { type: "integer" },
					openscad: toolSchema(),
					blender: toolSchema(),
					slicers: {
						type: "object",
						additionalProperties: false,
						properties: {
							available: { type: "boolean" },
							source: { type: "string" },
							reason: { type: "string" },
							items: {
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
										note: { type: "string" }
									},
									required: ["id", "family", "cli"]
								}
							}
						},
						required: ["available", "source", "items"]
					},
					settings: {
						type: "object",
						additionalProperties: false,
						properties: {
							outDir: { type: "string" },
							printer: { type: "string" },
							printerName: { type: "string" },
							bedMm: { type: "string" },
							nozzleMm: { type: "number" },
							openscadPath: { type: "string" },
							blenderPath: { type: "string" },
							timeoutMs: { type: "number" },
							renderTimeoutMs: { type: "number" },
							sliceTimeoutMs: { type: "number" },
							overhangDeg: { type: "number" },
							bedEps: { type: "number" },
							autoInstall: { type: "boolean" }
						},
						required: ["outDir", "printer", "printerName", "bedMm", "nozzleMm", "openscadPath", "blenderPath", "timeoutMs", "renderTimeoutMs", "sliceTimeoutMs", "overhangDeg", "bedEps", "autoInstall"]
					},
					printers: { type: "array", items: { type: "string" } },
					nextSteps: { type: "array", items: { type: "string" } }
				},
				required: ["verdict", "ready", "elapsedMs", "openscad", "blender", "slicers", "settings", "printers", "nextSteps"]
			},
			render: (_args, value) => [report.text(renderReport(value))]
		},
		async execute(args, exec) {
			// Validate before doing anything: a boolean typo should fail with a fix.
			if (args.verbose !== undefined && typeof args.verbose !== "boolean") {
				throw new Error(`verbose 必须是布尔值（true/false），收到 ${JSON.stringify(args.verbose)}`);
			}
			const verbose = args.verbose === true;
			const startedAt = Date.now();
			const found = await detect.snapshot(proc, settings, { openscad, exec });
			const printer = printers.resolvePrinter(undefined, settings.printer);
			const printerIds = printers.listPrinters().map((entry) => entry.id);

			const value = {
				verdict: verdictOf(found),
				ready: found.openscad.found === true && found.openscad.runnable === true,
				elapsedMs: Date.now() - startedAt,
				openscad: cleanTool(found.openscad),
				blender: cleanTool(found.blender),
				slicers: {
					available: found.slicers.available === true,
					source: found.slicers.source,
					...(typeof found.slicers.reason === "string" ? { reason: found.slicers.reason } : {}),
					items: found.slicers.items.map((item) => ({
						id: item.id,
						family: item.family,
						...(item.name === undefined ? {} : { name: item.name }),
						...(item.exe === undefined ? {} : { exe: item.exe }),
						...(item.version === undefined ? {} : { version: item.version }),
						cli: item.cli === true,
						...(item.note === undefined ? {} : { note: item.note })
					}))
				},
				settings: {
					outDir: settings.outDir,
					printer: printer.id,
					printerName: printer.name,
					bedMm: `${printer.bed.x}×${printer.bed.y}×${printer.bed.z}`,
					nozzleMm: printer.nozzle,
					openscadPath: settings.openscadPath.length > 0 ? settings.openscadPath : "(自动发现)",
					blenderPath: settings.blenderPath.length > 0 ? settings.blenderPath : "(自动发现)",
					timeoutMs: settings.timeoutMs,
					renderTimeoutMs: settings.renderTimeoutMs,
					sliceTimeoutMs: settings.sliceTimeoutMs,
					overhangDeg: settings.overhangDeg,
					bedEps: settings.bedEps,
					autoInstall: settings.autoInstall === true
				},
				printers: printerIds,
				nextSteps: nextStepsOf(found, verbose)
			};
			return value;
		},
		presentCall: () => ({ card: "generic", title: "3D 打印环境体检", kind: "read", rawInput: {} })
	};
}

/** One-line summary the model reads first. */
function verdictOf(found) {
	const parts = [
		`OpenSCAD ${found.openscad.found ? (found.openscad.runnable ? "✓" : "发现但跑不起来") : "✗"}`,
		`Blender ${found.blender.found ? (found.blender.runnable ? "✓" : "发现但跑不起来") : "✗"}`,
		`切片器 ${found.slicers.available ? `✓ ${found.slicers.items.length} 个` : "✗"}`
	].join(" · ");
	if (found.openscad.found && found.openscad.runnable) return `环境可用：${parts}`;
	return `缺 OpenSCAD，建模类工具暂时都不能用：${parts}`;
}

/** Keep only advertised fields and never emit `undefined`. */
function cleanTool(result) {
	return {
		found: result.found === true,
		runnable: result.runnable === true,
		...(result.path === undefined ? {} : { path: result.path }),
		...(typeof result.version === "string" && result.version.length > 0 ? { version: result.version } : {}),
		...(result.source === undefined ? {} : { source: result.source }),
		reasons: Array.isArray(result.reasons) ? result.reasons.map(String) : [],
		candidates: Array.isArray(result.candidates) ? result.candidates.map(String) : []
	};
}

/** What to call next, in the order that unblocks the most. */
function nextStepsOf(found, verbose) {
	const steps = [];
	if (!found.openscad.found) {
		steps.push('没有 OpenSCAD：**直接 print3d_render 就行**——autoInstall 开着时会自动测活选源并装到工作区的便携目录（不需要提权，也不会卡 UAC）。想先看计划再用 print3d_setup {"action":"probe","target":"openscad"}。');
	} else if (!found.openscad.runnable) {
		steps.push(`OpenSCAD 找到了（${found.openscad.path}）但拿不到版本：路径可能指向坏的/32 位残留，或 openscadPath 配错了。用 {"verbose":true} 看候选路径，改配置或重装。`);
	}
	if (!found.blender.found) {
		steps.push('Blender 缺失（可选）：多数建模用不到它，需要时 print3d_setup {"target":"blender"} 看计划（约 350 MB，不会自动装）。');
	}
	if (!found.slicers.available) {
		steps.push("没发现切片器：装 Creality Print / OrcaSlicer / PrusaSlicer 任一；只要网格和体检结论的话不需要切片器。");
	}
	if (found.openscad.found && found.openscad.runnable) {
		steps.push("可以直接建模：print3d_render {source:\"<你的 .scad>\"} 渲染完会自动体检 STL。");
		steps.push("先确认默认机型对得上：print3d_doctor 的 settings.printer，或渲染/体检时显式传 printer。");
	}
	if (verbose) {
		for (const [label, result] of [["OpenSCAD", found.openscad], ["Blender", found.blender]]) {
			if (!result.found && result.candidates.length > 0) steps.push(`${label} 已检查的候选路径：${result.candidates.join(" | ")}`);
		}
	}
	return steps;
}

/** Markdown report: toolchain, slicers, settings, printers, next steps. */
function renderReport(value) {
	const lines = [
		`**${value.verdict}**`,
		"",
		report.table(
			["组件", "状态", "版本", "路径", "来源"],
			[
				["OpenSCAD", report.mark(value.openscad.found && value.openscad.runnable), value.openscad.version ?? "—", value.openscad.path ?? "—", value.openscad.source ?? "—"],
				["Blender", report.mark(value.blender.found && value.blender.runnable), value.blender.version ?? "—", value.blender.path ?? "—", value.blender.source ?? "—"]
			]
		)
	];
	if (value.openscad.reasons.length > 0) lines.push("", `OpenSCAD 未就绪原因：${value.openscad.reasons.join("；")}`);
	if (value.blender.reasons.length > 0) lines.push("", `Blender 未就绪原因：${value.blender.reasons.join("；")}`);

	lines.push("", "**切片器**");
	if (value.slicers.items.length === 0) {
		lines.push("- 没发现任何切片器 CLI");
	} else {
		lines.push(
			report.table(
				["family", "名称", "exe", "版本", "CLI"],
				value.slicers.items.map((item) => [item.family, item.name ?? item.id, item.exe ?? "—", item.version ?? "—", item.cli ? "✓ 支持" : "✗ 仅 GUI"])
			)
		);
	}
	if (value.slicers.reason !== undefined) lines.push("", `> 来源 ${value.slicers.source}：${value.slicers.reason}`);
	else lines.push("", `> 探测来源：${value.slicers.source}`);
	// Why a slicer is GUI-only is the part that changes a plan, so keep the notes.
	for (const item of value.slicers.items) {
		if (item.note !== undefined) lines.push(`- ${item.family}：${item.note.replace(/\r?\n/gu, " / ")}`);
	}

	lines.push(
		"",
		"**插件设置**",
		report.keyValues([
			["outDir", value.settings.outDir],
			["默认机型", `${value.settings.printer}（${value.settings.printerName}，${value.settings.bedMm} mm，喷嘴 ${value.settings.nozzleMm}）`],
			["openscadPath", value.settings.openscadPath],
			["blenderPath", value.settings.blenderPath],
			["超时", `通用 ${value.settings.timeoutMs} ms / 渲染 ${value.settings.renderTimeoutMs} ms / 切片 ${value.settings.sliceTimeoutMs} ms`],
			["悬垂判据", `${value.settings.overhangDeg}°（贴床容差 ${value.settings.bedEps} mm）`],
			["autoInstall", value.settings.autoInstall ? "开启" : "关闭"]
		]),
		"",
		`**可用机型**（${value.printers.length}）：${value.printers.join(", ")}`,
		"",
		"**下一步**",
		...value.nextSteps.map((step) => `- ${step}`),
		"",
		`探测耗时 ${value.elapsedMs} ms。`
	);
	return lines.join("\n");
}
