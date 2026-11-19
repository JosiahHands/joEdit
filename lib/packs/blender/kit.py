# joEdit's 3D kit: short helpers for building Blender scenes in a few lines.
# Scene scripts run with everything here already imported, plus `bpy` (Blender's full Python API).
# Sizes are in meters, angles in degrees, colors are "#RRGGBB", times are frames (use seconds(s) to convert).
import math
import os

import bpy
from mathutils import Vector

# Filled in by setup() from the render settings, so scripts can plan their animation.
FPS = 30
FRAMES = 1
WIDTH = 1920
HEIGHT = 1080
FONTS = ""  # folder with joEdit's fonts (install fonts), may be empty


def seconds(s):
    """Frame number at `s` seconds (frames start at 1)."""
    return 1 + round(s * FPS)


def hex_color(color, alpha=1.0):
    """'#RRGGBB' (or an (r, g, b) tuple 0..1) to Blender's linear RGBA."""
    if not isinstance(color, str):
        return (*color[:3], alpha)
    value = color.lstrip("#")
    srgb = [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    # Blender works in linear light; hex colors are sRGB.
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*linear, alpha)


# ---------- the scene ----------


def clear():
    """Remove every object, material and light, for a clean start."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.curves):
        for item in list(collection):
            collection.remove(item)


def sky(color="#101014", top=None, strength=1.0):
    """Background color of the world (also lights the scene a little). `top` makes a vertical gradient."""
    world = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    try:
        world.use_nodes = True
    except AttributeError:
        pass  # newer Blender: worlds always use nodes
    nodes, links = world.node_tree.nodes, world.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputWorld")
    background = nodes.new("ShaderNodeBackground")
    background.inputs["Strength"].default_value = strength
    links.new(background.outputs["Background"], output.inputs["Surface"])
    if top is None:
        background.inputs["Color"].default_value = hex_color(color)
        return world
    # Gradient: mix the two colors by how far up the view points.
    coords = nodes.new("ShaderNodeTexCoord")
    separate = nodes.new("ShaderNodeSeparateXYZ")
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = hex_color(color)
    ramp.color_ramp.elements[1].color = hex_color(top)
    # Z of the view direction: 0 at the horizon, 1 straight up.
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[1].position = 0.45
    links.new(coords.outputs["Generated"], separate.inputs["Vector"])
    links.new(separate.outputs["Z"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], background.inputs["Color"])
    return world


def material(color="#FFFFFF", metal=0.0, rough=0.4, glow=0.0, glass=False, name=None):
    """A surface: color, how metallic (0..1), how rough (0 mirror .. 1 matte), glow (light it gives off), glass."""
    mat = bpy.data.materials.new(name or f"material {color}")
    try:
        mat.use_nodes = True
    except AttributeError:
        pass
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = hex_color(color)
    shader.inputs["Metallic"].default_value = metal
    shader.inputs["Roughness"].default_value = rough
    if glow:
        shader.inputs["Emission Color"].default_value = hex_color(color)
        shader.inputs["Emission Strength"].default_value = glow
    if glass:
        shader.inputs["Transmission Weight"].default_value = 1.0
        shader.inputs["IOR"].default_value = 1.45
        if hasattr(mat, "use_raytrace_refraction"):
            mat.use_raytrace_refraction = True  # EEVEE: see through the glass, bent like real glass
    return mat


def _finish(obj, location, rotation, mat):
    obj.location = location
    obj.rotation_euler = [math.radians(a) for a in rotation]
    if mat is not None:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    return obj


def shape(kind="cube", location=(0, 0, 0), size=1.0, rotation=(0, 0, 0), material=None, bevel=0.0):
    """A basic shape: cube, sphere, cylinder, cone, torus, plane or monkey. size = about its width in meters."""
    add = {
        "cube": lambda: bpy.ops.mesh.primitive_cube_add(size=size),
        "sphere": lambda: bpy.ops.mesh.primitive_uv_sphere_add(radius=size / 2, segments=64, ring_count=32),
        "cylinder": lambda: bpy.ops.mesh.primitive_cylinder_add(radius=size / 2, depth=size, vertices=64),
        "cone": lambda: bpy.ops.mesh.primitive_cone_add(radius1=size / 2, depth=size, vertices=64),
        "torus": lambda: bpy.ops.mesh.primitive_torus_add(major_radius=size / 2, minor_radius=size / 6, major_segments=64, minor_segments=24),
        "plane": lambda: bpy.ops.mesh.primitive_plane_add(size=size),
        "monkey": lambda: bpy.ops.mesh.primitive_monkey_add(size=size),
    }
    if kind not in add:
        raise ValueError(f"Unknown shape {kind!r}. Shapes: {', '.join(add)}")
    add[kind]()
    obj = bpy.context.active_object
    if kind != "cube" and kind != "plane":
        bpy.ops.object.shade_smooth()
    if bevel:
        modifier = obj.modifiers.new("bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 4
        bpy.ops.object.shade_smooth()
    return _finish(obj, location, rotation, material)


def text3d(text, size=1.0, depth=0.15, bevel=0.02, font=None, material=None, location=(0, 0, 0), rotation=(90, 0, 0)):
    """Solid 3D letters, centered on `location`, standing up and facing the camera (-Y) by default.
    font: a .ttf/.otf path, or a joEdit font name like "BebasNeue" or "Montserrat"."""
    curve = bpy.data.curves.new("text", type="FONT")
    curve.body = text
    curve.size = size
    curve.extrude = depth / 2
    curve.bevel_depth = bevel
    curve.bevel_resolution = 4
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    path = font
    if font and not os.path.exists(font) and FONTS:
        path = os.path.join(FONTS, f"{font}.ttf")
    if path and os.path.exists(path):
        curve.font = bpy.data.fonts.load(path, check_existing=True)
    obj = bpy.data.objects.new("text", curve)
    bpy.context.scene.collection.objects.link(obj)
    return _finish(obj, location, rotation, material)


def load(path, size=2.0, location=(0, 0, 0)):
    """Import a model (.glb .gltf .obj .fbx .stl .ply), scale it to `size` meters across,
    and stand it on the ground at `location`. Returns one object that holds all its parts (move/rotate that)."""
    path = os.path.abspath(path)
    before = set(bpy.data.objects)
    kind = path.lower().rsplit(".", 1)[-1]
    if kind in ("glb", "gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif kind == "obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif kind == "fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif kind == "stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif kind == "ply":
        bpy.ops.wm.ply_import(filepath=path)
    else:
        raise ValueError(f"Can't load .{kind} models. Use .glb, .gltf, .obj, .fbx, .stl or .ply")
    parts = [o for o in bpy.data.objects if o not in before]
    holder = bpy.data.objects.new("model", None)
    bpy.context.scene.collection.objects.link(holder)
    for part in parts:
        if part.parent is None:
            part.parent = holder
    # Measure the model, then center it and put its bottom on the ground.
    bpy.context.view_layer.update()
    corners = [part.matrix_world @ Vector(c) for part in parts if part.type == "MESH" for c in part.bound_box]
    if corners:
        low = Vector([min(c[i] for c in corners) for i in range(3)])
        high = Vector([max(c[i] for c in corners) for i in range(3)])
        scale = size / max(max(high - low), 1e-6)
        holder.scale = (scale, scale, scale)
        center = (low + high) / 2
        holder.location = Vector(location) - Vector((center.x, center.y, low.z)) * scale
    return holder


def ground(color="#1A1A1F", size=60, reflect=0.0, shadow_only=False):
    """A floor at height 0. reflect 0..1 makes it glossy. shadow_only shows only shadows (for see-through renders)."""
    bpy.ops.mesh.primitive_plane_add(size=size)
    floor = bpy.context.active_object
    floor.name = "ground"
    floor.data.materials.append(material(color, rough=1 - 0.9 * reflect, name="ground"))
    if shadow_only:
        floor.is_shadow_catcher = True
    return floor


LIGHT_STYLES = {
    # (key, fill, rim) strengths in watts, and the key light's color temperature feel.
    "soft": (600, 250, 300, "#FFF4E8"),
    "bright": (1000, 500, 400, "#FFFFFF"),
    "dramatic": (900, 40, 700, "#FFE2C4"),
    "sunset": (800, 120, 600, "#FFB070"),
    "cool": (700, 200, 500, "#DDE8FF"),
}


def studio_light(style="soft", strength=1.0, target=(0, 0, 0)):
    """Three soft lights (key, fill, rim) around `target`. Styles: soft, bright, dramatic, sunset, cool."""
    if style not in LIGHT_STYLES:
        raise ValueError(f"Unknown light style {style!r}. Styles: {', '.join(LIGHT_STYLES)}")
    key, fill, rim, warm = LIGHT_STYLES[style]
    lights = []
    for name, power, place, size, color in (
        ("key", key, (-4, -4, 5), 3, warm),
        ("fill", fill, (5, -3, 2), 4, "#FFFFFF"),
        ("rim", rim, (0, 5, 4), 2, "#FFFFFF"),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = power * strength
        data.size = size
        data.color = hex_color(color)[:3]
        light = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(light)
        light.location = Vector(target) + Vector(place)
        _aim(light, target)
        lights.append(light)
    return lights


def _aim(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def camera(location=(0, -8, 2), target=(0, 0, 0.5), lens=50):
    """The camera, aimed at `target`. lens in mm: 24 wide, 50 normal, 85+ close-up."""
    data = bpy.data.cameras.new("camera")
    data.lens = lens
    cam = bpy.data.objects.new("camera", data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = location
    # A "track to" constraint keeps it aimed at the target even while it moves.
    aim = bpy.data.objects.new("camera target", None)
    bpy.context.scene.collection.objects.link(aim)
    aim.location = target
    constraint = cam.constraints.new("TRACK_TO")
    constraint.target = aim
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"
    bpy.context.scene.camera = cam
    return cam


def orbit_camera(target=(0, 0, 0.5), radius=8, height=2, turns=1.0, start=-90, lens=50, frames=None):
    """A camera circling `target` over the whole render (or `frames` frames). turns 1 = full circle."""
    cam = camera(target=target, lens=lens)
    frames = frames or FRAMES
    for frame in range(1, frames + 1, max(1, frames // 48)):
        angle = math.radians(start + 360 * turns * (frame - 1) / max(1, frames - 1))
        cam.location = (target[0] + radius * math.cos(angle), target[1] + radius * math.sin(angle), height)
        cam.keyframe_insert("location", frame=frame)
    _linear(cam)
    return cam


def keyframe(obj, prop, keys, ease=True):
    """Animate a property: keyframe(cube, "location", {1: (0, 0, 0), seconds(2): (0, 0, 3)}).
    Rotation values are in degrees. ease=False moves at a constant speed."""
    for frame, value in keys.items():
        if prop == "rotation_euler":
            value = [math.radians(v) for v in value]
        setattr(obj, prop, value)
        obj.keyframe_insert(prop, frame=frame)
    if not ease:
        _linear(obj)
    return obj


def _linear(obj):
    action = obj.animation_data and obj.animation_data.action
    if not action:
        return
    curves = getattr(action, "fcurves", None)
    if curves is None:  # Blender 5: curves live in layered "channelbags"
        curves = [c for layer in action.layers for strip in layer.strips for bag in strip.channelbags for c in bag.fcurves]
    for curve in curves:
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"


# ---------- render settings (called by joEdit before the scene script) ----------


def _engine_name(engine):
    names = [item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    if engine == "cycles":
        return "CYCLES"
    return "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in names else "BLENDER_EEVEE"


def setup(settings):
    """Size, frame rate, length, engine and quality for this render."""
    global FPS, FRAMES, WIDTH, HEIGHT, FONTS
    FPS, FRAMES = settings["fps"], settings["frames"]
    WIDTH, HEIGHT = settings["width"], settings["height"]
    FONTS = settings.get("fonts", "")
    scene = bpy.context.scene
    render = scene.render
    render.resolution_x, render.resolution_y = WIDTH, HEIGHT
    render.resolution_percentage = 100
    render.fps = FPS
    scene.frame_start, scene.frame_end = 1, FRAMES
    render.engine = _engine_name(settings["engine"])
    render.film_transparent = settings.get("transparent", False)
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGBA" if render.film_transparent else "RGB"
    samples = settings["samples"]
    if render.engine == "CYCLES":
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        try:  # use the GPU when there is one (Metal on Apple, CUDA/OptiX on NVIDIA)
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for kind in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
                try:
                    prefs.compute_device_type = kind
                    prefs.get_devices()
                    if any(d.type == kind for d in prefs.devices):
                        for d in prefs.devices:
                            d.use = True
                        scene.cycles.device = "GPU"
                        break
                except TypeError:
                    continue
        except Exception:
            pass
    else:
        scene.eevee.taa_render_samples = samples
        if hasattr(scene.eevee, "use_raytracing"):
            scene.eevee.use_raytracing = True  # real reflections and refraction (glass, chrome, wet floors)
    # Soft motion blur makes movement look filmed rather than computed.
    render.use_motion_blur = settings.get("motion_blur", True)
