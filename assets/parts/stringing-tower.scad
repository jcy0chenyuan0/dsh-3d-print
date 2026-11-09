/*
	stringing-tower — 双塔回缩 / 拉丝测试

	测什么
		两根 10 mm 直径、30 mm 高的圆柱，净距 40 mm。打印时喷嘴要在两塔
		之间空驶几十次，回缩（retraction）调得对不对，一眼就能看出来。

	怎么判读
		- 塔身之间干干净净 = 回缩量合适。
		- 细丝像蜘蛛网：回缩量不够 / 回缩速度太慢 / 温度太高。
		- 塔身上有疙瘩、缺料：回缩量过大（把熔料抽回热区），或回缩后补偿不足。
		- 只在一侧拉丝：喷嘴在空驶起点漏料，加"空驶前回缩"或抬 Z（Z-hop 0.2–0.4）。
		- 调参顺序：先降 5 °C 看拉丝是否减少 → 再动回缩量（每次 0.2 mm）。
		  温度的影响通常比回缩量更大。
		- 两根塔也顺便测"同层两次定位"：如果第二根塔的层纹和前一根错位，
		  说明 XY 定位或皮带松。

	期望值（默认参数）
		STL 体积 4.939 cm³，包围盒 14.00 × 64.00 × 30.00 mm，2 个独立实体，水密。
		塔心距 50 mm（净距 40 mm），贴床垫直径 14 mm。

	参数
		tower_d     塔直径 (mm)
		tower_h     塔高 (mm)
		gap         两塔净距 (mm)：越大空驶越久，拉丝越明显
		base_d      贴床垫直径 (mm)
		base_h      贴床垫高 (mm)
		fn          圆周分段数
*/

/* [塔] */
tower_d = 10;     // 塔直径 (mm)
tower_h = 30;     // 塔高 (mm)
gap = 40;         // 两塔净距 (mm)

/* [贴床垫] */
base_d = 14;      // 垫直径 (mm)：比塔粗，帮助粘床
base_h = 1.5;     // 垫高 (mm)

/* [网格] */
fn = 48;

assert(tower_d > 0 && tower_h > 0, "塔尺寸必须 > 0");
assert(base_d > tower_d, "base_d 必须大于 tower_d，否则垫片看不见");
assert(gap > 0, "gap 必须 > 0");

center_y = tower_d + gap;

module tower(y0) {
	// 垫片和塔同轴、从 z=0 起，靠体积相交连成一体
	translate([0, y0, 0]) cylinder(h = base_h, d = base_d, $fn = fn);
	translate([0, y0, 0]) cylinder(h = tower_h, d = tower_d, $fn = fn);
}

tower(0);
tower(center_y);
