/**
 * 标准体库的正式测试：注册表自洽 + 期望值路径可解析 + 真渲染回归。
 *
 *   node --test tests/parts.test.mjs
 *
 * 分两层，故意不混在一起：
 *   - 静态层（不需要 OpenSCAD）：注册表字段、源码文件、-D 参数名、expects 路径、
 *     参数校验。这一层在 CI / 别人的机器上必须永远能跑。
 *   - 渲染层（需要 OpenSCAD）：真渲染 calibration-cube 并跑默认 5 个核心体的自检。
 *     找不到 OpenSCAD 时自动 skip，而不是把整份测试判失败。
 *
 * 静态层里用的测量记录来自**内存里造的** 20 mm 立方 STL：不碰磁盘、不调外部程序，
 * 但走的是真正的 measure()/stl.js 路径，所以能证明 expects 里每个指标路径都存在。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import * as catalogue from "../lib/core/parts.js";
import { findExecutable, commonInstallDirs } from "../lib/core/proc.js";
import { apply } from "../lib/index.js";
import { createFakeContext, makeExec } from "./harness.mjs";

/** 一个面 2 个三角形，6 个面 = 12 个；绕序保证外法线（有向体积为正）。 */
function cubeStl(size) {
	const s = size;
	const faces = [
		[[0, 0, 0], [0, s, 0], [s, s, 0]],
		[[0, 0, 0], [s, s, 0], [s, 0, 0]],
		[[0, 0, s], [s, 0, s], [s, s, s]],
		[[0, 0, s], [s, s, s], [0, s, s]],
		[[0, 0, 0], [s, 0, 0], [s, 0, s]],
		[[0, 0, 0], [s, 0, s], [0, 0, s]],
		[[0, s, 0], [0, s, s], [s, s, s]],
		[[0, s, 0], [s, s, s], [s, s, 0]],
		[[0, 0, 0], [0, 0, s], [0, s, s]],
		[[0, 0, 0], [0, s, s], [0, s, 0]],
		[[s, 0, 0], [s, s, 0], [s, s, s]],
		[[s, 0, 0], [s, s, s], [s, 0, s]]
	];
	const buffer = Buffer.alloc(84 + faces.length * 50);
	buffer.writeUInt32LE(faces.length, 80);
	let offset = 84;
	for (const face of faces) {
		offset += 12; // 法线由 stl.js 从绕序重算，这里留空
		for (const vertex of face) {
			for (const value of vertex) {
				buffer.writeFloatLE(value, offset);
				offset += 4;
			}
		}
		offset += 2;
	}
	return buffer;
}

const STUB_PRINTER = { id: "stub", name: "Stub 200³", bed: { x: 200, y: 200, z: 200 } };

/** 真渲染用：优先取环境里的 OpenSCAD，找不到就 skip 渲染层。 */
const OPENSCAD =
	[
		process.env.ProgramFiles === undefined ? "" : join(process.env.ProgramFiles, "OpenSCAD", "openscad.exe"),
		"/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD",
		"/usr/bin/openscad",
		"/usr/local/bin/openscad"
	]
		.filter((candidate) => candidate.length > 0)
		.find((candidate) => existsSync(candidate)) ?? findExecutable("openscad", commonInstallDirs());

const skipRender = OPENSCAD === undefined ? "本机没有 OpenSCAD，跳过真渲染" : false;

test("注册表：10 个标准体，字段齐全，id 与源码文件名一致", () => {
	const entries = Object.entries(catalogue.PARTS);
	assert.equal(entries.length, 10, "标准体数量应为 10");
	for (const [key, part] of entries) {
		assert.equal(part.id, key, `${key}: 注册表的键必须等于 part.id`);
		assert.equal(part.scadFile, `${part.id}.scad`, `${part.id}: scadFile 必须是 <id>.scad`);
		assert.ok(part.name.length > 0 && part.purpose.length > 0, `${part.id}: 名称/用途不能为空`);
		assert.ok(part.reading.length > 20, `${part.id}: 必须有可读的判读说明`);
		assert.ok(part.tags.length > 0, `${part.id}: 至少一个标签`);
		assert.equal(part.sizeMm.length, 3, `${part.id}: sizeMm 必须是 [x,y,z]`);
		assert.ok(part.sizeMm.every((value) => Number.isFinite(value) && value > 0), `${part.id}: sizeMm 必须是正数`);
		assert.ok(Object.keys(part.defaults).length > 0, `${part.id}: 必须声明可改参数`);
		assert.ok(Object.keys(part.expects).length >= 5, `${part.id}: 期望值至少 5 条才有判定价值`);
	}
});

test("核心体：CORE_PART_IDS 是 5 个、都存在且 core 标记一致", () => {
	assert.equal(catalogue.CORE_PART_IDS.length, 5);
	for (const id of catalogue.CORE_PART_IDS) {
		assert.equal(catalogue.getPart(id).core, true, `${id}: 必须标记 core`);
	}
	const core = catalogue.listParts({ core: true });
	assert.equal(core.length, 5);
});

test("源码：每个体的 .scad 存在、非空、有 customizer 段，且默认参数名真的写在文件里", () => {
	for (const part of catalogue.listParts()) {
		const path = catalogue.partPath(part.id);
		assert.ok(existsSync(path), `${part.id}: 缺少 ${path}`);
		const source = readFileSync(path, "utf8");
		assert.ok(source.length > 400, `${part.id}: 源码过短，像占位文件`);
		const sections = source.match(/\/\*\s*\[[^\]]+\]\s*\*\//gu) ?? [];
		assert.ok(sections.length >= 2, `${part.id}: 至少两个 /* [分组] */ customizer 段`);
		assert.ok(/测什么/u.test(source) && /怎么判读/u.test(source) && /期望值/u.test(source), `${part.id}: 顶部注释必须写清"测什么/怎么判读/期望值"`);
		// 纯立方体不需要 $fn；一旦有圆弧就必须把分段数暴露成参数，否则改不了圆度
		if (/cylinder|circle\s*\(|rotate_extrude/u.test(source)) {
			assert.ok(/^fn\s*=\s*\d+;/mu.test(source), `${part.id}: 有圆弧却没暴露 fn 参数`);
		}
		for (const name of Object.keys(part.defaults)) {
			assert.ok(new RegExp(`^\\s*${name}\\s*=`, "mu").test(source), `${part.id}: 默认参数 ${name} 在源码里没有赋值，-D 会失效`);
		}
	}
});

test("路径：partPath 指向插件内的 assets/parts，且不写死绝对路径", () => {
	for (const part of catalogue.listParts()) {
		const path = catalogue.partPath(part.id);
		assert.ok(isAbsolute(path), `${part.id}: 应返回绝对路径`);
		const rel = relative(process.cwd(), path).split("\\").join("/");
		assert.ok(rel.endsWith(`assets/parts/${part.scadFile}`), `${part.id}: 应在 assets/parts 下，实际 ${rel}`);
		assert.ok(!rel.startsWith(".."), `${part.id}: 解析结果应落在仓库内`);
	}
});

test("measure + expects：每个指标路径都能在真实测量记录里解析", () => {
	const record = catalogue.measure(cubeStl(20), { printer: STUB_PRINTER });
	assert.deepEqual(record.sizeMm, [20, 20, 20]);
	assert.equal(record.volumeCm3, 8);
	assert.equal(record.watertight, true);
	assert.equal(record.fitsBed, true);
	for (const part of catalogue.listParts()) {
		for (const metric of Object.keys(part.expects)) {
			const value = catalogue.readMetric(record, metric);
			assert.notEqual(value, undefined, `${part.id}: 指标 ${metric} 在测量记录里取不到值`);
		}
	}
});

test("evaluateExpects：对与错都能判，且每条失败都有可执行的下一步", () => {
	const record = catalogue.measure(cubeStl(20), { printer: STUB_PRINTER });
	const cube = catalogue.getPart("calibration-cube");
	const checks = catalogue.evaluateExpects(cube, record);
	for (const check of checks) assert.equal(check.ok, true, `${cube.id}: 默认值下 ${check.metric} 应达标`);

	const wrong = catalogue.evaluateExpects(cube, { ...record, sizeMm: [30, 20, 20], watertight: false });
	assert.equal(wrong.find((check) => check.metric === "sizeMm[0]").ok, false);
	assert.equal(wrong.find((check) => check.metric === "watertight").ok, false);

	for (const part of catalogue.listParts()) {
		for (const metric of Object.keys(part.expects)) {
			const text = catalogue.explainFailure({ metric });
			assert.ok(typeof text === "string" && text.length > 10, `${part.id}: ${metric} 缺少失败修复建议`);
		}
	}

	const missing = catalogue.evaluateExpects(cube, { sizeMm: [20, 20, 20] });
	assert.equal(missing.find((check) => check.metric === "volumeCm3").ok, false, "取不到的指标必须判失败");
});

test("measure：非水密/凹陷的网格会被判出来", () => {
	const buffer = cubeStl(20);
	// 砍掉最后 3 个三角形 = 留下一个洞
	const broken = Buffer.from(buffer.subarray(0, 84 + (12 - 3) * 50));
	broken.writeUInt32LE(9, 80);
	const record = catalogue.measure(broken, { printer: STUB_PRINTER });
	assert.equal(record.watertight, false);
	assert.equal(record.triangles, 9);
});

test("mergeParams：默认值不被改、覆盖生效、未知参数与坏类型被拒绝", () => {
	const cube = catalogue.getPart("calibration-cube");
	const defaults = catalogue.mergeParams(cube, {});
	assert.deepEqual(defaults, cube.defaults);
	assert.notEqual(defaults, cube.defaults, "必须返回副本，不能改到注册表");
	const overridden = catalogue.mergeParams(cube, { size: 30 });
	assert.equal(overridden.size, 30);
	assert.throws(() => catalogue.mergeParams(cube, { sizee: 20 }), /不认识参数 sizee/u);
	assert.throws(() => catalogue.mergeParams(cube, { size: [20] }), /只能是 number/u);
	assert.throws(() => catalogue.mergeParams("nope", {}), /未知标准体/u);
});

test("normalizeId / getPart：大小写、下划线、.scad 后缀都能认", () => {
	assert.equal(catalogue.normalizeId("Calibration Cube"), "calibration-cube");
	assert.equal(catalogue.normalizeId("calibration_cube"), "calibration-cube");
	assert.equal(catalogue.normalizeId("overhang-stairs.scad"), "overhang-stairs");
	assert.equal(catalogue.getPart("Calibration_Cube").id, "calibration-cube");
	assert.throws(() => catalogue.getPart("nope"), /可用：calibration-cube/u);
});

test("listParts：全部 / 标签 / 核心 / 关键词过滤", () => {
	assert.equal(catalogue.listParts().length, 10);
	assert.deepEqual(
		catalogue.listParts({ tag: "bridge" }).map((part) => part.id),
		["bridge-test"]
	);
	assert.equal(catalogue.listParts({ query: "悬垂" }).some((part) => part.id === "overhang-stairs"), true);
	assert.equal(catalogue.listParts("overhang").length, 1);
	assert.deepEqual(
		catalogue.listParts({ ids: ["z-ladder", "fastener-m4"] }).map((part) => part.id),
		["z-ladder", "fastener-m4"]
	);
	assert.equal(catalogue.listParts({ core: true }).length, 5);
});

test("格式化：尺寸 / 期望值 / 实测值都不糊", () => {
	assert.equal(catalogue.formatSize([20, 20, 20]), "20 × 20 × 20 mm");
	assert.equal(catalogue.formatSize([24.914, 60.5, 23]), "24.91 × 60.5 × 23 mm");
	assert.equal(catalogue.formatExpect({ min: 19.95, max: 20.05, unit: "mm" }), "19.95–20.05 mm");
	assert.equal(catalogue.formatExpect({ min: 1, max: 1, unit: "mm" }), "= 1 mm");
	assert.equal(catalogue.formatExpect({ equals: true }), "true");
	assert.equal(catalogue.formatActual({ actual: true }), "true");
	assert.equal(catalogue.formatActual({ actual: undefined }), "—（指标取不到）");
	assert.equal(catalogue.formatActual({ actual: 4.32, unit: "cm²" }), "4.32 cm²");
});

test("print3d_parts list：表格覆盖全部标准体", async () => {
	const ctx = createFakeContext();
	apply(ctx, OPENSCAD === undefined ? {} : { openscadPath: OPENSCAD });
	const tool = ctx.tools.get("print3d_parts");
	const value = await tool.execute({}, makeExec(ctx.cwd));
	assert.equal(value.action, "list");
	assert.equal(value.parts.length, 10);
	assert.equal(value.coreIds.length, 5);
	const text = tool.output.render({}, value)[0].text;
	assert.ok(text.includes("calibration-cube") && text.includes("fastener-m4"), "表格里应有全部 id");
	assert.ok(text.includes("20 × 20 × 20 mm"), "表格里应有默认尺寸");
});

test("print3d_parts info：给出判读方法、参数说明与期望值", async () => {
	const ctx = createFakeContext();
	apply(ctx, {});
	const tool = ctx.tools.get("print3d_parts");
	const value = await tool.execute({ action: "info", id: "overhang-stairs" }, makeExec(ctx.cwd));
	assert.equal(value.part.id, "overhang-stairs");
	assert.ok(value.part.reading.includes("竖直方向"));
	assert.ok(value.params.some((entry) => entry.name === "angle_6" && entry.comment.length > 0), "参数说明应从源码注释读出");
	assert.ok(value.expects.some((entry) => entry.metric === "overhangCm2"));
});

test("print3d_parts export：真渲染 20 mm 立方，尺寸与体积落在期望值内", { skip: skipRender }, async () => {
	const ctx = createFakeContext();
	apply(ctx, { openscadPath: OPENSCAD });
	const tool = ctx.tools.get("print3d_parts");
	const value = await tool.execute({ action: "export", id: "calibration-cube" }, makeExec(ctx.cwd));
	assert.equal(value.ok, true, JSON.stringify(value.failures));
	assert.equal(value.total, 8);
	assert.deepEqual(value.measurement.sizeMm, [20, 20, 20]);
	assert.ok(value.measurement.volumeCm3 > 7.9 && value.measurement.volumeCm3 < 8.1);
	assert.ok(existsSync(join(ctx.cwd, value.file)), "STL 应落在 <workspace>/<outDir>/parts 下");
});

test("print3d_parts export：改参数后期望值会诚实地报 ✗", { skip: skipRender }, async () => {
	const ctx = createFakeContext();
	apply(ctx, { openscadPath: OPENSCAD });
	const tool = ctx.tools.get("print3d_parts");
	const value = await tool.execute(
		{ action: "export", id: "calibration-cube", params: { size: 30 } },
		makeExec(ctx.cwd)
	);
	assert.equal(value.ok, false);
	assert.deepEqual(value.measurement.sizeMm, [30, 30, 30]);
	assert.ok(value.failures.length > 0);
	assert.ok(value.failures.every((failure) => failure.nextStep.length > 10), "每条失败都要有下一步");
});

test("print3d_selftest：默认 5 个核心体全部达标", { skip: skipRender }, async () => {
	const ctx = createFakeContext();
	apply(ctx, { openscadPath: OPENSCAD });
	const tool = ctx.tools.get("print3d_selftest");
	const value = await tool.execute({}, makeExec(ctx.cwd));
	assert.equal(value.selection, "core");
	assert.equal(value.partsTotal, 5);
	assert.equal(value.ok, true, JSON.stringify(value.nextSteps));
	assert.equal(value.passRate, 100);
	assert.equal(value.plugin.openscad.ok, true);
	assert.equal(value.plugin.catalogue.ok, true);
	assert.equal(value.plugin.printers.ok, true);
	// 默认不落盘：自检产物不应留在工作区
	for (const entry of value.parts) {
		assert.equal(existsSync(join(ctx.cwd, "3dprint", "selftest", `${entry.id}.stl`)), false, `${entry.id}: 默认应清掉 STL`);
	}
});

test("print3d_selftest：未知 id 报错并给出可用列表", async () => {
	const ctx = createFakeContext();
	apply(ctx, {});
	const tool = ctx.tools.get("print3d_selftest");
	await assert.rejects(async () => await tool.execute({ id: "nope" }, makeExec(ctx.cwd)), /可用：calibration-cube/u);
});
