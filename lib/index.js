/**
 * dsh-3d-print — an OpenSCAD-first 3D printing workbench for DeepSeek Harness.
 *
 * Eight tools that share one core: process seam (`core/proc.js`), path policy
 * (`core/paths.js`), mesh QA (`core/stl.js`), OpenSCAD driver
 * (`core/openscad.js`) and printer presets (`core/printers.js`).
 *
 * The plugin deliberately imports nothing from the Harness: it is mounted by
 * absolute path out of a workspace, where `@deepseek-ai/*` packages are not
 * reachable, and a second copy of the tool registry inside the process would be
 * worse than no import at all. Tool definitions are registered as raw JSON
 * Schema, which is the exact wire dialect the registry enforces.
 *
 * @module dsh-3d-print
 */
import * as report from "./core/report.js";
import * as mesh from "./core/stl.js";
import * as printers from "./core/printers.js";
import { createProc } from "./core/proc.js";
import { createPaths } from "./core/paths.js";
import { createOpenscad } from "./core/openscad.js";
import { normalizeConfig } from "./core/settings.js";

import { create as createDoctor } from "./tools/doctor.js";
import { create as createSetup } from "./tools/setup.js";
import { create as createRender } from "./tools/render.js";
import { create as createCheck } from "./tools/check.js";
import { create as createParts } from "./tools/parts.js";
import { create as createSlice } from "./tools/slice.js";
import { create as createBlender } from "./tools/blender.js";
import { create as createSelftest } from "./tools/selftest.js";

/** Cordis plugin identity. */
export const name = "dsh-3d-print";

/** Services this plugin requires before the Loader activates it. */
export const inject = ["tools", "subprocess"];

const FACTORIES = [
	createDoctor,
	createSetup,
	createRender,
	createCheck,
	createParts,
	createSlice,
	createBlender,
	createSelftest
];

/**
 * Register every tool, and keep one broken tool from taking down the rest.
 * @param {object} ctx - Cordis context with `tools` and `subprocess`
 * @param {object} config - the patch row's `config` object
 */
export function apply(ctx, config = {}) {
	const settings = normalizeConfig(config);
	const proc = createProc(ctx, settings);
	const paths = createPaths(settings);
	const openscad = createOpenscad(proc, settings);

	/** The shared surface every tool module closes over. */
	const shared = {
		ctx,
		settings,
		proc,
		paths,
		openscad,
		report,
		mesh,
		printers,
		/** Populated when a tool fails to register; surfaced by print3d_selftest. */
		errors: []
	};

	const register = (factory) => {
		const tool = factory(shared);
		const disposer = ctx.tools.register(tool);
		return typeof ctx.effect === "function" ? ctx.effect(() => disposer) : disposer;
	};

	const disposers = [];
	for (const factory of FACTORIES) {
		try {
			disposers.push(register(factory));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			shared.errors.push(reason);
			console.error(`[dsh-3d-print] tool registration failed: ${reason}`);
		}
	}
}
