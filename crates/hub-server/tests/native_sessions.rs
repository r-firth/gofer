use hub_server::{conversations, store::Store};
use serde_json::json;

#[test]
fn native_session_identity_and_parent_survive_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.vg");
    let mut store = Store::open(&path).unwrap();
    store.append("chat.created", "child", json!({
        "id":"child", "name":"Game build", "created_at":"2026-09-24",
        "parent_id":"coordinator", "agent":{"provider":"codex","device_id":"desktop","cwd":"/work/game"}
    })).unwrap();
    store
        .append(
            "agent.session",
            "child",
            json!({"native_id":"thread-on-desktop"}),
        )
        .unwrap();
    store.append("chat.closed", "child", json!({})).unwrap();
    store.append("chat.reopened", "child", json!({})).unwrap();
    drop(store);
    let chats = conversations::project(&Store::open(&path).unwrap().events());
    let chat = serde_json::to_value(&chats[0]).unwrap();
    assert_eq!(chat["agent"]["provider"], "codex");
    assert_eq!(chat["agent"]["device_id"], "desktop");
    assert_eq!(chat["agent"]["native_id"], "thread-on-desktop");
    assert_eq!(chat["parent_id"], "coordinator");
    assert_eq!(chat["closed"], false);
}

#[test]
fn claude_role_and_provider_survive_history_projection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.vg");
    let mut store = Store::open(&path).unwrap();
    for (id, extra) in [
        ("legacy", json!({})),
        ("coordinator", json!({"coordinator_provider":"claude"})),
        (
            "native",
            json!({"parent_id":"coordinator", "agent":{"provider":"claude","device_id":"remote","cwd":"/project"}}),
        ),
    ] {
        let mut chat = json!({"id":id,"name":"Test","created_at":"2026-09-26"});
        chat.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        store.append("chat.created", id, chat).unwrap();
    }
    for (scope, id) in [
        ("native", "claude-session"),
        ("coordinator", "thread-session"),
    ] {
        store
            .append("agent.session", scope, json!({"native_id":id}))
            .unwrap();
    }
    drop(store);
    let chats = conversations::project(&Store::open(&path).unwrap().events());
    let legacy = chats.iter().find(|c| c.id == "legacy").unwrap();
    assert_eq!(legacy.coordinator_provider, "claude");
    assert!(!legacy.thread);
    let coordinator = chats.iter().find(|c| c.id == "coordinator").unwrap();
    assert!(coordinator.agent.is_none());
    assert_eq!(coordinator.coordinator_provider, "claude");
    assert_eq!(coordinator.native_id.as_deref(), Some("thread-session"));
    let native = chats.iter().find(|c| c.id == "native").unwrap();
    assert!(native.native_id.is_none());
    assert_eq!(
        native.agent.as_ref().unwrap().native_id.as_deref(),
        Some("claude-session")
    );
    assert_eq!(native.agent.as_ref().unwrap().provider, "claude");
}
