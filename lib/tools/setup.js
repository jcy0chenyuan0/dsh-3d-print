/**
 * print3d_setup — plan / probe / install OpenSCAD (and optionally Blender).
 *
 * Why the three actions are separate: a model cannot see the network from here,
 * so "install it" must be decomposable into (a) show every route and what would
 * run, (b) measure which routes actually answer, (c) execute exactly one route
 * with an explicit `confirm`. Collapsing those into one automatic step is what
 * turns a failed download into an unexplained 8-second wait.
 *
 * Nothing here elevates privileges. A silent install into Program Files still
 * raises UAC; that dialog is the user's to answer, and the tool reports the
 * outcome by re-resolving OpenSCAD rather than by trusting an exit code.
 */
import * as report from "../core/report.js";
import * as detect from "../core/tools-detect.js";
import * as install from "../core/install.js";

const ACTIONS = ["plan", "probe", "install"];
const TARGETS = ["openscad", "blender"];
const BLENDER_HINT = "Blender 手动下载：https://www.blender.org/download/（装完 blender.exe 通常落在 C:\\Program Files\\Blender Foundation\\Blender <版本>\\）";

const DESCRIPTION = `准备 3D 打印环境：计划 / 探活 / 自动安装 OpenSCAD（可选 Blender）。自动选择安装源（winget、choco、scoop、GitHub 直链、gh 镜像）。

参数：
- action="plan"（默认）：列出所有候选源和将执行的命令，不联网、不改系统。
- action="probe"：并发测活每个源（每个 4–6 s 超时），报出哪几个通、延迟多少，并给出推荐源。
- action="install"：真装。**必须 confirm=true**，否则只返回计划（dry-run）；不传 source 时会先自动探活再选最快的可用源。

关键词检索：OpenSCAD / Blender / winget / choco / scoop / mirror / ghfast / GitHub releases / silent install / STL。
安装源优先级：本地包管理器可用就优先（它们能处理签名和卸载注册表），下载/镜像作为兜底；镜像 = 前缀 + GitHub 原链。
不会 sudo/提权：Windows 上静默安装可能弹 UAC，那一步只能由你在桌面上确认；装没装上以能否拿到版本为准。`;

/** The advertised shape of one install source. */
const SOURCE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: { type: "string" },
		kind: { type: "string" },
		label: { type: "string" },
		available: { type: "boolean" },
		latencyMs: { type: "number" },
		detail: { type: "string" },
		error: { type: "string" }
	},
	required: ["id", "kind", "label", "available", "detail"]
};

const STEP_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		step: { type: "string" },
		ok: { type: "boolean" },
		detail: { type: "string" }
	},
	required: ["step", "ok", "detail"]
};

const VERIFY_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		found: { type: "boolean" },
		runnable: { type: "boolean" },
		path: { type: "string" },
		version: { type: "string" },
		source: { type: "string" }
	},
	required: ["found", "runnable"]
};

export function create(shared) {
	const { settings, proc, openscad } = shared;

	return {
		name: "print3d_setup",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: {
					type: "string",
					enum: ACTIONS,
					description: "plan = 只看计划（默认，不联网）；probe = 并发测活所有源拿延迟；install = 真装（需要 confirm=true）。"
				},
				source: {
					type: "string",
					description: "指定安装源 id，例如 winget / choco / scoop / github / mirror-ghfast。省略则自动探活挑最快的可用源。"
				},
				confirm: {
					type: "boolean",
					description: "install 必须显式 true 才执行；缺省或 false 只返回计划（dry-run）。"
				},
				target: {
					type: "string",
					enum: TARGETS,
					description: "openscad（默认，建模必需）或 blender（可选，体积大，默认只给计划不自动装）。"
				}
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					action: { type: "string", enum: ACTIONS },
					target: { type: "string", enum: TARGETS },
					installed: { type: "boolean" },
					dryRun: { type: "boolean" },
					source: { type: "string" },
					command: { type: "string" },
					message: { type: "string" },
					hint: { type: "string" },
					sources: { type: "array", items: SOURCE_SCHEMA },
					steps: { type: "array", items: STEP_SCHEMA },
					verify: VERIFY_SCHEMA,
					asset: {
						type: "object",
						additionalProperties: false,
						properties: {
							name: { type: "string" },
							url: { type: "string" },
							tag: { type: "string" },
							resolvedFrom: { type: "string" }
						},
						required: ["name", "url", "tag", "resolvedFrom"]
					},
					nextSteps: { type: "array", items: { type: "string" } }
				},
				required: ["action", "target", "installed", "dryRun", "source", "command", "message", "hint", "sources", "steps", "verify", "nextSteps"]
			},
			render: (_args, value) => [report.text(renderReport(value))]
		},
		async execute(args, exec) {
			// Validate everything up front: the error message is the fix.
			const action = args.action ?? "plan";
			const target = args.target ?? "openscad";
			if (!ACTIONS.includes(action)) throw new Error(`action 只能是 ${ACTIONS.join(" / ")}，收到 "${action}"`);
			if (!TARGETS.includes(target)) throw new Error(`target 只能是 ${TARGETS.join(" / ")}，收到 "${target}"`);
			if (args.confirm !== undefined && typeof args.confirm !== "boolean") throw new Error(`confirm 必须是布尔值（true/false），收到 ${JSON.stringify(args.confirm)}`);
			if (args.source !== undefined && (typeof args.source !== "string" || args.source.trim().length === 0)) throw new Error("source 必须是非空字符串（来源 id，先跑 action=\"plan\" 或 \"probe\" 看 sources[].id）");
			const confirm = args.confirm === true;
			const source = typeof args.source === "string" ? args.source.trim() : undefined;
			if (target === "blender") return await blenderAction({ action, confirm, source, exec, settings, proc });
			return await openscadAction({ action, confirm, source, exec, settings, proc, openscad });
		},
		presentCall: (args) => ({
			card: "generic",
			title: `print3d_setup — ${args.action ?? "plan"}${args.confirm === true ? "（已确认）" : ""}`,
			kind: args.action === "install" && args.confirm === true ? "execute" : "read",
			rawInput: { action: args.action ?? "plan", target: args.target ?? "openscad", source: args.source }
		})
	};
}

async function openscadAction({ action, confirm, source, exec, settings, proc, openscad }) {
	const detection = await detect.detectOpenscad(proc, settings, { openscad, exec });

	if (action === "probe") {
		const probe = await install.probeSources({ proc, settings, exec });
		const up = probe.sources.filter((entry) => entry.available);
		const lines = [
			`探活 ${probe.sources.length} 个源，${up.length} 个可用（耗时 ${probe.elapsedMs} ms）。`,
			up.length > 0
				? `可用：${up.map((entry) => `${entry.id}（${entry.latencyMs ?? "?"} ms）`).join("、")}。`
				: "全部不可用：本地包管理器没装，GitHub API 与四个镜像也都不通。",
			probe.recommended === undefined ? "" : `推荐用 ${probe.recommended}。`,
			detection.found ? `OpenSCAD 其实已经可用（${detection.path}），不需要装。` : ""
		].filter((line) => line.length > 0);
		return {
			action,
			target: "openscad",
			installed: detection.found,
			dryRun: true,
			source: probe.recommended ?? "",
			command: "",
			message: lines.join(" "),
			hint: install.OPENSCAD_DOWNLOAD_HINT,
			sources: probe.sources.map(publicSource),
			steps: [],
			verify: publicVerify(detection),
			...(probe.asset === undefined ? {} : { asset: publicAsset(probe.asset) }),
			nextSteps:
				probe.recommended === undefined
					? ["按 hint 手动安装 OpenSCAD，然后把 exe 路径写进插件配置 openscadPath", "或检查网络/代理后重试 probe"]
					: [`{"action":"install","source":"${probe.recommended}","confirm":true}`, "装完重跑 print3d_doctor 确认"]
		};
	}

	if (action === "plan") {
		const planned = await install.planInstall({ proc, settings, exec });
		const plan = await install.installOpenscad({ proc, settings, exec, sourceId: source, confirm: false, openscad });
		const available = planned.filter((entry) => entry.available);
		return {
			action,
			target: "openscad",
			installed: plan.installed,
			dryRun: plan.dryRun,
			source: plan.sourceId,
			command: plan.command,
			message: detection.found
				? `OpenSCAD 已就绪：${detection.path}${detection.version === undefined ? "" : `（${detection.version}）`}，来源 ${detection.source}。不需要安装；下面只是候选源清单。`
				: `未发现 OpenSCAD。本机可用源 ${available.length} 个；计划用 ${plan.sourceId}。${plan.message}`,
			hint: plan.hint,
			sources: planned.map(publicSource),
			steps: plan.steps,
			verify: plan.verify,
			...(plan.asset === undefined ? {} : { asset: publicAsset(plan.asset) }),
			nextSteps: detection.found
				? ["OpenSCAD 已就绪，直接 print3d_render 建模；这份清单只在换机/重装时有用"]
				: [
						'先 {"action":"probe"} 测每个源的延迟（plan 阶段没有联网）',
						`确认后 {"action":"install","source":"${plan.sourceId}","confirm":true}`,
						"装不上就按 hint 手动安装，或把路径写进配置 openscadPath"
					]
		};
	}

	// action === "install" — installOpenscad itself enforces the confirm gate.
	const result = await install.installOpenscad({ proc, settings, exec, sourceId: source, confirm, openscad });
	return {
		action,
		target: "openscad",
		installed: result.installed,
		dryRun: result.dryRun,
		source: result.sourceId,
		command: result.command,
		message: result.message,
		hint: result.hint,
		sources: [],
		steps: result.steps,
		verify: result.verify,
		...(result.asset === undefined ? {} : { asset: publicAsset(result.asset) }),
		nextSteps: result.nextSteps
	};
}

async function blenderAction({ action, confirm, source, exec, settings, proc }) {
	if (action === "probe") {
		const probe = await install.probeBlender({ proc, settings, exec });
		const up = probe.sources.filter((entry) => entry.available);
		return {
			action,
			target: "blender",
			installed: probe.detected.found,
			dryRun: true,
			source: up[0]?.id ?? "",
			command: "",
			message: [
				probe.detected.found ? `Blender 已就绪：${probe.detected.path}（${probe.detected.version ?? "版本未知"}）。` : "未发现 Blender。",
				`winget ${up.length > 0 ? `可用（${up[0].latencyMs ?? "?"} ms）` : "不可用"}：这是 Blender 唯一的自动安装路线。`
			].join(" "),
			hint: BLENDER_HINT,
			sources: probe.sources.map(publicSource),
			steps: [],
			verify: publicVerify(probe.detected),
			nextSteps: up.length > 0 ? ['{"target":"blender","action":"install","confirm":true}（约 350 MB）'] : ["手动下载安装 Blender，再重跑 print3d_doctor"]
		};
	}

	if (action === "plan") {
		const probe = await install.probeBlender({ proc, settings, exec });
		const plan = await install.installBlender({ proc, settings, exec, confirm: false });
		return {
			action,
			target: "blender",
			installed: plan.installed,
			dryRun: plan.dryRun,
			source: plan.sourceId,
			command: plan.command,
			message: plan.message,
			hint: plan.hint,
			sources: probe.sources.map(publicSource),
			steps: plan.steps,
			verify: plan.verify,
			nextSteps: plan.nextSteps
		};
	}

	const result = await install.installBlender({ proc, settings, exec, confirm, sourceId: source });
	return {
		action,
		target: "blender",
		installed: result.installed,
		dryRun: result.dryRun,
		source: result.sourceId,
		command: result.command,
		message: result.message,
		hint: result.hint,
		sources: [],
		steps: result.steps,
		verify: result.verify,
		nextSteps: result.nextSteps
	};
}

/** Trim a source to the advertised fields and inline any newlines. */
function publicSource(source) {
	return {
		id: source.id,
		kind: source.kind,
		label: source.label,
		available: source.available === true,
		detail: inline(source.detail ?? ""),
		...(source.latencyMs === undefined ? {} : { latencyMs: source.latencyMs }),
		...(source.error === undefined ? {} : { error: inline(source.error) })
	};
}

function publicVerify(result) {
	return {
		found: result?.found === true,
		runnable: result?.runnable === true,
		...(result?.path === undefined ? {} : { path: result.path }),
		...(typeof result?.version === "string" && result.version.length > 0 ? { version: result.version } : {}),
		...(result?.source === undefined ? {} : { source: result.source })
	};
}

function publicAsset(asset) {
	return { name: asset.name, url: asset.url, tag: String(asset.tag ?? ""), resolvedFrom: String(asset.resolvedFrom ?? "unknown") };
}

/** Markdown table cells must stay on one line. */
function inline(value) {
	return String(value ?? "").replace(/\r?\n/gu, " / ");
}

function renderReport(value) {
	const lines = [`**print3d_setup** — action=\`${value.action}\` · target=\`${value.target}\`${value.dryRun ? "（dry-run，未改动系统）" : ""}`, "", value.message];
	if (value.sources.length > 0) {
		lines.push(
			"",
			"**候选安装源**",
			report.table(
				["源", "类型", "可用", "延迟", "说明"],
				value.sources.map((source) => [source.id, source.kind, source.available ? "✓" : "✗", source.latencyMs === undefined ? "—" : `${source.latencyMs} ms`, source.error ?? source.detail])
			)
		);
	}
	if (value.verify.found) {
		lines.push("", `**已验证**：${value.verify.path ?? "?"}${value.verify.version === undefined ? "" : ` — ${value.verify.version}`}${value.verify.source === undefined ? "" : `（来源 ${value.verify.source}）`}`);
	}
	if (value.command.length > 0) lines.push("", "**命令**", "```", inline(value.command), "```");
	if (value.steps.length > 0) {
		lines.push("", "**执行步骤**");
		for (const step of value.steps) lines.push(`- ${step.ok ? "✓" : "✗"} **${step.step}**：${step.detail}`);
	}
	if (value.asset !== undefined) lines.push("", `**安装包**：${value.asset.name}（${value.asset.tag}，来源 ${value.asset.resolvedFrom}）`);
	if (value.nextSteps.length > 0) lines.push("", "**下一步**", ...value.nextSteps.map((step) => `- ${step}`));
	if (value.hint.length > 0) lines.push("", "**手动安装**", "```", value.hint, "```");
	return lines.join("\n");
}
