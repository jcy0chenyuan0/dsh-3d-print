"""import_stl.py — turn a STL into a clean, print-ready .blend.

What "clean" means here, and why each step exists:

* **Units.** The scene is set to 1 Blender unit = 1 mm, so the numbers inside the
  file are the numbers in every report and no caller has to remember a scale.
* **One body.** A STL import yields one object, but an OBJ/GLB may yield dozens;
  joining makes the later boolean/remesh/preview steps operate on one mesh
  instead of N special cases.
* **Z up.** A STL carries no up vector. Files from OpenSCAD, PrusaSlicer, Cura and
  CAD are authored Z-up, which is also the printer's build direction, so the safe
  default is to *trust the file* and only report what a rotation search would do.
  `--orient min-height` (lay it as flat as the bounding box allows) or
  `min-footprint` (stand it up to fit the bed) apply the rotation for real. The
  suggestion is always reported, never applied silently: turning a 200 mm vase
  onto its side is a bug, not a helpful default.
* **Centred and grounded.** X/Y centred on the origin, lowest point at Z=0, so a
  later cutter placed at "the middle of the bed" lands where the author expects.

    blender -b --python import_stl.py -- --input model.stl --output model.blend
                                       [--orient keep|min-height|min-footprint]
                                       [--no-join] [--scale 1.0]
"""
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.environ.get("DSH3D_SCRIPTS", "")
if _HERE and _HERE not in sys.path:
	sys.path.insert(0, _HERE)

import _common as common  # noqa: E402

ORIENT_MODES = ("keep", "min-height", "min-footprint")


def main():
	started_at = time.time()
	parser = common.make_parser("Import a mesh and save a clean .blend")
	parser.add_argument("--input", required=True, help="model to import")
	parser.add_argument("--output", required=True, help=".blend to write")
	parser.add_argument("--orient", default="keep", choices=ORIENT_MODES, help="rotation policy")
	parser.add_argument("--no-join", action="store_true", help="keep the imported objects separate")
	parser.add_argument("--scale", type=float, default=1.0, help="uniform scale applied to the mesh")
	args = common.parse(parser)

	path = common.require_input(args.input)
	scene = common.reset_scene()
	common.set_mm_units(scene)
	objects = common.import_model(path)

	for obj in objects:
		common.bake_object_transform(obj)
	if not args.no_join:
		objects = common.join_meshes(objects)

	if abs(args.scale - 1.0) > 1e-9:
		from mathutils import Matrix as _Matrix

		for obj in objects:
			obj.data.transform(_Matrix.Scale(args.scale, 4))
		objects = [common.bake_object_transform(obj) for obj in objects]

	before = common.bbox_of(objects)
	# Even in `keep` mode, report what the search would choose: the caller can see
	# "this 2 mm plate is standing on its edge" without asking for a rotation.
	search_mode = "min-footprint" if args.orient == "min-footprint" else "min-height"
	suggestion = common.suggest_orientation(objects, search_mode)
	applied = args.orient != "keep" and not suggestion["unchanged"]
	if args.orient != "keep":
		common.apply_rotation(objects, suggestion["matrix"])
		suggestion = common.suggest_orientation(objects, args.orient)

	placed = common.place_on_bed(objects)
	facts = [common.mesh_facts(obj) for obj in objects]
	blend = common.save_blend(os.path.abspath(args.output))

	common.finish({
		"script": "import_stl",
		"input": path,
		"blend": blend,
		"bytes": os.path.getsize(blend),
		"units": "mm",
		"objects": len(objects),
		"objectNames": [obj.name for obj in objects],
		"faces": sum(entry["faces"] for entry in facts),
		"triangles": sum(entry["triangles"] for entry in facts),
		"vertices": sum(entry["vertices"] for entry in facts),
		"volumeCm3": round(sum(entry["absoluteVolumeCm3"] for entry in facts), 4),
		"watertight": all(entry["watertight"] for entry in facts),
		"openEdges": sum(entry["openEdges"] for entry in facts),
		"nonManifoldEdges": sum(entry["nonManifoldEdges"] for entry in facts),
		"sizeBeforeMm": before["size"],
		"bboxAfter": placed,
		"sizeMm": placed["size"],
		"orient": {
			"requested": args.orient,
			"applied": applied,
			"searchMode": search_mode,
			"wouldChange": not suggestion["unchanged"],
			"suggestedSizeMm": suggestion["size"]
		},
		"elapsedMs": common.elapsed_since(started_at)
	})


main()
