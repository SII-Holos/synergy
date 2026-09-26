import json
import signal
import subprocess
import sys
from pathlib import Path


def oom_kills():
    events = dict(line.split() for line in Path("/sys/fs/cgroup/memory.events").read_text().splitlines())
    return int(events["oom_kill"])


before = oom_kills()
child = subprocess.run(
    [
        sys.executable,
        "-c",
        "from pathlib import Path; Path('/proc/self/oom_score_adj').write_text('1000');"
        " data = bytearray(512 * 1024**2)",
    ],
    check=False,
)
after = oom_kills()
print(json.dumps({"child_exit_code": child.returncode, "oom_kill_before": before, "oom_kill_after": after}), flush=True)
assert child.returncode == -signal.SIGKILL
assert after - before == 1
# Auto-removal can precede the daemon's separate OOM handler; the test releases PID 1 after observing the event.
# https://github.com/moby/moby/blob/v28.0.4/daemon/monitor.go#L154-L176
assert sys.stdin.readline() == "release\n"
