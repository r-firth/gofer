use hub_server::{store::Store, views};
use serde_json::json;
#[test]
fn view_updates_keep_code_and_actions_are_bound_to_current_chat_and_revision() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("views.vg")).unwrap();
    let first = views::update(None, &json!({"view_id":"job","title":"Render progress","html":"<div id='progress'></div>","data":{"progress":1},"actions":[{"id":"retry","label":"Retry job","prompt":"Retry this job"}]})).unwrap();
    store.append("ui.updated", "a", first.clone()).unwrap();
    assert!(views::latest(&store.events(), "b", "job").is_none());
    let next = views::update(
        Some(&first),
        &json!({"view_id":"job","data":{"progress":90}}),
    )
    .unwrap();
    assert_eq!(next["html"], first["html"]);
    assert_eq!(next["revision"], 2);
    assert!(views::action(&next, &json!({"action_id":"retry","revision":1,"data":{}})).is_err());
    assert!(views::action(&next, &json!({"action_id":"forged","revision":2})).is_err());
    let prompt = views::action(
        &next,
        &json!({"action_id":"retry","revision":2,"data":{"quality":"high"}}),
    )
    .unwrap();
    assert!(prompt.contains("Retry this job") && prompt.contains("high"));
    assert!(
        views::update(
            None,
            &json!({"view_id":"bad","html":"<p>Missing title</p>"})
        )
        .is_err()
    );
}
