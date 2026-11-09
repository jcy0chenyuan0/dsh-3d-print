/**
 * print3d_parts — 内置标准测试体库：列目录 / 看判读方法 / 导出 STL 并当场对照期望值。
 *
 * 为什么要有这个工具：
 *   3D 打印的"调好没有"一直是玄学——没有标准体，用户只能凭感觉改切片参数，
 *   改完不知道是变好还是变坏。这里把 10 个标准体连**判据**一起内置：
 *   每个体都知道自己该量成多少，导出后立刻给出 ✓/✗ 和下一步。
 *
 * 三个动作：
 *   list    表格列出全部标准体（id / 名称 / 测什么 / 默认尺寸）
 *   info    单个体的用途、判读方法、可改参数、期望值（参数说明直接从 .scad 的注释读，
 *           保证"源码里写的"和"工具里显示的"是同一份，不会漂移）
 *   export  渲染成 <workspace>/<outDir>/parts/<id>.stl → 测量 → 对照 expects 给 ✓/✗
 *
 * 期望值与注册表在 core/parts.js：print3d_selftest 用的是同一份，不另存一套。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as report from "../core/report.js";
import * as catalogue from "../core/parts.js";

const DESCRIPTION = `内置标准测试体库（calibration / overhang / bridge / tolerance …）：用 OpenSCAD 把参数化源码渲成 STL，列目录、看判读方法、当场对照期望值。

三个动作：
- {"action":"list"}：全部标准体（默认），给 id / 名称 / 测什么 / 默认尺寸
- {"action":"info","id":"overhang-stairs"}：这个体的用途、**怎么判读**、可改参数、期望值
- {"action":"export","id":"calibration-cube"}：真渲染成 STL，量尺寸/体积/水密/悬垂/贴床，
  逐条对照期望值给 ✓/✗；加 "preview":true 顺手出一张 PNG

可用 id：calibration-cube、flow-wall、overhang-stairs、bridge-test、tolerance-gauge、
z-ladder、first-layer-patch、stringing-tower、hole-compensation、fastener-m4。
参数用 "params" 覆盖该体的默认值（例如 {"id":"calibration-cube","params":{"size":30}}），
写错的参数名会被拒绝并列出可用参数——OpenSCAD 对未知 -D 是静默接受的，所以必须在这里拦住。

输出落在 <workspace>/<outDir>/parts/<id>.stl。渲染慢（单体 1–25 s），超时用 timeoutMs 调（默认 10 分钟）。
想把全部体跑一遍做回归：用 print3d_selftest（默认只跑 5 个核心体，全量要 {"id":"all"}）。`;

export function create(shared) {
	const { paths, openscad, settings, printers } = shared;

	/** 渲染一个体并测量，给出可判定的 checks。渲染失败时把"下一步"写进错误里。 */
	async function renderAndCheck(part, args, exec) {
		const dir = paths.out(exec, "parts");
		const output = join(dir, `${part.id}.stl`);
		const printer = printers.resolvePrinter(undefined, settings.printer);
		const startedAt = Date.now();
		let result;
		try {
			result = await catalogue.exportPart(openscad, part, {
				output,
				params: args.params ?? {},
				exec,
				printer,
				overhangDeg: settings.overhangDeg,
				bedEps: settings.bedEps,
				...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {})
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(
				`渲染标准体 ${part.id} 失败：${reason}\n` +
					`下一步：先用 print3d_render 单独渲染这份源码看完整报错（source = ${catalogue.partPath(part.id)}）；` +
					"若报 OpenSCAD 找不到，调 print3d_doctor / print3d_setup。"
			);
		}

		const warnings = [...(result.build.diagnostics ?? [])];
		let preview;
		if (args.preview === true) {
			const previewPath = join(dir, `${part.id}.png`);
			try {
				await openscad.preview({
					source: catalogue.partPath(part.id),
					output: previewPath,
					params: result.params,
					exec,
					...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {})
				});
				preview = paths.display(exec, previewPath);
			} catch (error) {
				warnings.push(`预览渲染失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { dir, output, printer, result, warnings, preview, startedAt };
	}

	/** list：全部标准体一览。 */
	function listAction() {
		const items = catalogue.listParts();
		const core = items.filter((part) => part.core === true).map((part) => part.id);
		return {
			action: "list",
			verdict: `${items.length} 个标准体（核心 ${core.length} 个：${core.join(", ")}）`,
			count: items.length,
			coreIds: core,
			parts: items.map((part) => ({
				id: part.id,
				name: part.name,
				purpose: part.purpose,
				sizeMm: part.sizeMm,
				size: catalogue.formatSize(part.sizeMm),
				core: part.core === true,
				tags: part.tags
			}))
		};
	}

	/** info：一个体的全部"人该知道的东西"，参数说明从源码注释读。 */
	function infoAction(args) {
		if (typeof args.id !== "string" || args.id.trim().length === 0) throw new Error("info 需要 id，例如 {\"action\":\"info\",\"id\":\"overhang-stairs\"}");
		const part = catalogue.getPart(args.id);
		const scadPath = catalogue.partPath(part.id);
		let bytes = 0;
		let comments = new Map();
		try {
			bytes = statSync(scadPath).size;
			comments = readParamComments(scadPath);
		} catch {
			throw new Error(
				`标准体 ${part.id} 的源码读不到：${scadPath}\n下一步：确认 assets/parts/${part.scadFile} 存在（插件打包时漏了 assets/**）`
			);
		}
		return {
			action: "info",
			verdict: `${part.id} — ${part.name}`,
			part: {
				id: part.id,
				name: part.name,
				purpose: part.purpose,
				reading: part.reading,
				scadFile: part.scadFile,
				scadPath,
				scadBytes: bytes,
				sizeMm: part.sizeMm,
				size: catalogue.formatSize(part.sizeMm),
				core: part.core === true,
				tags: part.tags,
				defaults: { ...part.defaults }
			},
			params: Object.keys(part.defaults).map((name) => ({
				name,
				value: String(part.defaults[name]),
				comment: comments.get(name) ?? ""
			})),
			expects: Object.entries(part.expects).map(([metric, spec]) => ({
				metric,
				label: spec.label ?? metric,
				expect: catalogue.formatExpect(spec)
			}))
		};
	}

	/** export：真渲染 → 测量 → 逐条对照期望值。 */
	async function exportAction(args, exec) {
		if (typeof args.id !== "string" || args.id.trim().length === 0) throw new Error("export 需要 id，例如 {\"action\":\"export\",\"id\":\"calibration-cube\"}");
		const part = catalogue.getPart(args.id);
		// 参数名/类型错误不是渲染失败：先在这里拦，别把人往 OpenSCAD 排错上带
		catalogue.mergeParams(part, args.params ?? {});
		const run = await renderAndCheck(part, args, exec);
		const checks = run.result.checks.map((check) => ({
			metric: check.metric,
			label: check.label,
			actual: catalogue.formatActual(check),
			expect: catalogue.formatCheckExpect(check),
			ok: check.ok
		}));
		const failures = checks
			.filter((check) => !check.ok)
			.map((check) => ({
				label: check.label,
				actual: check.actual,
				expect: check.expect,
				nextStep: catalogue.explainFailure({ metric: check.metric, actual: check.actual })
			}));
		const passed = checks.filter((check) => check.ok).length;
		const total = checks.length;
		const ok = passed === total;
		const measurement = run.result.measurement;
		return {
			action: "export",
			verdict: ok ? `✓ ${part.id}：${total}/${total} 项判定通过` : `✗ ${part.id}：${total - passed} 项不达标（${passed}/${total}）`,
			part: {
				id: part.id,
				name: part.name,
				purpose: part.purpose,
				reading: part.reading,
				scadFile: part.scadFile,
				scadPath: catalogue.partPath(part.id),
				sizeMm: part.sizeMm,
				size: catalogue.formatSize(part.sizeMm),
				core: part.core === true,
				tags: part.tags,
				defaults: { ...part.defaults }
			},
			params: buildParamList(part, run.result.params),
			file: paths.display(exec, run.output),
			absolutePath: run.output,
			...(run.preview !== undefined ? { preview: run.preview } : {}),
			bytes: run.result.build.bytes,
			elapsedMs: Date.now() - run.startedAt,
			printer: run.printer.name,
			measurement: {
				sizeMm: measurement.sizeMm,
				volumeCm3: measurement.volumeCm3,
				areaCm2: measurement.areaCm2,
				triangles: measurement.triangles,
				shells: measurement.shells,
				watertight: measurement.watertight,
				overhangCm2: measurement.overhangCm2,
				overhangPercent: measurement.overhangPercent,
				flatBottomCm2: measurement.flatBottomCm2,
				meanThicknessMm: measurement.meanThicknessMm,
				minZm: measurement.minZm,
				fitsBed: measurement.fitsBed === true,
				bedName: measurement.bedName ?? run.printer.name
			},
			checks,
			failures,
			passed,
			total,
			ok,
			warnings: run.warnings
		};
	}

	return {
		name: "print3d_parts",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: {
					type: "string",
					enum: ["list", "info", "export"],
					description: "list = 列目录（默认）；info = 单个体的用途/判读/参数/期望值；export = 渲染成 STL 并对照期望值。"
				},
				id: {
					type: "string",
					description: "标准体 id（list 不需要；info/export 必填），例如 \"calibration-cube\"、\"overhang-stairs\"。"
				},
				params: {
					type: "object",
					additionalProperties: {
						oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }]
					},
					description: "覆盖该体的默认参数，例如 {\"size\":30} 或 {\"angle_6\":65}。只接受该体声明过的参数名。"
				},
				preview: {
					type: "boolean",
					description: "export 时顺便渲一张 PNG 预览。默认 false。"
				},
				timeoutMs: {
					type: "number",
					description: "渲染超时毫秒数，默认 600000（10 分钟）。"
				}
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string" },
					verdict: { type: "string" },
					count: { type: "integer" },
					coreIds: { type: "array", items: { type: "string" } },
					parts: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								name: { type: "string" },
								purpose: { type: "string" },
								sizeMm: { type: "array", items: { type: "number" } },
								size: { type: "string" },
								core: { type: "boolean" },
								tags: { type: "array", items: { type: "string" } }
							},
							required: ["id", "name", "purpose", "size"]
						}
					},
					part: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: { type: "string" },
							name: { type: "string" },
							purpose: { type: "string" },
							reading: { type: "string" },
							scadFile: { type: "string" },
							scadPath: { type: "string" },
							scadBytes: { type: "integer" },
							sizeMm: { type: "array", items: { type: "number" } },
							size: { type: "string" },
							core: { type: "boolean" },
							tags: { type: "array", items: { type: "string" } },
							defaults: {
								type: "object",
								// The output-schema dialect requires a boolean here; a parameter
								// schema allows the object form, an output schema does not.
								additionalProperties: true
							}
						},
						required: ["id", "name", "purpose", "reading", "scadFile"]
					},
					params: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string" },
								value: { type: "string" },
								comment: { type: "string" }
							},
							required: ["name", "value"]
						}
					},
					expects: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								metric: { type: "string" },
								label: { type: "string" },
								expect: { type: "string" }
							},
							required: ["metric", "label", "expect"]
						}
					},
					file: { type: "string" },
					absolutePath: { type: "string" },
					preview: { type: "string" },
					bytes: { type: "integer" },
					elapsedMs: { type: "integer" },
					printer: { type: "string" },
					measurement: {
						type: "object",
						additionalProperties: false,
						properties: {
							sizeMm: { type: "array", items: { type: "number" } },
							volumeCm3: { type: "number" },
							areaCm2: { type: "number" },
							triangles: { type: "integer" },
							shells: { type: "integer" },
							watertight: { type: "boolean" },
							overhangCm2: { type: "number" },
							overhangPercent: { type: "number" },
							flatBottomCm2: { type: "number" },
							meanThicknessMm: { type: "number" },
							minZm: { type: "number" },
							fitsBed: { type: "boolean" },
							bedName: { type: "string" }
						},
						required: ["sizeMm", "volumeCm3", "triangles", "watertight"]
					},
					checks: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								metric: { type: "string" },
								label: { type: "string" },
								actual: { type: "string" },
								expect: { type: "string" },
								ok: { type: "boolean" }
							},
							required: ["metric", "label", "actual", "expect", "ok"]
						}
					},
					failures: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								label: { type: "string" },
								actual: { type: "string" },
								expect: { type: "string" },
								nextStep: { type: "string" }
							},
							required: ["label", "actual", "expect", "nextStep"]
						}
					},
					passed: { type: "integer" },
					total: { type: "integer" },
					ok: { type: "boolean" },
					warnings: { type: "array", items: { type: "string" } }
				},
				required: ["action", "verdict"]
			},
			render: (_args, value) => [report.text(renderValue(value))]
		},
		async execute(args, exec) {
			const action = String(args.action ?? "list").trim().toLowerCase();
			if (action === "list") return listAction();
			if (action === "info") return infoAction(args);
			if (action === "export") return await exportAction(args, exec);
			throw new Error(`不支持的 action "${action}"，可选：list / info / export`);
		},
		presentCall: (args) => {
			const action = String(args.action ?? "list").toLowerCase();
			return {
				card: "generic",
				title: action === "export" ? `导出标准体 ${args.id ?? ""}`.trim() : action === "info" ? `标准体 ${args.id ?? ""}`.trim() : "标准测试体库",
				kind: action === "export" ? "execute" : "read",
				rawInput: { action, id: args.id }
			};
		}
	};
}

/**
 * 从 .scad 顶层的 `name = value; // 说明` 里读出参数说明。
 * 只当显示用：解析失败不影响渲染，返回空表即可。
 * @param {string} sourcePath
 * @returns {Map<string, string>}
 */
function readParamComments(sourcePath) {
	const map = new Map();
	const text = readFileSync(sourcePath, "utf8");
	for (const raw of text.split(/\r?\n/u)) {
		const line = raw.trim();
		const match = /^([A-Za-z_]\w*)\s*=\s*[^;]+;\s*(?:\/\/\s*(.*))?$/u.exec(line);
		if (match === null) continue;
		const name = match[1];
		if (map.has(name)) continue;
		map.set(name, (match[2] ?? "").trim());
	}
	return map;
}

/** export 里展示实际生效的参数（默认值 + 覆盖）。 */
function buildParamList(part, params) {
	return Object.keys(part.defaults).map((name) => ({
		name,
		value: String(params[name]),
		comment: params[name] === part.defaults[name] ? "" : `（已覆盖默认值 ${String(part.defaults[name])}）`
	}));
}

/** 统一渲染三种 action 的输出。 */
function renderValue(value) {
	if (value.action === "list") return renderList(value);
	if (value.action === "info") return renderInfo(value);
	if (value.action === "export") return renderExport(value);
	return value.verdict ?? "";
}

function renderList(value) {
	const lines = [
		`**内置标准测试体库** — ${value.count} 个，核心 ${value.coreIds.length} 个`,
		"",
		report.table(
			["id", "名称", "测什么", "默认尺寸"],
			value.parts.map((part) => [part.core ? `**${part.id}**` : part.id, part.name, part.purpose, part.size])
		),
		"",
		`核心体（自检默认跑这 ${value.coreIds.length} 个）：${value.coreIds.join(", ")}`,
		"- 看单个体的判读方法：`print3d_parts {\"action\":\"info\",\"id\":\"overhang-stairs\"}`",
		"- 导出并对照期望值：`print3d_parts {\"action\":\"export\",\"id\":\"calibration-cube\"}`（加 `\"preview\":true` 出 PNG）",
		"- 全量回归：`print3d_selftest {\"id\":\"all\"}`"
	];
	return lines.join("\n");
}

function renderInfo(value) {
	const part = value.part;
	const lines = [
		`**${part.id} — ${part.name}**（默认尺寸 ${part.size}${part.core ? "，核心体" : ""}）`,
		"",
		`- **测什么**: ${part.purpose}`,
		`- **判读方法**: ${part.reading}`,
		`- **源码**: \`${part.scadFile}\`（${report.bytes(part.scadBytes)}，插件目录内，可直接改参数重导出）`,
		`- **标签**: ${part.tags.join(", ")}`
	];
	if (value.params.length > 0) {
		lines.push(
			"",
			"可改参数（用 export 的 `params` 覆盖；改完尺寸/体积会变，expects 只对默认值成立）：",
			report.table(
				["参数", "默认", "说明"],
				value.params.map((entry) => [entry.name, entry.value, entry.comment])
			)
		);
	}
	lines.push(
		"",
		"期望值（自检用的判据，`sizeMm[0]` 是包围盒 X）：",
		report.table(
			["指标", "判据"],
			value.expects.map((entry) => [entry.label, entry.expect])
		),
		"",
		`导出：\`print3d_parts {"action":"export","id":"${part.id}"}\``
	);
	return lines.join("\n");
}

function renderExport(value) {
	const m = value.measurement;
	const lines = [
		`**${value.part.id} → ${value.file}** — ${report.bytes(value.bytes)}，${(value.elapsedMs / 1000).toFixed(1)} s（${value.printer}）`,
		"",
		report.table(
			["指标", "实测", "期望", "结果"],
			value.checks.map((check) => [check.label, check.actual, check.expect, check.ok ? "✓" : "✗"])
		),
		"",
		report.table(
			["几何", "值"],
			[
				["包围盒", `${m.sizeMm.map((entry) => entry.toFixed(2)).join(" × ")} mm`],
				["体积", report.cm3(m.volumeCm3)],
				["表面积", report.cm2(m.areaCm2)],
				["三角面 / 实体", `${m.triangles} / ${m.shells}`],
				["水密", m.watertight ? "✓" : "✗"],
				["真悬垂", report.cm2(m.overhangCm2)],
				["贴床面积", report.cm2(m.flatBottomCm2)],
				["床内", m.fitsBed ? `✓ ${m.bedName}` : `✗ ${m.bedName}`]
			]
		),
		"",
		`**${value.verdict}**`
	];
	if (value.failures.length > 0) {
		lines.push("", "不达标的项与下一步：");
		for (const failure of value.failures) {
			lines.push(`- ✗ **${failure.label}**：实测 ${failure.actual}，期望 ${failure.expect}`, `  - → ${failure.nextStep}`);
		}
	}
	if (value.preview !== undefined) lines.push("", `预览图：\`${value.preview}\``);
	for (const warning of value.warnings) lines.push(`- ⚠️ ${warning}`);
	lines.push("", `判读：${value.part.reading}`);
	return lines.join("\n");
}
