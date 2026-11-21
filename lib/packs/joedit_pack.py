# Plumbing shared by joEdit's Python packs (shared.ts is the Node side).
#
# A pack's run.py describes one kind of job and ends with joedit_pack.main(...):
#   parser                        argparse parser for one job's arguments
#   download()                    adds the models (only `node joedit.ts install <pack>` runs it); returns a dict
#   load()                        loads the models; returns whatever make() needs
#   make(models, args, progress)  does one job and returns its result (a dict). It may call
#                                 progress(step, total) or progress(phase="...") now and then.
#
# run.py then works three ways:
#   python run.py --download        install the models
#   python run.py <job arguments>   one job: load, make, print the result as JSON (always the last stdout line)
#   python run.py --serve           a worker: loads the models once, then does queued jobs until it has been
#                                   idle for 10 minutes (JOEDIT_WORKER_IDLE seconds), so later jobs skip the loading
#
# Jobs are files in .packs/queue/, written by runPack in shared.ts:
#   <id>.json           the request {"pack", "args"}; renamed to <id>.running when a worker takes it
#   <id>.progress.json  {"phase", "step", "total", "eta"}, written by the worker
#   <id>.result.json    {"ok": true, "result": {...}} or {"ok": false, "error": "..."}
#   <id>.cancel         written by joEdit to stop the job
# A worker holds .packs/gpu.lock while its models are loaded, so only one pack's models use the GPU at a time.
# An idle worker leaves as soon as another pack has a job waiting, which frees the GPU for it.
import json
import os
import sys
import time
import traceback

LIB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = os.path.join(LIB, ".packs")
QUEUE = os.path.join(PACKS, "queue")
GPU_LOCK = os.path.join(PACKS, "gpu.lock")
IDLE_SECONDS = float(os.environ.get("JOEDIT_WORKER_IDLE", 600))

# This computer's memory, measured by joEdit (shared.ts hardware()). 0 = no GPU found.
VRAM_GB = float(os.environ.get("JOEDIT_VRAM_GB", 0) or 0)
RAM_GB = float(os.environ.get("JOEDIT_RAM_GB", 0) or 0)


class Cancelled(Exception):
    pass


# ---------- Measuring ----------


def peak_ram_gb():
    """The most RAM this process (and the programs it ran) has used, in GB."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t)
                for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                             "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")
            ]

        counters = Counters()
        counters.cb = ctypes.sizeof(Counters)
        process = ctypes.windll.kernel32.GetCurrentProcess()
        ctypes.windll.psapi.GetProcessMemoryInfo(process, ctypes.byref(counters), counters.cb)
        return round(counters.PeakWorkingSetSize / 1024**3, 1)
    import resource

    peak = max(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
    # macOS counts bytes, Linux kilobytes.
    return round(peak / 1024**3 if sys.platform == "darwin" else peak / 1024**2, 1)


def _torch_cuda():
    torch = sys.modules.get("torch")  # only if the pack uses torch (mflux on a Mac does not)
    return torch if torch is not None and torch.cuda.is_available() else None


def _apple_gpu_gb():
    """GPU memory held by PyTorch on Apple Silicon (Metal memory is not counted in the process's RAM), or None."""
    torch = sys.modules.get("torch")
    if torch is None or not torch.backends.mps.is_available():
        return None
    return torch.mps.driver_allocated_memory() / 1024**3


def _gpu_held_gb():
    """GPU memory this worker is holding right now (NVIDIA: what PyTorch has reserved), in GB. 0 without torch on a GPU."""
    torch = _torch_cuda()
    if torch:
        return torch.cuda.memory_reserved() / 1024**3
    return _apple_gpu_gb() or 0.0


def _heavy():
    """True when this worker holds a big part of the computer's memory, so waiting idle would crowd out everything else:
    over 40% of the RAM, or over 40% of the GPU's memory (on Apple Silicon the GPU shares the RAM, so they add up)."""
    ram, gpu = peak_ram_gb(), _gpu_held_gb()
    if _torch_cuda():
        return (RAM_GB and ram > 0.4 * RAM_GB) or (VRAM_GB and gpu > 0.4 * VRAM_GB)
    return bool(RAM_GB) and ram + gpu > 0.4 * RAM_GB


def _measured(make, models, args, progress):
    """Run one job and add how long it took and how much memory it used."""
    torch = _torch_cuda()
    if torch:
        torch.cuda.reset_peak_memory_stats()
    progress.apple_gpu_peak = 0.0
    started = time.time()
    result = make(models, args, progress) or {}
    result["seconds"] = round(time.time() - started, 1)
    if torch:
        result["vramGb"] = round(torch.cuda.max_memory_allocated() / 1024**3, 1)  # the most GPU memory the job used
    elif progress.apple_gpu_peak:
        result["vramGb"] = round(progress.apple_gpu_peak, 1)  # the most seen at a progress report (Apple Silicon)
    result["ramGb"] = peak_ram_gb()
    return result


# ---------- Files ----------


def _write_json(path, data):
    temporary = f"{path}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as file:
        json.dump(data, file)
    for _ in range(50):  # Windows refuses to replace a file another program is reading at that moment
        try:
            os.replace(temporary, path)
            return
        except PermissionError:
            time.sleep(0.02)
    os.replace(temporary, path)


def _read_json(path):
    try:
        with open(path, encoding="utf-8-sig") as file:
            return json.load(file)
    except (OSError, ValueError):
        return None


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def alive(pid):
    """True if a program with this process id is running."""
    if not pid or pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)  # signal 0 only checks (on Windows os.kill would end the program, hence the code above)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


# ---------- The GPU lock ----------


def _take_gpu(status):
    """Wait until no other pack has its models loaded, then hold the GPU."""
    while True:
        try:
            handle = os.open(GPU_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(handle, str(os.getpid()).encode())
            os.close(handle)
            return
        except FileExistsError:
            try:
                with open(GPU_LOCK) as file:
                    holder = int(file.read().strip() or 0)
                age = time.time() - os.path.getmtime(GPU_LOCK)
            except (OSError, ValueError):
                holder, age = 0, 0
            if not alive(holder) and (holder or age > 5):  # the holder is gone (a lock with no id yet is just being made)
                _remove(GPU_LOCK)
                continue
            status("waiting for the GPU")
            time.sleep(0.5)


def _free_gpu():
    try:
        with open(GPU_LOCK) as file:
            if file.read().strip() == str(os.getpid()):
                _remove(GPU_LOCK)
    except OSError:
        pass


# ---------- Progress ----------


class _Progress:
    """Passed to make(): reports how far a job is (with an estimate of the time left) and stops it if cancelled."""

    def __init__(self, path=None, cancel=None):
        self.path, self.cancel = path, cancel
        self.started = time.time()
        self.written = 0.0
        self.phase = "working"

    def __call__(self, step=None, total=None, phase=None):
        if self.cancel and os.path.exists(self.cancel):
            raise Cancelled()
        apple = _apple_gpu_gb()
        if apple:
            self.apple_gpu_peak = max(getattr(self, "apple_gpu_peak", 0.0), apple)
        now = time.time()
        if phase:
            self.phase = phase
        elif now - self.written < 0.5:
            return
        self.written = now
        eta = round((now - self.started) / step * (total - step)) if step and total and step < total else None
        if self.path:
            _write_json(self.path, {"phase": self.phase, "step": step, "total": total, "eta": eta, "elapsed": round(now - self.started)})


# ---------- The worker ----------


def _requests():
    """Waiting job requests, oldest first: (path, request)."""
    try:
        names = [n for n in os.listdir(QUEUE) if n.endswith(".json") and not n.endswith((".progress.json", ".result.json"))]
    except OSError:
        return []
    found = []
    for name in names:
        path = os.path.join(QUEUE, name)
        request = _read_json(path)
        if request:
            try:
                found.append((os.path.getmtime(path), path, request))
            except OSError:
                pass
    return [(path, request) for _, path, request in sorted(found)]


def _serve(pack, parser, load, make):
    os.makedirs(QUEUE, exist_ok=True)
    me = os.path.join(PACKS, pack, "worker.json")
    # One worker per pack. (While this one starts, joEdit's file names only the "starter".)
    other = (_read_json(me) or {}).get("pid")
    if other != os.getpid() and alive(other):
        return

    def status(state, **extra):
        _write_json(me, {"pid": os.getpid(), "state": state, **extra})

    status("waiting for the GPU")
    _take_gpu(status)
    try:
        status("loading")
        started = time.time()
        real_stdout, sys.stdout = sys.stdout, sys.stderr  # model libraries print to stdout; keep it for nothing
        models = load()
        load_seconds = round(time.time() - started, 1)
        status("ready", loadSeconds=load_seconds)
        idle_since = time.time()
        first = True
        while True:
            mine = [(path, request) for path, request in _requests() if request.get("pack") == pack]
            if mine:
                path, request = mine[0]
                base = path[:-5]
                try:
                    os.rename(path, base + ".running")  # take the job (only one worker can)
                except OSError:
                    continue
                status("working")
                broken = _do(make, models, parser, request, base, load_seconds if first else None)
                first = False
                idle_since = time.time()
                if broken:
                    break  # after a crash (out of memory, for example) the models may be in a bad state: start fresh next time
                status("ready", loadSeconds=load_seconds)
                continue
            others = [request for _, request in _requests() if request.get("pack") != pack]
            # A worker that fills much of the RAM or the GPU's memory leaves sooner: idle, it would push everything else
            # into swap, or leave other programs (games, editors, other AI tools) no room on the GPU.
            idle_limit = min(IDLE_SECONDS, 120) if _heavy() else IDLE_SECONDS
            if others or time.time() - idle_since > idle_limit:
                break  # another pack needs the GPU, or nothing to do for a while: free the memory
            time.sleep(0.2)
    finally:
        _free_gpu()
        if (_read_json(me) or {}).get("pid") == os.getpid():
            _remove(me)


def _do(make, models, parser, request, base, load_seconds):
    """Do one queued job and write its result. Returns True if the worker should stop (the job crashed)."""
    cancel = base + ".cancel"
    progress = _Progress(base + ".progress.json", cancel)
    broken = False
    try:
        args = parser.parse_args(request.get("args", []))
        result = _measured(make, models, args, progress)
        if load_seconds is not None:
            result["loadSeconds"] = load_seconds  # the first job after starting also waited for the models to load
        outcome = {"ok": True, "result": result}
    except Cancelled:
        outcome = {"ok": False, "error": "cancelled", "cancelled": True}
    except SystemExit as error:  # run.py stops with a message, or argparse rejects the arguments
        outcome = {"ok": False, "error": str(error) if not isinstance(error.code, int) else "the pack refused its arguments (see .packs/worker.log)"}
    except BaseException as error:
        traceback.print_exc()
        outcome = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        broken = True
    _write_json(base + ".result.json", outcome)
    for leftover in (base + ".running", cancel, base + ".progress.json"):
        _remove(leftover)
    return broken


# ---------- Entry point ----------


def main(pack, parser, download, load, make):
    """Run a pack: --download, --serve (a worker), or one job from the command line."""
    if "--download" in sys.argv:
        real_stdout, sys.stdout = sys.stdout, sys.stderr
        result = download()
        sys.stdout = real_stdout
        print(json.dumps(result))
        return
    if "--serve" in sys.argv:
        _serve(pack, parser, load, make)
        return
    args = parser.parse_args()
    real_stdout, sys.stdout = sys.stdout, sys.stderr  # keep stdout for the JSON result
    started = time.time()
    models = load()
    load_seconds = round(time.time() - started, 1)
    result = _measured(make, models, args, _Progress())
    result["loadSeconds"] = load_seconds
    sys.stdout = real_stdout
    print(json.dumps(result))
