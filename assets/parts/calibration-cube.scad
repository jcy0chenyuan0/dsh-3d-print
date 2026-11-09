/*
	calibration-cube — 20 mm XYZ 尺寸 / 轴校准立方体

	测什么
		打印一个 20×20×20 的立方，用卡尺量 X / Y / Z 三个方向。
		这是整套标准体里最基础的一件：它先证明机器"尺寸可信"，
		后面的流量、悬垂、桥接判读才有意义。

	怎么判读
		- 三个方向都应为 20.00 ±0.05 mm。
		- 偏大：挤出过量（flow >100%），或切片器的 XY 补偿为正。
		- 偏小：流量不足、皮带张力不够、Steps/mm 偏小。
		- X 与 Y 相差 >0.1 mm：两轴不一致，查皮带 / 两轴 Steps/mm。
		- 只 Z 偏小 0.1–0.3 mm：通常是首层被压（z-offset 偏低），不是步进问题。
		- 顶面有凹陷 / 立柱间有缝：顶面层数不足（top solid layers 少于 4）。

	期望值（默认参数）
		STL 体积 8.000 cm³，包围盒 20.00 × 20.00 × 20.00 mm，水密、单实体。
		开 chamfer 后体积会变小，判读尺寸时只量下部直壁。

	参数
		size     边长 (mm)
		chamfer  >0 时把顶面四条边削成 45° 倒角（便于观察顶面接缝）
*/

/* [尺寸] */
size = 20;        // 边长 (mm)：量 X/Y/Z，期望 20.00 ±0.05

/* [顶面倒角] */
chamfer = 0;      // 顶面 45° 倒角 (mm)：0 = 纯立方

assert(size > 0, "size 必须 > 0");
assert(chamfer >= 0 && chamfer < size / 2, "chamfer 必须 >= 0 且 < size/2");

module calibration_cube(s = size, c = chamfer) {
	if (c <= 0) {
		// 纯立方：没有圆角、没有倒角，STL 就是 12 个面，量出来的就是机器的真实误差
		cube([s, s, s]);
	} else {
		// 只削顶面：底块保持全尺寸直壁，顶块内缩，凸包给出四面 45° 倒角。
		// 这样直壁仍然从 z=0 一直量到 s-c，不会因为倒角把尺寸基准弄丢。
		hull() {
			cube([s, s, s - c]);
			translate([c, c, s - c]) cube([s - 2 * c, s - 2 * c, c]);
		}
	}
}

calibration_cube();
