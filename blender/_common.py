"""Shared helpers for the headless Blender scripts behind print3d_blender.

Why this file exists
--------------------
Six scripts need the same five things: read the arguments Blender hands them,
report facts on the one channel the caller trusts, import a mesh by extension
across the 4.x operator renames, measure a mesh in millimetres, and write STL /
GLB without relying on the operator context. Duplicating that six times is how
the scripts drift apart, so it lives here and each script stays a short, readable
description of *its* job.

Two Blender facts this module hides
-----------------------------------
* `__file__` is set for `--python` scripts but the script's folder is *not* on
  `sys.path`, so `import _common` fails unless the folder is added. The runner
  also exports DSH3D_SCRIPTS as a second source, because `--python-expr` and some
  packaged builds do not define `__file__`.
* Units: an STL has no units. Files from OpenSCAD / slicers / CAD are in
  millimetres and Blender's native unit is the metre, so every script sets
  `scene.unit_settings.scale_length = 0.001` — one Blender unit is one
  millimetre. The numbers in the file are then read and written unchanged, which
  is what makes "20 mm cube" mean 20 everywhere in the report.
"""
import argparse
import json
import math
import os
import sys
import time

MARKER = "[dsh3d]"

try:  # only true inside Blender; the import below must not run at module scope
	import bpy
	import bmesh
	from mathutils import Euler, Matrix, Vector
except ImportError:  # pragma: no cover - the module is only ever used inside Blender
	bpy = None
	bmesh = None


def _rehome():
	"""Put this file's folder on sys.path so `import _common` works from a script."""
	here = ""
	try:
		here = os.path.dirname(os.path.abspath(__file__))
	except NameError:  # --python-expr or a build without __file__
		here = os.environ.get("DSH3D_SCRIPTS", "")
	if here and here not in sys.path:
		sys.path.insert(0, here)


_rehome()


def _jsonable(value):
	"""Vectors, matrices and sets are common in Blender payloads; json needs lists."""
	for attribute in ("to_list", "to_tuple"):
		method = getattr(value, attribute, None)
		if callable(method):
			return list(method())
	try:
		return list(value)
	except TypeError:
		return str(value)


def emit(payload):
	"""Write one fact on the only channel the caller reads."""
	sys.stdout.write(MARKER + " " + json.dumps(payload, ensure_ascii=False, default=_jsonable) + "\n")
	sys.stdout.flush()


def finish(payload):
	emit(dict(payload, ok=True))
	sys.exit(0)


def fail(message, **extra):
	"""Report a failure the model can act on, then exit non-zero.

	The non-zero exit is not decoration: the runner passes `--python-exit-code 1`
	so that a raised exception is distinguishable from a silent no-op, and a
	script that decides "this cannot work" should look the same as one that
	crashed.
	"""
	emit(dict(ok=False, error=str(message), **extra))
	sys.exit(3)


def script_args():
	"""Arguments after `--` (Blender keeps its own argv including the separator)."""
	if "--" not in sys.argv:
		return []
	return sys.argv[sys.argv.index("--") + 1:]


def make_parser(description):
	return argparse.ArgumentParser(prog="print3d_blender", description=description)


def parse(parser):
	return parser.parse_args(script_args())


def parse_list(text, default=None):
	"""`"1,2,3"` → `[1.0, 2.0, 3.0]`; empty/None → default."""
	if text is None or str(text).strip() == "":
		return default
	try:
		return [float(part) for part in str(text).replace("x", ",").split(",") if part.strip() != ""]
	except ValueError:
		fail("数值列表解析失败：%r（期望形如 1,2,3）" % text)


def require_input(path):
	if not path:
		fail("缺少 --input（要打开的模型路径）")
	if not os.path.isfile(path):
		fail("找不到输入文件：%s" % path)
	if os.path.getsize(path) == 0:
		fail("输入文件是空的：%s" % path)
	return os.path.abspath(path)


def ensure_dir(path):
	if not path:
		return
	os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)


def reset_scene():
	"""Empty the scene without touching preferences or add-ons.

	`read_factory_settings()` would also do it, but it reloads the whole
	preference set — which can disable the bundled glTF add-on on a machine where
	the user turned it off. Removing objects is enough and has no side effects.
	"""
	scene = bpy.context.scene
	for obj in list(bpy.data.objects):
		bpy.data.objects.remove(obj, do_unlink=True)
	for collection in list(bpy.data.collections):
		bpy.data.collections.remove(collection)
	return scene


def set_mm_units(scene):
	"""One Blender unit = one millimetre, for both display and the scripts."""
	units = scene.unit_settings
	units.system = "METRIC"
	units.scale_length = 0.001
	try:
		units.length_unit = "MILLIMETERS"
	except TypeError:  # older/newer enum layouts
		pass


def mesh_objects():
	return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def import_model(path):
	"""Import a model, dispatching on the extension.

	4.x moved STL and OBJ to `wm.*` operators; the `hasattr` guards keep the
	bridge working on a 3.x install and on builds where the add-on is missing.
	The axis arguments are the importer defaults, spelled out because "which way
	is up" is exactly the thing that silently changes between versions.
	"""
	extension = os.path.splitext(path)[1].lower()
	if extension == ".stl":
		if hasattr(bpy.ops.wm, "stl_import"):
			bpy.ops.wm.stl_import(filepath=path, global_scale=1.0, use_scene_unit=False)
		elif hasattr(bpy.ops.import_mesh, "stl"):
			bpy.ops.import_mesh.stl(filepath=path)
		else:
			fail("这个 Blender 既没有 wm.stl_import 也没有 import_mesh.stl，装的是精简版？")
	elif extension == ".obj":
		if hasattr(bpy.ops.wm, "obj_import"):
			bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z")
		elif hasattr(bpy.ops.import_scene, "obj"):
			bpy.ops.import_scene.obj(filepath=path)
		else:
			fail("这个 Blender 没有 OBJ 导入器（io_scene_obj 被关掉了？）")
	elif extension in (".glb", ".gltf"):
		if not hasattr(bpy.ops.import_scene, "gltf"):
			fail("这个 Blender 没有 glTF 导入器（io_scene_gltf2 被关掉了？）")
		bpy.ops.import_scene.gltf(filepath=path)
	elif extension == ".ply":
		bpy.ops.wm.ply_import(filepath=path)
	elif extension == ".blend":
		bpy.ops.wm.open_mainfile(filepath=path)
	else:
		fail("不支持的输入格式 %r（支持 .stl/.obj/.glb/.gltf/.ply/.blend）" % extension)
	objects = mesh_objects()
	if not objects:
		fail("导入成功但场景里没有网格对象：%s" % path)
	return objects


def bake_object_transform(obj):
	"""Fold the object matrix into the mesh so all later math is in millimetres.

	After this, `matrix_world` is identity and vertex coordinates *are* world
	coordinates — which is what every bbox/volume/orientation calculation
	downstream assumes.
	"""
	matrix = obj.matrix_world.copy()
	if matrix != Matrix.Identity(4):
		obj.data.transform(matrix)
	obj.matrix_world = Matrix.Identity(4)
	return obj


def join_meshes(objects):
	"""Join into one object; STL/GLB output is a single body in almost every case."""
	if len(objects) <= 1:
		return objects
	view_layer = bpy.context.view_layer
	for obj in bpy.data.objects:
		obj.select_set(False)
	for obj in objects:
		obj.select_set(True)
	target = objects[0]
	view_layer.objects.active = target
	try:
		with bpy.context.temp_override(
			active_object=target,
			selected_objects=objects,
			selected_editable_objects=objects
		):
			bpy.ops.object.join()
	except RuntimeError as error:
		fail("合并对象失败：%s" % error)
	return [target]


def apply_modifier(obj, modifier):
	"""Apply one modifier; the `temp_override` is what makes ops work in `-b`."""
	if obj.data.users > 1:
		obj.data = obj.data.copy()
	view_layer = bpy.context.view_layer
	view_layer.objects.active = obj
	obj.select_set(True)
	try:
		with bpy.context.temp_override(
			object=obj,
			active_object=obj,
			selected_objects=[obj],
			selected_editable_objects=[obj]
		):
			bpy.ops.object.modifier_apply(modifier=modifier.name)
	except RuntimeError as error:
		fail("应用修改器 %s 失败：%s" % (modifier.name, error))


def _round(value, digits=4):
	"""Round, and normalise -0.0 to 0.0 so reports do not show a negative zero."""
	rounded = round(value, digits)
	return 0.0 if rounded == 0 else rounded


def bbox_of(objects):
	"""World-space bounds over one or more objects, in millimetres.

	`obj.bound_box` is a *cached* value: after `Mesh.transform()` runs (which is how
	this module rotates, centres and grounds a model — no operators involved) the
	cache still holds the pre-transform box until the depsgraph evaluates. Without
	the update below the report would happily print the size from before the
	rotation, which is exactly the number a caller checks to confirm it worked.
	"""
	bpy.context.view_layer.update()
	minimum = [float("inf")] * 3
	maximum = [float("-inf")] * 3
	for obj in objects:
		matrix = obj.matrix_world
		for corner in obj.bound_box:
			point = matrix @ Vector(corner)
			for axis in range(3):
				minimum[axis] = min(minimum[axis], point[axis])
				maximum[axis] = max(maximum[axis], point[axis])
	if minimum[0] == float("inf"):
		return {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0], "size": [0.0, 0.0, 0.0], "center": [0.0, 0.0, 0.0]}
	size = [maximum[i] - minimum[i] for i in range(3)]
	center = [(maximum[i] + minimum[i]) / 2 for i in range(3)]
	return {
		"min": [_round(value) for value in minimum],
		"max": [_round(value) for value in maximum],
		"size": [_round(value) for value in size],
		"center": [_round(value) for value in center]
	}


def mesh_facts(obj, weld=True, weld_dist=1.0e-4):
	"""Faces, topology, volume and bounds for one object, in millimetres.

	The weld is not cosmetic: `wm.stl_import` keeps every triangle's vertices, so
	an un-welded STL reports every edge as open and every model looks broken.
	Measuring the welded topology is the only number that matches what a slicer
	will see.
	"""
	bm = bmesh.new()
	try:
		bm.from_mesh(obj.data)
		raw_vertices = len(bm.verts)
		if weld and bm.verts:
			bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=weld_dist)
		bm.normal_update()
		faces = len(bm.faces)
		vertices = len(bm.verts)
		triangles = sum(max(1, len(face.verts) - 2) for face in bm.faces)
		open_edges = sum(1 for edge in bm.edges if len(edge.link_faces) == 1)
		non_manifold = sum(1 for edge in bm.edges if len(edge.link_faces) > 2)
		wire_edges = sum(1 for edge in bm.edges if len(edge.link_faces) == 0)
		loose_vertices = sum(1 for vertex in bm.verts if not vertex.link_edges)
		signed_volume = bm.calc_volume(signed=True) if faces > 0 else 0.0
		matrix = obj.matrix_world
		points = [matrix @ vertex.co for vertex in bm.verts]
		if points:
			minimum = [min(point[axis] for point in points) for axis in range(3)]
			maximum = [max(point[axis] for point in points) for axis in range(3)]
		else:
			minimum = [0.0, 0.0, 0.0]
			maximum = [0.0, 0.0, 0.0]
	finally:
		bm.free()
	size = [maximum[i] - minimum[i] for i in range(3)]
	return {
		"name": obj.name,
		"faces": faces,
		"triangles": triangles,
		"vertices": vertices,
		"rawVertices": raw_vertices,
		"openEdges": open_edges,
		"nonManifoldEdges": non_manifold,
		"wireEdges": wire_edges,
		"looseVertices": loose_vertices,
		"watertight": faces > 0 and open_edges == 0 and non_manifold == 0 and wire_edges == 0,
		"manifold": non_manifold == 0 and open_edges == 0,
		"volumeMm3": round(signed_volume, 3),
		"volumeCm3": round(signed_volume / 1000.0, 4),
		"absoluteVolumeCm3": round(abs(signed_volume) / 1000.0, 4),
		"bbox": {
			"min": [round(value, 4) for value in minimum],
			"max": [round(value, 4) for value in maximum],
			"size": [round(value, 4) for value in size]
		},
		"materials": [material.name for material in obj.data.materials if material is not None],
		"modifiers": [{"name": modifier.name, "type": modifier.type} for modifier in obj.modifiers]
	}


def model_facts(objects):
	"""Aggregate facts for a whole import: per object plus totals."""
	per_object = [mesh_facts(obj) for obj in objects]
	total_faces = sum(entry["faces"] for entry in per_object)
	total_triangles = sum(entry["triangles"] for entry in per_object)
	total_vertices = sum(entry["vertices"] for entry in per_object)
	total_volume = sum(entry["absoluteVolumeCm3"] for entry in per_object)
	box = bbox_of(objects)
	return {
		"objects": per_object,
		"totals": {
			"objects": len(per_object),
			"faces": total_faces,
			"triangles": total_triangles,
			"vertices": total_vertices,
			"volumeCm3": round(total_volume, 4)
		},
		"bbox": box,
		"sizeMm": box["size"],
		"watertight": all(entry["watertight"] for entry in per_object),
		"openEdges": sum(entry["openEdges"] for entry in per_object),
		"nonManifoldEdges": sum(entry["nonManifoldEdges"] for entry in per_object),
		"materials": sorted({name for entry in per_object for name in entry["materials"]}),
		"modifiers": [modifier for entry in per_object for modifier in entry["modifiers"]]
	}


def export_stl(path):
	ensure_dir(path)
	if hasattr(bpy.ops.wm, "stl_export"):
		bpy.ops.wm.stl_export(filepath=path, ascii_format=False, apply_modifiers=True)
	elif hasattr(bpy.ops.export_mesh, "stl"):
		bpy.ops.export_mesh.stl(filepath=path, ascii=False, use_selection=False)
	else:
		fail("这个 Blender 既没有 wm.stl_export 也没有 export_mesh.stl，没法导出 STL")
	if not os.path.isfile(path) or os.path.getsize(path) == 0:
		fail("STL 导出没有产出文件：%s" % path)
	return path


def export_glb(path):
	ensure_dir(path)
	if not hasattr(bpy.ops.export_scene, "gltf"):
		fail("这个 Blender 没有 glTF 导出器（io_scene_gltf2 被关掉了？）")
	bpy.ops.export_scene.gltf(
		filepath=path,
		export_format="GLB",
		use_selection=False,
		export_apply=True,
		export_yup=True
	)
	if not os.path.isfile(path) or os.path.getsize(path) == 0:
		fail("GLB 导出没有产出文件：%s" % path)
	return path


def save_blend(path):
	ensure_dir(path)
	# One .blend per call, not per save: a stray .blend1 next to the output is
	# noise in a directory the model is going to list.
	bpy.context.preferences.filepaths.save_version = 0
	bpy.ops.wm.save_as_mainfile(filepath=path, check_existing=False)
	if not os.path.isfile(path):
		fail("保存 .blend 失败：%s" % path)
	return path


def rotation_candidates():
	"""All 24 axis-aligned proper rotations, as matrices.

	Counting the axis-aligned ones is enough for a printable part: STL files come
	from CAD and slicers, so the interesting orientations are always 90° steps.
	Building them from quarter-turn Eulers and de-duplicating avoids hand-writing
	a permutation table with the right determinant signs.
	"""
	found = {}
	for ix in range(4):
		for iy in range(4):
			for iz in range(4):
				matrix = Euler(
					(ix * math.pi / 2, iy * math.pi / 2, iz * math.pi / 2), "XYZ"
				).to_matrix()
				key = tuple(round(matrix[row][column], 4) for row in range(3) for column in range(3))
				found.setdefault(key, matrix)
	return list(found.values())


def suggest_orientation(objects, mode):
	"""Pick the rotation that best matches `mode`, plus the numbers behind it.

	`min-height` lays the part as flat as the bounding box allows (the usual
	"print it the way it was designed" answer), `min-footprint` stands it up to
	fit a small bed. The suggestion is always reported, but only applied when the
	caller asked for it: silently rotating a vase onto its side is a bug, not a
	feature.
	"""
	box = bbox_of(objects)
	identity = Matrix.Identity(3)
	corners = [
		Vector((box["min"][0], box["min"][1], box["min"][2])),
		Vector((box["max"][0], box["min"][1], box["min"][2])),
		Vector((box["min"][0], box["max"][1], box["min"][2])),
		Vector((box["min"][0], box["min"][1], box["max"][2])),
		Vector((box["max"][0], box["max"][1], box["min"][2])),
		Vector((box["max"][0], box["min"][1], box["max"][2])),
		Vector((box["min"][0], box["max"][1], box["max"][2])),
		Vector((box["max"][0], box["max"][1], box["max"][2]))
	]

	def size_after(matrix):
		points = [matrix @ corner for corner in corners]
		return [
			max(point[axis] for point in points) - min(point[axis] for point in points)
			for axis in range(3)
		]

	def score(size):
		if mode == "min-footprint":
			return (size[0] * size[1], size[2])
		return (size[2], size[0] * size[1])

	best = {"matrix": identity, "size": size_after(identity)}
	best_score = score(best["size"])
	for candidate in rotation_candidates():
		size = size_after(candidate)
		candidate_score = score(size)
		# Strict improvement only: on a tie the file's own orientation wins, which
		# is what makes "already correct" models come out untouched.
		if candidate_score[0] < best_score[0] * 0.999 or (
			abs(candidate_score[0] - best_score[0]) <= best_score[0] * 0.001
			and candidate_score[1] < best_score[1]
		):
			best = {"matrix": candidate, "size": size}
			best_score = candidate_score
	return {
		"mode": mode,
		"matrix": best["matrix"],
		"size": [round(value, 3) for value in best["size"]],
		"unchanged": best["matrix"] == identity
	}


def apply_rotation(objects, matrix):
	"""Rotate mesh data in place (no operators, no context requirements).

	`Mesh.transform` insists on a 4×4 matrix while the search works in 3×3, so
	the conversion happens here once instead of at every call site.
	"""
	if len(matrix) == 3:
		matrix = matrix.to_4x4()
	seen = set()
	for obj in objects:
		if obj.data.name in seen:
			continue
		seen.add(obj.data.name)
		obj.data.transform(matrix)


def place_on_bed(objects, center_xy=True, ground=True):
	"""Centre on X/Y and drop the lowest point onto Z=0, in mesh space."""
	box = bbox_of(objects)
	shift = Vector((0.0, 0.0, 0.0))
	if center_xy:
		shift.x = -box["center"][0]
		shift.y = -box["center"][1]
	if ground:
		shift.z = -box["min"][2]
	if shift.length == 0:
		return box
	seen = set()
	for obj in objects:
		if obj.data.name in seen:
			continue
		seen.add(obj.data.name)
		obj.data.transform(Matrix.Translation(shift))
	return bbox_of(objects)


def elapsed_since(started_at):
	"""Milliseconds since `time.time()` was captured before the work started."""
	return int(round((time.time() - started_at) * 1000))
