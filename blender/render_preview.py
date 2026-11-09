"""render_preview.py — three orthographic views plus an isometric, as PNGs.

Why not EEVEE everywhere: EEVEE needs a light rig and, on a headless box, a GPU
context; Workbench renders a studio-lit, cavity-shaded solid with no GPUs, no
lights and no material setup, which is exactly right for "show me the shape". It
is also 3–5× faster, which matters when a preview is a side effect of some other
operation. `--engine eevee` exists for material/colour previews and is verified to
work headless on this machine.

The framing is computed from the model's own bounding box, per view: the box
corners are projected onto the camera's right/up axes, so a 200×20×5 mm plate fills
the frame in the front view instead of sitting in a postage stamp of empty space
(the usual result of a fixed camera distance).

    blender -b --python render_preview.py -- --input part.stl --outdir preview/
                                             --stem part [--size 900]
                                             [--views front,right,top,iso]
                                             [--engine workbench|eevee]
                                             [--no-sheet]
"""
import math
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.environ.get("DSH3D_SCRIPTS", "")
if _HERE and _HERE not in sys.path:
	sys.path.insert(0, _HERE)

import _common as common  # noqa: E402

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

# Camera direction is measured from the model towards the camera, so "front"
# means "looking at the -Y face", which is the convention every CAD viewer uses.
VIEWS = {
	"front": (Vector((0.0, -1.0, 0.0)), "ortho"),
	"back": (Vector((0.0, 1.0, 0.0)), "ortho"),
	"left": (Vector((-1.0, 0.0, 0.0)), "ortho"),
	"right": (Vector((1.0, 0.0, 0.0)), "ortho"),
	"top": (Vector((0.0, 0.0, 1.0)), "ortho"),
	"bottom": (Vector((0.0, 0.0, -1.0)), "ortho"),
	"iso": (Vector((1.0, -1.0, 0.75)), "persp")
}

DEFAULT_VIEWS = ["front", "right", "top", "iso"]


def scene_setup(engine, size):
	scene = bpy.context.scene
	scene.render.resolution_x = size
	scene.render.resolution_y = size
	scene.render.resolution_percentage = 100
	scene.render.image_settings.file_format = "PNG"
	scene.render.image_settings.color_mode = "RGB"
	scene.render.image_settings.color_depth = "8"
	scene.render.film_transparent = False
	if engine == "eevee":
		scene.render.engine = "BLENDER_EEVEE_NEXT"
		try:
			scene.eevee.taa_render_samples = 32
		except AttributeError:
			pass
	else:
		scene.render.engine = "BLENDER_WORKBENCH"
	shading = scene.display.shading
	# Cosmetic, so a build that lacks one of these must not kill the preview.
	for attribute, value in (
		("light", "STUDIO"),
		("color_type", "OBJECT"),
		("show_cavity", True),
		("cavity_type", "BOTH"),
		("show_shadows", True),
		("shadow_intensity", 0.35),
		("show_object_outline", True),
		("background_type", "VIEWPORT"),
	):
		try:
			setattr(shading, attribute, value)
		except (AttributeError, TypeError):
			pass
	try:
		shading.background_color = (0.10, 0.11, 0.13)
	except (AttributeError, TypeError):
		pass
	try:
		scene.display.render_aa = "8"
	except (AttributeError, TypeError):
		pass
	return scene


def give_objects_a_body(objects):
	"""A colour for Workbench and a Principled material for EEVEE.

	Without this an EEVEE preview of a bare STL is flat grey and every edge
	disappears; the teal is chosen to read against the dark background.
	"""
	material = bpy.data.materials.new("dsh3d-preview")
	material.use_nodes = True
	principled = material.node_tree.nodes.get("Principled BSDF")
	if principled is not None:
		principled.inputs["Base Color"].default_value = (0.24, 0.55, 0.68, 1.0)
		principled.inputs["Roughness"].default_value = 0.45
		principled.inputs["Metallic"].default_value = 0.05
	for obj in objects:
		obj.color = (0.24, 0.55, 0.68, 1.0)
		if len(obj.data.materials) == 0:
			obj.data.materials.append(material)


def light_rig(center, radius):
	"""Workbench needs none of this; EEVEE needs a key, a fill and a world."""
	if bpy.context.scene.render.engine != "BLENDER_EEVEE_NEXT":
		return
	world = bpy.data.worlds.new("dsh3d-world")
	world.use_nodes = True
	background = world.node_tree.nodes.get("Background")
	if background is not None:
		background.inputs[0].default_value = (0.05, 0.055, 0.07, 1.0)
		background.inputs[1].default_value = 1.0
	bpy.context.scene.world = world
	for name, kind, energy, direction in (
		("dsh3d-key", "SUN", 4.0, Vector((0.6, -0.8, 1.0))),
		("dsh3d-fill", "SUN", 1.2, Vector((-0.8, -0.3, 0.4))),
	):
		light = bpy.data.lights.new(name, kind)
		light.energy = energy
		obj = bpy.data.objects.new(name, light)
		obj.location = center + direction.normalized() * (radius * 4.0)
		# A sun lamp shines along its own -Z, and `direction` points from the model
		# towards the lamp, so aligning +Z with it aims the light at the model.
		obj.rotation_euler = direction.normalized().to_track_quat("Z", "Y").to_euler()
		bpy.context.scene.collection.objects.link(obj)


def make_camera(name, direction, center, radius, corners, kind):
	camera_data = bpy.data.cameras.new(name)
	camera = bpy.data.objects.new(name, camera_data)
	bpy.context.scene.collection.objects.link(camera)
	unit = direction.normalized()
	quaternion = unit.to_track_quat("Z", "Y")
	camera.rotation_euler = quaternion.to_euler()
	rotated = quaternion.to_matrix()
	right = rotated @ Vector((1.0, 0.0, 0.0))
	up = rotated @ Vector((0.0, 1.0, 0.0))
	widths = [(corner - center).dot(right) for corner in corners]
	heights = [(corner - center).dot(up) for corner in corners]
	width = max(widths) - min(widths)
	height = max(heights) - min(heights)
	span = max(width, height, 1e-3)
	camera_data.clip_start = 0.01
	if kind == "ortho":
		camera_data.type = "ORTHO"
		camera_data.ortho_scale = span * 1.12
		distance = radius * 4.0 + span
	else:
		camera_data.type = "PERSP"
		camera_data.lens = 50.0
		camera_data.sensor_width = 36.0
		# 50 mm on a 36 mm sensor ≈ 39.6° horizontal FOV; back the camera off until
		# the projected span fills the frame with a 20 % margin.
		half_fov = math.atan(camera_data.sensor_width / (2.0 * camera_data.lens))
		distance = (span / 2.0) / math.tan(half_fov) * 1.2 + radius
		camera_data.clip_start = max(0.01, distance - radius * 3.0)
	camera.location = center + unit * distance
	camera_data.clip_end = distance + radius * 8.0 + 100.0
	return camera


def build_sheet(paths, out_path, columns=2, gap=10):
	"""2×2 contact sheet, so one image shows every angle.

	Blender ships numpy, and the alternative (4 separate images the model has to
	open one by one) is exactly the kind of extra round trip this plugin avoids.
	"""
	try:
		import numpy as np
	except ImportError:
		return None
	if len(paths) < 2:
		return None
	images = [bpy.data.images.load(path) for path in paths]
	width, height = images[0].size
	rows = (len(images) + columns - 1) // columns
	canvas_width = columns * width + gap * (columns + 1)
	canvas_height = rows * height + gap * (rows + 1)
	canvas = np.zeros((canvas_height, canvas_width, 4), dtype=np.float32)
	canvas[:, :, 3] = 1.0
	canvas[:, :, 0:3] = 0.09
	for index, image in enumerate(images):
		buffer = np.empty(width * height * 4, dtype=np.float32)
		image.pixels.foreach_get(buffer)
		tile = buffer.reshape(height, width, 4)
		# Blender images are bottom-up; place the first tile in the top-left cell.
		row = rows - 1 - (index // columns)
		column = index % columns
		x = gap + column * (width + gap)
		y = gap + row * (height + gap)
		canvas[y:y + height, x:x + width] = tile
		bpy.data.images.remove(image)
	sheet = bpy.data.images.new("dsh3d-sheet", canvas_width, canvas_height, alpha=True)
	sheet.pixels.foreach_set(canvas.ravel())
	sheet.filepath_raw = out_path
	sheet.file_format = "PNG"
	sheet.save()
	bpy.data.images.remove(sheet)
	return out_path if os.path.isfile(out_path) else None


def main():
	started_at = time.time()
	parser = common.make_parser("Render orthographic and isometric previews")
	parser.add_argument("--input", required=True, help="model to render")
	parser.add_argument("--outdir", required=True, help="directory for the PNGs")
	parser.add_argument("--stem", default="model", help="file name stem")
	parser.add_argument("--size", type=int, default=900, help="square image size in pixels")
	parser.add_argument("--views", default=",".join(DEFAULT_VIEWS), help="comma separated view names")
	parser.add_argument("--engine", default="workbench", choices=("workbench", "eevee"))
	parser.add_argument("--no-sheet", action="store_true", help="do not compose a contact sheet")
	args = common.parse(parser)

	requested = [name.strip().lower() for name in args.views.split(",") if name.strip()]
	unknown = [name for name in requested if name not in VIEWS]
	if unknown:
		common.fail("未知视角 %s；可选：%s" % (", ".join(unknown), ", ".join(VIEWS)))
	if not requested:
		common.fail("--views 是空的")

	path = common.require_input(args.input)
	scene = common.reset_scene()
	common.set_mm_units(scene)
	objects = common.import_model(path)
	for obj in objects:
		common.bake_object_transform(obj)

	box = common.bbox_of(objects)
	center = Vector(box["center"])
	radius = max(0.5, 0.5 * Vector(box["size"]).length)
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

	scene_setup(args.engine, args.size)
	give_objects_a_body(objects)
	light_rig(center, radius)

	os.makedirs(os.path.abspath(args.outdir), exist_ok=True)
	written = []
	for name in requested:
		direction, kind = VIEWS[name]
		camera = make_camera("dsh3d-%s" % name, direction, center, radius, corners, kind)
		scene.camera = camera
		target = os.path.join(os.path.abspath(args.outdir), "%s-%s.png" % (args.stem, name))
		scene.render.filepath = target
		try:
			bpy.ops.render.render(write_still=True)
		except RuntimeError as error:
			common.fail("渲染 %s 视角失败：%s" % (name, error))
		if not os.path.isfile(target) or os.path.getsize(target) == 0:
			common.fail("渲染 %s 视角没有产出 PNG（引擎 %s 在这台机器上跑不起来？）" % (name, args.engine))
		written.append(target)
		bpy.data.objects.remove(camera, do_unlink=True)

	sheet = None
	if not args.no_sheet:
		sheet = build_sheet(written, os.path.join(os.path.abspath(args.outdir), "%s-sheet.png" % args.stem))

	common.finish({
		"script": "render_preview",
		"input": path,
		"engine": "BLENDER_WORKBENCH" if args.engine == "workbench" else "BLENDER_EEVEE_NEXT",
		"sizePx": args.size,
		"views": requested,
		"files": written,
		"sheet": sheet,
		"bytes": [os.path.getsize(file) for file in written],
		"bbox": box,
		"units": "mm",
		"elapsedMs": common.elapsed_since(started_at)
	})


main()
