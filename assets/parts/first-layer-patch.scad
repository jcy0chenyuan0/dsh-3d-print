/*
	first-layer-patch — 首层压合补丁（80×80 单层）

	测什么
		一张 80×80、厚度单层的平片。首层是最难的一层：它决定贴床、翘边和
		之后的每一层能不能长在上面。这张片子把首层的状态放大到一眼能看。

	怎么判读
		- 整片均匀半透明、丝与丝之间没有缝、边缘不翘 = 首层合格。
		- 丝之间有缝：喷嘴离床太远（z-offset 正偏），调低。
		- 表面被压得发亮、边缘挤出料被推成小鳍：喷嘴太低（z-offset 负偏）。
		- 四角翘起：床温不够 / 冷却过早 / 首层太慢。
		- 局部发白、粘不住：该处床面有油或不平，清洁或换贴面。
		- patch_h 一般填切片器里的**首层高**（0.2 / 0.24 / 0.28），
		  这样量出来的片厚既是首层高，也是首层是否被压的依据。
		- notch > 0 会在左上角切个方口，用来分辨朝向（判断哪边是 X+）。

	期望值（默认参数）
		STL 体积 1.280 cm³，包围盒 80.00 × 80.00 × 0.20 mm，单实体，水密。
		片厚 = patch_h（默认 0.20 mm）。

	参数
		patch_w/d  补丁宽 / 深 (mm)
		patch_h    单层厚度 (mm)
		notch      左上角缺口边长 (mm)，0 = 不要
*/

/* [补丁尺寸] */
patch_w = 80;     // X
patch_d = 80;     // Y
patch_h = 0.2;    // 单层厚：填切片器的首层高（0.2 / 0.24 / 0.28）

/* [朝向标记] */
notch = 0;        // 左上角切掉 notch × notch，0 = 不切

assert(patch_w > 0 && patch_d > 0, "补丁尺寸必须 > 0");
assert(patch_h > 0 && patch_h <= 1, "patch_h 是单层厚度，应在 (0, 1] mm");
assert(notch >= 0 && notch < min([patch_w, patch_d]) / 2, "notch 太大");

difference() {
	cube([patch_w, patch_d, patch_h]);
	if (notch > 0) {
		translate([-0.01, patch_d - notch, -0.01])
			cube([notch + 0.01, notch + 0.01, patch_h + 0.02]);
	}
}
