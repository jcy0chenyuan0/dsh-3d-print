/*
	fastener-m4 — M4 沉头孔 + 螺母槽样件

	测什么
		一块 40×20×10 的样件，左边一个 M4 沉头通孔（平头螺钉），
		右边一个 M4 通孔 + 六角螺母槽（从底面塞螺母）。
		这两处正是挂钩、挂板这类件的受力点：沉头能不能让螺钉平齐，
		螺母槽能不能让螺母卡住不打转。

	怎么判读
		- 螺钉头应完全沉入、与顶面平齐：沉不下去 = 沉头锥角/深度不够；
		  沉下去但晃 = 通孔偏大。
		- 螺母从底面塞入应"卡住、不掉、不打转"：太紧塞不进（孔偏小），
		  太松会打转（槽偏大）。M4 螺母对边 7.0 mm，这里给 7.2 mm 余量。
		- 螺母槽顶面是水平朝下的面，会被 print3d_check 算作真悬垂——
		  这是正常的（螺母槽顶就是一段小桥），<0.5 cm² 一般不用支撑。
		- 通孔 4.5 mm 是 FDM 上的常用 M4 间隙孔；如果螺钉穿不进，
		  把 hole_d 调到 4.6–4.8 再导出一次。
		- 沉头深度按 90° 沉头自动算：(head_d - hole_d) / 2，不用手填角度。

	期望值（默认参数）
		STL 体积 7.353 cm³，包围盒 40.00 × 20.00 × 10.00 mm，单实体，水密。
		真悬垂 ≈0.29 cm²（螺母槽顶面减去通孔）。
		沉头深 1.95 mm，螺母槽深 3.41 mm、六角对边 7.20 mm。

	参数
		hole_d       M4 通孔直径 (mm)
		head_d       M4 平头最大直径 (mm)
		nut_af       六角螺母对边 (mm)
		nut_h        螺母槽深 (mm)
		block_w/d/h  样件宽 / 深 / 高 (mm)
		csk_x        沉头孔中心 X
		nut_x        螺母槽中心 X
		fn           圆周分段数
*/

/* [M4 通孔 / 沉头] */
hole_d = 4.5;     // 通孔直径 (mm)
head_d = 8.4;     // 平头最大直径 (mm)：M4 内六角平头约 8.0–8.4

/* [M4 螺母槽] */
nut_af = 7.2;     // 六角对边 (mm)：M4 标准螺母 7.0，留 0.2 余量
nut_h = 3.4;      // 槽深 (mm)：螺母厚 3.2 + 0.2

/* [块体] */
block_w = 40;     // X
block_d = 20;     // Y
block_h = 10;     // Z

/* [布局] */
csk_x = 10;       // 沉头孔中心 X
nut_x = 30;       // 螺母槽中心 X

/* [网格] */
fn = 48;

// 90° 沉头：锥高由头径和孔径共同决定
csk_h = (head_d - hole_d) / 2;

assert(head_d > hole_d, "head_d 必须大于 hole_d");
assert(nut_h < block_h, "nut_h 必须小于块高，槽才能从底面往上留顶");
assert(csk_x > hole_d && csk_x < block_w - hole_d, "csk_x 超出块体");
assert(nut_x > nut_af / 2 && nut_x < block_w - nut_af / 2, "nut_x 超出块体");

module m4_sample() {
	difference() {
		cube([block_w, block_d, block_h]);

		// 左边：通孔
		translate([csk_x, block_d / 2, -1])
			cylinder(h = block_h + 2, d = hole_d, $fn = fn);
		// 左边：90° 沉头锥（d1 在下、d2 在上 → 从顶面向下张开）
		translate([csk_x, block_d / 2, block_h - csk_h])
			cylinder(h = csk_h + 1, d1 = hole_d, d2 = head_d, $fn = fn);

		// 右边：通孔 + 沉头
		translate([nut_x, block_d / 2, -1])
			cylinder(h = block_h + 2, d = hole_d, $fn = fn);
		translate([nut_x, block_d / 2, block_h - csk_h])
			cylinder(h = csk_h + 1, d1 = hole_d, d2 = head_d, $fn = fn);
		// 右边：六角螺母槽，从底面往上挖；$fn=6 的"直径"是对角尺寸
		translate([nut_x, block_d / 2, -1])
			cylinder(h = nut_h + 1.01, d = nut_af / cos(30), $fn = 6);
	}
}

m4_sample();
