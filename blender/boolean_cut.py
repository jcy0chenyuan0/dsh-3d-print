"""boolean_cut.py — drill a hole or mill a slot with a solid, in Blender's view.

This is the "modify it in Blender" operation: a cube or a cylinder is placed in
model space and subtracted (or unioned / intersected). The cutter is built with
bmesh instead of `primitive_*_add`, because in `-b` the primitive operators depend
on the 3D view's cursor and mode while `bmesh.ops.create_cube` does not — the same
reason the modifier is applied through a `temp_override`.

Coordinates are the model's own: millimetres, the same space the STL was authored
in, after `import_stl.py` has centred it on the origin and dropped it onto Z=0.
`--position` omitted means "the middle of the model", which is what a through-hole
almost always wants.

    blender -b --python boolean_cut.py -- --input part.stl --output part-hole.stl
                                      [--shape cylinder] [--diameter 5] [--depth 0]
                                      [--box 10,10,10] [--position 0,0,10]
                                      [--rotation 0,0,0] [--operation difference]
"""
import math
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.environ.get("DSH3D_SCRIPTS", "")
if _HERE and _HERE not in sys.path:
	sys.path.insert(0, _HERE)

import _common as common  # noqa: E402

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

OPERATIONS = ("difference", "union", "intersect")
SHAPES = ("cube", "cylinder")


def cutter_object(shape, box, diameter, depth, location, rotation):
	"""Build the cutter mesh directly — no operators, no view-layer assumptions."""
	bm = bmesh.new()
	if shape == "cube":
		bmesh.ops.create_cube(bm, size=1.0)
		bmesh.ops.scale(bm, vec=Vector(box), verts=list(bm.verts))
	else:
		# 96 segments: a 5 mm hole at 96 sides is 0.16 mm per chord, well under a
		# 0.4 mm nozzle line, so the cylinder reads as a circle after slicing.
		bmesh.ops.create_cone(
			bm,
			cap_ends=True,
			cap_tris=False,
			segments=96,
			radius1=diameter / 2.0,
			radius2=diameter / 2.0,
			depth=depth
		)
	mesh = bpy.data.meshes.new("dsh3d-cutter")
	bm.to_mesh(mesh)
	bm.free()
	obj = bpy.data.objects.new("dsh3d-cutter", mesh)
	obj.location = Vector(location)
	obj.rotation_euler = Euler(rotation, "XYZ")
	bpy.context.scene.collection.objects.link(obj)
	return obj


def main():
	started_at = time.time()
	parser = common.make_parser("Subtract or add a solid in Blender")
	parser.add_argument("--input", required=True, help="model to modify")
	parser.add_argument("--output", required=True, help=".stl to write")
	parser.add_argument("--shape", default="cylinder", choices=SHAPES)
	parser.add_argument("--box", default="10,10,10", help="cube dimensions x,y,z in mm")
	parser.add_argument("--diameter", type=float, default=5.0, help="cylinder diameter in mm")
	parser.add_argument("--depth", type=float, default=0.0, help="cylinder length in mm (0 = through)")
	parser.add_argument("--position", default="", help="cutter centre x,y,z in mm (default: model centre)")
	parser.add_argument("--rotation", default="0,0,0", help="cutter rotation rx,ry,rz in degrees")
	parser.add_argument("--operation", default="difference", choices=OPERATIONS)
	args = common.parse(parser)

	path = common.require_input(args.input)
	scene = common.reset_scene()
	common.set_mm_units(scene)
	objects = common.import_model(path)
	for obj in objects:
		common.bake_object_transform(obj)

	box_before = common.bbox_of(objects)
	before = [common.mesh_facts(obj) for obj in objects]

	box = common.parse_list(args.box, [10.0, 10.0, 10.0])
	rotation = [math.radians(value) for value in common.parse_list(args.rotation, [0.0, 0.0, 0.0])]
	position = common.parse_list(args.position, None)
	if position is None:
		position = list(box_before["center"])
	# "depth 0 = through": a cylinder shorter than the model's diagonal can leave
	# a blind pocket, which is never what "drill a hole" means, so default it long
	# enough to exit on both sides.
	depth = args.depth if args.depth > 0 else max(box_before["size"]) * 1.6 + 1.0
	if args.diameter <= 0:
		common.fail("--diameter 必须大于 0 mm")
	if min(box) <= 0:
		common.fail("--box 的三个尺寸都必须大于 0 mm，收到 %r" % args.box)

	cutter = cutter_object(args.shape, box, args.diameter, depth, position, rotation)
	cutter_name = "%s %s" % (
		args.shape,
		("Ø%.2f×%.2f mm" % (args.diameter, depth)) if args.shape == "cylinder" else ("×".join("%.2f" % v for v in box) + " mm")
	)

	for obj in objects:
		modifier = obj.modifiers.new(name="dsh3d-boolean", type="BOOLEAN")
		modifier.operation = {"difference": "DIFFERENCE", "union": "UNION", "intersect": "INTERSECT"}[args.operation]
		modifier.object = cutter
		# EXACT is the solver that produces a watertight result on coplanar and
		# near-degenerate geometry; FAST leaves cracks exactly where a cut meets a
		# face, which is the case here (a hole through a flat wall).
		modifier.solver = "EXACT"
		common.apply_modifier(obj, modifier)

	bpy.data.objects.remove(cutter, do_unlink=True)

	after = [common.mesh_facts(obj) for obj in objects]
	box_after = common.bbox_of(objects)
	volume_before = sum(entry["absoluteVolumeCm3"] for entry in before)
	volume_after = sum(entry["absoluteVolumeCm3"] for entry in after)
	changed = abs(volume_after - volume_before) > 1e-6 or sum(entry["faces"] for entry in after) != sum(entry["faces"] for entry in before)
	stl = common.export_stl(os.path.abspath(args.output))

	common.finish({
		"script": "boolean_cut",
		"input": path,
		"stl": stl,
		"bytes": os.path.getsize(stl),
		"units": "mm",
		"operation": args.operation,
		"solver": "EXACT",
		"cutter": {
			"shape": args.shape,
			"label": cutter_name,
			"position": [round(value, 3) for value in position],
			"rotationDeg": [round(math.degrees(value), 3) for value in rotation],
			"box": box if args.shape == "cube" else None,
			"diameter": args.diameter if args.shape == "cylinder" else None,
			"depth": round(depth, 3) if args.shape == "cylinder" else None
		},
		"changed": changed,
		"facesBefore": sum(entry["faces"] for entry in before),
		"facesAfter": sum(entry["faces"] for entry in after),
		"volumeBeforeCm3": round(volume_before, 4),
		"volumeAfterCm3": round(volume_after, 4),
		"removedCm3": round(volume_before - volume_after, 4),
		"watertightAfter": all(entry["watertight"] for entry in after),
		"openEdgesAfter": sum(entry["openEdges"] for entry in after),
		"nonManifoldEdgesAfter": sum(entry["nonManifoldEdges"] for entry in after),
		"sizeBeforeMm": box_before["size"],
		"sizeMm": box_after["size"],
		"elapsedMs": common.elapsed_since(started_at)
	})


main()
