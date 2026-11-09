/**
 * print3d_render — .scad → STL / 3MF / OFF / AMF / CSG / DXF / SVG / PNG.
 *
 * The point of the tool is the round trip: a model is only real once a mesh
 * exists, so every mesh render is immediately measured (volume, bounds,
 * watertightness, overhang, bed fit) and the facts go back to the model in the
 * same call. That removes the usual "render, then remember to check it" step.
 */
import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import { readFile } from "node:fs/promises";
import * as report from "../core/report.js";

const FORMATS = ["stl", "3mf", "off", "amf", "csg", "dxf", "svg", "png"];
const MESH_FORMATS = new Set(["stl"]);

const DESCRIPTION = `用 OpenSCAD 把参数化源码渲染成可用网格，并当场体检。

典型用法：
- 从 .scad 建 STL：{"source":"3dprint/hook-rack/hook_rack.scad"}
- 改参数重建：{"source":"…/hook_rack.scad","params":{"n_hooks":3,"peg_deg":55}}
- 出预览图：{"source":"…/hook_rack.scad","format":"png","camera":"0,0,0,55,0,25,0"}

渲染 STL 时会自动量体积/包围盒/水密性/真悬垂/床内适配，并把结论一起返回，
不需要再单独叫一次 print3d_check。输出默认落在 <workspace>/<outDir>/build。
$fn 之类的高阶参数会让渲染变慢，超时用 timeoutMs 调（默认 10 分钟）。`;

export function create(shared) {
	const { proc, paths, openscad, mesh, report, settings } = shared;

	return {
		name: "print3d_render",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				source: {
					type: "string",
					description: "要渲染的 .scad 文件（相对会话工作区），例如 \"3dprint/hook-rack/hook_rack.scad\"。"
				},
				out: {
					type: "string",
					description: "输出文件的名字（不含扩展名）。默认用源文件名。"
				},
				format: {
					type: "string",
					enum: FORMATS,
					description: "导出格式。stl = 切片用的网格（默认）；png = 预览渲染；3mf/off/amf 也是网格；csg/dxf/svg 是过程/轮廓。"
				},
				params: {
					type: "object",
					additionalProperties: {
						oneOf: [
							{ type: "string" },
							{ type: "number" },
							{ type: "boolean" }
						]
					},
					description: "传给 OpenSCAD 的 -D 覆盖项，例如 {\"n_hooks\":3,\"peg_deg\":50,\"part\":\"single_peg\"}。字符串会自动加引号，数字和布尔原样传。"
				},
				printer: {
					type: "string",
					description: "用于判定床内适配的机型 id（print3d_doctor 会列出可用机型）。省略则用插件配置里的默认机型。"
				},
				preview: {
					type: "boolean",
					description: "渲染网格时顺便出一张 PNG 预览。默认 false。"
				},
				camera: {
					type: "string",
					description: "PNG 的相机参数 tx,ty,tz,rx,ry,rz,dist。默认沿用插件配置。"
				},
				imgsize: {
					type: "string",
					description: "PNG 尺寸 \"宽,高\"，默认 1600,1200。"
				},
				timeoutMs: {
					type: "number",
					description: "渲染超时毫秒数，默认 600000。"
				}
			},
			required: ["source"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					file: { type: "string" },
					absolutePath: { type: "string" },
					format: { type: "string" },
					bytes: { type: "number" },
					elapsedMs: { type: "number" },
					openscad: { type: "string" },
					preview: { type: "string" },
					analysis: {
						type: "object",
						additionalProperties: false,
						properties: {
							volumeCm3: { type: "number" },
							areaCm2: { type: "number" },
							triangles: { type: "integer" },
							shells: { type: "integer" },
							sizeMm: { type: "array", items: { type: "number" } },
							watertight: { type: "boolean" },
							overhangCm2: { type: "number" },
							overhangPercent: { type: "number" },
							bedFit: { type: "string" },
							fits: { type: "boolean" }
						},
						required: ["volumeCm3", "areaCm2", "triangles", "watertight"]
					},
					diagnostics: { type: "array", items: { type: "string" } },
					warnings: { type: "array", items: { type: "string" } }
				},
				required: ["file", "format", "bytes", "elapsedMs"]
			},
			render: (_args, value) => [report.text(renderSummary(value))]
		},
		async execute(args, exec) {
			const format = String(args.format ?? "stl").toLowerCase();
			if (!FORMATS.includes(format)) throw new Error(`不支持的 format "${format}"，可选：${FORMATS.join(", ")}`);
			const source = await resolveSource(shared, args.source, exec);
			const stem = args.out ?? basename(source, extname(source));
			const buildDir = paths.out(exec, "build");
			const output = `${buildDir}/${stem}.${format}`;
			const result = await openscad.build({
				source,
				output,
				format,
				params: args.params ?? {},
				exec,
				timeoutMs: args.timeoutMs ?? settings.renderTimeoutMs
			});

			const value = {
				file: paths.display(exec, result.output),
				absolutePath: result.output,
				format,
				bytes: result.bytes,
				elapsedMs: result.elapsedMs,
				openscad: result.openscad,
				diagnostics: result.diagnostics,
				warnings: result.warnings
			};

			// A missing toolchain is provisioned on the spot; say so instead of letting
			// a first render look mysteriously slow.
			if (result.provisioned === true) {
				value.warnings = [
					`本机原本没有 OpenSCAD，已自动安装（来源 ${result.install?.source ?? "auto"}）→ ${result.openscad}。下次渲染不会再装。`,
					...value.warnings
				];
			}

			if (MESH_FORMATS.has(format)) {
				const buffer = await readFile(result.output);
				const analyzed = mesh.analyzeStl(buffer, { overhangDeg: settings.overhangDeg, bedEps: settings.bedEps });
				const printer = shared.printers.resolvePrinter(args.printer, settings.printer);
				const fit = mesh.bedFit(analyzed.bbox, printer.bed);
				value.analysis = {
					volumeCm3: round(analyzed.volumeCm3, 3),
					areaCm2: round(analyzed.areaCm2, 2),
					triangles: analyzed.triangles,
					shells: analyzed.shells,
					sizeMm: analyzed.bbox.size.map((entry) => round(entry, 2)),
					watertight: analyzed.topology.watertight,
					overhangCm2: round(analyzed.surface.overhangCm2, 2),
					overhangPercent: round(analyzed.surface.overhangPercent, 2),
					bedFit: printer.name,
					fits: fit.fits || fit.fitsAfterSwapXY
				};
			}

			if (args.preview === true && MESH_FORMATS.has(format)) {
				const previewPath = `${paths.out(exec, "preview")}/${stem}.png`;
				try {
					await openscad.preview({
						source,
						output: previewPath,
						params: args.params ?? {},
						camera: args.camera,
						imgsize: args.imgsize,
						exec,
						timeoutMs: args.timeoutMs ?? settings.renderTimeoutMs
					});
					value.preview = paths.display(exec, previewPath);
				} catch (error) {
					value.warnings = [...value.warnings, `预览渲染失败：${error instanceof Error ? error.message : String(error)}`];
				}
			}

			return value;
		},
		presentCall: (args) => ({
			card: "generic",
			title: `OpenSCAD 渲染 → ${String(args.format ?? "stl").toUpperCase()}`,
			kind: "execute",
			rawInput: { source: args.source, params: args.params }
		})
	};
}

/** Resolve the source against the workspace and fail with a readable reason. */
async function resolveSource(shared, requested, exec) {
	if (typeof requested !== "string" || requested.trim().length === 0) throw new Error("source 必须是非空字符串");
	const absolute = shared.paths.inside(exec, requested);
	let size;
	try {
		size = statSync(absolute).size;
	} catch {
		throw new Error(`找不到源文件：${requested}（相对会话工作区 ${shared.paths.workspaceOf(exec)}）`);
	}
	if (size === 0) throw new Error(`源文件是空的：${requested}`);
	if (extname(absolute).toLowerCase() !== ".scad") throw new Error(`print3d_render 只吃 .scad 源文件，收到 ${extname(absolute) || "(无扩展名)"}`);
	return absolute;
}

function round(value, digits) {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function renderSummary(value) {
	const lines = [`**已渲染** \`${value.file}\` — ${value.format.toUpperCase()}，${report.bytes(value.bytes)}，${(value.elapsedMs / 1000).toFixed(1)} s`];
	if (value.analysis !== undefined) {
		const a = value.analysis;
		lines.push(
			"",
			report.table(
				["项", "值"],
				[
					["体积", report.cm3(a.volumeCm3)],
					["表面积", report.cm2(a.areaCm2)],
					["三角面", a.triangles],
					["实体数", a.shells],
					["包围盒", `${a.sizeMm.map((entry) => entry.toFixed(1)).join(" × ")} mm`],
					["水密", a.watertight ? "✓ 是" : "✗ 否（切片器会自己修，但不保证）"],
					["真悬垂", `${a.overhangCm2.toFixed(2)} cm²（${a.overhangPercent.toFixed(1)}%）`],
					["床内适配", `${a.fits ? "✓" : "✗"} ${a.bedFit}`]
				]
			)
		);
	}
	if (value.preview !== undefined) lines.push("", `预览图：\`${value.preview}\``);
	for (const warning of value.warnings ?? []) lines.push(`- ⚠️ ${warning}`);
	for (const diagnostic of value.diagnostics ?? []) lines.push(`- ✗ ${diagnostic}`);
	return lines.join("\n");
}
