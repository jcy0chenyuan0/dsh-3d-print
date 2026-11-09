/*
	hole-compensation — 圆孔阵列 / 孔径补偿标定（5/8/10 mm）

	测什么
		一块 5 mm 厚板上开 5 / 8 / 10 mm 三个通孔。打出来用卡尺或塞规量
		**实际孔径**，差值就是这台机器在该孔径上的孔收缩量。

	怎么判读
		- 补偿量 = 设计孔径 - 实测孔径（通常为正值，FDM 上 0.1–0.3 mm 很常见）。
		- 三个孔径的收缩量不应该差太多；如果 5 mm 孔缩得特别多（>0.3），
		  是圆弧近似 + 层宽不足，换 $fn 更大或加流量能改善。
		- 把测得的补偿量填回 comp（或用 print3d_parts 传 params {"comp": 0.2}），
		  重新导出 → 孔直接画大，外轮廓不受影响。这比切片器里的
		  XY 尺寸补偿更准，因为那份补偿会连外轮廓一起放大。
		- 量孔用内测爪，量三个方向取平均；孔口的喇叭口（第一层塌陷）不要量进去。

	期望值（默认参数）
		STL 体积 6.258 cm³，包围盒 70.00 × 20.00 × 5.00 mm，单实体，水密。
		comp=0 时三个孔的模型直径就是 5 / 8 / 10 mm（$fn=64 正圆）。

	参数
		d_1..3      三个设计孔径 (mm)
		comp        统一加在孔径上的补偿量 (mm)：正值放大孔，负值缩小孔
		plate_w/d/h 板的宽 / 深 / 厚 (mm)
		margin_x    第一个孔中心距板左边缘 (mm)
		pitch       孔间距 (X)
		fn          圆周分段数（孔越小越要够，建议 >= 48）
*/

/* [设计孔径 (mm)] */
d_1 = 5;          // 小孔
d_2 = 8;          // 中孔
d_3 = 10;         // 大孔

/* [间隙补偿 (mm)] */
comp = 0;         // 正值把孔放大：量出缩 0.2 就填 0.2

/* [基板] */
plate_w = 70;     // X
plate_d = 20;     // Y
plate_h = 5;      // Z

/* [布局] */
margin_x = 15;    // 第一个孔中心 X
pitch = 20;       // 孔间距 (X)

/* [网格] */
fn = 64;

holes = [d_1, d_2, d_3];
n_holes = len(holes);

assert(min(holes) > 0, "孔径必须 > 0");
assert(comp > -1 && comp < 2, "comp 超出合理范围（-1 .. 2 mm）");
assert(margin_x + (n_holes - 1) * pitch < plate_w, "孔位超出板宽：加大 plate_w 或减小 pitch");

difference() {
	cube([plate_w, plate_d, plate_h]);
	for (i = [0:n_holes - 1]) {
		// 上下各多切 1 mm，保证通孔，不在板面留零厚度面
		translate([margin_x + i * pitch, plate_d / 2, -1])
			cylinder(h = plate_h + 2, d = holes[i] + comp, $fn = fn);
	}
}
