use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hub_server::push::{PushStore, valid_subscription};
use serde_json::json;
#[test]
fn subscriptions_only_accept_real_push_services_and_valid_keys() {
    let subscription = |endpoint| json!({"endpoint":endpoint,"keys":{"p256dh":URL_SAFE_NO_PAD.encode([4u8;65]),"auth":URL_SAFE_NO_PAD.encode([1u8;16])}});
    assert!(valid_subscription(&subscription(
        "https://web.push.apple.com/test"
    )));
    assert!(!valid_subscription(&subscription(
        "https://web.push.apple.com.evil.test/test"
    )));
    assert!(!valid_subscription(&subscription("http://127.0.0.1/test")));
    assert!(!valid_subscription(
        &json!({"endpoint":"https://fcm.googleapis.com/test","keys":{}})
    ));
}
#[test]
fn push_queue_survives_restart_skips_active_viewers_and_retries_transient_failures() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("push.json");
    let mut store = PushStore::open(&path).unwrap();
    store.subscribe("phone",json!({"endpoint":"https://fcm.googleapis.com/test","keys":{"p256dh":URL_SAFE_NO_PAD.encode([4u8;65]),"auth":URL_SAFE_NO_PAD.encode([1u8;16])}})).unwrap();
    store.presence("phone", "tab", Some("chat"), 100);
    store
        .enqueue("1", "chat", json!({"title":"Done"}), 100, false)
        .unwrap();
    assert!(store.due(100).is_none());
    store
        .enqueue("2", "chat", json!({"title":"Done"}), 200, false)
        .unwrap();
    drop(store);
    let mut store = PushStore::open(&path).unwrap();
    let job = store.due(200).unwrap();
    store.delivered(&job, 503, 200).unwrap();
    assert!(store.due(200).is_none());
    let job = store.due(240).unwrap();
    store.delivered(&job, 410, 240).unwrap();
    assert!(store.due(300).is_none());
    assert!(!store.subscribed("phone"));
}
