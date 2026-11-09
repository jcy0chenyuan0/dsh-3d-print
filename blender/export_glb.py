"""export_glb.py — STL/OBJ/glTF in, one GLB out, optionally decimated.

Why decimate at all: a GLB is for viewing, sharing and web previews, where a
200k-triangle scan is a 12 MB download that nothing renders smoothly. The
decimate ratio is applied per object (before an optional join) so a multi-part
model keeps its parts distinguishable in the viewer.

    blender -b --python export_glb.py -- --input model.stl --output model.glb
                                       [--decimate 0.5] [--join] [--save-blend model.blend]
"""
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.environ.get("DSH3D_SCRIPTS", "")
if _HERE and _HERE not in sys.path:
	sys.path.insert(0, _HERE)

import _common as common  # noqa: E402


def main():
	started_at = time.time()
	parser = common.make_parser("Export a model as GLB")
	parser.add_argument("--input", required=True, help="model to import")
	parser.add_argument("--output", required=True, help=".glb to write")
	parser.add_argument("--decimate", type=float, default=0.0, help="target ratio 0..1 (0 = keep every face)")
	parser.add_argument("--join", action="store_true", help="join everything into one mesh first")
	parser.add_argument("--save-blend", default="", help="also save the edited scene here")
	args = common.parse(parser)

	if args.decimate < 0 or args.decimate >= 1:
		common.fail("--decimate 取值必须在 (0, 1) 之间，收到 %r；1.0 表示不减面，直接省略即可" % args.decimate)

	path = common.require_input(args.input)
	scene = common.reset_scene()
	common.set_mm_units(scene)
	objects = common.import_model(path)
	for obj in objects:
		common.bake_object_transform(obj)

	before = [common.mesh_facts(obj) for obj in objects]
	before_faces = sum(entry["triangles"] for entry in before)

	if args.join:
		objects = common.join_meshes(objects)

	if args.decimate > 0:
		for obj in objects:
			modifier = obj.modifiers.new(name="dsh3d-decimate", type="DECIMATE")
			modifier.decimate_type = "COLLAPSE"
			modifier.ratio = args.decimate
			# Use the mesh's existing normals rather than recomputing them: a
			# collapse decimate on an organic surface looks worse without them.
			modifier.use_collapse_triangulate = True
			common.apply_modifier(obj, modifier)

	after = [common.mesh_facts(obj) for obj in objects]
	after_faces = sum(entry["triangles"] for entry in after)
	glb = common.export_glb(os.path.abspath(args.output))
	blend = common.save_blend(os.path.abspath(args.save_blend)) if args.save_blend else ""

	common.finish({
		"script": "export_glb",
		"input": path,
		"glb": glb,
		"bytes": os.path.getsize(glb),
		"blend": blend,
		"objects": len(objects),
		"joined": bool(args.join),
		"decimate": args.decimate,
		"units": "mm",
		"trianglesBefore": before_faces,
		"trianglesAfter": after_faces,
		"ratio": round(after_faces / before_faces, 4) if before_faces else 0.0,
		"volumeBeforeCm3": round(sum(entry["absoluteVolumeCm3"] for entry in before), 4),
		"volumeAfterCm3": round(sum(entry["absoluteVolumeCm3"] for entry in after), 4),
		"sizeMm": common.bbox_of(objects)["size"],
		"elapsedMs": common.elapsed_since(started_at)
	})


main()
