# dsh_3d print — DeepSeek Harness 的 3D 打印工作台

让模型**直接**做 3D 建模与打印，而不是在旁边出主意：OpenSCAD 参数化建模 → 网格体检 → 切片器直连 → Blender 查看/修改，八个工具一条链。

一句话验收：*给出一个 .scad，拿回一个已经体检过、能直接切的 STL。*

---

## 为什么需要它

模型自发写 STL 的可靠性很低（顶点、法线、水密性全是手工维护的坑）。OpenSCAD 把「几何 = 源码」这件事变成可复现的：参数改一个数字，模型跟着变，构建过程可审计。这个插件就是围绕这条主线做的：

- **渲染即体检**：`print3d_render` 出完 STL 立刻量体积/包围盒/水密/真悬垂/床内适配，不用再单独叫一次检查
- **判据写死在代码里**：真悬垂 = 朝下且与水平面夹角 < 45°（48° 斜挑的钩臂底面**不算**悬垂），这条最容易搞反，所以不交给调用方猜
- **外部工具全走一个进程 seam**：OpenSCAD、Blender、切片器、安装器都经过 `lib/core/proc.js`，会尊重会话的沙箱策略

## OpenSCAD 缺失时会自己装

第一次渲染发现本机没有 OpenSCAD 时，插件不会把「你去装一下」甩给你，而是当场装：

1. 并发测活所有源（winget / choco / scoop / GitHub 直链 / 4 个 gh 镜像），每个 4–6 s 超时
2. 按 **镜像 → 直链 → 包管理器** 的顺序尝试——前两种不需要提权，自动安装绝不能卡在一个没人点的 UAC 上
3. 下载 zip 解开，落到 **工作区里的便携目录** `<workspace>/<outDir>/_tools/openscad/`，跑一次 `--version` 验证
4. 验过就把路径缓存起来，本次进程后续调用直接用；下次开新会话时 `resolve()` 会先找这个便携目录

为什么装在**工作区**而不是 `%LOCALAPPDATA%`：`workspace-write` 会话只允许写工作区，写到外面必然失败；`%TEMP%` 同理（下载暂存目录也跟着落在 `<outDir>/_tools/_stage`）。这个设计是实测踩出来的——早先的版本在只写工作区的会话里，四个镜像全被误判成「不通」，其实只是暂存目录写不进去。

要装到系统里（带卸载项、多用户可见）就显式调 `print3d_setup {"action":"install","confirm":true}`，它会给 winget/choco/scoop 的计划。

自测这条路径不需要卸载任何东西：

```bash
DSH_3DPRINT_IGNORE_OPENSCAD=1 node tests/run-tool.mjs print3d_render '{"source":"models/x.scad"}'
```

这个环境变量只隐藏「发现」这一步，专门用来验证自动安装链路。

## 工具

| 工具 | 做什么 |
| --- | --- |
| `print3d_doctor` | 自检环境：OpenSCAD / Blender / 各家切片器的路径、版本、CLI 能力，缺什么、下一步调谁 |
| `print3d_setup` | 装 OpenSCAD（也可 Blender）：`plan` 看计划、`probe` 并发测活选源、`install` 真装（必须 `confirm:true`） |
| `print3d_render` | `.scad` → STL/3MF/OFF/AMF/CSG/DXF/SVG/PNG，支持 `-D` 参数覆盖与相机，网格格式自动体检 |
| `print3d_check` | 任意 STL 体检：水密/法线/实体数/体积/包围盒/真悬垂（附按高度分布）/贴床面/最优摆放 |
| `print3d_parts` | 内置标准测试体库：`list` / `info` / `export`（导出即校验期望值） |
| `print3d_slice` | 切片器兼容层：`detect` / `slice`（真跑 CLI 出 gcode）/ `open`（丢给 GUI） |
| `print3d_blender` | Blender 桥：`detect` / `inspect` / `open` / `export`（GLB）/ `edit`（布尔、重网格）/ `preview` |
| `print3d_selftest` | 内置回归：逐个真渲染标准体 → 按期望值判定 → 汇总通过率 |

## 安装

```bash
plugin_manager  action=install_bundle
                target=<本目录绝对路径>
```

`cordis.patch.yml` 里用的是**绝对路径**而不是包名——profile 对裸包名的解析走的是已安装 Harness 自己的模块树（`app.asar` 内），写包名会在加载时 404。仓库搬家后改那一行即可。

装完在 GUI「设置 → 插件」里能看到「3D 打印工作台」，可整体停用。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `outDir` | `3dprint` | 产物目录，相对会话工作区 |
| `printer` | `creality-hi` | 默认机型（19 个预设，见 `lib/core/printers.js`） |
| `openscadPath` / `blenderPath` | 自动发现 | 显式指定可跳过探测 |
| `renderTimeoutMs` | 600000 | 渲染超时（`$fn=200` 的大模型会很慢） |
| `sliceTimeoutMs` | 1800000 | 切片超时 |
| `overhangDeg` | 45 | 悬垂判据角度 |
| `bedEps` | 1.0 | 多少 mm 内算贴床面 |
| `autoInstall` | true | 允许 `print3d_setup` 直接装 |

## 典型流程

```
1. print3d_doctor                                  # 环境对不对
2. 写 model.scad（参数化）
3. print3d_render {source:"model.scad"}            # 出 STL + 体检
4. 照体检结论改几何（悬垂 > 5 cm² 就加倒角/改角度/减跨度）
5. print3d_slice {action:"slice", input:"..."}     # 真出 gcode
6. print3d_blender {action:"preview"}              # 要图给图，要改就让 Blender 改
```

## 本机实测结论（Creality Hi + Creality Print 7.3）

- `print3d_render` 渲 148×41.6×64.8 的钩架：12 726 面、54.33 cm³、水密、真悬垂 3.96 cm²（1.8%），22.9 s
- `print3d_slice` 真出 gcode：`CrealityPrint.exe --cli --slice 0 --outputdir <dir> --need-gcode-file --load-settings "<machine>;<process>" --load-filaments <filament> model.stl`
  - 坑：选项用**连字符**（`--load-settings`，下划线报 `Invalid option`）；`--load-settings` 值是**分号分隔**且空格路径可用；**没有 `--need-gcode-file` 时只校验不写文件**；裸 `--help` 会被 GUI 接管，只能 `--cli --help`

## 目录

```
lib/index.js              apply()：注册 8 个工具，共享 core
lib/core/proc.js          进程 seam（沙箱感知）+ PATH 扫描
lib/core/paths.js         工作区相对路径策略（禁止 .. 逃逸）
lib/core/stl.js           STL 解析、体积、边拓扑、真悬垂、最优摆放
lib/core/openscad.js      OpenSCAD 发现与渲染/预览
lib/core/printers.js      19 个机型预设
lib/core/slicers.js       9 个切片器家族的探测与三种 CLI 方言
lib/core/slicer-profiles.js  机型 → 各家族 process 参数
lib/core/install.js       安装源（winget/choco/scoop/直链/4 个镜像）+ 并发测活
lib/core/tools-detect.js  OpenSCAD / Blender / 切片器 探测
lib/core/parts.js         标准体注册表与期望值
lib/core/blender.js       Blender 发现与无头执行
assets/parts/*.scad       10 个标准测试体
blender/*.py              在 Blender 里跑的脚本（inspect/import/export/…）
tests/harness.mjs         假的 ctx（可直接脱离 Harness 驱动工具）
tests/run-tool.mjs        单工具跑批入口
```

## 开发

```bash
NODE="<dsh runtime>/node/bin/node.exe"
node tests/run-tool.mjs print3d_doctor '{}' --cwd /tmp/w
node tests/run-tool.mjs print3d_render '{"source":"models/x.scad"}' --cwd /tmp/w
node tests/run-tool.mjs print3d_selftest '{}' --cwd /tmp/w
```

`tests/harness.mjs` 用 `node:child_process` 实现 `ctx.subprocess`，所以工具的真实执行路径（含 spawn 与超时）在 Harness 外就能跑通。

## 已知限制

- 只解析 **STL**；3MF/OBJ 要先转（切片器或 Blender 都能转）
- 自动安装的两个坑已经修掉，但值得记着：**必须选 `.zip` 资源**（NSIS 安装器要管理员权限，自动安装会死在一个没人点的 UAC 上）；**下载暂存目录必须可写**（`%TEMP%` 在 `workspace-write` 会话里写不进去，会被误判成"镜像不通"）
- 自动安装的"下载 → 解压 → 验证"链路：下载实测成功过（抓到 21.8 MB 官方安装包），便携目录被发现并成功渲染也验证过；但**完整的一次 `下载 zip → 解压 → 自动渲染` 没能在网络完全不可达的时段端到端复跑**（四个镜像 6 s 全超时）
- 安装器静默安装（`/S`、`winget install`，即 `print3d_setup` 的机器级路线）可能弹 UAC，**那一步无法自动确认**，只以装完能否 `resolve` 到版本为准
- OrcaSlicer / Bambu Studio / PrusaSlicer / SuperSlicer / Cura 的代码路径按各自 CLI 方言写好，但**本机没装，只有 Creality Print 做过端到端验证**；其它家族的可切能力靠运行时读 `--help` 判定，不做硬编码假设
- Prusa/Orca 没有逐项参数开关（不存在 `--layer-height`），层高/填充只能经 `extraArgs` 传 `--load <ini>`，本插件不硬造
- Blender GUI 动作是尽力而为：进程 seam 没有"脱离式启动"，超时会结束进程，因此结果里始终附一条可点的命令行；本机实测 GUI 进程约 10 s 后自行退出（疑似远程会话拿不到 OpenGL 上下文），所以 `open` 只承诺"进程起来了"

## 许可

MIT。标准测试体的几何尺寸取自公开的 3D 打印标定惯例（20 mm 立方、45° 悬垂、桥接跨度等），源码为本仓库原创。
