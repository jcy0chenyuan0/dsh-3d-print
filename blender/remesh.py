"""remesh.py — make a scan or a rough model printable.

The repair pipeline, in the order that actually works:

1. **Voxel remesh.** The REMESH modifier in VOXEL mode rebuilds the surface as a
   closed shell at a fixed resolution, which is what fixes self-intersections,
   flipped normals and stray shells in one step. The voxel size is the whole
   trade-off: 0.2 mm keeps detail and explodes the face count, 1 mm smooths a
   miniature into a blob. It is expressed in millimetres and rounded to the mesh,
   so the result is deterministic.
2. **Smooth.** A SMOOTH modifier (Laplacian, factor 0.5) takes the stair-stepping
   off the voxel surface without changing the silhouette much.
3. **Decimate.** Optional, and last, because decimating before remeshing just
   destroys the evidence the remesher needs.

    blender -b --python remesh.py -- --input scan.stl --output fixed.stl
                                   [--voxel 0.4] [--smooth 3] [--decimate 0.4]
                                   [--adaptivity 0]
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
	parser = common.make_parser("Voxel-remesh and smooth a mesh into a printable solid")
	parser.add_argument("--input", required=True, help="mesh to repair")
	parser.add_argument("--output", required=True, help=".stl to write")
	parser.add_argument("--voxel", type=float, default=0.5, help="voxel size in mm (0.2 fine … 1.0 coarse)")
	parser.add_argument("--smooth", type=int, default=0, help="smoothing iterations (0 = off)")
	parser.add_argument("--decimate", type=float, default=0.0, help="target ratio 0..1 (0 = off)")
	parser.add_argument("--adaptivity", type=float, default=0.0, help="voxel adaptivity 0..1 (0 = uniform)")
	args = common.parse(parser)

	if args.voxel <= 0:
		common.fail("--voxel 必须大于 0（单位 mm）；手办/扫描件一般 0.2–0.6，越大越省面也越糊")
	if args.decimate < 0 or args.decimate >= 1:
		common.fail("--decimate 取值必须在 (0, 1) 之间，收到 %r" % args.decimate)

	path = common.require_input(args.input)
	scene = common.reset_scene()
	common.set_mm_units(scene)
	objects = common.import_model(path)
	for obj in objects:
		common.bake_object_transform(obj)
	objects = common.join_meshes(objects)

	before = [common.mesh_facts(obj) for obj in objects]
	size = common.bbox_of(objects)["size"]
	# One voxel must not exceed a third of the smallest dimension, or a thin wall
	# simply disappears and the "repair" produces a smoother, smaller, wrong part.
	smallest = min(value for value in size if value > 0) if any(value > 0 for value in size) else 0.0
	if smallest > 0 and args.voxel > smallest / 3.0:
		common.fail(
			"--voxel %.2f mm 太粗：模型最小尺寸只有 %.2f mm，体素超过它的 1/3 会把薄壁吃掉。"
			"改用 %.2f mm 或更小。" % (args.voxel, smallest, max(0.05, round(smallest / 8.0, 2)))
		)

	for obj in objects:
		modifier = obj.modifiers.new(name="dsh3d-remesh", type="REMESH")
		modifier.mode = "VOXEL"
		modifier.voxel_size = args.voxel
		modifier.adaptivity = args.adaptivity
		modifier.use_smooth_shade = True
		common.apply_modifier(obj, modifier)

	applied = ["voxel:%g" % args.voxel, "adaptivity:%g" % args.adaptivity]
	if args.smooth > 0:
		for obj in objects:
			modifier = obj.modifiers.new(name="dsh3d-smooth", type="SMOOTH")
			modifier.factor = 0.5
			modifier.iterations = args.smooth
			common.apply_modifier(obj, modifier)
		applied.append("smooth:%d" % args.smooth)
	if args.decimate > 0:
		for obj in objects:
			modifier = obj.modifiers.new(name="dsh3d-decimate", type="DECIMATE")
			modifier.decimate_type = "COLLAPSE"
			modifier.ratio = args.decimate
			common.apply_modifier(obj, modifier)
		applied.append("decimate:%g" % args.decimate)

	after = [common.mesh_facts(obj) for obj in objects]
	stl = common.export_stl(os.path.abspath(args.output))

	common.finish({
		"script": "remesh",
		"input": path,
		"stl": stl,
		"bytes": os.path.getsize(stl),
		"units": "mm",
		"steps": applied,
		"voxelMm": args.voxel,
		"trianglesBefore": sum(entry["triangles"] for entry in before),
		"trianglesAfter": sum(entry["triangles"] for entry in after),
		"watertightBefore": all(entry["watertight"] for entry in before),
		"watertightAfter": all(entry["watertight"] for entry in after),
		"openEdgesAfter": sum(entry["openEdges"] for entry in after),
		"nonManifoldEdgesAfter": sum(entry["nonManifoldEdges"] for entry in after),
		"volumeBeforeCm3": round(sum(entry["absoluteVolumeCm3"] for entry in before), 4),
		"volumeAfterCm3": round(sum(entry["absoluteVolumeCm3"] for entry in after), 4),
		"sizeBeforeMm": size,
		"sizeMm": common.bbox_of(objects)["size"],
		"elapsedMs": common.elapsed_since(started_at)
	})


main()
