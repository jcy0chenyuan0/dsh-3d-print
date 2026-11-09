/*
	overhang-stairs — 免支撑临界角阶梯（30/40/45/50/60/70°）

	测什么
		六片悬臂，斜面与**竖直方向**的夹角分别为 30/40/45/50/60/70°。
		角度越大越难打；FDM 常规判据是 45°（即斜面与水平面成 45°）起开始退化。

	怎么判读
		- 从 30° 往上打，第一片出现下垂/毛糙/分层的那一档，就是本机的免支撑临界角。
		- 40° 及以下应当完全平整；45° 是分界，边缘轻微毛糙可接受；
		  50° 以上底面开始拉丝、下垂，60/70° 基本一定要支撑。
		- 只毛糙、能连成一片 = 还能打；底面塌陷、出现悬空丝 = 已过临界角。
		- 记下角度后，建模时把所有朝下的斜面控制在临界角以内（本插件
		  print3d_check 的"真悬垂"就是按这个角度判的）。
		- 注意量角基准：这里量的是**斜面与竖直方向**的夹角。print3d_check 输出的
		  theta 是斜面与**水平面**的夹角，两者互补：theta = 90° - 本图角度。
		  所以 50° 片在体检里 theta≈40°（会被算作真悬垂），45° 片 theta≈45°（正好在边界）。

	期望值（默认参数）
		STL 体积 ≈14.8 cm³，包围盒 24.90 × 60.50 × 23.00 mm，6 个独立实体，水密。
		真悬垂面积 ≈4.3 cm²：恰好是 50/60/70 三片的斜面（3 × 18 × 8 = 432 mm²），
		30/40 片因为 theta≥45° 不计入，45 片在边界上（通常也不计入）。
		如果体检报出的悬垂面积远大于 4.3 cm²，说明斜面角没被正确识别。

	参数
		angle_1..6  六片斜面与竖直方向的夹角（度）
		reach       斜面长度 (mm)：决定悬臂伸出多远，也直接决定悬垂面积
		fin_t       每片沿 Y 的厚度 (mm)
		fin_h       台面以上每片的竖直高度 (mm)
		gap         片间净距 (Y)
		base_h      台面高度 (mm)：斜面从台面顶起算，不贴床，避免被"贴床面"豁免
		margin      台面左右外扩 (mm)
*/

/* [悬臂角（自竖直方向量）] */
angle_1 = 30;     // 第 1 片：最容易
angle_2 = 40;     // 第 2 片
angle_3 = 45;     // 第 3 片：FDM 经典分界
angle_4 = 50;     // 第 4 片：开始需要留意
angle_5 = 60;     // 第 5 片
angle_6 = 70;     // 第 6 片：基本必须支撑

/* [尺寸] */
reach = 18;       // 斜面长度 (mm)
fin_t = 8;        // 每片厚度 (Y)
fin_h = 20;       // 台面以上竖直高度 (Z)
gap = 2.5;        // 片间净距 (Y)

/* [底座] */
base_h = 3;       // 台面高度 (mm)
margin = 4;       // 台面外扩 (mm)
embed = 1;        // 斜面在台面内部多埋入的长度，保证是体积相交而不是刀刃接触
assert(reach > 0 && fin_h > 2, "reach / fin_h 必须 > 0");
assert(base_h > embed * 1.8, "base_h 太小：embed 会把片底切到 z<0");

angles = [angle_1, angle_2, angle_3, angle_4, angle_5, angle_6];
n_fins = len(angles);
max_reach = max([for (a = angles) reach * sin(a)]);
plate_w = margin + max_reach + margin;
total_y = n_fins * fin_t + (n_fins - 1) * gap;

module stair(beta, y0) {
	x1 = margin + reach * sin(beta);
	z1 = base_h + reach * cos(beta);
	top = base_h + fin_h;
	// 把斜面沿自身方向往台面里延长 embed：几何角仍是精确的 beta，
	// 但和台面是体积相交（并集干净），而不是只有一条公共棱。
	x0 = margin - embed;
	z0 = base_h - embed / tan(beta);
	assert(z0 > 0.2, "base_h / embed 组合会让斜面切到 z<0");
	assert(z1 < top - 1, "fin_h 太小：加大 fin_h 或减小 reach");
	// rotate([90,0,0]) 把 2D 轮廓的 (x,y) 映射成 3D 的 (x,z)，挤出方向是 -Y，
	// 所以整体平移 y0+fin_t 之后正好占据 [y0, y0+fin_t]。
	translate([0, y0 + fin_t, 0])
		rotate([90, 0, 0])
			linear_extrude(height = fin_t)
				polygon([[x0, z0], [x1, z1], [x1, top], [x0, top]]);
}

module base_plate() {
	cube([plate_w, total_y, base_h]);
}

union() {
	base_plate();
	for (i = [0:n_fins - 1]) {
		translate([0, i * (fin_t + gap), 0]) stair(angles[i], 0);
	}
}
