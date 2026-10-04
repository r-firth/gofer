use hub_server::{claims::NewClaim, embeddings::DIMENSIONS, store::Store};
use serde_json::{Value, json};

fn claims(value: Value) -> Vec<NewClaim> {
    serde_json::from_value(value).unwrap()
}
fn recalled(items: &[Value], kind: &str) -> Vec<u64> {
    items
        .iter()
        .filter(|i| i["kind"] == kind)
        .map(|i| i["id"].as_u64().unwrap())
        .collect()
}
fn axis(index: usize) -> Vec<f32> {
    let mut vector = vec![0.0; DIMENSIONS];
    vector[index] = 1.0;
    vector
}

#[test]
fn supersession_and_retraction_decide_what_is_recalled() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.vg");
    let mut s = Store::open(&path).unwrap();
    s.append("chat.created", "thread", json!({"name":"Thread"}))
        .unwrap();
    let said = s
        .append(
            "message.user",
            "thread",
            json!({"text":"I use uv for Python, never pip."}),
        )
        .unwrap();
    let first = s
        .write_claims(
            "thread",
            "Thread",
            claims(json!([{"text":"Ryan uses uv for Python, never pip.","about":["Ryan"," UV "],"supersedes":[],"evidence":[said.id]}])),
        )
        .unwrap();
    let old = first[0]["id"].as_u64().unwrap();
    assert_eq!(first[0]["about"], json!(["ryan", "uv"]));
    assert_eq!(
        recalled(
            &s.recall("Which Python installer, uv or pip?", None, "other", 0)
                .unwrap(),
            "claim"
        ),
        [old]
    );
    let correction = s
        .append(
            "message.user",
            "thread",
            json!({"text":"I switched to pixi instead of uv."}),
        )
        .unwrap();
    let second = s
        .write_claims(
            "thread",
            "Thread",
            claims(json!([{"text":"Ryan uses pixi instead of uv for new Python projects.","about":["ryan","pixi","uv"],"supersedes":[old],"evidence":[correction.id]}])),
        )
        .unwrap();
    let new = second[0]["id"].as_u64().unwrap();
    assert_eq!(
        second[0]["supersedes"],
        json!([{"id":old,"text":"Ryan uses uv for Python, never pip."}])
    );
    let query = "Which Python installer do I use, uv or pixi?";
    assert_eq!(
        recalled(&s.recall(query, None, "other", 0).unwrap(), "claim"),
        [new]
    );
    assert!(
        s.write_claims(
            "thread",
            "Thread",
            claims(json!([{"text":"Again","about":[],"supersedes":[old],"evidence":[said.id]}]))
        )
        .is_err(),
        "A superseded claim cannot be superseded again"
    );
    assert!(
        s.write_claims(
            "thread",
            "Thread",
            claims(json!([{"text":"Unsupported","about":[],"supersedes":[],"evidence":[999_999]}]))
        )
        .is_err()
    );
    // Entities are reused by name, and the graph carries every relationship.
    let graph = s.memory_graph(Some(new), 0).unwrap();
    let labels: Vec<_> = graph["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["label"].as_str().unwrap())
        .collect();
    for label in ["ABOUT", "SUPPORTED_BY", "SUPERSEDES"] {
        assert!(labels.contains(&label), "{label} missing from {labels:?}");
    }
    let uv: Vec<_> = graph["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["label"] == "Entity" && n["title"] == "uv")
        .collect();
    assert_eq!(uv.len(), 1);
    let entity = s.memory_graph(uv[0]["id"].as_u64(), 0).unwrap();
    assert_eq!(
        entity["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["label"] == "Claim")
            .count(),
        2
    );
    assert_eq!(
        s.memory_element("node", old).unwrap()["state"],
        "superseded"
    );

    assert_eq!(s.mark_claim(new, true).unwrap().state, "retracted");
    assert!(s.mark_claim(new, true).is_err());
    assert!(
        s.recall(query, None, "other", 0)
            .unwrap()
            .iter()
            .all(|i| i["kind"] != "claim")
    );
    assert_eq!(s.mark_claim(new, false).unwrap().state, "active");
    s.mark_claim(old, true).unwrap();
    assert_eq!(s.mark_claim(old, false).unwrap().state, "superseded");
    drop(s);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        recalled(&reopened.recall(query, None, "other", 0).unwrap(), "claim"),
        [new]
    );
    assert_eq!(
        reopened.memory_element("node", new).unwrap()["about"],
        json!(["pixi", "ryan", "uv"])
    );
}

#[test]
fn recall_uses_vectors_and_skips_the_current_context() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(&dir.path().join("history.vg")).unwrap();
    s.append("chat.created", "garage", json!({"name":"Garage"}))
        .unwrap();
    let older = s
        .append(
            "message.assistant",
            "garage",
            json!({"text":"The homeserver backup runs nightly at 02:00."}),
        )
        .unwrap();
    let current = s
        .append(
            "message.user",
            "thread",
            json!({"text":"When does the homeserver backup run?"}),
        )
        .unwrap();
    let claim = s
        .write_claims("garage", "Garage", claims(json!([{"text":"Nightly snapshots go to the NAS.","about":["nas"],"supersedes":[],"evidence":[older.id]}])))
        .unwrap()[0]["id"]
        .as_u64()
        .unwrap();
    s.embed(claim, axis(3)).unwrap();
    s.embed(older.id, axis(5)).unwrap();
    let items = s
        .recall(
            "When does the homeserver backup run?",
            Some(&axis(3)),
            "thread",
            0,
        )
        .unwrap();
    assert_eq!(
        recalled(&items, "claim"),
        [claim],
        "Similarity alone recalls a claim"
    );
    assert_eq!(
        recalled(&items, "event"),
        [older.id],
        "Other chats' messages are recalled"
    );
    assert!(!recalled(&items, "event").contains(&current.id));
    let event = items.iter().find(|i| i["kind"] == "event").unwrap();
    assert_eq!(event["source"], "Garage");
    assert!(event["score"].as_f64().unwrap() <= 1.0);
    // Same-chat messages are recalled only once older than the context window.
    let inside = s
        .recall("homeserver backup", None, "garage", older.id)
        .unwrap();
    assert_eq!(recalled(&inside, "event"), [current.id]);
    let outside = s
        .recall("homeserver backup", None, "garage", current.id)
        .unwrap();
    assert_eq!(recalled(&outside, "event"), [current.id, older.id]);
    assert!(
        s.recall("completely unrelated words", Some(&axis(9)), "thread", 0)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn memory_search_filters_to_claims_and_turns_are_digested_for_consolidation() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = Store::open(&dir.path().join("history.vg")).unwrap();
    let user = s
        .append(
            "message.user",
            "thread",
            json!({"text":"Install the renderer with pixi"}),
        )
        .unwrap();
    s.append("agent.started", "thread", json!({})).unwrap();
    let receipt = s
        .append("tool.result", "thread", json!({"name":"Bash","arguments":{"command":"pixi add renderer"},"result":{"ok":true,"result":{"output":"added renderer"}}}))
        .unwrap();
    let reply = s
        .append(
            "message.assistant",
            "thread",
            json!({"text":"The renderer is installed with pixi."}),
        )
        .unwrap();
    s.append("agent.finished", "thread", json!({})).unwrap();
    let turn = s.turn_digest(user.id).unwrap();
    assert_eq!(turn["user"]["id"], user.id);
    assert_eq!(turn["assistant"]["id"], reply.id);
    assert_eq!(turn["receipts"][0]["id"], receipt.id);
    assert_eq!(turn["receipts"][0]["ok"], true);
    let claim = s
        .write_claims("thread", "Thread", claims(json!([{"text":"The renderer is installed with pixi.","about":["renderer"],"supersedes":[],"evidence":[receipt.id]}])))
        .unwrap()[0]["id"]
        .as_u64()
        .unwrap();
    let only = s.memory_search("renderer", "claim", 0, None).unwrap();
    assert_eq!(only["total"], 1);
    assert_eq!(only["hits"][0]["id"], claim);
    assert_eq!(only["hits"][0]["label"], "Claim");
    assert_eq!(only["hits"][0]["run_id"], user.id);
    let all = s.memory_search("renderer", "all", 0, None).unwrap();
    assert_eq!(all["hits"][0]["id"], claim, "Newest first, claims included");
    assert!(all["total"].as_u64().unwrap() > 1);
    assert_eq!(
        s.memory_search("renderer", "message", 0, None).unwrap()["hits"][0]["kind"],
        "message.assistant"
    );
    let overview = s.memory_graph(None, 0).unwrap();
    let labels: Vec<_> = overview["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["label"].as_str().unwrap())
        .collect();
    assert!(labels.contains(&"Claim") && labels.contains(&"Entity"));
    assert_eq!(
        s.pending_embeddings(1)[0].0,
        claim,
        "Claims are indexed first"
    );
}
