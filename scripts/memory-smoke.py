"""Read-only checks of the Memory viewer's real HTTP/Vecgra boundary."""

import json
import sys
import urllib.request

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4323"


def get(path):
    with urllib.request.urlopen(base + "/api/memory" + path, timeout=10) as response:
        assert "application/json" in response.headers.get("Content-Type", ""), (
            "Memory routes must return JSON, not the SPA fallback"
        )
        return json.load(response)


graph = get("/graph")
assert graph["nodes"] and graph["stats"]["nodes"] >= len(graph["nodes"])
ids = {n["id"] for n in graph["nodes"]}
assert all(e["source"] in ids and e["target"] in ids for e in graph["edges"])
for edge in graph["edges"][:3]:
    record = get("/element/edge/" + str(edge["id"]))
    assert record["source"] == edge["source"] and record["target"] == edge["target"]
result = get("/search?q=&kind=all")
assert result["hits"]
hit = result["hits"][0]
node = get("/element/node/" + str(hit["id"]))
assert node["id"] == hit["id"] and node["properties"]
if hit.get("run_id") is not None:
    run = get("/runs/" + str(hit["run_id"]) + "?anchor=" + str(hit["id"]))
    assert any(e["id"] == hit["id"] for e in run["events"]), (
        "Run must open at the matching evidence"
    )
focused = get("/graph?node=" + str(hit["id"]))
assert any(n["id"] == hit["id"] for n in focused["nodes"])
assert get("/search?q=__HUB_ABSENT_2cb910c9__")["hits"] == []
print(
    "PASS: real graph identities, relationship inspection, search, focused context, and run provenance"
)
