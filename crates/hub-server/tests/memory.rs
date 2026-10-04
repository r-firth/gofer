use hub_server::{embeddings::DIMENSIONS, store::Store};
use serde_json::json;

#[test]
fn search_handles_an_offset_beyond_the_archive() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("test.vg")).unwrap();
    store
        .append("message.user", "chat", json!({"text":"archive"}))
        .unwrap();
    let page = store
        .memory_search("archive", "all", usize::MAX, None)
        .unwrap();
    assert_eq!(page["hits"], json!([]));
    assert_eq!(page["next_offset"], json!(null));
    assert_eq!(
        store.memory_search("archive", "all", 0, None).unwrap()["total"],
        1
    );
}

#[test]
fn graph_handles_an_offset_beyond_the_archive() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("test.vg")).unwrap();
    store
        .append("message.user", "chat", json!({"text":"archive"}))
        .unwrap();
    let page = store.memory_graph(None, usize::MAX).unwrap();
    assert_eq!(page["next_offset"], json!(null));
    assert!(
        store.memory_graph(None, 0).unwrap()["nodes"]
            .as_array()
            .unwrap()
            .len()
            >= 2
    );
}

#[test]
fn run_handles_an_offset_beyond_the_archive() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("test.vg")).unwrap();
    let run = store
        .append("message.user", "chat", json!({"text":"archive"}))
        .unwrap();
    let page = store.memory_run(run.id, None, Some(usize::MAX)).unwrap();
    assert_eq!(page["events"], json!([]));
    assert_eq!(page["next_offset"], json!(null));
    assert_eq!(
        store.memory_run(run.id, None, None).unwrap()["events"][0]["id"],
        run.id
    );
}
#[test]
fn graph_contains_real_edges_and_inspectable_vectors() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(&dir.path().join("test.vg")).unwrap();
    let a = s
        .append(
            "message.user",
            "chat",
            json!({"text":"Search the lunar archive"}),
        )
        .unwrap();
    let b = s
        .append(
            "message.assistant",
            "chat",
            json!({"text":"Found the lunar archive"}),
        )
        .unwrap();
    s.embed(b.id, vec![0.25; DIMENSIONS]).unwrap();
    let graph = s.memory_graph(Some(b.id), 0).unwrap();
    let edges = graph["edges"].as_array().unwrap();
    let next = edges.iter().find(|e| e["label"] == "NEXT").unwrap();
    assert_eq!(next["source"], a.id);
    assert_eq!(next["target"], b.id);
    let inspect = s
        .memory_element("edge", next["id"].as_u64().unwrap())
        .unwrap();
    assert_eq!(inspect["source"], a.id);
    assert_eq!(
        s.memory_element("node", b.id).unwrap()["vector"]
            .as_array()
            .unwrap()
            .len(),
        DIMENSIONS
    );
    assert!(s.memory_graph(Some(999999), 0).is_err());
}
#[test]
fn indexed_search_rebuilds_and_keeps_fragments_and_archived_bytes_out_of_results() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.vg");
    let mut s = Store::open(&path).unwrap();
    s.append("message.delta", "chat", json!({"delta":"café renderer"}))
        .unwrap();
    s.append(
        "terminal.output",
        "terminal",
        json!({"text":"shell output","bytes":"secret_encoded_blob"}),
    )
    .unwrap();
    let e = s
        .append(
            "message.assistant",
            "chat",
            json!({"text":"The café renderer is ready"}),
        )
        .unwrap();
    for reopened in [false, true] {
        if reopened {
            drop(s);
            s = Store::open(&path).unwrap();
        }
        let hits = s.memory_search("CAFÉ renderer", "all", 0, None).unwrap();
        assert_eq!(hits["total"], 1);
        assert_eq!(hits["hits"][0]["id"], e.id);
        assert_eq!(
            s.memory_search("secret_encoded_blob", "all", 0, None)
                .unwrap()["total"],
            0
        );
        assert_eq!(
            s.memory_search("renderer", "terminal", 0, None).unwrap()["total"],
            0
        );
    }
}
#[test]
fn results_open_in_their_own_run_and_closed_history_stays_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(&dir.path().join("test.vg")).unwrap();
    s.append("chat.created", "chat", json!({"name":"Game build"}))
        .unwrap();
    let first = s
        .append("message.user", "chat", json!({"text":"Build the game"}))
        .unwrap();
    s.append("agent.started", "chat", json!({})).unwrap();
    let result=s.append("tool.result","chat",json!({"name":"command_execution","result":{"ok":true,"result":{"aggregatedOutput":"Build succeeded"}}})).unwrap();
    s.append("agent.finished", "chat", json!({})).unwrap();
    let next = s
        .append("message.user", "chat", json!({"text":"Run the tests"}))
        .unwrap();
    s.append("chat.closed", "chat", json!({})).unwrap();
    let count = s.event_count();
    let run = s.memory_run(first.id, Some(result.id), None).unwrap();
    assert_eq!(run["next_run"], next.id);
    assert_eq!(run["status"], "Complete");
    assert!(
        run["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == result.id)
    );
    assert!(
        !run["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == next.id)
    );
    assert_eq!(s.event_count(), count);
    assert_eq!(
        s.memory_search("succeeded", "tool", 0, None).unwrap()["hits"][0]["run_id"],
        first.id
    );
}
#[test]
fn raw_fragments_are_searchable_and_can_open_at_their_source() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(&dir.path().join("test.vg")).unwrap();
    let first = s
        .append(
            "message.user",
            "chat",
            json!({"text":"Investigate a fault"}),
        )
        .unwrap();
    let fragment = s
        .append(
            "message.delta",
            "chat",
            json!({"delta":"rare-fragment-evidence"}),
        )
        .unwrap();
    s.append("agent.error", "chat", json!({"error":"worker failed"}))
        .unwrap();
    s.append("agent.finished", "chat", json!({})).unwrap();
    assert_eq!(
        s.memory_search("rare-fragment-evidence", "all", 0, None)
            .unwrap()["total"],
        0
    );
    assert_eq!(
        s.memory_search("rare-fragment-evidence", "raw", 0, None)
            .unwrap()["hits"][0]["id"],
        fragment.id
    );
    let run = s.memory_run(first.id, Some(fragment.id), None).unwrap();
    assert_eq!(run["status"], "Failed");
    assert!(
        run["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == fragment.id)
    );
}

#[test]
fn search_preview_marks_omitted_context_and_preserves_words() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(&dir.path().join("test.vg")).unwrap();
    s.append("message.assistant","chat",json!({"text":format!("{} saved output describes the persistent terminal used to inspect Craig. {}", "Earlier context. ".repeat(15), "Further evidence. ".repeat(30))})).unwrap();
    let result = s.memory_search("Craig", "message", 0, None).unwrap();
    let excerpt = result["hits"][0]["excerpt"].as_str().unwrap();
    assert!(excerpt.starts_with("… "));
    assert!(excerpt.ends_with(" …"));
    assert!(excerpt.contains("saved output"));
    assert!(excerpt.contains("Craig"));
}
