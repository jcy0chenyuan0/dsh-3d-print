/**
 * print3d_selftest — 内置回归自检：真的把标准体渲出来，按期望值判定，再查插件自身状态。
 *
 * 为什么不是"检查文件在不在"：
 *   3D 打印插件的失败模式几乎都发生在**外部程序**上（OpenSCAD 装错版本、参数被 -D
 *   静默忽略、几何退化导致不水密）。只有真渲染 + 真测量才能证明这条链路是通的。
 *   所以自检的判据不是"没报错"，而是"尺寸/体积/水密/悬垂落在设计值里"。
 *
 * 设计约束：
 *   - 一个体崩了不能带走其它体：逐个 try/catch，最后汇总。
 *   - 默认只跑 5 个核心体（10 个全跑要十几分钟）；全量必须显式 `id: "all"`。
 *   - 每个体有自己的渲染超时（默认 settings.renderTimeoutMs = 10 分钟），
 *     慢机器不会把整轮自检卡死在一个体上。
 *   - 失败必须给**可执行的下一步**，不是只报 ✗。
 */
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import * as report from "../core/report.js";
import * as catalogue from "../core/parts.js";

const DESCRIPTION = `内置回归自检（OpenSCAD 真渲染 + 形状判定 + 插件状态），一条命令回答"这套插件在这台机器上还能用吗"。

会做三件事：
1. 逐个**真实渲染**标准体（默认 5 个核心体：calibration-cube、flow-wall、overhang-stairs、
   bridge-test、tolerance-gauge），量尺寸/体积/水密/悬垂/贴床，对照每个体的 expects 给 ✓/✗
2. 检查插件自身状态：工具注册是否报错、OpenSCAD 能否 resolve、机型预设是否自洽、标准体源码是否齐
3. 汇总通过率，并对每条失败给出可执行的下一步

用法：
- {"id":"calibration-cube"}：只查一个体（改完某个 .scad 之后最快的回归）
- {}（默认）：5 个核心体，约 1–2 分钟
- {"id":"all"}：全部 10 个标准体，约 5–10 分钟（渲染很慢，别在交互里随便跑）
- {"preview":true}：额外渲 PNG 预览；{"keepArtifacts":true}：留下 STL/PNG（默认清掉）

允许部分失败：一个体崩了不影响其它体，最后仍给出完整汇总。渲染超时用 timeoutMs 调（默认 600000/个体）。`;

export function create(shared) {
	const { settings, paths, openscad, printers, errors } = shared;

	/** 选要跑哪些体：单个 id / "all" / 默认核心 5 个。 */
	function selectParts(args) {
		if (typeof args.id === "string" && args.id.trim().length > 0) {
			const raw = args.id.trim();
			if (raw.toLowerCase() === "all") return { selection: "all", parts: catalogue.listParts() };
			return { selection: "single", parts: [catalogue.getPart(raw)] };
		}
		return { selection: "core", parts: catalogue.CORE_PART_IDS.map((id) => catalogue.getPart(id)) };
	}

	/**
	 * 插件自身状态：注册错误、OpenSCAD 可解析、机型预设自洽、标准体源码齐全。
	 * 每一项都单独成条，不给"整体 OK/不 OK"的含糊结论。
	 */
	async function checkPlugin(exec) {
		const registration = {
			ok: errors.length === 0,
			errors: [...errors]
		};

		let openscadState;
		try {
			const resolved = await openscad.resolve(exec);
			openscadState = {
				ok: true,
				path: resolved.path,
				version: resolved.version ?? "",
				source: resolved.source
			};
		} catch (error) {
			openscadState = {
				ok: false,
				path: "",
				version: "",
				source: "",
				reason: error instanceof Error ? error.message : String(error)
			};
		}

		const presets = printers.listPrinters();
		const problems = [];
		for (const printer of presets) {
			const bed = printer.bed ?? {};
			if (![bed.x, bed.y, bed.z].every((value) => Number.isFinite(value) && value > 0)) {
				problems.push(`${printer.id}: bed 必须是三个正数，实际 ${JSON.stringify(bed)}`);
			}
			if (!(Number.isFinite(printer.nozzle) && printer.nozzle > 0)) {
				problems.push(`${printer.id}: nozzle 必须是正数，实际 ${JSON.stringify(printer.nozzle)}`);
			}
		}
		try {
			printers.resolvePrinter(undefined, settings.printer);
		} catch (error) {
			problems.push(`默认机型 "${settings.printer}" 解析失败：${error instanceof Error ? error.message : String(error)}`);
		}

		const missing = [];
		for (const part of catalogue.listParts()) {
			try {
				if (statSync(catalogue.partPath(part.id)).size === 0) missing.push(`${part.id}: 源码是空文件`);
			} catch {
				missing.push(`${part.id}: 找不到 assets/parts/${part.scadFile}`);
			}
		}

		return {
			registration,
			openscad: openscadState,
			printers: { ok: problems.length === 0, count: presets.length, defaultPrinter: settings.printer, problems },
			catalogue: { ok: missing.length === 0, count: catalogue.listParts().length, missing }
		};
	}

	/** 渲染 + 判定一个体；任何异常都收进结果，不向外抛。 */
	async function runPart(part, args, exec, dir) {
		const output = join(dir, `${part.id}.stl`);
		const startedAt = Date.now();
		try {
			const result = await catalogue.exportPart(openscad, part, {
				output,
				exec,
				printer: printers.resolvePrinter(undefined, settings.printer),
				overhangDeg: settings.overhangDeg,
				bedEps: settings.bedEps,
				timeoutMs: args.timeoutMs ?? settings.renderTimeoutMs
			});
			let preview;
			if (args.preview === true) {
				const previewPath = join(dir, `${part.id}.png`);
				try {
					await openscad.preview({
						source: catalogue.partPath(part.id),
						output: previewPath,
						exec,
						timeoutMs: args.timeoutMs ?? settings.renderTimeoutMs
					});
					preview = previewPath;
				} catch {
					// 预览失败不影响判定结论：STL 已经渲出来并量过了
					preview = undefined;
				}
			}
			const checks = result.checks.map((check) => ({
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
			const entry = {
				id: part.id,
				name: part.name,
				ok: passed === checks.length,
				elapsedMs: Date.now() - startedAt,
				bytes: result.build.bytes,
				sizeMm: result.measurement.sizeMm,
				volumeCm3: result.measurement.volumeCm3,
				watertight: result.measurement.watertight,
				passed,
				total: checks.length,
				failures,
				checks
			};
			if (args.keepArtifacts === true) {
				if (preview !== undefined) entry.preview = paths.display(exec, preview);
			} else {
				// 默认不落盘：自检的产物是结论，别在用户工作区里堆一堆 STL
				cleanUp(output);
				if (preview !== undefined) cleanUp(preview);
			}
			return entry;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const entry = {
				id: part.id,
				name: part.name,
				ok: false,
				elapsedMs: Date.now() - startedAt,
				bytes: 0,
				sizeMm: [0, 0, 0],
				volumeCm3: 0,
				watertight: false,
				passed: 0,
				total: 0,
				failures: [
					{
						label: "渲染失败",
						actual: reason.split(/\r?\n/u)[0].slice(0, 200),
						expect: "能渲出非空 STL",
						nextStep: `单独复现：print3d_parts {"action":"export","id":"${part.id}"}；若报 OpenSCAD 错误，用 print3d_render 渲染 ${catalogue.partPath(part.id)} 看完整 stderr`
					}
				],
				checks: [],
				error: reason
			};
			if (args.keepArtifacts !== true) cleanUp(output);
			return entry;
		}
	}

	return {
		name: "print3d_selftest",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				id: {
					type: "string",
					description: "只跑一个标准体 id，或 \"all\" 跑全部 10 个。省略 = 5 个核心体。"
				},
				preview: {
					type: "boolean",
					description: "为每个体额外渲染 PNG 预览。默认 false（慢）。"
				},
				keepArtifacts: {
					type: "boolean",
					description: "留下渲染出的 STL/PNG（默认 false：测完即删，只留结论）。排查时设 true。"
				},
				timeoutMs: {
					type: "number",
					description: "每个体的渲染超时毫秒数，默认 600000（10 分钟）。"
				}
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					verdict: { type: "string" },
					ok: { type: "boolean" },
					elapsedMs: { type: "integer" },
					selection: { type: "string" },
					passRate: { type: "number" },
					partsPassed: { type: "integer" },
					partsTotal: { type: "integer" },
					checksPassed: { type: "integer" },
					checksTotal: { type: "integer" },
					plugin: {
						type: "object",
						additionalProperties: false,
						properties: {
							registration: {
								type: "object",
								additionalProperties: false,
								properties: {
									ok: { type: "boolean" },
									errors: { type: "array", items: { type: "string" } }
								},
								required: ["ok", "errors"]
							},
							openscad: {
								type: "object",
								additionalProperties: false,
								properties: {
									ok: { type: "boolean" },
									path: { type: "string" },
									version: { type: "string" },
									source: { type: "string" },
									reason: { type: "string" }
								},
								required: ["ok", "path", "version", "source"]
							},
							printers: {
								type: "object",
								additionalProperties: false,
								properties: {
									ok: { type: "boolean" },
									count: { type: "integer" },
									defaultPrinter: { type: "string" },
									problems: { type: "array", items: { type: "string" } }
								},
								required: ["ok", "count", "defaultPrinter", "problems"]
							},
							catalogue: {
								type: "object",
								additionalProperties: false,
								properties: {
									ok: { type: "boolean" },
									count: { type: "integer" },
									missing: { type: "array", items: { type: "string" } }
								},
								required: ["ok", "count", "missing"]
							}
						},
						required: ["registration", "openscad", "printers", "catalogue"]
					},
					parts: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								name: { type: "string" },
								ok: { type: "boolean" },
								elapsedMs: { type: "integer" },
								bytes: { type: "integer" },
								sizeMm: { type: "array", items: { type: "number" } },
								volumeCm3: { type: "number" },
								watertight: { type: "boolean" },
								passed: { type: "integer" },
								total: { type: "integer" },
								preview: { type: "string" },
								error: { type: "string" },
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
								}
							},
							required: ["id", "name", "ok", "passed", "total", "failures"]
						}
					},
					nextSteps: { type: "array", items: { type: "string" } },
					artifacts: { type: "string" }
				},
				required: ["verdict", "ok", "parts"]
			},
			render: (_args, value) => [report.text(renderSummary(value))]
		},
		async execute(args, exec) {
			const startedAt = Date.now();
			const { selection, parts } = selectParts(args);
			const dir = paths.out(exec, "selftest");
			const plugin = await checkPlugin(exec);
			const results = [];
			for (const part of parts) {
				// 串行：OpenSCAD 是 CPU 密集型，并发只会让每个体都变慢且更容易超时
				results.push(await runPart(part, args, exec, dir));
			}

			const partsPassed = results.filter((entry) => entry.ok).length;
			const checksPassed = results.reduce((sum, entry) => sum + entry.passed, 0);
			const checksTotal = results.reduce((sum, entry) => sum + entry.total, 0);
			const pluginOk = plugin.registration.ok && plugin.openscad.ok && plugin.printers.ok && plugin.catalogue.ok;
			const ok = pluginOk && partsPassed === results.length;
			const passRate = results.length === 0 ? 0 : Math.round((1000 * partsPassed) / results.length) / 10;
			const elapsedMs = Date.now() - startedAt;
			const nextSteps = buildNextSteps(plugin, results, selection);

			return {
				verdict:
					partsPassed === results.length && pluginOk
						? `✓ 自检通过：${results.length}/${results.length} 个标准体、${checksPassed}/${checksTotal} 项判定（${(elapsedMs / 1000).toFixed(1)} s）`
						: `✗ 自检未通过：${partsPassed}/${results.length} 个标准体、${checksPassed}/${checksTotal} 项判定（${(elapsedMs / 1000).toFixed(1)} s）`,
				ok,
				elapsedMs,
				selection,
				passRate,
				partsPassed,
				partsTotal: results.length,
				checksPassed,
				checksTotal,
				plugin,
				parts: results,
				nextSteps,
				...(args.keepArtifacts === true ? { artifacts: paths.display(exec, dir) } : {})
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `回归自检${typeof args.id === "string" ? ` · ${args.id}` : ""}`,
			kind: "execute",
			rawInput: { id: args.id }
		})
	};
}

/** 测完就删：自检的产物是结论，不是文件。删不掉也不该让自检失败。 */
function cleanUp(file) {
	try {
		rmSync(file, { force: true });
	} catch {
		/* 文件被占用 / 权限问题：不影响结论 */
	}
}

/** 把插件状态和逐体失败翻译成"下一步做什么"。 */
function buildNextSteps(plugin, results, selection) {
	const steps = [];
	if (!plugin.registration.ok) {
		steps.push(
			`有 ${plugin.registration.errors.length} 个工具注册失败（${plugin.registration.errors[0]}）：看 Harness 控制台里 [dsh-3d-print] tool registration failed 的完整堆栈，通常是某个 tools/*.js 的 output.schema 不合法`
		);
	}
	if (!plugin.openscad.ok) {
		steps.push(`OpenSCAD 不可用（${plugin.openscad.reason ?? "原因未知"}）：调 print3d_setup 自动安装，或在插件配置的 openscadPath 写绝对路径`);
	}
	if (!plugin.printers.ok) {
		steps.push(`机型预设不自洽（${plugin.printers.problems[0] ?? ""}）：改 lib/core/printers.js 里对应机型的 bed.x/y/z 与 nozzle`);
	}
	if (!plugin.catalogue.ok) {
		steps.push(`标准体源码不全（${plugin.catalogue.missing[0] ?? ""}）：确认插件打包包含 assets/**，或重新签出仓库`);
	}
	// OpenSCAD / 机型这两个根因出问题时，逐体的"渲染失败"全是同一个原因，
	// 再列 10 遍只是噪音；根因已经在上面的插件状态里单独说了
	if (plugin.openscad.ok && plugin.printers.ok) {
		for (const entry of results) {
			for (const failure of entry.failures) {
				steps.push(`${entry.id} · ${failure.label}：${failure.nextStep}`);
			}
		}
	}
	if (steps.length === 0) {
		steps.push(
			selection === "all"
				? "全部标准体都跑过了，没有需要处理的问题。改了某个 .scad 之后可以用 {\"id\":\"<该体>\"} 只回归那一个。"
				: `没有需要处理的问题。想覆盖全部 ${catalogue.listParts().length} 个体跑一遍：print3d_selftest {"id":"all"}`
		);
	}
	return steps;
}

function renderSummary(value) {
	const plugin = value.plugin;
	const status = (ok) => (ok ? "✓" : "✗");
	const lines = [
		`**内置回归自检** — ${value.verdict}`,
		"",
		report.table(
			["插件状态", "结果", "细节"],
			[
				["工具注册", status(plugin.registration.ok), plugin.registration.ok ? "全部注册成功" : plugin.registration.errors.join("; ")],
				["OpenSCAD", status(plugin.openscad.ok), plugin.openscad.ok ? `${plugin.openscad.version || "已找到"}（${plugin.openscad.source}）${plugin.openscad.path}` : plugin.openscad.reason ?? ""],
				["机型预设", status(plugin.printers.ok), `${plugin.printers.count} 个机型，默认 ${plugin.printers.defaultPrinter}${plugin.printers.problems.length > 0 ? `；${plugin.printers.problems.join("；")}` : "，bed 与 nozzle 均有效"}`],
				["标准体源码", status(plugin.catalogue.ok), plugin.catalogue.ok ? `${plugin.catalogue.count} 个都在` : plugin.catalogue.missing.join("；")]
			]
		),
		"",
		report.table(
			["标准体", "结果", "判定", "尺寸 (mm)", "体积", "耗时", "说明"],
			value.parts.map((entry) => [
				entry.ok ? `**${entry.id}**` : entry.id,
				entry.ok ? "✓" : "✗",
				entry.total === 0 ? "—" : `${entry.passed}/${entry.total}`,
				entry.total === 0 ? "—" : entry.sizeMm.map((size) => size.toFixed(2)).join(" × "),
				entry.total === 0 ? "—" : report.cm3(entry.volumeCm3),
				`${(entry.elapsedMs / 1000).toFixed(1)} s`,
				entry.error !== undefined ? "渲染失败" : entry.ok ? "全部达标" : `${entry.total - entry.passed} 项不达标`
			])
		),
		"",
		`通过率 **${value.passRate}%**（${value.partsPassed}/${value.partsTotal} 个体、${value.checksPassed}/${value.checksTotal} 项判定，共 ${(value.elapsedMs / 1000).toFixed(1)} s）`
	];
	const failing = value.parts.filter((entry) => !entry.ok);
	if (failing.length > 0) {
		lines.push("", "不达标的体：");
		for (const entry of failing) {
			lines.push("", `**${entry.id}** — ${entry.name}`);
			for (const failure of entry.failures) {
				lines.push(`- ✗ ${failure.label}：实测 ${failure.actual}，期望 ${failure.expect}`, `  - → ${failure.nextStep}`);
			}
		}
	}
	if (value.nextSteps.length > 0) {
		lines.push("", "下一步：", ...value.nextSteps.map((step) => `- ${step}`));
	}
	if (value.artifacts !== undefined) lines.push("", `产物保留在 \`${value.artifacts}\``);
	return lines.join("\n");
}
