/**
 * print3d_check — mesh QA on an existing STL.
 *
 * The interesting number is *real* overhang: a downward-facing surface flatter
 * than 45° from the horizontal. A 48° cantilever peg has none (its underside is
 * steeper than 45°), while a counterbore ceiling or a horizontal bridge has
 * plenty — that distinction is exactly what decides whether supports are
 * needed, and it is the one an inverted test gets wrong.
 */
import { statSync } from "node:fs";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import * as report from "../core/report.js";

const DESCRIPTION = `体检一个 STL：水密性、内外法线、实体数、体积、包围盒、真悬垂、床内适配、最优摆放。

判据说明（容易被搞反，这里写死）：
- 真悬垂 = 朝下且与水平面夹角 < 45° 的面。48° 斜挑的钩臂底面 ≈48°，**不算**悬垂；
  沉孔顶、水平桥、平顶的内腔顶面才算。
- 贴床面（最低 1 mm 内）单独统计，不计入悬垂：那是热床托着的。
- 建议支撑 = 真悬垂 > 5 cm² 或超过表面积 3%。

相对会话工作区给路径即可；需要先建模再查的话直接用 print3d_render（它渲染完会自动体检）。`;

export function create(shared) {
	const { paths, mesh, report, settings, printers } = shared;

	return {
		name: "print3d_check",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "STL 路径（相对会话工作区），例如 \"3dprint/hook-rack/hook_rack.stl\"。"
				},
				printer: {
					type: "string",
					description: "机型 id，用于床内适配判定。省略则用插件默认机型。"
				},
				overhangDeg: {
					type: "number",
					description: "悬垂判据角度，默认 45（度）。FDM 一般 45，光固化可放宽到 60。"
				},
				bedEps: {
					type: "number",
					description: "多少 mm 以内算贴床面，默认 1.0。"
				},
				orientation: {
					type: "boolean",
					description: "是否搜索最优摆放（footprint 最小优先，其次高度最小）。默认 true。"
				}
			},
			required: ["path"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					file: { type: "string" },
					format: { type: "string" },
					triangles: { type: "integer" },
					vertices: { type: "integer" },
					volumeCm3: { type: "number" },
					areaCm2: { type: "number" },
					sizeMm: { type: "array", items: { type: "number" } },
					shells: { type: "integer" },
					watertight: { type: "boolean" },
					consistentWinding: { type: "boolean" },
					openEdges: { type: "integer" },
					nonManifoldEdges: { type: "integer" },
					overhangCm2: { type: "number" },
					overhangPercent: { type: "number" },
					overhangOnBedCm2: { type: "number" },
					flatBottomCm2: { type: "number" },
					overhangBands: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								z0: { type: "number" },
								z1: { type: "number" },
								areaCm2: { type: "number" }
							},
							required: ["z0", "z1", "areaCm2"]
						}
					},
					meanThicknessMm: { type: "number" },
					printer: { type: "string" },
					fits: { type: "boolean" },
					overflowMm: { type: "array", items: { type: "number" } },
					bestOrientation: { type: "string" },
					needsSupport: { type: "boolean" },
					verdicts: { type: "array", items: { type: "string" } }
				},
				required: ["file", "triangles", "volumeCm3", "watertight", "overhangCm2", "verdicts"]
			},
			render: (_args, value) => [report.text(renderSummary(value))]
		},
		async execute(args, exec) {
			if (typeof args.path !== "string" || args.path.trim().length === 0) throw new Error("path 必须是非空字符串");
			const absolute = paths.inside(exec, args.path);
			if (extname(absolute).toLowerCase() !== ".stl") throw new Error("print3d_check 目前只解析 STL；3MF/OBJ 先用切片器或 Blender 转成 STL");
			let size = 0;
			try {
				size = statSync(absolute).size;
			} catch {
				throw new Error(`找不到文件：${args.path}`);
			}
			if (size < 84) throw new Error(`文件太小，不像 STL：${args.path}`);

			const overhangDeg = args.overhangDeg ?? settings.overhangDeg;
			const bedEps = args.bedEps ?? settings.bedEps;
			const analyzed = mesh.analyzeStl(await readFile(absolute), { overhangDeg, bedEps });
			const printer = printers.resolvePrinter(args.printer, settings.printer);
			const fit = mesh.bedFit(analyzed.bbox, printer.bed);
			const best = args.orientation === false ? undefined : mesh.bestOrientation(analyzed.verts);

			const verdicts = [];
			const surface = analyzed.surface;
			const needsSupport = surface.overhangCm2 > 5 || surface.overhangPercent > 3;

			if (!analyzed.topology.watertight) {
				verdicts.push(`✗ 网格不水密：${analyzed.topology.openEdges} 条开放边、${analyzed.topology.nonManifoldEdges} 条非流形边。切片器通常能修，但孔洞/薄壁会先出问题。`);
			} else {
				verdicts.push("✓ 水密且流形（可以直接切片）");
			}
			if (!analyzed.topology.consistentWinding) verdicts.push("✗ 法线朝向不一致：内外反了会让切片器算出负体积，先修面再打。");
			if (!analyzed.volumePositive) verdicts.push("✗ 有向体积为负：整体法线朝内。");
			if (analyzed.shells > 1) verdicts.push(`! 有 ${analyzed.shells} 个互不相连的实体：确认这是不是想要的（多件同床，还是模型裂了）。`);
			if (needsSupport) {
				verdicts.push(`! 真悬垂 ${surface.overhangCm2.toFixed(2)} cm²（${surface.overhangPercent.toFixed(1)}%）：需要支撑，或改几何（斜面 ≥45°、桥接 ≤10 mm、加倒角）。`);
			} else if (surface.overhangCm2 > 0.5) {
				verdicts.push(`✓ 真悬垂只有 ${surface.overhangCm2.toFixed(2)} cm²：沉孔顶/小圆弧这类，打印机自己能扛。`);
			} else {
				verdicts.push("✓ 基本没有真悬垂：零支撑可打。");
			}
			if (fit.fits) verdicts.push(`✓ 床内放得下：${analyzed.bbox.size.map((entry) => entry.toFixed(1)).join(" × ")} mm ≤ ${printer.name} ${printer.bed.x}×${printer.bed.y}×${printer.bed.z}`);
			else if (fit.fitsAfterSwapXY) verdicts.push(`! 当前朝向放不下，绕 Z 转 90° 可以（${printer.name} 的床是 ${printer.bed.x}×${printer.bed.y}）。`);
			else verdicts.push(`✗ 放不下：超出 ${fit.overflowMm.map((entry) => entry.toFixed(1)).join(" / ")} mm（X/Y/Z）。`);
			if (analyzed.volumeCm3 > 0 && analyzed.areaCm2 > 0 && analyzed.meanThicknessMm < 0.8) {
				verdicts.push(`! 平均厚度估算 ${analyzed.meanThicknessMm.toFixed(2)} mm：偏薄，按 3 墙（约 ${(printer.nozzle * 1.2).toFixed(1)} mm）考虑加厚或用 0.4 喷嘴的 0.42 线宽。`);
			}

			return {
				file: paths.display(exec, absolute),
				format: analyzed.format,
				triangles: analyzed.triangles,
				vertices: analyzed.vertices,
				volumeCm3: round(analyzed.volumeCm3, 3),
				areaCm2: round(analyzed.areaCm2, 2),
				sizeMm: analyzed.bbox.size.map((entry) => round(entry, 2)),
				shells: analyzed.shells,
				watertight: analyzed.topology.watertight,
				consistentWinding: analyzed.topology.consistentWinding,
				openEdges: analyzed.topology.openEdges,
				nonManifoldEdges: analyzed.topology.nonManifoldEdges,
				overhangCm2: round(surface.overhangCm2, 2),
				overhangPercent: round(surface.overhangPercent, 2),
				overhangOnBedCm2: round(surface.overhangOnBedCm2, 2),
				flatBottomCm2: round(surface.flatBottomCm2, 2),
				overhangBands: surface.overhangByBandCm2.map((band) => ({ z0: band.z0, z1: band.z1, areaCm2: round(band.areaCm2, 2) })),
				meanThicknessMm: round(analyzed.meanThicknessMm, 2),
				printer: printer.id,
				fits: fit.fits || fit.fitsAfterSwapXY,
				overflowMm: fit.overflowMm.map((entry) => round(entry, 1)),
				bestOrientation: best === undefined ? undefined : best.label,
				needsSupport,
				verdicts
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "网格体检",
			kind: "read",
			rawInput: { path: args.path }
		})
	};
}

function round(value, digits) {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function renderSummary(value) {
	const lines = [
		`**${value.file}** — ${value.triangles} 面 / ${value.vertices} 顶点，${report.cm3(value.volumeCm3)}`,
		"",
		report.table(
			["项", "值"],
			[
				["包围盒", `${value.sizeMm.map((entry) => entry.toFixed(1)).join(" × ")} mm`],
				["表面积", report.cm2(value.areaCm2)],
				["实体数", value.shells === 1 ? "1（单件）" : `${value.shells}（多件/裂开？）`],
				["水密", value.watertight ? "✓" : `✗ 开放边 ${value.openEdges} / 非流形边 ${value.nonManifoldEdges}`],
				["法线", value.consistentWinding ? "✓ 一致" : "✗ 不一致"],
				["真悬垂", `${value.overhangCm2.toFixed(2)} cm²（${value.overhangPercent.toFixed(1)}%）`],
				["贴床面", `${value.flatBottomCm2.toFixed(2)} cm² 平底（热床附着）`],
				["平均厚度", report.mm(value.meanThicknessMm)],
				["机型", value.printer]
			]
		)
	];
	if (value.overhangBands.length > 0) {
		lines.push("", "悬垂分布（按离床高度）:", report.table(
			["z 区间", "面积"],
			value.overhangBands.map((band) => [`${band.z0}–${band.z1} mm`, report.cm2(band.areaCm2)])
		));
	}
	lines.push("", ...value.verdicts.map((line) => `- ${line}`));
	if (value.bestOrientation !== undefined) lines.push("", `最优摆放（footprint 最小）：\`${value.bestOrientation}\``);
	return lines.join("\n");
}
