/**
 * Blender bridge tests.
 *
 *   node --test tests/blender.test.mjs
 *
 * The bridge is worth testing for real — a mocked `bpy` would prove nothing,
 * because every bug this module had during development was a Blender fact (a
 * stale `bound_box`, a renamed operator, a missing `--python-exit-code`) and not
 * a JavaScript one. So the tests spawn the actual Blender when it is installed
 * and skip cleanly when it is not: a machine without Blender must still get a
 * green run, it just has less to say.
 *
 * The numbers asserted below are exact on purpose: a 20 mm cube is 8 cm³ and a
 * Ø6 hole through 20 mm of material removes π·3²·20 = 565.49 mm³. If those drift,
 * either the unit convention or the boolean changed, and both matter.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { apply } from "../lib/index.js";
import { diagnose, parseMessages } from "../lib/core/blender.js";
import { createFakeContext, makeExec } from "./harness.mjs";

/** A binary STL box, with outward normals implied by the winding. */
function boxStl(width, depth, height, originX = 0, originY = 0, originZ = 0) {
	const point = (x, y, z) => [originX + x * width, originY + y * depth, originZ + z * height];
	const at = (x, y, z) => point(x, y, z);
	const faces = [
		[at(0, 0, 0), at(0, 1, 0), at(1, 1, 0), at(1, 0, 0)],
		[at(0, 0, 1), at(1, 0, 1), at(1, 1, 1), at(0, 1, 1)],
		[at(0, 0, 0), at(1, 0, 0), at(1, 0, 1), at(0, 0, 1)],
		[at(0, 1, 0), at(0, 1, 1), at(1, 1, 1), at(1, 1, 0)],
		[at(0, 0, 0), at(0, 0, 1), at(0, 1, 1), at(0, 1, 0)],
		[at(1, 0, 0), at(1, 1, 0), at(1, 1, 1), at(1, 0, 1)]
	];
	const triangles = faces.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]);
	const buffer = Buffer.alloc(84 + triangles.length * 50);
	buffer.write("dsh3d test box", 0, "utf8");
	buffer.writeUInt32LE(triangles.length, 80);
	let offset = 84;
	for (const triangle of triangles) {
		offset += 12; // facet normal, recomputed from winding by every consumer
		for (const vertex of triangle) {
			for (const value of vertex) {
				buffer.writeFloatLE(value, offset);
				offset += 4;
			}
		}
		offset += 2; // attribute byte count
	}
	return buffer;
}

const workspace = mkdtempSync(join(tmpdir(), "dsh3d-blender-test-"));
writeFileSync(join(workspace, "cube20.stl"), boxStl(20, 20, 20));
writeFileSync(join(workspace, "block.stl"), boxStl(40, 40, 20, -20, -20, 0));

const ctx = createFakeContext({ cwd: workspace });
apply(ctx, {});

function call(name, args) {
	const definition = ctx.tools.get(name);
	assert.ok(definition, `${name} must be registered`);
	return definition.execute(args, makeExec(workspace));
}

// One probe decides whether the Blender-backed tests run; `createBlender` caches
// it, so every later call reuses this single launch.
const availability = await call("print3d_blender", { action: "detect" });
const noBlender = availability.ok === true ? false : "Blender 未安装或跑不起来";

test("parseMessages keeps only the [dsh3d] payloads", () => {
	const stdout = [
		"Blender 4.3.0 (hash 2b18cad88b13 built 2024-11-19 11:04:29)",
		"",
		"[dsh3d] {\"ok\": true, \"faces\": 12}",
		"Timer 'STL Import' took 1.01 ms",
		"[dsh3d] not json at all",
		"  File \"x.py\", line 1, in <module>  # mentions [dsh3d] in a comment"
	].join("\n");
	const messages = parseMessages(stdout, "");
	assert.equal(messages.filter((message) => message.json !== undefined).length, 1);
	assert.deepEqual(messages[0].json, { ok: true, faces: 12 });
	assert.equal(messages[0].text, "{\"ok\": true, \"faces\": 12}");
});

test("diagnose prefers the traceback reason over Blender noise", () => {
	const stderr = [
		"Blender 4.3.0 (hash 2b18cad88b13 built 2024-11-19 11:04:29)",
		"Traceback (most recent call last):",
		"  File \"/repo/blender/remesh.py\", line 71, in main",
		"    common.apply_modifier(obj, modifier)",
		"  File \"/repo/blender/_common.py\", line 300, in apply_modifier",
		"    bpy.ops.object.modifier_apply(modifier=modifier.name)",
		"RuntimeError: Error: Modifier is disabled, skipping apply",
		"Error: script failed, file: 'remesh.py', exiting."
	].join("\n");
	const lines = diagnose({ stderr, stdout: "" });
	assert.ok(lines.some((line) => line.includes("RuntimeError")), "keeps the exception line");
	assert.ok(!lines.some((line) => line.includes("Blender 4.3.0")), "drops the version banner");
});

test("detect reports a usable Blender", { skip: noBlender }, () => {
	assert.equal(availability.detect.found, true);
	assert.equal(availability.detect.scriptOk, true);
	assert.match(availability.detect.version, /^\d+\.\d+/u);
	assert.equal(availability.detect.capabilities.stlImport, true);
	assert.equal(availability.detect.capabilities.gltfExport, true);
	assert.ok(availability.detect.scripts.every((entry) => entry.exists), "every script ships with the plugin");
	assert.ok(existsSync(availability.blender.path));
});

test("inspect measures a 20 mm cube as 12 faces / 8 cm³", { skip: noBlender }, async () => {
	const value = await call("print3d_blender", { action: "inspect", input: "cube20.stl" });
	assert.equal(value.ok, true);
	assert.equal(value.model.totals.objects, 1);
	assert.equal(value.model.totals.faces, 12);
	assert.equal(value.model.totals.triangles, 12);
	assert.ok(Math.abs(value.model.totals.volumeCm3 - 8) < 1e-6, `volume was ${value.model.totals.volumeCm3}`);
	assert.deepEqual(value.model.sizeMm, [20, 20, 20]);
	assert.equal(value.model.watertight, true);
	assert.equal(value.model.openEdges, 0);
	// The welding pass is what makes those numbers true: a raw STL import has one
	// vertex per triangle corner, so unwelded it looks like a mesh full of holes.
	assert.equal(value.model.welded, true);
	assert.equal(value.model.objects[0].vertices, 8);
	assert.ok(value.argv.includes("--python-exit-code"), "a script crash must not exit 0");
});

test("a boolean cut removes exactly the cylinder volume", { skip: noBlender }, async () => {
	const value = await call("print3d_blender", {
		action: "edit",
		input: "block.stl",
		params: { op: "boolean", shape: "cylinder", diameter: 6 }
	});
	assert.equal(value.ok, true);
	assert.equal(value.edit.op, "boolean");
	assert.equal(value.edit.changed, true);
	// π · 3² · 20 = 565.49 mm³ through the 20 mm block.
	assert.ok(Math.abs(value.edit.removedCm3 - 0.56549) < 0.01, `removed ${value.edit.removedCm3} cm³`);
	assert.ok(value.edit.facesAfter > value.edit.facesBefore);
	assert.equal(value.edit.watertightAfter, true);
	assert.ok(existsSync(value.artifactsAbsolute[0]));
});

test("a cutter that misses the model is reported, not silently accepted", { skip: noBlender }, async () => {
	const value = await call("print3d_blender", {
		action: "edit",
		input: "block.stl",
		params: { op: "boolean", shape: "cylinder", diameter: 4, position: [500, 500, 500] }
	});
	assert.equal(value.edit.changed, false);
	assert.ok(value.warnings.some((warning) => warning.includes("没有碰到")), "warns that nothing was cut");
});

test("remesh closes the surface and reports the face explosion", { skip: noBlender }, async () => {
	const value = await call("print3d_blender", {
		action: "edit",
		input: "block.stl",
		params: { op: "remesh", voxel: 1.0 }
	});
	assert.equal(value.edit.op, "remesh");
	assert.equal(value.edit.watertightAfter, true);
	assert.ok(value.edit.facesAfter > 100, "voxel remesh produces many more faces");
	assert.ok(value.warnings.some((warning) => warning.includes("面数")), "warns about the face count");
});

test("export writes a real GLB", { skip: noBlender }, async () => {
	const value = await call("print3d_blender", { action: "export", input: "cube20.stl" });
	assert.equal(value.ok, true);
	const bytes = readFileSync(value.artifactsAbsolute[0]);
	assert.equal(bytes.subarray(0, 4).toString("ascii"), "glTF", "GLB magic");
	assert.equal(bytes.readUInt32LE(4), 2, "GLB version 2");
	assert.equal(value.export.trianglesAfter, 12);
});

test("decimate warns when it eats the volume", { skip: noBlender }, async () => {
	const value = await call("print3d_blender", { action: "export", input: "cube20.stl", params: { decimate: 0.5 } });
	assert.ok(value.export.trianglesAfter < value.export.trianglesBefore);
	assert.ok(value.warnings.some((warning) => warning.includes("体积")), "a destructive decimate is called out");
});

test("preview writes the views and a contact sheet", { skip: noBlender }, async () => {
	const value = await call("print3d_blender", { action: "preview", input: "cube20.stl", params: { sizePx: 240 } });
	assert.equal(value.preview.views.length, 4);
	for (const file of value.preview.files) {
		const bytes = readFileSync(join(workspace, file));
		assert.ok(bytes.length > 1000, `${file} should not be an empty PNG`);
		assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "PNG magic");
	}
	assert.ok(existsSync(join(workspace, value.preview.sheet)), "contact sheet exists");
});

test("edit refuses parameters it cannot honour", { skip: noBlender }, async () => {
	await assert.rejects(() => call("print3d_blender", { action: "export", input: "cube20.stl", params: { decimate: 1 } }), /decimate/u);
	await assert.rejects(() => call("print3d_blender", { action: "inspect", input: "missing.stl" }), /找不到模型/u);
	await assert.rejects(() => call("print3d_blender", { action: "explode" }), /不支持的 action/u);
	await assert.rejects(() => call("print3d_blender", { action: "edit", input: "block.stl", params: { op: "boolean", box: [10, 10] } }), /3 个数字/u);
});
