"""inspect.py — what Blender sees when it opens a model.

Blender's view complements `print3d_check` rather than duplicating it: the local
STL analyser measures the raw triangle soup, while this reports the *scene* — how
many objects the file really contains, which materials and modifiers came with
it, and whether the welded topology is closed. A slicer repairs holes silently;
this is the honest count before that happens.

    blender -b --python inspect.py -- --input model.stl [--no-weld]

Prints one `[dsh3d] {json}` line with per-object facts, totals and the bounding
box in millimetres.
"""
import json
import os
import sys
import time

# Blender puts the script's folder nowhere near sys.path; DSH3D_SCRIPTS is the
# fallback for launches where __file__ is not defined.
_HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.environ.get("DSH3D_SCRIPTS", "")
if _HERE and _HERE not in sys.path:
	sys.path.insert(0, _HERE)

import _common as common  # noqa: E402  (sys.path is set up above, by necessity)


def main():
	started_at = time.time()
	parser = common.make_parser("Inspect a model with Blender")
	parser.add_argument("--input", required=True, help="model to open (.stl/.obj/.glb/.blend)")
	parser.add_argument("--no-weld", action="store_true", help="report the unwelded topology")
	parser.add_argument("--output", default="", help="also write this JSON report to a file")
	args = common.parse(parser)

	path = common.require_input(args.input)
	scene = common.reset_scene()
	common.set_mm_units(scene)
	objects = common.import_model(path)

	# Measure the welded mesh by default: an imported STL carries one vertex per
	# triangle corner, so un-welded numbers would call every edge a hole.
	facts = common.model_facts(objects)
	if args.no_weld:
		facts["objects"] = [common.mesh_facts(obj, weld=False) for obj in objects]
		facts["watertight"] = all(entry["watertight"] for entry in facts["objects"])
		facts["openEdges"] = sum(entry["openEdges"] for entry in facts["objects"])
		facts["nonManifoldEdges"] = sum(entry["nonManifoldEdges"] for entry in facts["objects"])

	payload = {
		"script": "inspect",
		"input": path,
		"units": "mm",
		"imported": len(objects),
		"objects": facts["objects"],
		"totals": facts["totals"],
		"bbox": facts["bbox"],
		"sizeMm": facts["sizeMm"],
		"watertight": facts["watertight"],
		"openEdges": facts["openEdges"],
		"nonManifoldEdges": facts["nonManifoldEdges"],
		"materials": facts["materials"],
		"modifiers": facts["modifiers"],
		"volumeCm3": facts["totals"]["volumeCm3"],
		"welded": not args.no_weld,
		"elapsedMs": common.elapsed_since(started_at)
	}
	if args.output:
		common.ensure_dir(args.output)
		with open(args.output, "w", encoding="utf-8") as handle:
			json.dump(payload, handle, ensure_ascii=False, indent=2)
		payload["report"] = os.path.abspath(args.output)
	common.finish(payload)


main()
