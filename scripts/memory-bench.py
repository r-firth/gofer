"""Read-only loopback latency checks; use a disposable archive for repeatability."""

import json
import sys
import time
import urllib.request

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4323"
paths = {
    "recent records": "/search?kind=all",
    "selective text": "/search?q=marker-09997&kind=all",
    "broad text": "/search?q=renderer&kind=all",
    "graph overview": "/graph",
    "scope expansion": "/graph?node=0",
}
for label, path in paths.items():
    samples = []
    for i in range(35):
        started = time.perf_counter()
        with urllib.request.urlopen(base + "/api/memory" + path, timeout=10) as r:
            result = json.load(r)
        elapsed = (time.perf_counter() - started) * 1000
        if i >= 5:
            samples.append(elapsed)
    samples.sort()
    print(
        f"{label}: p50={samples[15]:.2f}ms p95={samples[28]:.2f}ms max={samples[-1]:.2f}ms; 30 requests"
    )
