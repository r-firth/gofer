use hub_server::{requests, store::Store};
use serde_json::json;

#[test]
fn malformed_or_oversized_prompts_cannot_become_pending_requests() {
    assert!(requests::validate_request(&json!({"title":"Question"})).is_err());
    assert!(requests::validate_request(&json!({"title":"Question", "options":[{"id":"yes","label":"Yes"},{"id":"yes","label":"Again"}]})).is_err());
    assert!(
        requests::validate_request(
            &json!({"title":"Question", "questions":[{"id":"answer","label":"Your answer"}]})
        )
        .is_ok()
    );
}

#[test]
fn answering_or_stopping_removes_pending_input_and_rejects_forged_choices() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("history.vg")).unwrap();
    let request = json!({"request_id":"request", "title":"Run deployment?", "options":[{"id":"allow","label":"Allow once"},{"id":"deny","label":"Decline"}]});
    store
        .append("agent.requested", "chat", request.clone())
        .unwrap();
    assert!(requests::pending(&store.events(), "chat", "request").is_some());
    assert!(requests::validate_answer(&request, &json!({"choice":"always-allow"})).is_err());
    requests::validate_answer(&request, &json!({"choice":"deny"})).unwrap();
    store
        .append(
            "agent.answered",
            "chat",
            json!({"request_id":"request","choice":"deny"}),
        )
        .unwrap();
    assert!(requests::pending(&store.events(), "chat", "request").is_none());
    store.append("agent.requested", "chat", request).unwrap();
    store.append("agent.stopped", "chat", json!({})).unwrap();
    assert!(requests::pending(&store.events(), "chat", "request").is_none());
}
