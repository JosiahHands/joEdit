# Runs inside Blender (started by 3d.ts): sets up the render, runs the scene script, renders PNG frames.
# Usage: blender -b --factory-startup --python run.py -- <settings.json>
# settings: {script, folder, width, height, fps, frames, engine, samples, transparent, fonts, still}
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
import kit

settings = json.load(open(sys.argv[sys.argv.index("--") + 1]))
kit.clear()
kit.setup(settings)

# Default stage, so even a script that only adds objects gives a good-looking picture.
# Scripts replace any of it by calling camera(), sky() or studio_light() themselves.
kit.sky("#101014")
default_camera = kit.camera()
default_lights = kit.studio_light("soft")

# Run the scene script with the whole kit (and bpy) ready to use.
script = settings["script"]
scope = {name: getattr(kit, name) for name in dir(kit) if not name.startswith("_")}
scope.update({"bpy": bpy, "kit": kit, "__name__": "__main__", "__file__": script})
try:
    exec(compile(open(script).read(), script, "exec"), scope)
except Exception as error:
    # Show the error from the scene script itself (skipping this file's line), then stop.
    lines = traceback.format_exception(type(error), error, error.__traceback__.tb_next)
    print("Error in the scene script:\n" + "".join(lines), file=sys.stderr)
    sys.exit(2)

def alive(obj):
    """False if the script already deleted this object (for example with clear())."""
    try:
        return obj.name in bpy.data.objects
    except ReferenceError:
        return False


# If the script made its own camera or lights, the defaults step aside.
scene = bpy.context.scene
if scene.camera is None:
    kit.camera()  # the script cleared everything and made no camera: use the default view
elif alive(default_camera) and scene.camera is not default_camera:
    target = default_camera.constraints[0].target
    bpy.data.objects.remove(default_camera, do_unlink=True)
    bpy.data.objects.remove(target, do_unlink=True)
defaults = [light for light in default_lights if alive(light)]
if any(o.type == "LIGHT" and o not in defaults for o in scene.objects):
    for light in defaults:
        bpy.data.objects.remove(light, do_unlink=True)

# Scripts may change the length or frame rate (kit.FRAMES, kit.FPS are read back by joEdit from the frame count).
scene.render.filepath = os.path.join(settings["folder"], "")
if settings.get("still"):
    scene.frame_set(settings["still"])
    scene.render.filepath = os.path.join(settings["folder"], "still.png")
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
