/*
	bridge-test — 桥接跨度阶梯（5/10/15/20/25 mm）

	测什么
		五个门形件，桥面跨度 5 / 10 / 15 / 20 / 25 mm，桥面离床 12 mm。
		桥面下方没有支撑，全靠挤出线自己拉过去；跨度越大越容易下垂。

	怎么判读
		- 5/10 mm 应当平整；15 mm 开始出现轻微下垂，20 mm 以上常见单根丝下垂。
		- 判据：桥面下表面不塌陷、不断线，视为该跨度可打。
		- 大面积桥接还取决于冷却：桥面下垂先加风扇、降温度、降速度，再考虑加支撑。
		- 桥接合格而悬垂不合格，说明冷却够、但材料在陡斜面上撑不住；
		  反之则先修冷却。两者一起看才能定位问题。
		- 桥面本身是水平朝下的面，会被 print3d_check 判为真悬垂——这是**正确**的，
		  桥接就是"不落支撑的悬垂"，不要因为它报警就去加支撑。

	期望值（默认参数）
		STL 体积 9.300 cm³，包围盒 37.00 × 56.00 × 15.00 mm，5 个独立实体，水密。
		真悬垂面积 ≈6.0 cm² = 五个桥面 (5+10+15+20+25) × 8 mm 宽。
		桥面下沿高度 11.50 mm（压进支柱 0.5 mm，避免共面并集）。

	参数
		span_1..5   五个桥面净跨 (mm)
		pillar_w    支柱沿 X 宽 (mm)
		pillar_d    支柱/桥面沿 Y 深 (mm)
		pillar_h    桥面下沿高度 (mm)
		beam_h      桥面厚度 (mm)
		gap         单元间距 (Y)
		embed       桥面压进支柱的深度，避免两个盒子共面接触
*/

/* [桥接跨度 (mm)] */
span_1 = 5;       // 最容易
span_2 = 10;      // 常规 FDM 能稳过
span_3 = 15;      // 开始考验冷却
span_4 = 20;      // 多数机器开始轻微下垂
span_5 = 25;      // 需要好冷却 / 低速度

/* [尺寸] */
pillar_w = 6;     // 支柱 X
pillar_d = 8;     // 支柱 / 桥面 Y
pillar_h = 12;    // 桥面下沿高度 (Z)
beam_h = 3;       // 桥面厚 (Z)
gap = 4;          // 单元间距 (Y)

/* [并集] */
embed = 0.5;      // 桥面压进支柱的深度 (mm)

assert(pillar_w > 0 && pillar_d > 0 && pillar_h > embed, "支柱尺寸不合法");

spans = [span_1, span_2, span_3, span_4, span_5];
n_units = len(spans);

module bridge_unit(span) {
	len = 2 * pillar_w + span;
	// 两根支柱
	cube([pillar_w, pillar_d, pillar_h]);
	translate([pillar_w + span, 0, 0]) cube([pillar_w, pillar_d, pillar_h]);
	// 桥面：压在支柱顶面下 embed 处起，保证与支柱体积相交
	translate([0, 0, pillar_h - embed]) cube([len, pillar_d, beam_h + embed]);
}

union() {
	for (i = [0:n_units - 1]) {
		translate([0, i * (pillar_d + gap), 0]) bridge_unit(spans[i]);
	}
}
