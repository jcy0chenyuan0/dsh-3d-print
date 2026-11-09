/*
	tolerance-gauge — 销孔配合 / 间隙补偿样件

	测什么
		一块 5 mm 厚板上开 5 个通孔，孔径 3.0 / 3.1 / 3.2 / 3.4 / 3.6 mm，
		旁边单独打一根 3.0 mm 的测试销。销能插进哪一档，就说明本机
		"孔的实际直径"比设计值小多少——也就是切片器/机器需要的间隙补偿量。

	怎么判读
		- 逐个试插：销能自由滑入、且不晃的最大孔径 = 你的"最小可用间隙"。
		- 3.0 孔能进：机器孔偏大或配合松（间隙补偿该往负调）。
		- 3.2 孔才进：孔实际缩小约 0.2 mm，属 FDM 常见量级（热收缩 + 圆弧内缩）。
		- 3.6 孔才进：偏大，查挤出过量、皮带松、或是孔内有毛刺。
		- 记住"设计孔径 → 实际可用孔径"的差值，建模时把孔直接画大同等量，
		  比在切片器里调 XY 补偿更可控（补偿会同时改外轮廓）。
		- 销本身也是直径检具：卡尺量销的实际直径，和 3.0 比对。

	期望值（默认参数）
		STL 体积 5.896 cm³，包围盒 70.00 × 20.00 × 10.00 mm，2 个独立实体
		（板 + 销），水密。孔壁是 $fn=48 的正圆，模型孔径就是设计值。

	参数
		hole_1..5   五个孔径 (mm)
		pin_d/pin_h 测试销直径 / 高度 (mm)
		plate_w/d/h 板的宽 / 深 / 厚 (mm)
		hole_x0     第一个孔的中心 X
		hole_pitch  孔间距 (X)
		pin_x       销的中心 X
*/

/* [孔径阶梯 (mm)] */
hole_1 = 3.0;     // 名义尺寸：能进说明配合偏松
hole_2 = 3.1;
hole_3 = 3.2;     // FDM 上最常见的"刚好能进"
hole_4 = 3.4;
hole_5 = 3.6;     // 最松

/* [测试销] */
pin_d = 3.0;      // 销直径 (mm)
pin_h = 10;       // 销高 (mm)

/* [基板] */
plate_w = 60;     // X
plate_d = 20;     // Y
plate_h = 5;      // Z（越厚孔越容易偏小）

/* [布局] */
hole_x0 = 10;     // 第一个孔中心 X
hole_pitch = 11;  // 孔间距 (X)
pin_x = 67;       // 销中心 X：放在板右侧，和板一起打

/* [网格] */
fn = 48;

holes = [hole_1, hole_2, hole_3, hole_4, hole_5];
n_holes = len(holes);

assert(min(holes) > 0 && pin_d > 0, "孔径 / 销径必须 > 0");
assert(hole_x0 + (n_holes - 1) * hole_pitch < plate_w, "孔位超出板宽：加大 plate_w 或减小 hole_pitch");
assert(pin_x - 3 > plate_w, "销和板会叠在一起：加大 pin_x");

module tolerance_plate() {
	difference() {
		cube([plate_w, plate_d, plate_h]);
		for (i = [0:n_holes - 1]) {
			// 上下各多切 1 mm，保证是通孔，且不会在板面留下零厚度的面
			translate([hole_x0 + i * hole_pitch, plate_d / 2, -1])
				cylinder(h = plate_h + 2, d = holes[i], $fn = fn);
		}
	}
}

module test_pin() {
	// 小垫片让 3 mm 细销能被热床抓住；销从 z=0 起，和垫片体积相交
	translate([pin_x - 3, plate_d / 2 - 3, 0]) cube([6, 6, 1.2]);
	translate([pin_x, plate_d / 2, 0]) cylinder(h = pin_h, d = pin_d, $fn = fn);
}

union() {
	tolerance_plate();
	test_pin();
}
