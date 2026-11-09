/**
 * print3d_blender — Blender as a second pair of hands on a mesh.
 *
 * The other tools in this plugin *read* geometry (check, slice) or *rebuild* it
 * from OpenSCAD source (render). This one is the only place a mesh can be
 * modified directly: convert to GLB for sharing, drill a hole with a boolean,
 * remesh a scan into a printable solid, and render the three views plus an
 * isometric that the model can actually look at.
 *
 * Every action is one headless Blender launch, and the facts come back through
 * the `[dsh3d]` marker rather than through Blender's own stdout — see
 * core/blender.js for why that distinction decides whether a failed cut looks
 * like a failed cut.
 */
import { mkdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import * as report from "../core/report.js";
import { stem } from "../core/paths.js";
import { createBlender, scriptPath } from "../core/blender.js";

const ACTIONS = ["detect", "inspect", "open", "export", "edit", "preview"];
const INPUT_EXTENSIONS = [".stl", ".obj", ".glb", ".gltf", ".blend", ".ply"];
const OPERATIONS = ["difference", "union", "intersect"];
const SHAPES = ["cube", "cylinder"];
const ORIENTS = ["keep", "min-height", "min-footprint"];

const DESCRIPTION = `用 Blender 查看和修改网格：格式转换（GLB）、打孔/开槽（boolean）、体素重网格（remesh）、三视图预览。

动作：
- detect：Blender 装在哪、什么版本、能不能跑无头脚本（顺带列出 STL/GLB/remesh 的真实能力）。
- inspect：从 Blender 视角看模型——对象数、面数、包围盒、体积、材质/修改器、非流形边。和 print3d_check 互补（那边量的是三角面汤，这边量的是场景）。
- open：拉起 Blender GUI 打开模型，给你自己手动改。**不等待窗口关闭**。
  params.saveBlend=true 时会先摆正/居中/贴地并另存成 .blend，再用 GUI 打开那个场景。
- export：转 GLB（可 decimate 减面、join 合并），给网页/分享/3D 查看器用。
- edit：在 Blender 里改几何。
  - params.op="boolean"：用一个立方/圆柱做差集，打孔、开槽、切平（默认圆柱贯穿孔）。
  - params.op="remesh"：体素重网格 + 平滑 + 可选减面，把扫描件/破面模型修成可打印件。
- preview：三视图（front/right/top）+ 等距图，workbench 秒出；再合成一张 2×2 拼图。

典型用法：
- 看 Blender 在不在：{"action":"detect"}
- 看一个 STL 在 Blender 里什么样：{"action":"inspect","input":"3dprint/build/part.stl"}
- 打一个 Ø6 通孔：{"action":"edit","input":"part.stl","params":{"op":"boolean","shape":"cylinder","diameter":6}}
- 开一条 10×40 的槽：{"action":"edit","input":"part.stl","params":{"op":"boolean","shape":"cube","box":[10,40,6]}}
- 修扫描件：{"action":"edit","input":"scan.stl","params":{"op":"remesh","voxel":0.4,"smooth":3}}
- 减面转 GLB：{"action":"export","input":"part.stl","params":{"decimate":0.4,"join":true}}
- 出预览图：{"action":"preview","input":"part.stl"}

约定与坑：
- 单位全程 mm（STL 无单位，按 1 单位 = 1 mm 读）。
- 无头 Blender 启动慢（3–10 s），timeoutMs 默认 300000；超时先加大它再怀疑模型。
- 布尔用 EXACT 求解器：FAST 在"孔穿过平面"这种共面情形会留裂缝。
- 减面是破坏性的：立方体减 50% 会直接塌成斜面，减面前先看 inspect 的面数。
- 只做只读探测，不会装 Blender；要装用 print3d_setup {"target":"blender","action":"install","confirm":true}。
关键词/keywords: Blender, GLB, STL, remesh, boolean, decimate, preview, headless, bpy。`;

/** Bounding box schema, reused by the model report. */
const BBOX_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		min: { type: "array", items: { type: "number" } },
		max: { type: "array", items: { type: "number" } },
		size: { type: "array", items: { type: "number" } }
	},
	required: ["min", "max", "size"]
};

const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string", enum: ACTIONS },
		ok: { type: "boolean" },
		elapsedMs: { type: "number" },
		blender: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				version: { type: "string" },
				source: { type: "string" }
			},
			required: ["path"]
		},
		argv: { type: "array", items: { type: "string" } },
		artifacts: { type: "array", items: { type: "string" } },
		artifactsAbsolute: { type: "array", items: { type: "string" } },
		warnings: { type: "array", items: { type: "string" } },
		next: { type: "string" },
		detect: {
			type: "object",
			additionalProperties: false,
			properties: {
				found: { type: "boolean" },
				path: { type: "string" },
				version: { type: "string" },
				source: { type: "string" },
				reason: { type: "string" },
				scriptOk: { type: "boolean" },
				probeMs: { type: "number" },
				python: { type: "string" },
				capabilities: {
					type: "object",
					additionalProperties: false,
					properties: {
						stlImport: { type: "boolean" },
						stlExport: { type: "boolean" },
						objImport: { type: "boolean" },
						gltfExport: { type: "boolean" },
						voxelRemesh: { type: "boolean" },
						engines: { type: "array", items: { type: "string" } }
					}
				},
				scripts: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							name: { type: "string" },
							exists: { type: "boolean" }
						},
						required: ["name", "exists"]
					}
				},
				tried: { type: "array", items: { type: "string" } }
			},
			required: ["found"]
		},
		model: {
			type: "object",
			additionalProperties: false,
			properties: {
				totals: {
					type: "object",
					additionalProperties: false,
					properties: {
						objects: { type: "integer" },
						faces: { type: "integer" },
						triangles: { type: "integer" },
						vertices: { type: "integer" },
						volumeCm3: { type: "number" }
					},
					required: ["objects", "faces", "triangles", "vertices", "volumeCm3"]
				},
				bbox: BBOX_SCHEMA,
				sizeMm: { type: "array", items: { type: "number" } },
				watertight: { type: "boolean" },
				openEdges: { type: "integer" },
				nonManifoldEdges: { type: "integer" },
				materials: { type: "array", items: { type: "string" } },
				welded: { type: "boolean" },
				objects: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							name: { type: "string" },
							faces: { type: "integer" },
							triangles: { type: "integer" },
							vertices: { type: "integer" },
							volumeCm3: { type: "number" },
							watertight: { type: "boolean" },
							openEdges: { type: "integer" },
							nonManifoldEdges: { type: "integer" },
							materials: { type: "array", items: { type: "string" } },
							modifiers: { type: "array", items: { type: "string" } }
						},
						required: ["name", "faces", "triangles", "vertices"]
					}
				}
			},
			required: ["totals", "bbox", "sizeMm", "watertight"]
		},
		open: {
			type: "object",
			additionalProperties: false,
			properties: {
				file: { type: "string" },
				blend: { type: "string" },
				mode: { type: "string" },
				launched: { type: "boolean" },
				pid: { type: "number" },
				note: { type: "string" }
			},
			required: ["file", "mode", "launched", "note"]
		},
		export: {
			type: "object",
			additionalProperties: false,
			properties: {
				file: { type: "string" },
				bytes: { type: "number" },
				trianglesBefore: { type: "integer" },
				trianglesAfter: { type: "integer" },
				ratio: { type: "number" },
				volumeBeforeCm3: { type: "number" },
				volumeAfterCm3: { type: "number" },
				decimate: { type: "number" },
				joined: { type: "boolean" },
				objects: { type: "integer" }
			},
			required: ["file", "bytes", "trianglesBefore", "trianglesAfter"]
		},
		edit: {
			type: "object",
			additionalProperties: false,
			properties: {
				op: { type: "string", enum: ["boolean", "remesh"] },
				file: { type: "string" },
				bytes: { type: "number" },
				operation: { type: "string" },
				solver: { type: "string" },
				cutter: { type: "string" },
				steps: { type: "array", items: { type: "string" } },
				changed: { type: "boolean" },
				facesBefore: { type: "integer" },
				facesAfter: { type: "integer" },
				volumeBeforeCm3: { type: "number" },
				volumeAfterCm3: { type: "number" },
				removedCm3: { type: "number" },
				watertightAfter: { type: "boolean" },
				openEdgesAfter: { type: "integer" },
				sizeBeforeMm: { type: "array", items: { type: "number" } },
				sizeMm: { type: "array", items: { type: "number" } }
			},
			required: ["op", "file", "facesBefore", "facesAfter"]
		},
		preview: {
			type: "object",
			additionalProperties: false,
			properties: {
				files: { type: "array", items: { type: "string" } },
				sheet: { type: "string" },
				engine: { type: "string" },
				sizePx: { type: "integer" },
				views: { type: "array", items: { type: "string" } }
			},
			required: ["files", "views", "engine"]
		}
	},
	required: ["action", "ok", "elapsedMs", "warnings"]
};

export function create(shared) {
	// `report` is taken from the module import rather than from `shared`: both are
	// the same module, and destructuring it here would shadow the import that the
	// module-level renderers use.
	const { proc, paths, settings } = shared;
	const blender = createBlender(proc, settings);

	/**
	 * Refuse to spawn Blender when the answer is already known, because a failed
	 * spawn reports "exit 1" and the useful part — install it, or point
	 * blenderPath at it — has to come from us.
	 */
	function notReady(found) {
		if (found.found !== true) {
			return [
				`没有找到 Blender${found.reason !== undefined ? `（${found.reason}）` : ""}。三条路，任选一条：`,
				'1) 让它装（约 350 MB，走 winget）：print3d_setup {"target":"blender","action":"install","confirm":true}',
				"2) 手动装官方版 https://www.blender.org/download/ ，默认会落在 C:\\Program Files\\Blender Foundation\\Blender <版本>\\，装完直接重跑本工具；",
				"3) 装在别处的话，把 blender.exe 的完整路径写进插件配置 blenderPath。",
				`已经找过：${found.tried.map((entry) => entry.path).join("、") || "(无可探测位置)"}`,
				"想看完整环境判断：print3d_doctor。"
			].join("\n");
		}
		return [
			`Blender 找到了（${found.path}），但没法跑无头脚本。`,
			found.probe?.timedOut === true
				? "探测超时：首次启动可能被杀毒软件扫描拖住，重试一次通常就好。"
				: "常见原因：安装不完整、被杀软拦住、或者装的是没有 Python 的精简版。",
			...toDetailLines(found.probe?.detail, 6),
			'下一步：重跑 print3d_doctor 确认；仍不行就重装：print3d_setup {"target":"blender","action":"install","confirm":true}。'
		].join("\n");
	}

	async function requireBlender() {
		const found = await blender.resolve();
		if (found.found === true && found.probe?.ok === true) return found;
		throw new Error(notReady(found));
	}

	/**
	 * Run one script and turn "no payload / non-zero exit" into a message that
	 * says what to try next. The exact argv is included: a user or a model can
	 * re-run it in a terminal and see the whole traceback, which is the fastest
	 * route out of an unexpected bpy error.
	 */
	async function runScript(exec, request) {
		const found = await requireBlender();
		const startedAt = Date.now();
		const result = await blender.runScript({
			exec,
			blender: found.path,
			scriptPath: scriptPath(request.script),
			args: request.args,
			timeoutMs: request.timeoutMs
		});
		const payloads = result.messages.filter((message) => message.json !== undefined).map((message) => message.json);
		const payload = payloads[payloads.length - 1];
		// Two very different failures look the same from the outside: a script that
		// *decided* it cannot do the job (it prints {"ok":false} with a reason and
		// exits 3) and one that crashed. A refusal's message is already complete, so
		// appending Blender's startup banner and import timers would bury it; a crash
		// has nothing but stderr, so that is where the traceback tail goes.
		const refused = payload !== undefined && payload.ok === false;
		const ok = result.code === 0 && payload !== undefined && payload.ok === true;
		if (!ok) {
			const lines = [
				`Blender 跑 ${request.script} 失败${result.timedOut ? "（超时）" : `（exit ${result.code}）`}：${payload?.error ?? "脚本没有输出 [dsh3d] 结果"}`
			];
			if (!refused) lines.push(...toDetailLines(result.details, 8, "  "));
			lines.push(`复现命令（终端里跑一遍能看到完整 traceback）：\n  ${result.argv.map(quoteArg).join(" ")}`);
			if (refused) lines.push("下一步：按上面的提示改参数重跑——这是脚本主动拒绝，不是崩溃。");
			else if (result.timedOut) lines.push("下一步：无头 Blender 启动就要 3–10 s，大模型更久——先把 timeoutMs 加大（例如 600000）再怀疑模型。");
			else lines.push('下一步：先用 print3d_check 确认模型本身不是坏网格；格式/导入问题用 print3d_blender {"action":"inspect"} 看它到底导入了什么。');
			throw new Error(lines.join("\n"));
		}
		return { found, payload, result, elapsedMs: Date.now() - startedAt };
	}

	function artifactPaths(exec, absolutePaths) {
		const cleaned = absolutePaths.filter((entry) => typeof entry === "string" && entry.length > 0);
		return {
			artifacts: cleaned.map((entry) => paths.display(exec, entry)),
			artifactsAbsolute: cleaned
		};
	}

	/** Resolve `output` / default target, and create the directory. */
	function targetPath(exec, args, { folder, extension, fallbackStem }) {
		const requested = typeof args.output === "string" ? args.output.trim() : "";
		let absolute;
		if (requested.length > 0) {
			absolute = paths.inside(exec, requested);
			if (extname(absolute).length === 0) absolute = `${absolute}.${extension}`;
		} else {
			absolute = join(paths.out(exec, folder), `${fallbackStem}.${extension}`);
		}
		mkdirSync(dirname(absolute), { recursive: true });
		return absolute;
	}

	function inputPath(exec, requested) {
		if (typeof requested !== "string" || requested.trim().length === 0) throw new Error("input 必须是非空字符串（相对会话工作区的模型路径）");
		const absolute = paths.inside(exec, requested);
		let size = 0;
		try {
			size = statSync(absolute).size;
		} catch {
			throw new Error(`找不到模型：${requested}（相对会话工作区 ${paths.workspaceOf(exec)}）`);
		}
		if (size === 0) throw new Error(`模型文件是空的：${requested}`);
		const extension = extname(absolute).toLowerCase();
		if (!INPUT_EXTENSIONS.includes(extension)) {
			throw new Error(`print3d_blender 只吃 ${INPUT_EXTENSIONS.join(" / ")}，收到 ${extension || "(无扩展名)"}；.3mf 请先用切片器或 print3d_render 转成 STL。`);
		}
		return absolute;
	}

	const paramsOf = (args) => (typeof args.params === "object" && args.params !== null ? args.params : {});

	/** `edit` is two scripts behind one action; the presence of a knob picks one. */
	function editOperation(params) {
		if (typeof params.op === "string") {
			if (!["boolean", "remesh"].includes(params.op)) throw new Error(`params.op 只能是 "boolean" 或 "remesh"，收到 "${params.op}"`);
			return params.op;
		}
		if (params.voxel !== undefined || params.smooth !== undefined || params.adaptivity !== undefined) return "remesh";
		return "boolean";
	}

	function validateNumbers(params) {
		if (params.decimate !== undefined && !(typeof params.decimate === "number" && params.decimate > 0 && params.decimate < 1)) {
			throw new Error("params.decimate 必须在 (0, 1) 之间（它是保留比例：0.4 = 留 40% 的三角面）。1 表示不减面，直接省略。");
		}
		if (params.voxel !== undefined && !(typeof params.voxel === "number" && params.voxel > 0)) {
			throw new Error("params.voxel 必须大于 0（单位 mm，打印件一般 0.2–0.6）。");
		}
		if (params.diameter !== undefined && !(typeof params.diameter === "number" && params.diameter > 0)) {
			throw new Error("params.diameter 必须大于 0（单位 mm）。");
		}
		for (const key of ["box", "position", "rotation"]) {
			const value = params[key];
			if (value === undefined) continue;
			if (!Array.isArray(value) || value.length !== 3 || !value.every((entry) => Number.isFinite(entry))) {
				throw new Error(`params.${key} 必须是 3 个数字的数组，例如 [10, 40, 6]。`);
			}
			if (key === "box" && value.some((entry) => entry <= 0)) throw new Error("params.box 的三个尺寸都必须大于 0（单位 mm）。");
		}
	}

	return {
		name: "print3d_blender",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: {
					type: "string",
					enum: ACTIONS,
					description: "detect（探测安装）/ inspect（看模型）/ open（开 GUI）/ export（转 GLB）/ edit（boolean 或 remesh 改几何）/ preview（三视图 + 等距图）。"
				},
				input: {
					type: "string",
					description: "要处理的模型（相对会话工作区），支持 .stl/.obj/.glb/.gltf/.blend/.ply。例如 \"3dprint/build/part.stl\"。"
				},
				output: {
					type: "string",
					description: "输出文件名（相对会话工作区，扩展名可省，会按动作补 .glb/.stl）。省略则落到 <outDir>/blender/。preview 不用它。"
				},
				params: {
					type: "object",
					additionalProperties: false,
					description: "动作参数。edit 用 op/shape/box/diameter/depth/position/rotation/operation（boolean）或 voxel/smooth/decimate/adaptivity（remesh）；export 用 decimate/join；preview 用 views/engine/sizePx/sheet。",
					properties: {
						op: { type: "string", enum: ["boolean", "remesh"], description: "edit 的动作：boolean 用立体做差集（打孔开槽），remesh 体素重网格修模型。" },
						name: { type: "string", description: "输出文件的名字（不含扩展名）。默认用输入文件名。" },
						saveBlend: { type: "boolean", description: "open 用：先把模型摆正/居中/贴地存成 .blend，再用 GUI 打开这个 .blend（而不是原始 STL）。" },
						orient: { type: "string", enum: ORIENTS, description: "导入时的朝向策略：keep（默认，假定 STL 本来就是 Z 向上）/ min-height（放平）/ min-footprint（立起来省床）。" },
						decimate: { type: "number", description: "保留的三角面比例 0–1，例如 0.4 留 40%。破坏性操作，先看 inspect 的面数。" },
						join: { type: "boolean", description: "先把所有网格合并成一个（export 默认 false）。" },
						voxel: { type: "number", description: "体素边长 mm。0.2 保细节但面数爆炸，1.0 适合粗修；要大于模型最小尺寸的 1/3 才会被接受。" },
						smooth: { type: "integer", description: "平滑迭代次数，默认 0（不平滑）。2–5 去体素台阶感。" },
						adaptivity: { type: "number", description: "体素自适应 0–1，默认 0（均匀）。大于 0 会在平坦区域少生成面。" },
						shape: { type: "string", enum: SHAPES, description: "裁剪体形状：cylinder（默认，打孔）或 cube（开槽/切平）。" },
						box: { type: "array", items: { type: "number" }, description: "cube 的三边尺寸 [x,y,z] mm，默认 [10,10,10]。想切开就把对应轴给大。" },
						diameter: { type: "number", description: "cylinder 直径 mm，默认 5。" },
						depth: { type: "number", description: "cylinder 长度 mm。省略或 0 = 自动贯穿（比包围盒对角线更长），打孔就该这样。" },
						position: { type: "array", items: { type: "number" }, description: "裁剪体中心 [x,y,z] mm（模型坐标系）。省略 = 模型包围盒中心。" },
						rotation: { type: "array", items: { type: "number" }, description: "裁剪体旋转 [rx,ry,rz] 度，默认 [0,0,0]。斜孔/斜槽用。" },
						operation: { type: "string", enum: OPERATIONS, description: "布尔运算：difference（默认，减料）/ union（加料）/ intersect（只留交集）。" },
						views: { type: "array", items: { type: "string" }, description: "preview 要哪些视角，可选 front/back/left/right/top/bottom/iso，默认 [front,right,top,iso]。" },
						engine: { type: "string", enum: ["workbench", "eevee"], description: "preview 渲染引擎：workbench（默认，快、无需灯光）/ eevee（材质与光影更真实，慢一些）。" },
						sizePx: { type: "integer", description: "preview 每张图边长像素，默认 900。" },
						sheet: { type: "boolean", description: "preview 是否合成一张 2×2 拼图，默认 true。" }
					}
				},
				timeoutMs: {
					type: "number",
					description: "本次 Blender 进程的超时毫秒数，默认 300000。无头启动本身要 3–10 s，大模型/高分辨率预览要更久。"
				}
			},
			required: ["action"]
		},
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [report.text(renderSummary(value))]
		},

		async execute(args, exec) {
			const action = String(args.action ?? "").toLowerCase();
			if (!ACTIONS.includes(action)) throw new Error(`不支持的 action "${args.action}"，可选：${ACTIONS.join(", ")}`);
			const timeoutMs = clampTimeout(args.timeoutMs, settings.timeoutMs);
			const params = paramsOf(args);
			validateNumbers(params);
			const startedAt = Date.now();
			const warnings = [];

			if (action === "detect") {
				const found = await blender.detect();
				const scripts = ["inspect.py", "import_stl.py", "export_glb.py", "remesh.py", "boolean_cut.py", "render_preview.py"].map((name) => ({
					name,
					exists: existsFile(scriptPath(name))
				}));
				const probe = found.probe;
				const missing = scripts.filter((entry) => !entry.exists).map((entry) => entry.name);
				if (missing.length > 0) warnings.push(`脚本缺失：${missing.join("、")}（插件安装不完整，重装或从仓库补回 blender/ 目录）`);
				const value = {
					action,
					ok: found.found === true && probe?.ok === true,
					elapsedMs: Date.now() - startedAt,
					warnings,
					...(found.found === true ? { blender: { path: found.path, version: found.version ?? undefined, source: found.source ?? undefined } } : {}),
					detect: {
						found: found.found === true,
						path: found.path ?? undefined,
						version: found.version ?? undefined,
						source: found.source ?? undefined,
						reason: found.reason ?? undefined,
						scriptOk: probe?.ok === true,
						probeMs: probe?.elapsedMs,
						python: probe?.python,
						capabilities: {
							stlImport: probe?.stlImport === true,
							stlExport: probe?.stlExport === true,
							objImport: probe?.objImport === true,
							gltfExport: probe?.gltfExport === true,
							voxelRemesh: probe?.voxelRemesh === true,
							engines: Array.isArray(probe?.engines) ? probe.engines : []
						},
						scripts,
						tried: (found.tried ?? []).map((entry) => entry.path)
					},
					next: found.found === true ? undefined : "Blender 没装：print3d_setup {\"target\":\"blender\",\"action\":\"install\",\"confirm\":true}，或手动装后写 blenderPath。"
				};
				return compact(value);
			}

			if (action === "inspect") {
				const absolute = inputPath(exec, args.input);
				const run = await runScript(exec, {
					script: "inspect.py",
					args: ["--input", absolute],
					timeoutMs
				});
				const payload = run.payload;
				const value = {
					action,
					ok: true,
					elapsedMs: Date.now() - startedAt,
					blender: { path: run.found.path, version: run.found.version ?? undefined, source: run.found.source ?? undefined },
					argv: run.result.argv,
					warnings,
					model: {
						totals: {
							objects: payload.totals.objects,
							faces: payload.totals.faces,
							triangles: payload.totals.triangles,
							vertices: payload.totals.vertices,
							volumeCm3: payload.totals.volumeCm3
						},
						// `center` is deliberately not passed through: the schema is a
						// contract, and a bbox with one extra key is a schema violation.
						bbox: { min: payload.bbox.min, max: payload.bbox.max, size: payload.bbox.size },
						sizeMm: payload.sizeMm,
						watertight: payload.watertight === true,
						openEdges: payload.openEdges,
						nonManifoldEdges: payload.nonManifoldEdges,
						materials: payload.materials ?? [],
						welded: payload.welded === true,
						objects: (payload.objects ?? []).map((object) => ({
							name: object.name,
							faces: object.faces,
							triangles: object.triangles,
							vertices: object.vertices,
							volumeCm3: object.absoluteVolumeCm3,
							watertight: object.watertight === true,
							openEdges: object.openEdges,
							nonManifoldEdges: object.nonManifoldEdges,
							materials: object.materials ?? [],
							modifiers: (object.modifiers ?? []).map((modifier) => `${modifier.type}:${modifier.name}`)
						}))
					},
					artifacts: [],
					artifactsAbsolute: []
				};
				if (payload.watertight !== true) warnings.push(`网格不水密：${payload.openEdges} 条开放边、${payload.nonManifoldEdges} 条非流形边——切片器多半能修，但打孔/减面之前最好先用 edit remesh 修一遍。`);
				return compact(value);
			}

			if (action === "open") {
				const absolute = inputPath(exec, args.input);
				const found = await requireBlender();
				// `open` normally hands Blender the file as-is. With saveBlend the
				// model goes through import_stl.py first: mm units, joined, optionally
				// rotated flat, centred and sitting on Z=0 — then the *scene* opens, so
				// whatever you do in the GUI starts from a sane place instead of from
				// a 0.02-unit STL at an arbitrary offset.
				let opened = absolute;
				let blendPath;
				if (params.saveBlend === true && extname(absolute).toLowerCase() !== ".blend") {
					const orient = params.orient ?? "keep";
					if (!ORIENTS.includes(orient)) throw new Error(`params.orient 只能是 ${ORIENTS.join(" / ")}，收到 "${orient}"`);
					blendPath = targetPath(exec, args, { folder: "blender", extension: "blend", fallbackStem: params.name ?? stem(absolute) });
					const prepared = await runScript(exec, {
						script: "import_stl.py",
						args: ["--input", absolute, "--output", blendPath, "--orient", orient],
						timeoutMs
					});
					opened = blendPath;
					warnings.push(`已先摆正并另存为 ${paths.display(exec, blendPath)}（${prepared.payload.triangles} 三角面，水密 ${prepared.payload.watertight === true ? "✓" : "✗"}）`);
					if (prepared.payload.watertight !== true) warnings.push("这个模型不水密，在 Blender 里手动改之前建议先跑一次 action:\"edit\" params:{op:\"remesh\"}。");
				}
				const launched = await blender.openGui({ exec, blender: found.path, file: opened });
				return compact({
					action,
					ok: launched.launched === true,
					elapsedMs: Date.now() - startedAt,
					blender: { path: found.path, version: found.version ?? undefined },
					argv: launched.argv,
					...artifactPaths(exec, blendPath !== undefined ? [blendPath] : []),
					warnings,
					open: {
						file: paths.display(exec, opened),
						blend: blendPath !== undefined ? paths.display(exec, blendPath) : undefined,
						mode: launched.mode,
						launched: launched.launched === true,
						pid: launched.pid,
						note: launched.note
					},
					next: launched.launched === true ? "窗口已拉起，手动改完记得在 Blender 里另存/导出；后续自动处理仍走本工具。" : "没看到 Blender 窗口：确认这是有桌面的本机会话（远程/无头环境开不了 GUI），或改用 inspect/preview 无头处理。"
				});
			}

			if (action === "export") {
				const absolute = inputPath(exec, args.input);
				const fallbackStem = `${stem(absolute)}`;
				const target = targetPath(exec, args, { folder: "blender", extension: "glb", fallbackStem: params.name ?? fallbackStem });
				const argv = ["--input", absolute, "--output", target];
				if (params.decimate !== undefined) argv.push("--decimate", String(params.decimate));
				if (params.join === true) argv.push("--join");
				const run = await runScript(exec, { script: "export_glb.py", args: argv, timeoutMs });
				const payload = run.payload;
				if (payload.decimate > 0 && payload.volumeAfterCm3 < payload.volumeBeforeCm3 * 0.9) {
					warnings.push(`减面把体积削掉了 ${(100 * (1 - payload.volumeAfterCm3 / payload.volumeBeforeCm3)).toFixed(1)}%（${payload.volumeBeforeCm3} → ${payload.volumeAfterCm3} cm³）：GLB 只给看没问题，别拿它去打印。`);
				}
				return compact({
					action,
					ok: true,
					elapsedMs: Date.now() - startedAt,
					blender: { path: run.found.path, version: run.found.version ?? undefined },
					argv: run.result.argv,
					...artifactPaths(exec, [payload.glb]),
					warnings,
					export: {
						file: paths.display(exec, payload.glb),
						bytes: payload.bytes,
						trianglesBefore: payload.trianglesBefore,
						trianglesAfter: payload.trianglesAfter,
						ratio: payload.ratio,
						volumeBeforeCm3: payload.volumeBeforeCm3,
						volumeAfterCm3: payload.volumeAfterCm3,
						decimate: payload.decimate,
						joined: payload.joined === true,
						objects: payload.objects
					}
				});
			}

			if (action === "edit") {
				const absolute = inputPath(exec, args.input);
				const op = editOperation(params);
				const fallbackStem = `${stem(absolute)}-${op === "boolean" ? "cut" : "remesh"}`;
				const target = targetPath(exec, args, { folder: "blender", extension: "stl", fallbackStem: params.name ?? fallbackStem });
				let argv;
				let script;
				if (op === "boolean") {
					const shape = params.shape ?? "cylinder";
					if (!SHAPES.includes(shape)) throw new Error(`params.shape 只能是 ${SHAPES.join(" / ")}，收到 "${shape}"`);
					const operation = params.operation ?? "difference";
					if (!OPERATIONS.includes(operation)) throw new Error(`params.operation 只能是 ${OPERATIONS.join(" / ")}，收到 "${operation}"`);
					script = "boolean_cut.py";
					argv = ["--input", absolute, "--output", target, "--shape", shape, "--operation", operation];
					if (params.box !== undefined) argv.push("--box", params.box.join(","));
					if (params.diameter !== undefined) argv.push("--diameter", String(params.diameter));
					if (params.depth !== undefined) argv.push("--depth", String(params.depth));
					if (params.position !== undefined) argv.push("--position", params.position.join(","));
					if (params.rotation !== undefined) argv.push("--rotation", params.rotation.join(","));
				} else {
					script = "remesh.py";
					argv = ["--input", absolute, "--output", target];
					if (params.voxel !== undefined) argv.push("--voxel", String(params.voxel));
					if (params.smooth !== undefined) argv.push("--smooth", String(params.smooth));
					if (params.adaptivity !== undefined) argv.push("--adaptivity", String(params.adaptivity));
					if (params.decimate !== undefined) argv.push("--decimate", String(params.decimate));
				}
				const run = await runScript(exec, { script, args: argv, timeoutMs });
				const payload = run.payload;
				if (op === "boolean" && payload.changed !== true) {
					warnings.push("裁剪体没有碰到模型：体积和面数都没变。检查 position（模型坐标，省略时是包围盒中心）和 shape 尺寸。");
				}
				if (payload.watertightAfter !== true) {
					warnings.push(`改完不水密：${payload.openEdgesAfter} 条开放边。改用 remesh（op:"remesh"）可以重建闭合表面。`);
				}
				if (op === "remesh" && payload.trianglesAfter > payload.trianglesBefore * 20) {
					warnings.push(`体素重网格把面数从 ${payload.trianglesBefore} 拉到 ${payload.trianglesAfter}（${Math.round(payload.trianglesAfter / Math.max(1, payload.trianglesBefore))}×）：voxel 调大一点，或加 params.decimate。`);
				}
				const value = {
					action,
					ok: true,
					elapsedMs: Date.now() - startedAt,
					blender: { path: run.found.path, version: run.found.version ?? undefined },
					argv: run.result.argv,
					...artifactPaths(exec, [payload.stl]),
					warnings,
					edit: {
						op,
						file: paths.display(exec, payload.stl),
						bytes: payload.bytes,
						facesBefore: payload.facesBefore ?? payload.trianglesBefore,
						facesAfter: payload.facesAfter ?? payload.trianglesAfter,
						watertightAfter: payload.watertightAfter === true,
						...(payload.sizeMm !== undefined ? { sizeMm: payload.sizeMm } : {}),
						...(payload.sizeBeforeMm !== undefined ? { sizeBeforeMm: payload.sizeBeforeMm } : {}),
						...(payload.volumeBeforeCm3 !== undefined ? { volumeBeforeCm3: payload.volumeBeforeCm3 } : {}),
						...(payload.volumeAfterCm3 !== undefined ? { volumeAfterCm3: payload.volumeAfterCm3 } : {}),
						...(op === "boolean"
							? {
								operation: payload.operation,
								solver: payload.solver,
								cutter: payload.cutter?.label,
								changed: payload.changed === true,
								removedCm3: payload.removedCm3,
								openEdgesAfter: payload.openEdgesAfter
							}
							: {
								steps: payload.steps ?? [],
								openEdgesAfter: payload.openEdgesAfter
							})
					}
				};
				return compact(value);
			}

			// preview
			const absolute = inputPath(exec, args.input);
			if (typeof args.output === "string" && args.output.trim().length > 0) {
				warnings.push(`preview 的产物固定在 <outDir>/preview/ 下，忽略 output="${args.output}"。`);
			}
			const views = Array.isArray(params.views) && params.views.length > 0 ? params.views : ["front", "right", "top", "iso"];
			const engine = params.engine ?? "workbench";
			const sizePx = Number.isFinite(params.sizePx) ? Math.round(params.sizePx) : 900;
			const outDir = paths.out(exec, "preview");
			const prefix = stem(absolute);
			const argv = ["--input", absolute, "--outdir", outDir, "--stem", prefix, "--size", String(sizePx), "--engine", engine, "--views", views.join(",")];
			if (params.sheet === false) argv.push("--no-sheet");
			const run = await runScript(exec, { script: "render_preview.py", args: argv, timeoutMs });
			const payload = run.payload;
			const files = (payload.files ?? []).map((file) => paths.display(exec, file));
			return compact({
				action,
				ok: true,
				elapsedMs: Date.now() - startedAt,
				blender: { path: run.found.path, version: run.found.version ?? undefined },
				argv: run.result.argv,
				...artifactPaths(exec, [...(payload.files ?? []), ...(payload.sheet !== undefined && payload.sheet !== null ? [payload.sheet] : [])]),
				warnings,
				preview: {
					files,
					sheet: typeof payload.sheet === "string" ? paths.display(exec, payload.sheet) : undefined,
					engine: payload.engine,
					sizePx: payload.sizePx,
					views: payload.views ?? views
				}
			});
		},

		presentCall: (args) => ({
			card: "generic",
			title: `Blender ${String(args.action ?? "")}`,
			kind: args.action === "open" || args.action === "detect" ? "read" : "execute",
			rawInput: { action: args.action, input: args.input, params: args.params }
		})
	};
}

/** `[dsh3d]` payloads are trusted only for their own fields; nulls are dropped. */
function compact(value) {
	if (Array.isArray(value)) return value.map((entry) => (entry === undefined || entry === null ? entry : compact(entry)));
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry === undefined || entry === null) continue;
			out[key] = compact(entry);
		}
		return out;
	}
	return value;
}

function existsFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function clampTimeout(requested, fallback) {
	const value = Number.isFinite(requested) ? requested : fallback;
	if (!Number.isFinite(value) || value < 1_000) return 300_000;
	return Math.min(value, 3_600_000);
}

function toDetailLines(details, limit, prefix = "- ") {
	if (!Array.isArray(details) || details.length === 0) return [];
	return details.slice(-limit).map((line) => `${prefix}${line}`);
}

/** A copy-pasteable command line, quoting only what needs it. */
function quoteArg(value) {
	const text = String(value);
	return /[\s"]/u.test(text) ? `"${text.replace(/"/gu, '\\"')}"` : text;
}

function renderSummary(value) {
	const lines = [];
	if (value.action === "detect") {
		const detect = value.detect ?? {};
		if (detect.found !== true) {
			lines.push("**Blender** ✗ 没找到");
			if (detect.reason !== undefined) lines.push("", `- 原因：${detect.reason}`);
			if ((detect.tried ?? []).length > 0) lines.push(`- 找过 ${detect.tried.length} 个位置，例如 \`${detect.tried[0]}\``);
		} else {
			lines.push(`**Blender** ${value.ok === true ? "✓" : "!"} ${detect.version ?? "版本未知"}`);
			lines.push(
				"",
				report.keyValues([
					["路径", `\`${detect.path}\``],
					["来源", detect.source],
					["无头脚本", detect.scriptOk === true ? `✓ 可用（探测 ${Number.isFinite(detect.probeMs) ? `${(detect.probeMs / 1000).toFixed(1)} s` : "耗时未知"}）` : "✗ 跑不起来"],
					["Python", detect.python],
					["包能力", describeCapabilities(detect.capabilities)]
				])
			);
			const missing = (detect.scripts ?? []).filter((entry) => !entry.exists);
			if (missing.length > 0) lines.push("", `- ✗ 脚本缺失：${missing.map((entry) => entry.name).join("、")}`);
		}
	} else if (value.action === "inspect") {
		const model = value.model;
		lines.push(
			`**Blender 视角** — ${model.totals.objects} 个对象 / ${model.totals.faces} 面（${model.totals.triangles} 三角面），${report.cm3(model.totals.volumeCm3)}`,
			"",
			report.table(
				["项", "值"],
				[
					["包围盒", `${model.sizeMm.map((entry) => entry.toFixed(1)).join(" × ")} mm`],
					["水密", model.watertight ? "✓ 是" : `✗ 否（开放边 ${model.openEdges} / 非流形边 ${model.nonManifoldEdges}）`],
					["材质", model.materials.length > 0 ? model.materials.join("、") : "（无，STL 不带材质）"],
					["拓扑", model.welded ? "已焊接后统计" : "未焊接"]
				]
			)
		);
		if ((model.objects ?? []).length > 1) {
			lines.push("", report.table(["对象", "面", "三角面", "体积", "水密"], model.objects.map((object) => [object.name, object.faces, object.triangles, report.cm3(object.volumeCm3), report.mark(object.watertight)])));
		}
	} else if (value.action === "open") {
		lines.push(`**${value.open.launched ? "已交给" : "尝试交给"} Blender GUI** \`${value.open.file}\``, "", `- 方式：${value.open.mode} — ${value.open.note}`);
		if (value.open.blend !== undefined) lines.push(`- 场景文件：\`${value.open.blend}\`（mm 单位、居中、贴地）`);
		lines.push(value.open.launched ? "- 已核对进程存活（不只是启动命令返回 0）。" : "- 没有观察到新的 Blender 进程：窗口可能没弹出，别当成成功。");
	} else if (value.action === "export") {
		const made = value.export;
		lines.push(
			`**已导出** \`${made.file}\` — GLB，${report.bytes(made.bytes)}，${(value.elapsedMs / 1000).toFixed(1)} s`,
			"",
			report.table(
				["项", "值"],
				[
					["三角面", `${made.trianglesBefore} → ${made.trianglesAfter}${made.ratio > 0 ? `（${report.pct(made.ratio * 100)}）` : ""}`],
					["体积", `${made.volumeBeforeCm3} → ${made.volumeAfterCm3} cm³`],
					["减面", made.decimate > 0 ? made.decimate : "无"],
					["合并", made.joined ? `✓ ${made.objects} 个对象合成 1` : "否"]
				]
			)
		);
	} else if (value.action === "edit") {
		const made = value.edit;
		const headline = made.op === "boolean" ? `布尔 ${made.operation}（${made.cutter}，${made.solver}）` : `体素重网格 ${(made.steps ?? []).join(" / ")}`;
		lines.push(
			`**已改完** \`${made.file}\` — ${headline}，${report.bytes(made.bytes)}，${(value.elapsedMs / 1000).toFixed(1)} s`,
			"",
			report.table(
				["项", "值"],
				[
					["面数", `${made.facesBefore} → ${made.facesAfter}`],
					["体积", made.volumeBeforeCm3 !== undefined ? `${made.volumeBeforeCm3} → ${made.volumeAfterCm3} cm³${made.removedCm3 !== undefined ? `（去掉 ${made.removedCm3}）` : ""}` : "—"],
					["包围盒", made.sizeMm !== undefined ? `${made.sizeMm.map((entry) => entry.toFixed(1)).join(" × ")} mm` : "—"],
					["水密", made.watertightAfter ? "✓ 是" : `✗ 否（开放边 ${made.openEdgesAfter}）`]
				]
			)
		);
	} else if (value.action === "preview") {
		const made = value.preview;
		lines.push(`**预览已出** ${made.files.length} 张（${made.engine}，${made.sizePx}px）`, "");
		for (const file of made.files) lines.push(`- \`${file}\``);
		if (made.sheet !== undefined) lines.push("", `拼图：\`${made.sheet}\``);
	}
	for (const warning of value.warnings ?? []) lines.push(`- ⚠️ ${warning}`);
	if (value.next !== undefined) lines.push("", `下一步：${value.next}`);
	return lines.join("\n");
}

function describeCapabilities(capabilities) {
	if (capabilities === undefined) return "—";
	const flags = [
		["STL 导入", capabilities.stlImport],
		["STL 导出", capabilities.stlExport],
		["OBJ 导入", capabilities.objImport],
		["GLB 导出", capabilities.gltfExport],
		["voxel remesh", capabilities.voxelRemesh]
	];
	const text = flags.map(([label, ok]) => `${report.mark(ok)} ${label}`).join("，");
	const engines = (capabilities.engines ?? []).join(" / ");
	return engines.length > 0 ? `${text}；引擎 ${engines}` : text;
}
