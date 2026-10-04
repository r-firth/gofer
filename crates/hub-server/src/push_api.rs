use super::*;
use std::time::Duration;
async fn worker(h: &Shared, task: Value) -> Result<Value> {
    let mut child = tokio::process::Command::new(h.root.join("agent/.venv/bin/python"))
        .arg(h.root.join("agent/push.py"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().unwrap();
    input.write_all(task.to_string().as_bytes()).await?;
    drop(input);
    let output = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output()).await??;
    if !output.status.success() {
        bail!("Push worker unavailable")
    };
    Ok(serde_json::from_slice(&output.stdout)?)
}
pub async fn config(State(h): State<Shared>) -> Api<Value> {
    if h.push.lock().unwrap().keys().is_null() {
        let keys = worker(&h, json!({"generate":true})).await?;
        h.push.lock().unwrap().set_keys(keys)?;
    }
    Ok(Json(
        json!({"public_key":h.push.lock().unwrap().keys()["public"]}),
    ))
}
pub async fn subscribe(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Value> {
    let id = p["client_id"].as_str().context("Browser ID required")?;
    h.push
        .lock()
        .unwrap()
        .subscribe(id, p["subscription"].clone())?;
    Ok(Json(json!({"ok":true})))
}
pub async fn unsubscribe(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Value> {
    h.push
        .lock()
        .unwrap()
        .unsubscribe(p["client_id"].as_str().context("Browser ID required")?)?;
    Ok(Json(json!({"ok":true})))
}
pub async fn presence(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Value> {
    let id = p["client_id"].as_str().context("Browser ID required")?;
    h.push.lock().unwrap().presence(
        id,
        p["tab_id"].as_str().unwrap_or(""),
        p["chat_id"].as_str(),
        chrono::Utc::now().timestamp(),
    );
    Ok(Json(
        json!({"subscribed":h.push.lock().unwrap().subscribed(id)}),
    ))
}
pub async fn test(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Value> {
    let id = p["client_id"].as_str().context("Browser ID required")?;
    let (subscription, keys) = {
        let push = h.push.lock().unwrap();
        (
            push.subscription(id)
                .context("This browser is not subscribed")?,
            push.keys(),
        )
    };
    let result=worker(&h,json!({"subscription":subscription,"keys":keys,"payload":{"title":"Gofer","body":"Notifications are connected.","chat_id":p["chat_id"],"tag":"test"}})).await?;
    let status = result["status"].as_u64().unwrap_or(503);
    if !(200..300).contains(&status) {
        bail_api(&format!(
            "Push service returned {status}; try enabling notifications again"
        ))?
    };
    Ok(Json(json!({"ok":true})))
}
pub async fn deliver(h: Shared) {
    let mut interval = tokio::time::interval(Duration::from_secs(3));
    loop {
        interval.tick().await;
        loop {
            let now = chrono::Utc::now().timestamp();
            let Some(job) = h.push.lock().unwrap().due(now) else {
                break;
            };
            let task = {
                let push = h.push.lock().unwrap();
                if job.expires <= now || push.watching(&job.client, &job.chat, now) {
                    None
                } else {
                    push.subscription(&job.client).map(|subscription|json!({"subscription":subscription,"keys":push.keys(),"payload":job.payload}))
                }
            };
            let request_resolved = job.payload["request_id"].as_str().is_some_and(|id| {
                hub_server::requests::pending(&h.history(), &job.chat, id).is_none()
            });
            let status = if let Some(task) = task.filter(|_| !request_resolved) {
                match worker(&h, task).await {
                    Ok(result) => result["status"].as_u64().unwrap_or(503) as u16,
                    Err(_) => 503,
                }
            } else {
                0
            };
            if let Err(error) = h.push.lock().unwrap().delivered(&job, status, now) {
                tracing::warn!("Could not persist notification delivery: {error}");
                break;
            }
        }
    }
}
