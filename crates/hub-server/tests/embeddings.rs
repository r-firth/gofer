type ProviderState = (Arc<Mutex<Vec<Value>>>, StatusCode, Value);
use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use hub_server::{
    embeddings::{DIMENSIONS, Embedder, MODEL},
    store::Store,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
// Provider protocol checks use the Qwen profile at its historical size.
const QWEN: &str = "qwen/qwen3-embedding-8b";

// Only the remote provider is replaced; requests use the real HTTP client.
async fn provider(
    status: StatusCode,
    response: Value,
) -> (String, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let state = (calls.clone(), status, response);
    async fn reply(
        State((calls, status, response)): State<ProviderState>,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        calls.lock().unwrap().push(body);
        (status, Json(response))
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/embeddings", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/embeddings", post(reply))
                .with_state(state),
        )
        .await
        .unwrap();
    });
    (url, calls, task)
}

#[tokio::test]
async fn orders_provider_vectors_and_adds_instruction_only_to_queries() {
    let (url, calls, server) = provider(
        StatusCode::OK,
        json!({"model":"qwen/qwen3-embedding-8b", "data":[
            {"index":1,"embedding":vec![0.2;384]}, {"index":0,"embedding":vec![0.1;384]}
        ]}),
    )
    .await;
    let client = Embedder::new(Some("fixture-key".into()), &url, QWEN, 384).unwrap();
    let vectors = client
        .embed_documents(vec!["first".into(), "second".into()])
        .await
        .unwrap();
    assert_eq!(vectors[0][0], 0.1);
    assert_eq!(vectors[1][0], 0.2);
    let body = calls.lock().unwrap()[0].clone();
    assert_eq!(body["input"], json!(["first", "second"]));
    assert_eq!(body["model"], "qwen/qwen3-embedding-8b");
    assert_eq!(body["dimensions"], 384);
    server.abort();

    let (url, calls, server) = provider(
        StatusCode::OK,
        json!({"data":[{"index":0,"embedding":vec![0.5;384]}]}),
    )
    .await;
    let client = Embedder::new(Some("fixture-key".into()), &url, QWEN, 384).unwrap();
    assert_eq!(
        client.query("earlier renderer decision").await.unwrap()[0],
        0.5
    );
    assert_eq!(
        client.query("earlier renderer decision").await.unwrap()[0],
        0.5
    );
    let requests = calls.lock().unwrap();
    assert_eq!(
        requests.len(),
        1,
        "Repeated queries must use the cached vector"
    );
    assert_eq!(
        requests[0]["input"][0],
        "Instruct: Retrieve graph elements relevant to the query\nQuery: earlier renderer decision"
    );
    server.abort();
}

#[tokio::test]
async fn rejects_invalid_vectors_indices_and_wrong_models() {
    for response in [
        json!({"data":[{"index":0,"embedding":vec![1.0;383]}]}),
        json!({"data":[{"index":0,"embedding":vec![0.0;384]}]}),
        json!({"data":[{"index":1,"embedding":vec![1.0;384]}]}),
        json!({"model":"another-model", "data":[{"index":0,"embedding":vec![1.0;384]}]}),
        json!({"data":[]}),
    ] {
        let (url, _, server) = provider(StatusCode::OK, response).await;
        let client = Embedder::new(Some("fixture-key".into()), &url, QWEN, 384).unwrap();
        assert!(client.embed_documents(vec!["text".into()]).await.is_err());
        server.abort();
    }
    let (url, _, server) = provider(
        StatusCode::OK,
        json!({"data":[
            {"index":0,"embedding":vec![1.0;384]}, {"index":0,"embedding":vec![1.0;384]}
        ]}),
    )
    .await;
    let client = Embedder::new(Some("fixture-key".into()), &url, QWEN, 384).unwrap();
    assert!(
        client
            .embed_documents(vec!["a".into(), "b".into()])
            .await
            .is_err()
    );
    server.abort();
}

#[tokio::test]
async fn auth_failure_is_not_retried_or_echoed_and_missing_key_never_sends() {
    let (url, calls, server) = provider(
        StatusCode::UNAUTHORIZED,
        json!({"error":{"message":"fixture-key private user text"}}),
    )
    .await;
    let client = Embedder::new(Some("fixture-key".into()), &url, QWEN, 384).unwrap();
    let error = client
        .query("private user text")
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("401"));
    assert!(!error.contains("fixture-key") && !error.contains("private user text"));
    assert_eq!(calls.lock().unwrap().len(), 1);
    let disabled = Embedder::new(None, &url, QWEN, 384).unwrap();
    assert!(
        disabled
            .query("private user text")
            .await
            .unwrap_err()
            .to_string()
            .contains("OPENROUTER_API_KEY")
    );
    assert_eq!(calls.lock().unwrap().len(), 1);
    assert!(
        Embedder::new(
            Some("fixture-key".into()),
            "http://remote.example/embeddings",
            QWEN,
            384
        )
        .is_err()
    );
    server.abort();
}

#[test]
fn migration_backs_up_old_vectors_preserves_graph_and_resumes_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.vg");
    let mut store = Store::open(&path).unwrap();
    let a = store
        .append(
            "message.user",
            "chat",
            json!({"text":"Keep this conversation"}),
        )
        .unwrap();
    let b = store
        .append(
            "message.assistant",
            "chat",
            json!({"text":"And the relationships"}),
        )
        .unwrap();
    store.embed(a.id, vec![0.1; DIMENSIONS]).unwrap();
    store.embed(b.id, vec![0.2; DIMENSIONS]).unwrap();
    let before = serde_json::to_value(store.events()).unwrap();
    let edges = store.memory_graph(Some(b.id), 0).unwrap()["edges"].clone();
    let profile = Embedder::new(
        None,
        "https://openrouter.ai/api/v1/embeddings",
        MODEL,
        DIMENSIONS,
    )
    .unwrap()
    .profile();
    let backup = store
        .prepare_embeddings(&profile, DIMENSIONS)
        .unwrap()
        .expect("Legacy vectors need a backup");
    assert_eq!(serde_json::to_value(store.events()).unwrap(), before);
    assert_eq!(store.memory_graph(Some(b.id), 0).unwrap()["edges"], edges);
    assert_eq!(store.pending_embeddings(100).len(), 2);
    assert!(store.memory_element("node", a.id).unwrap()["vector"].is_null());
    let old = Store::open(&backup).unwrap();
    assert_eq!(
        old.memory_element("node", a.id).unwrap()["vector"]
            .as_array()
            .unwrap()
            .len(),
        DIMENSIONS
    );
    assert_eq!(serde_json::to_value(old.events()).unwrap(), before);
    store
        .embed_batch(vec![(a.id, vec![0.3; DIMENSIONS])])
        .unwrap();
    drop(store);
    let mut resumed = Store::open(&path).unwrap();
    assert!(
        resumed
            .prepare_embeddings(&profile, DIMENSIONS)
            .unwrap()
            .is_none()
    );
    let pending = resumed.pending_embeddings(100);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].0, b.id);
    assert_eq!(resumed.memory_graph(Some(b.id), 0).unwrap()["edges"], edges);
    // Same-dimensional vectors from another provider/profile cannot be mixed.
    let changed = format!("{profile}-different-model");
    assert!(
        resumed
            .prepare_embeddings(&changed, DIMENSIONS)
            .unwrap()
            .is_some()
    );
    assert_eq!(resumed.pending_embeddings(100).len(), 2);
}

#[test]
fn malformed_batch_cannot_partially_commit_embeddings() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("history.vg")).unwrap();
    let a = store
        .append("message.user", "chat", json!({"text":"One"}))
        .unwrap();
    let b = store
        .append("message.assistant", "chat", json!({"text":"Two"}))
        .unwrap();
    assert!(
        store
            .embed_batch(vec![
                (a.id, vec![0.1; DIMENSIONS]),
                (b.id, vec![0.2; DIMENSIONS - 1])
            ])
            .is_err()
    );
    assert_eq!(store.pending_embeddings(100).len(), 2);
    assert!(
        store
            .search("no literal match", Some(&vec![0.1; DIMENSIONS]))
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn retries_transient_provider_errors_then_accepts_a_valid_response() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let attempts = Arc::new(AtomicUsize::new(0));
    let seen = attempts.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/embeddings", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/embeddings",
        post(move || {
            let seen = seen.clone();
            async move {
                if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [("retry-after", "0")],
                        Json(json!({"error":{}})),
                    )
                } else {
                    (
                        StatusCode::OK,
                        [("retry-after", "0")],
                        Json(json!({"data":[{"index":0,"embedding":vec![0.4;384]}]})),
                    )
                }
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = Embedder::new(Some("fixture-key".into()), &url, QWEN, 384).unwrap();
    assert_eq!(client.query("recoverable search").await.unwrap()[0], 0.4);
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    server.abort();
}

#[tokio::test]
async fn query_does_not_wait_for_an_indexing_request() {
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/embeddings", listener.local_addr().unwrap());
    let s = started.clone();
    let r = release.clone();
    let app = Router::new().route(
        "/embeddings",
        post(move |Json(body): Json<Value>| {
            let s = s.clone();
            let r = r.clone();
            async move {
                if body["input"][0] == "background" {
                    s.notify_one();
                    r.notified().await;
                }
                Json(json!({"data":[{"index":0,"embedding":vec![0.4;384]}]}))
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = Arc::new(Embedder::new(Some("fixture-key".into()), &url, QWEN, 384).unwrap());
    let background = client.clone();
    let indexing =
        tokio::spawn(async move { background.embed_documents(vec!["background".into()]).await });
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    let vector = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        client.query("interactive"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(vector[0], 0.4);
    assert!(!indexing.is_finished());
    release.notify_one();
    indexing.await.unwrap().unwrap();
    server.abort();
}

#[tokio::test]
async fn a_timed_out_viewer_does_not_cancel_or_duplicate_the_query_embedding() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let attempts = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/embeddings", listener.local_addr().unwrap());
    let a = attempts.clone();
    let s = started.clone();
    let r = release.clone();
    let app = Router::new().route(
        "/embeddings",
        post(move || {
            let a = a.clone();
            let s = s.clone();
            let r = r.clone();
            async move {
                a.fetch_add(1, Ordering::SeqCst);
                s.notify_one();
                r.notified().await;
                Json(json!({"data":[{"index":0,"embedding":vec![0.7;384]}]}))
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = Arc::new(Embedder::new(Some("fixture-key".into()), &url, QWEN, 384).unwrap());
    let reader = client.clone();
    let first = tokio::spawn(async move {
        tokio::time::timeout(
            std::time::Duration::from_millis(150),
            reader.query("slow provider"),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    assert!(first.await.unwrap().is_err());
    let (provisional, pending) = client.search_query("slow provider").await;
    assert!(
        provisional.is_none() && pending,
        "The UI must know to refresh text-only matches"
    );
    release.notify_one();
    let vector = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        client.query("slow provider"),
    )
    .await
    .expect("A later viewer should receive the completed request, not start another one")
    .unwrap();
    assert_eq!(vector[0], 0.7);
    let (cached, pending) = client.search_query("slow provider").await;
    assert_eq!(cached.unwrap()[0], 0.7);
    assert!(!pending, "Completed searches must stop polling");
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn gemini_uses_its_retrieval_formats_and_accepts_its_bare_model_name() {
    let (url, calls, server) = provider(
        StatusCode::OK,
        json!({"model":"gemini-embedding-2", "data":[{"index":0,"embedding":vec![0.3;768]}]}),
    )
    .await;
    let client = Embedder::new(Some("fixture-key".into()), &url, MODEL, DIMENSIONS).unwrap();
    client
        .embed_documents(vec!["Ryan uses uv".into()])
        .await
        .unwrap();
    client.query("package manager").await.unwrap();
    let requests = calls.lock().unwrap().clone();
    assert_eq!(requests[0]["model"], "google/gemini-embedding-2");
    assert_eq!(requests[0]["dimensions"], 768);
    assert_eq!(requests[0]["input"][0], "title: none | text: Ryan uses uv");
    assert_eq!(
        requests[1]["input"][0],
        "task: search result | query: package manager"
    );
    assert!(client.profile().contains("title: none | text: "));
    server.abort();
    let (url, _, server) = provider(
        StatusCode::OK,
        json!({"model":"embedding-2", "data":[{"index":0,"embedding":vec![0.3;768]}]}),
    )
    .await;
    let client = Embedder::new(Some("fixture-key".into()), &url, MODEL, DIMENSIONS).unwrap();
    assert!(client.embed_documents(vec!["text".into()]).await.is_err());
    server.abort();
}
