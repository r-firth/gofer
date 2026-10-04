use hub_server::store::Store;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

#[test]
fn private_memory_permissions_cover_creation_reopening_and_migration_backups() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("private");
    let path = directory.join("memory.vg");
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let event = store
        .append(
            "message.user",
            "chat",
            json!({"text":"private conversation"}),
        )
        .unwrap();
    store
        .embed(event.id, vec![0.25; hub_server::embeddings::DIMENSIONS])
        .unwrap();
    drop(store);
    // Upgrade permissions on archives written by older versions, too.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let mut store = Store::open(&path).unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let backup = store
        .prepare_embeddings("new-profile", hub_server::embeddings::DIMENSIONS)
        .unwrap()
        .unwrap();
    assert_eq!(
        std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        Store::open(&backup).unwrap().events()[0].payload["text"],
        "private conversation"
    );
}

#[test]
fn session_output_and_messages_survive_a_server_restart_in_order() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("memory.vg");
    let mut store = Store::open(&path).unwrap();
    let first = store
        .append("session.created", "terminal-1", json!({"cwd":"/tmp"}))
        .unwrap();
    let second = store
        .append("terminal.output", "terminal-1", json!({"data":"hello\r\n"}))
        .unwrap();
    assert!(second.id > first.id);
    drop(store);
    let restored = Store::open(&path).unwrap();
    let events = restored.events();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].payload["data"], "hello\r\n");
    assert_eq!(events[0].scope, "terminal-1");
}

#[test]
fn search_returns_the_complete_message_instead_of_duplicate_stream_fragments() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = Store::open(&temp.path().join("memory.vg")).unwrap();
    store
        .append(
            "message.started",
            "chat",
            json!({"message_id":"answer","text":""}),
        )
        .unwrap();
    store
        .append(
            "message.delta",
            "chat",
            json!({"message_id":"answer","delta":"The renderer"}),
        )
        .unwrap();
    store
        .append(
            "message.delta",
            "chat",
            json!({"message_id":"answer","delta":" is ready."}),
        )
        .unwrap();
    let final_message = store
        .append(
            "message.assistant",
            "chat",
            json!({"message_id":"answer","text":"The renderer is ready."}),
        )
        .unwrap();
    let results = store.search("renderer", None).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, final_message.id);
    // Every original chunk is still durably available for replay.
    drop(store);
    assert_eq!(
        Store::open(&temp.path().join("memory.vg"))
            .unwrap()
            .events()
            .len(),
        4
    );
}
