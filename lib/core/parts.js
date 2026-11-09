/**
 * 内置标准测试体库 —— 注册表、参数合并、渲染与判定。
 *
 * 为什么把这些放在 core 而不是塞进 print3d_parts：
 *   - `print3d_parts` 只是"给人用的入口"，`print3d_selftest` 需要**同一份**
 *     期望值去回归；两边各存一份期望值，早晚会漂移成两个真相。
 *   - 期望值（expects）是数据不是代码：一个标准体的"合格"定义应该和它的
 *     源码放在一起，能被读、能被改，而不是散落在 if 里。
 *
 * 三层职责：
 *   PARTS        纯数据：id / 名称 / 标签 / 用途 / 判读 / 源码文件 / 默认参数 / 期望值
 *   measure()    把 STL 变成**可判定的测量记录**（尺寸、体积、水密、悬垂、贴床…）
 *   exportPart() 渲染一个体并给出 ✓/✗：渲染 → 测量 → 对照 expects
 *
 * 路径一律相对本文件解析（`new URL(...)`），插件目录搬家后不用改任何常量。
 *
 * @module dsh-3d-print/core/parts
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as mesh from "./stl.js";

/** 标准体源码目录（相对本文件，插件搬家也不用改）。 */
const PARTS_DIR = new URL("../../assets/parts/", import.meta.url);

/**
 * 自检默认只跑这 5 个"核心体"：尺寸、流量、悬垂、桥接、配合。
 * 覆盖了 FDM 最常出问题的四类误差，又不会让一次自检拖到十几分钟。
 * 全量（10 个）要显式 `id: "all"`。
 */
export const CORE_PART_IDS = ["calibration-cube", "flow-wall", "overhang-stairs", "bridge-test", "tolerance-gauge"];

/**
 * @typedef {object} ExpectSpec
 * @property {number} [min]     数值下限（含）
 * @property {number} [max]     数值上限（含）
 * @property {boolean|number|string} [equals] 精确相等（布尔/枚举用）
 * @property {string} [unit]    单位，仅用于显示
 * @property {string} [label]   表格里显示的名字
 */

/**
 * @typedef {object} PartDefinition
 * @property {string} id            kebab-case 短 id，同时是输出文件名
 * @property {string} name          中文名
 * @property {string[]} tags        机器可筛的英文标签（stl / openscad / calibration / overhang / bridge …）
 * @property {string} purpose       一行"测什么"，列表里直接显示
 * @property {string} reading       怎么判读（打出来拿卡尺量什么、偏大偏小说明什么）
 * @property {string} scadFile      assets/parts/ 下的源码文件名
 * @property {boolean} core         是否属于自检默认跑的 5 个核心体
 * @property {number[]} sizeMm      默认参数下的名义包围盒 [x,y,z]
 * @property {Record<string, number|boolean|string>} defaults 可 -D 覆盖的默认参数
 * @property {Record<string, ExpectSpec>} expects 指标路径 → 期望区间（路径支持 `sizeMm[0]`）
 */

/** @type {Record<string, PartDefinition>} */
export const PARTS = {
	"calibration-cube": {
		id: "calibration-cube",
		name: "20 mm XYZ 校准立方",
		tags: ["stl", "openscad", "calibration", "dimension", "xyz", "axis", "core"],
		purpose: "XYZ 尺寸精度与轴校准（期望 20.00 ±0.05 mm）",
		reading:
			"卡尺量 X/Y/Z：三向都 20.00±0.05 才算过。整体偏大 = 挤出过量或 XY 补偿为正；偏小 = 流量不足/Steps 偏小；" +
			"只有 Z 少 0.1–0.3 mm 通常是首层被压（调 z-offset）；X 与 Y 差 >0.1 mm 查皮带与两轴 Steps。",
		scadFile: "calibration-cube.scad",
		core: true,
		sizeMm: [20, 20, 20],
		defaults: { size: 20, chamfer: 0 },
		expects: {
			"sizeMm[0]": { label: "X 尺寸", min: 19.95, max: 20.05, unit: "mm" },
			"sizeMm[1]": { label: "Y 尺寸", min: 19.95, max: 20.05, unit: "mm" },
			"sizeMm[2]": { label: "Z 尺寸", min: 19.95, max: 20.05, unit: "mm" },
			volumeCm3: { label: "体积", min: 7.9, max: 8.1, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 1, max: 1 },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	},

	"flow-wall": {
		id: "flow-wall",
		name: "单壁厚阶梯（流量 / 线宽）",
		tags: ["stl", "openscad", "calibration", "flow", "extrusion", "wall", "core"],
		purpose: "挤出流量与线宽（0.4 / 0.5 / 0.6 / 0.8 mm 四片单壁）",
		reading:
			"按 1 圈外墙、0 填充、0 顶底打（不要用花瓶模式，四片会断开），卡尺量每片壁厚 = 实际线宽。" +
			"0.4 片量出 0.42–0.46 属正常。全部偏薄 = 流量不足；全部偏厚 = 流量过量；四片之间差 >0.05 mm = 线宽随速度漂移。",
		scadFile: "flow-wall.scad",
		core: true,
		sizeMm: [95, 3, 21],
		defaults: { wall_t1: 0.4, wall_t2: 0.5, wall_t3: 0.6, wall_t4: 0.8, wall_w: 20, wall_h: 20, gap: 5, base_d: 3, base_h: 1 },
		expects: {
			"sizeMm[0]": { label: "总长", min: 94.8, max: 95.2, unit: "mm" },
			"sizeMm[1]": { label: "最厚片", min: 2.9, max: 3.1, unit: "mm" },
			"sizeMm[2]": { label: "高度", min: 20.9, max: 21.1, unit: "mm" },
			volumeCm3: { label: "体积", min: 1.13, max: 1.19, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 4, max: 4 },
			overhangCm2: { label: "真悬垂", min: 0, max: 0.01, unit: "cm²" },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	},

	"overhang-stairs": {
		id: "overhang-stairs",
		name: "悬臂阶梯（免支撑临界角）",
		tags: ["stl", "openscad", "calibration", "overhang", "support", "angle", "core"],
		purpose: "免支撑临界角与悬垂判定（30 / 40 / 45 / 50 / 60 / 70° 六片悬臂）",
		reading:
			"从 30° 往上打，第一片底面出现下垂/拉丝的角度就是临界角。40° 及以下应平整，45° 分界，50° 以上开始退化。" +
			"注意量角基准是**斜面与竖直方向**；print3d_check 的 theta 是斜面与**水平面**，两者互补（theta = 90° − 本角度）。",
		scadFile: "overhang-stairs.scad",
		core: true,
		sizeMm: [24.91, 60.5, 23],
		defaults: { angle_1: 30, angle_2: 40, angle_3: 45, angle_4: 50, angle_5: 60, angle_6: 70, reach: 18, fin_t: 8, fin_h: 20, gap: 2.5, base_h: 3, margin: 4, embed: 1 },
		expects: {
			"sizeMm[0]": { label: "伸出长度", min: 24.7, max: 25.1, unit: "mm" },
			"sizeMm[1]": { label: "总宽", min: 60.4, max: 60.6, unit: "mm" },
			"sizeMm[2]": { label: "总高", min: 22.9, max: 23.1, unit: "mm" },
			volumeCm3: { label: "体积", min: 14.4, max: 15.1, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 1, max: 1 },
			// 只该有 50/60/70 三片被算成真悬垂：3 × 18 × 8 = 432 mm² = 4.32 cm²。
			// 上下限刻意放在 "3 或 4 片被计入" 的区间：如果 30/40 片也被计入（≈8.6），
			// 或者一片都没计入（0），都说明悬垂分类器坏了。
			overhangCm2: { label: "真悬垂（3 片斜面）", min: 3.9, max: 6.1, unit: "cm²" },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	},

	"bridge-test": {
		id: "bridge-test",
		name: "桥接跨度阶梯",
		tags: ["stl", "openscad", "calibration", "bridge", "span", "cooling", "core"],
		purpose: "桥接跨度（5 / 10 / 15 / 20 / 25 mm 五个门形件）",
		reading:
			"桥面下表面不塌陷、不断线就算该跨度可打。5/10 应平整，15 起轻微下垂，20 以上常见单根丝下垂。" +
			"桥面下垂先加风扇、降温度、降速度。桥面本身是水平朝下的面，print3d_check 会判它为真悬垂——这是对的，别因此加支撑。",
		scadFile: "bridge-test.scad",
		core: true,
		sizeMm: [37, 56, 15],
		defaults: { span_1: 5, span_2: 10, span_3: 15, span_4: 20, span_5: 25, pillar_w: 6, pillar_d: 8, pillar_h: 12, beam_h: 3, gap: 4, embed: 0.5 },
		expects: {
			"sizeMm[0]": { label: "最长跨度件", min: 36.9, max: 37.1, unit: "mm" },
			"sizeMm[1]": { label: "总宽", min: 55.9, max: 56.1, unit: "mm" },
			"sizeMm[2]": { label: "总高", min: 14.9, max: 15.1, unit: "mm" },
			volumeCm3: { label: "体积", min: 9.2, max: 9.4, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 5, max: 5 },
			// 五个桥面 (5+10+15+20+25) × 8 mm 宽 = 600 mm²
			overhangCm2: { label: "真悬垂（5 个桥面）", min: 5.7, max: 6.3, unit: "cm²" },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	},

	"tolerance-gauge": {
		id: "tolerance-gauge",
		name: "销孔配合规（间隙补偿）",
		tags: ["stl", "openscad", "calibration", "tolerance", "fit", "hole", "pin", "core"],
		purpose: "销孔配合与间隙补偿（孔 3.0 / 3.1 / 3.2 / 3.4 / 3.6 mm × 销 3.0 mm）",
		reading:
			"把 3.0 mm 销逐个试插五档孔：能自由滑入又不晃的最大孔径就是本机最小可用间隙。" +
			"3.0 能进 = 偏松；3.2 才进 = 约 0.2 mm 收缩（FDM 常见）；3.6 才进 = 孔偏小太多，查流量/皮带。" +
			"记住差值，建模时直接把孔画大同样量，比在切片器里调 XY 补偿更可控（后者会同时放大外轮廓）。",
		scadFile: "tolerance-gauge.scad",
		core: true,
		sizeMm: [70, 20, 10],
		defaults: { hole_1: 3, hole_2: 3.1, hole_3: 3.2, hole_4: 3.4, hole_5: 3.6, pin_d: 3, pin_h: 10, plate_w: 60, plate_d: 20, plate_h: 5, hole_x0: 10, hole_pitch: 11, pin_x: 67, fn: 48 },
		expects: {
			"sizeMm[0]": { label: "总长", min: 69.9, max: 70.1, unit: "mm" },
			"sizeMm[1]": { label: "宽", min: 19.9, max: 20.1, unit: "mm" },
			"sizeMm[2]": { label: "高", min: 9.9, max: 10.1, unit: "mm" },
			volumeCm3: { label: "体积", min: 5.82, max: 5.97, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 2, max: 2 },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	},

	"z-ladder": {
		id: "z-ladder",
		name: "层高标记阶梯",
		tags: ["stl", "openscad", "calibration", "layer-height", "z", "ladder"],
		purpose: "层高实际值（1.0 / 1.5 / 2.0 / 2.5 / 3.0 mm 五块）",
		reading:
			"用候选层高打一遍，量五块实际高度，除以侧面数出的层数 = 实际层高。" +
			"能被层高整除的块顶面正好收在一层结束，不能整除的块顶面会落在半层上（发亮/被压）。" +
			"0.2 层高下 1.0/2.0/3.0 整除、1.5/2.5 不整除；0.15 层高下反过来。全部偏矮 0.1–0.2 mm = 首层被压。",
		scadFile: "z-ladder.scad",
		sizeMm: [87, 15, 3],
		defaults: { h_1: 1, h_2: 1.5, h_3: 2, h_4: 2.5, h_5: 3, block_w: 15, block_d: 15, gap: 3 },
		expects: {
			"sizeMm[0]": { label: "总长", min: 86.9, max: 87.1, unit: "mm" },
			"sizeMm[1]": { label: "宽", min: 14.9, max: 15.1, unit: "mm" },
			"sizeMm[2]": { label: "最高一块", min: 2.95, max: 3.05, unit: "mm" },
			volumeCm3: { label: "体积", min: 2.2, max: 2.3, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 5, max: 5 },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	},

	"first-layer-patch": {
		id: "first-layer-patch",
		name: "首层压合补丁（80×80 单层）",
		tags: ["stl", "openscad", "calibration", "first-layer", "bed-adhesion"],
		purpose: "首层压合（80 × 80 单层，一眼看贴床状态）",
		reading:
			"整片均匀、丝间无缝、边缘不翘 = 首层合格。有缝 = 喷嘴太远；发亮被压、边缘挤出小鳍 = 喷嘴太近；" +
			"四角翘 = 床温不够或冷却过早。patch_h 填切片器的首层高，量出的片厚就是首层是否被压的依据。",
		scadFile: "first-layer-patch.scad",
		sizeMm: [80, 80, 0.2],
		defaults: { patch_w: 80, patch_d: 80, patch_h: 0.2, notch: 0 },
		expects: {
			"sizeMm[0]": { label: "长", min: 79.9, max: 80.1, unit: "mm" },
			"sizeMm[1]": { label: "宽", min: 79.9, max: 80.1, unit: "mm" },
			"sizeMm[2]": { label: "片厚", min: 0.19, max: 0.21, unit: "mm" },
			volumeCm3: { label: "体积", min: 1.2, max: 1.36, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 1, max: 1 },
			flatBottomCm2: { label: "贴床面积", min: 63, max: 65, unit: "cm²" },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	},

	"stringing-tower": {
		id: "stringing-tower",
		name: "双塔（回缩 / 拉丝）",
		tags: ["stl", "openscad", "calibration", "stringing", "retraction", "temperature"],
		purpose: "回缩与拉丝（两塔净距 40 mm，空驶几十次）",
		reading:
			"塔间干净 = 回缩合适；蛛网状细丝 = 回缩不够/温度过高；塔身有疙瘩 = 回缩过大。" +
			"调参顺序：先降 5 °C 看拉丝，再每次 0.2 mm 动回缩量；温度的影响通常更大。两塔层纹错位 = XY 定位或皮带松。",
		scadFile: "stringing-tower.scad",
		sizeMm: [14, 64, 30],
		defaults: { tower_d: 10, tower_h: 30, gap: 40, base_d: 14, base_h: 1.5, fn: 48 },
		expects: {
			"sizeMm[0]": { label: "宽", min: 13.9, max: 14.1, unit: "mm" },
			"sizeMm[1]": { label: "塔间距（含塔身）", min: 63.9, max: 64.1, unit: "mm" },
			"sizeMm[2]": { label: "塔高", min: 29.9, max: 30.1, unit: "mm" },
			volumeCm3: { label: "体积", min: 4.85, max: 5.0, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 2, max: 2 },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	},

	"hole-compensation": {
		id: "hole-compensation",
		name: "圆孔阵列 / 孔径补偿",
		tags: ["stl", "openscad", "calibration", "hole", "compensation", "shrinkage"],
		purpose: "孔径补偿标定（5 / 8 / 10 mm 圆孔，量孔径算补偿量）",
		reading:
			"量实际孔径，补偿量 = 设计孔径 − 实测孔径（FDM 常见 0.1–0.3 mm）。" +
			"把补偿量填回 comp（或 params {\"comp\":0.2}）重新导出，孔直接画大，外轮廓不受影响——比切片器 XY 补偿更准。量孔用内测爪取三方向平均，别把第一层喇叭口量进去。",
		scadFile: "hole-compensation.scad",
		sizeMm: [70, 20, 5],
		defaults: { d_1: 5, d_2: 8, d_3: 10, comp: 0, plate_w: 70, plate_d: 20, plate_h: 5, margin_x: 15, pitch: 20, fn: 64 },
		expects: {
			"sizeMm[0]": { label: "长", min: 69.9, max: 70.1, unit: "mm" },
			"sizeMm[1]": { label: "宽", min: 19.9, max: 20.1, unit: "mm" },
			"sizeMm[2]": { label: "厚", min: 4.9, max: 5.1, unit: "mm" },
			volumeCm3: { label: "体积", min: 6.2, max: 6.32, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 1, max: 1 },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	},

	"fastener-m4": {
		id: "fastener-m4",
		name: "M4 沉头孔 + 螺母槽",
		tags: ["stl", "openscad", "calibration", "fastener", "m4", "countersink", "nut"],
		purpose: "沉头与螺母槽（M4 平头螺钉 + 六角螺母，挂钩类件的受力点）",
		reading:
			"螺钉头应完全沉入并与顶面平齐（沉不下 = 锥深不够；沉下但晃 = 通孔偏大）。" +
			"螺母从底面塞入应卡住、不掉、不打转（太紧塞不进 / 太松会打转）。螺母槽顶面是水平朝下的面，会被算作真悬垂（≈0.29 cm²），这是正常的。",
		scadFile: "fastener-m4.scad",
		sizeMm: [40, 20, 10],
		defaults: { hole_d: 4.5, head_d: 8.4, nut_af: 7.2, nut_h: 3.4, block_w: 40, block_d: 20, block_h: 10, csk_x: 10, nut_x: 30, fn: 48 },
		expects: {
			"sizeMm[0]": { label: "长", min: 39.9, max: 40.1, unit: "mm" },
			"sizeMm[1]": { label: "宽", min: 19.9, max: 20.1, unit: "mm" },
			"sizeMm[2]": { label: "厚", min: 9.9, max: 10.1, unit: "mm" },
			volumeCm3: { label: "体积", min: 7.45, max: 7.6, unit: "cm³" },
			watertight: { label: "水密", equals: true },
			shells: { label: "实体数", min: 1, max: 1 },
			// 螺母槽顶 ≈ 0.29 cm²：这块"小桥"就是该被识别出来的悬垂
			overhangCm2: { label: "真悬垂（螺母槽顶）", min: 0.2, max: 0.4, unit: "cm²" },
			minZm: { label: "贴床", min: -0.01, max: 0.01, unit: "mm" },
			fitsBed: { label: "床内放得下", equals: true }
		}
	}
};

/**
 * 把用户写的 id 归一化：大小写、下划线、空格、带 .scad 都接受。
 * @param {string} id
 */
export function normalizeId(id) {
	return String(id ?? "")
		.trim()
		.toLowerCase()
		.replace(/\.scad$/u, "")
		.replace(/[\s_]+/gu, "-");
}

/**
 * 取一个标准体；未知 id 抛错并列出可用 id（模型下一步能自纠）。
 * @param {string} id
 * @returns {PartDefinition}
 */
export function getPart(id) {
	const key = normalizeId(id);
	const part = PARTS[key];
	if (part === undefined) throw new Error(`未知标准体 "${id}"。可用：${Object.keys(PARTS).join(", ")}`);
	return part;
}

/**
 * 列出标准体（保持注册表里的教学顺序：先尺寸，再流量/几何，最后专项）。
 * @param {string|{tag?: string, ids?: string[], query?: string, core?: boolean}} [filter]
 * @returns {PartDefinition[]}
 */
export function listParts(filter) {
	const all = Object.values(PARTS);
	if (filter === undefined || filter === null) return all;

	if (typeof filter === "string") {
		const query = filter.trim().toLowerCase();
		if (query.length === 0) return all;
		return all.filter((part) => partMatches(part, query));
	}

	const wanted = new Set();
	if (Array.isArray(filter.ids)) for (const id of filter.ids) wanted.add(normalizeId(id));
	const query = filter.query === undefined ? undefined : String(filter.query).trim().toLowerCase();
	return all.filter((part) => {
		if (wanted.size > 0 && !wanted.has(part.id)) return false;
		if (filter.core === true && part.core !== true) return false;
		if (typeof filter.tag === "string" && filter.tag.length > 0 && !part.tags.includes(filter.tag)) return false;
		if (query !== undefined && query.length > 0 && !partMatches(part, query)) return false;
		return true;
	});
}

function partMatches(part, query) {
	return (
		part.id.includes(query) ||
		part.name.toLowerCase().includes(query) ||
		part.purpose.toLowerCase().includes(query) ||
		part.reading.toLowerCase().includes(query) ||
		part.tags.some((tag) => tag.includes(query))
	);
}

/**
 * 一个标准体源码的绝对路径。走相对 URL 解析，插件目录搬家/改名都不用改代码。
 * @param {string} id
 * @returns {string}
 */
export function partPath(id) {
	const part = typeof id === "string" ? getPart(id) : id;
	return fileURLToPath(new URL(part.scadFile, PARTS_DIR));
}

/**
 * 合并默认参数与用户覆盖；不认识的名字直接报错。
 * OpenSCAD 对未知 `-D` 是静默接受的，所以拼写错误必须在 JS 这边拦住。
 * @param {PartDefinition|string} partOrId
 * @param {Record<string, number|boolean|string>} [params]
 * @returns {Record<string, number|boolean|string>}
 */
export function mergeParams(partOrId, params = {}) {
	const part = typeof partOrId === "string" ? getPart(partOrId) : partOrId;
	if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error("params 必须是对象");
	const unknown = Object.keys(params).filter((key) => !Object.hasOwn(part.defaults, key));
	if (unknown.length > 0) {
		throw new Error(
			`标准体 "${part.id}" 不认识参数 ${unknown.join(", ")}；可用参数：${Object.keys(part.defaults).join(", ")}`
		);
	}
	const merged = { ...part.defaults };
	for (const [key, value] of Object.entries(params)) {
		if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") {
			throw new Error(`参数 ${key} 只能是 number / boolean / string`);
		}
		merged[key] = value;
	}
	return merged;
}

function round(value, digits) {
	if (!Number.isFinite(value)) return value;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/**
 * 把 STL 变成**可判定**的测量记录。
 *
 * 字段名就是 expects 里用的指标路径；`sizeMm[0]` 这类下标路径也支持。
 * 所有长度单位 mm，体积 cm³，面积 cm²。
 *
 * @param {Buffer} buffer - STL 文件内容
 * @param {{overhangDeg?: number, bedEps?: number, printer?: {name: string, bed: {x: number, y: number, z: number}}}} [options]
 * @returns {object} 测量记录
 */
export function measure(buffer, options = {}) {
	const analyzed = mesh.analyzeStl(buffer, {
		overhangDeg: options.overhangDeg,
		bedEps: options.bedEps
	});
	const printer = options.printer;
	const fit = printer === undefined ? undefined : mesh.bedFit(analyzed.bbox, printer.bed);
	return {
		/** 包围盒尺寸 [x, y, z]（mm） */
		sizeMm: analyzed.bbox.size.map((entry) => round(entry, 3)),
		volumeCm3: round(analyzed.volumeCm3, 4),
		areaCm2: round(analyzed.areaCm2, 3),
		triangles: analyzed.triangles,
		vertices: analyzed.vertices,
		shells: analyzed.shells,
		watertight: analyzed.topology.watertight,
		consistentWinding: analyzed.topology.consistentWinding,
		volumePositive: analyzed.volumePositive,
		overhangCm2: round(analyzed.surface.overhangCm2, 4),
		overhangPercent: round(analyzed.surface.overhangPercent, 3),
		overhangOnBedCm2: round(analyzed.surface.overhangOnBedCm2, 3),
		flatBottomCm2: round(analyzed.surface.flatBottomCm2, 3),
		meanThicknessMm: round(analyzed.meanThicknessMm, 3),
		/** 最低点：标准体必须落在 z=0 的床上，不是悬空也不是陷进床里 */
		minZm: round(analyzed.bbox.min[2], 4),
		maxZm: round(analyzed.bbox.max[2], 4),
		/** 包围盒底面积 mm²；**不是**实际贴床面积，贴床面积看 flatBottomCm2 */
		footprintMm2: round(analyzed.bbox.size[0] * analyzed.bbox.size[1], 2),
		/** 放得下（默认机型或传入机型）；没传机型时为 undefined */
		fitsBed: fit === undefined ? undefined : fit.fits || fit.fitsAfterSwapXY,
		bedName: printer === undefined ? undefined : printer.name
	};
}

/**
 * 按 `sizeMm[0]` / `watertight` 这类路径从测量记录里取值。
 * @param {object} record
 * @param {string} metric
 */
export function readMetric(record, metric) {
	const tokens = String(metric).replace(/\[(\d+)\]/gu, ".$1").split(".");
	let value = record;
	for (const token of tokens) {
		if (value === undefined || value === null) return undefined;
		value = value[token];
	}
	return value;
}

/**
 * 对照 expects 判定一个测量记录。
 * @param {PartDefinition|string} partOrId
 * @param {object} measurement - measure() 的返回值
 * @returns {Array<{metric: string, label: string, actual: any, min?: number, max?: number, equals?: any, unit?: string, ok: boolean}>}
 */
export function evaluateExpects(partOrId, measurement) {
	const part = typeof partOrId === "string" ? getPart(partOrId) : partOrId;
	return Object.entries(part.expects).map(([metric, spec]) => {
		const actual = readMetric(measurement, metric);
		const numeric = typeof actual === "number" && Number.isFinite(actual);
		let ok;
		if (spec.equals !== undefined) {
			ok = actual === spec.equals;
		} else if (numeric) {
			ok = (spec.min === undefined || actual >= spec.min) && (spec.max === undefined || actual <= spec.max);
		} else {
			// 指标取不到（路径写错、或测量里没有这项）按失败算，selftest 会报出确切名字
			ok = false;
		}
		return {
			metric,
			label: spec.label ?? metric,
			actual,
			...(spec.min !== undefined ? { min: spec.min } : {}),
			...(spec.max !== undefined ? { max: spec.max } : {}),
			...(spec.equals !== undefined ? { equals: spec.equals } : {}),
			...(spec.unit !== undefined ? { unit: spec.unit } : {}),
			ok
		};
	});
}

/**
 * 渲染一次标准体：渲染 → 读盘 → 测量 → 判定。
 * 失败时抛出带上下文的错误（源码路径、参数），调用方负责决定是整体失败还是记一条。
 *
 * @param {ReturnType<import("./openscad.js").createOpenscad>} openscad - core/openscad.js 实例
 * @param {PartDefinition|string} partOrId
 * @param {{output: string, params?: Record<string, number|boolean|string>, exec?: object,
 *          timeoutMs?: number, printer?: object, overhangDeg?: number, bedEps?: number}} options
 * @returns {Promise<{part: PartDefinition, params: object, build: object, measurement: object, checks: object[], ok: boolean}>}
 */
export async function exportPart(openscad, partOrId, options) {
	const part = typeof partOrId === "string" ? getPart(partOrId) : partOrId;
	if (typeof options?.output !== "string" || options.output.length === 0) throw new Error("exportPart 需要 output 路径");
	const params = mergeParams(part, options.params ?? {});
	const source = partPath(part);
	const build = await openscad.build({
		source,
		output: options.output,
		format: "stl",
		params,
		exec: options.exec,
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
	});
	const buffer = await readFile(options.output);
	const measurement = measure(buffer, {
		printer: options.printer,
		overhangDeg: options.overhangDeg,
		bedEps: options.bedEps
	});
	const checks = evaluateExpects(part, measurement);
	return { part, params, build, measurement, checks, ok: checks.every((check) => check.ok) };
}

/** `20 × 20 × 20 mm`，最多两位小数，去掉多余的 0。 */
export function formatSize(sizeMm) {
	if (!Array.isArray(sizeMm) || sizeMm.length < 3) return "—";
	return `${sizeMm
		.slice(0, 3)
		.map((value) => {
			if (!Number.isFinite(value)) return "—";
			const text = value.toFixed(2);
			return text.replace(/\.00$/u, "").replace(/(\.\d)0$/u, "$1");
		})
		.join(" × ")} mm`;
}

/** 把一个期望值写成短句：`19.95–20.05 mm` / `= true`。 */
export function formatExpect(spec) {
	if (spec.equals !== undefined) {
		return typeof spec.equals === "boolean" ? String(spec.equals) : `= ${JSON.stringify(spec.equals)}`;
	}
	const unit = spec.unit === undefined ? "" : ` ${spec.unit}`;
	if (spec.min !== undefined && spec.max !== undefined) {
		return spec.min === spec.max ? `= ${spec.min}${unit}` : `${spec.min}–${spec.max}${unit}`;
	}
	if (spec.min !== undefined) return `≥ ${spec.min}${unit}`;
	if (spec.max !== undefined) return `≤ ${spec.max}${unit}`;
	return "—";
}

/** 一个实测值写成短句；取不到值时明说，别让 0 冒充"没测到"。 */
export function formatActual(check) {
	if (check.actual === undefined) return "—（指标取不到）";
	if (typeof check.actual === "boolean") return check.actual ? "true" : "false";
	if (typeof check.actual === "number") {
		const text = Number.isInteger(check.actual) ? String(check.actual) : check.actual.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
		return check.unit === undefined ? text : `${text} ${check.unit}`;
	}
	return String(check.actual);
}

/** 把一条 check 的期望值写成短句（check 里已经展开了 min/max/equals）。 */
export function formatCheckExpect(check) {
	return formatExpect(check);
}

/**
 * 一条不达标的判定 → 可执行的下一步。
 *
 * "✗ 体积 7.31 cm³" 不算结论：模型下一步要么改参数、要么改判据、要么换机型。
 * 这里按指标名给出具体动作，而不是一句"检查一下"。
 *
 * @param {{metric: string, actual?: any}} check
 * @returns {string}
 */
export function explainFailure(check) {
	const metric = String(check.metric ?? "");
	if (metric.startsWith("sizeMm")) {
		return `${check.metric} 不等于设计值：先确认导出时的 params 没把尺寸参数改掉（print3d_parts 的 params 会覆盖默认值），再看源码里对应的 cube/cylinder 尺寸`;
	}
	if (metric.startsWith("volumeCm3")) {
		return "体积与设计不符：参数被覆盖、或 OpenSCAD 版本对圆弧的分段近似有差异（$fn 越小差别越大）；量尺寸正常时可以只把这条当参考";
	}
	if (metric === "watertight") {
		return "网格不水密：先 print3d_check 看开放边/非流形边数；常见原因是两个实体只共面接触（应压进 0.01 做体积相交）或 $fn 太小导致退化三角形";
	}
	if (metric === "shells") {
		return "实体数与预期不符：该体应当是多个分离件还是一个整体，先看 SCAD 里 union/difference 的层级；分离件没被并进来通常是坐标没对上";
	}
	if (metric.startsWith("overhangCm2")) {
		return "真悬垂面积与几何不符：悬垂判据按「朝下且与水平面夹角 < overhangDeg」算，检查斜面角度参数，或插件配置里的 overhangDeg（默认 45）";
	}
	if (metric === "flatBottomCm2") {
		return "贴床面积不对：说明模型底部不是一整块平面（被台阶/缺口切开），首层附着会变差";
	}
	if (metric === "minZm") {
		return "体没有落在 z=0 的床上（悬空或陷进床里）：SCAD 里所有实体都必须从 z=0 长出，切片前不要整体平移";
	}
	if (metric === "fitsBed") {
		return "默认机型的打印体积放不下这个体：换一台更大的机型，或调小该体的尺寸参数（print3d_parts 的 params）";
	}
	return `指标 ${check.metric || "(未命名)"} 在测量记录里取不到值：多半是 lib/core/parts.js 的 expects 路径写错（可用路径见 measure() 返回的字段）`;
}

