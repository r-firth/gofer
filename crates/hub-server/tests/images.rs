use base64::{Engine, engine::general_purpose::STANDARD as B64};
use hub_server::store::Store;
use serde_json::json;

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=";

#[test]
fn image_generation_becomes_a_durable_chat_attachment() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.vg");
    let mut store = Store::open(&path).unwrap();
    let event = store
        .append(
            "tool.result",
            "chat",
            json!({
                "name":"image_generation", "result":{"ok":true,"result":{
                    "type":"imageGeneration", "result":PNG, "revisedPrompt":"A vintage computer"
                }}
            }),
        )
        .unwrap();
    let image = &event.payload["images"][0];
    assert_eq!(
        image["mime_type"], "image/png",
        "Generated images must be visible attachments"
    );
    assert_eq!(image["width"], 1);
    assert_eq!(image["height"], 1);
    assert!(
        !event.payload.to_string().contains(PNG),
        "Binary data must not flood chat, search, or model context"
    );
    let bytes = std::fs::read(
        dir.path()
            .join("artifacts")
            .join(image["id"].as_str().unwrap()),
    )
    .unwrap();
    assert_eq!(bytes, B64.decode(PNG).unwrap());
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.events()[0].payload["images"],
        event.payload["images"]
    );
}

#[test]
fn screenshots_from_native_tool_content_are_visible_and_deduplicated() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("history.vg")).unwrap();
    let event = store
        .append(
            "tool.result",
            "chat",
            json!({"name":"screenshot", "result":{"ok":true,"result":{
                "content":[
                    {"type":"text","text":"Desktop screenshot"},
                    {"type":"image","data":PNG,"mimeType":"image/png"},
                    {"type":"input_image","image_url":format!("data:image/png;base64,{PNG}")},
                    {"type":"inputImage","imageUrl":format!("data:image/png;base64,{PNG}")}
                ]
            }}}),
        )
        .unwrap();
    assert_eq!(event.payload["images"].as_array().map(Vec::len), Some(1));
    assert!(event.payload.to_string().contains("Desktop screenshot"));
    assert!(!event.payload.to_string().contains(PNG));
}

#[test]
fn old_receipts_are_migrated_in_place_and_remain_searchable() {
    use std::sync::Arc;
    use vecgra::{Database, DatabaseOptions, Value};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.vg");
    let id;
    {
        let db = Database::create(&path, DatabaseOptions::new(384)).unwrap();
        let mut tx = db.transaction();
        id = tx.create_node("Event", [("event", Value::String(Arc::from(json!({
            "id":0,"scope":"chat","kind":"tool.result","time":"2026-09-23T22:00:00Z",
            "payload":{"name":"image_generation","result":{"ok":true,"result":{
                "type":"imageGeneration","result":PNG,"revisedPrompt":"A vintage computer"
            }}}
        }).to_string())))], &[]);
        tx.commit().unwrap();
    }
    let store = Store::open(&path).unwrap();
    let event = &store.events()[0];
    assert_eq!(
        event.id, id,
        "Migration must preserve provenance and graph links"
    );
    assert!(event.payload["images"][0]["url"].is_string());
    assert_eq!(store.search("vintage computer", None).unwrap()[0].id, id);
    drop(store);
    // The Vecgra event itself is upgraded; reloading doesn't reimport the blob.
    let db = Database::open(&path).unwrap();
    let read = db.read();
    let node = read.node(id).unwrap();
    assert!(
        node.properties
            .iter()
            .all(|p| !format!("{:?}", p.value).contains(PNG))
    );
    assert_eq!(
        std::fs::read_dir(dir.path().join("artifacts"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn local_images_survive_source_deletion_and_never_expose_arbitrary_paths() {
    use hub_server::artifacts::Artifacts;
    let dir = tempfile::tempdir().unwrap();
    let artifacts = Artifacts::new(dir.path().join("artifacts")).unwrap();
    let source = dir.path().join("screen 'one'.png");
    std::fs::write(&source, B64.decode(PNG).unwrap()).unwrap();
    let image = artifacts.local(source.to_str().unwrap(), "Screen").unwrap();
    std::fs::remove_file(source).unwrap();
    let bytes = std::fs::read(artifacts.path(&image.id).unwrap()).unwrap();
    assert_eq!(bytes, B64.decode(PNG).unwrap());
    for path in [
        "/etc/passwd",
        "../secret.png",
        "../../image.png",
        "not-a-hash.png",
        "file.svg",
    ] {
        assert!(artifacts.path(path).is_none());
    }
    assert!(
        artifacts
            .save(&vec![0; 25 * 1024 * 1024 + 1], "", None, None)
            .is_err()
    );
    assert!(
        artifacts
            .save(
                b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
                "",
                None,
                None
            )
            .is_err()
    );
}

#[test]
fn invalid_images_report_a_display_error_without_losing_the_tool_result() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("history.vg")).unwrap();
    let event = store.append("tool.result", "chat", json!({"name":"screenshot", "result":{"ok":true,"result":{
        "content":[{"type":"image","data":B64.encode(b"<script>alert(1)</script>"),"mimeType":"image/png"}]
    }}})).unwrap();
    assert_eq!(event.payload["result"]["ok"], true);
    assert!(event.payload["image_errors"][0].is_string());
    assert!(event.payload["images"].as_array().is_none_or(Vec::is_empty));
}
