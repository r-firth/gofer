mod agent_api;
mod embedding;
mod push_api;
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use futures_util::SinkExt;
use hub_server::{
    conversations::{self, AgentSession, Chat},
    discovery::{self, Device, DiscoveryState},
    store::{Event, Store},
    terminal::{self, Terminal},
    validate_target,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex as AsyncMutex, Notify, broadcast},
};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    id: String,
    name: String,
    device_id: String,
    cwd: String,
    created_at: String,
    #[serde(default = "agent_owner")]
    owner: String,
    #[serde(default)]
    closed: bool,
    #[serde(default)]
    cleanup_pending: bool,
    #[serde(default)]
    cleanup_error: Option<String>,
}
fn agent_owner() -> String {
    "agent".into()
}
struct Live {
    terminal: Arc<Terminal>,
    tx: broadcast::Sender<Vec<u8>>,
}
struct Hub {
    store: Mutex<Store>,
    input_lock: Mutex<()>,
    agent_tokens: Mutex<HashMap<String, String>>,
    push: Mutex<hub_server::push::PushStore>,
    events: broadcast::Sender<Event>,
    terminals: AsyncMutex<HashMap<String, Live>>,
    terminal_operations: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    attached_ids: Mutex<HashSet<String>>,
    terminal_lifecycle: AsyncMutex<()>,
    terminal_cleanup: Notify,
    running: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    consolidation: AsyncMutex<()>,
    embedder: embedding::Embedder,
    embedding_status: Mutex<String>,
    discovery: Mutex<DiscoveryState>,
    discovery_lock: AsyncMutex<()>,
    root: PathBuf,
    token: Option<String>,
    port: u16,
    allowed_hosts: HashSet<String>,
}
type Shared = Arc<Hub>;
struct ApiError(anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":self.0.to_string()})),
        )
            .into_response()
    }
}
type Api<T> = std::result::Result<Json<T>, ApiError>;
impl Hub {
    fn record(&self, kind: &str, scope: &str, payload: Value) -> Result<Event> {
        let event = self.store.lock().unwrap().append(kind, scope, payload)?;
        let _ = self.events.send(event.clone());
        if let Err(error) = self.push.lock().unwrap().observe(&event) {
            tracing::warn!("Could not queue notification: {error}");
        }
        Ok(event)
    }
    fn history(&self) -> Vec<Event> {
        self.store.lock().unwrap().metadata()
    }
    fn terminal_operation(&self, id: &str) -> Arc<AsyncMutex<()>> {
        self.terminal_operations
            .lock()
            .unwrap()
            .entry(id.into())
            .or_default()
            .clone()
    }
    fn devices(&self) -> Vec<Device> {
        let mut result = discovery::without_self(self.all_devices());
        result.sort_by_key(|d| (d.id != "local", d.name.clone()));
        result
    }
    /// Saved records that turned out to be this host, so history that names them still resolves.
    fn device_aliases(&self) -> HashMap<String, String> {
        let kept: HashSet<String> = self.devices().into_iter().map(|d| d.id).collect();
        self.all_devices()
            .into_iter()
            .filter(|d| !kept.contains(&d.id))
            .map(|d| (d.id, "local".to_string()))
            .collect()
    }
    fn all_devices(&self) -> Vec<Device> {
        let mut map = HashMap::new();
        for e in self.history() {
            if e.kind == "device.saved"
                && let Ok(d) = serde_json::from_value::<Device>(e.payload.clone())
            {
                map.insert(d.id.clone(), d);
            }
            if e.kind == "device.status"
                && let Some(d) = map.get_mut(&e.scope)
            {
                d.status = e.payload["status"].as_str().unwrap_or("unknown").into();
            }
        }
        map.into_values().collect()
    }
    fn sessions(&self) -> Vec<Session> {
        let mut map = HashMap::new();
        for e in self.history() {
            if e.kind == "session.created"
                && let Ok(s) = serde_json::from_value::<Session>(e.payload.clone())
            {
                map.insert(s.id.clone(), s);
            }
            if let Some(s) = map.get_mut(&e.scope) {
                match e.kind.as_str() {
                    "session.close_requested" => {
                        s.closed = true;
                        s.cleanup_pending = true;
                        s.cleanup_error = None;
                    }
                    "session.closed" => {
                        s.closed = true;
                        s.cleanup_pending = false;
                        s.cleanup_error = None;
                    }
                    "session.cleanup_failed" => {
                        s.cleanup_error = e.payload["error"].as_str().map(str::to_owned);
                    }
                    _ => {}
                }
                if e.kind == "session.control" {
                    s.owner = e.payload["owner"].as_str().unwrap_or("agent").into();
                }
            }
        }
        let mut result: Vec<_> = map.into_values().collect();
        result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        result
    }
    fn chats(&self) -> Vec<Chat> {
        conversations::project(&self.history())
    }
    fn projects(&self) -> Vec<conversations::Project> {
        conversations::projects(&self.history())
    }
    /// The open project a conversation works for: its own, or its thread's.
    fn project_of(&self, chat_id: &str) -> Option<conversations::Project> {
        let chats = self.chats();
        let chat = chats.iter().find(|c| c.id == chat_id)?;
        let id = chat.project_id.clone().or_else(|| {
            let parent = chat.parent_id.as_deref()?;
            chats.iter().find(|c| c.id == parent)?.project_id.clone()
        })?;
        self.projects()
            .into_iter()
            .find(|p| p.id == id && !p.closed)
    }
    fn link_terminal(&self, chat_id: &str, session_id: &str) -> Result<()> {
        let chats = self.chats();
        let chat = chats
            .iter()
            .find(|c| c.id == chat_id)
            .context("Conversation not found")?;
        if chat.closed || chat.closing {
            bail!("Conversation is closed or closing");
        }
        if chats
            .iter()
            .any(|c| c.id != chat_id && c.session_ids.iter().any(|id| id == session_id))
        {
            bail!("This terminal belongs to another session. Open that session to use it.");
        }
        let (linking, _) = self.session(session_id)?;
        if self.sessions().iter().any(|s| {
            !s.closed
                && s.id != session_id
                && s.device_id == linking.device_id
                && chat.session_ids.contains(&s.id)
        }) {
            bail!(
                "This session already has a terminal on that machine. Use its existing terminal."
            );
        }
        if !chat.session_ids.iter().any(|id| id == session_id) {
            self.record(
                "chat.terminal_linked",
                chat_id,
                json!({"session_id":session_id}),
            )?;
        }
        Ok(())
    }

    fn chat_terminals(&self, chat_id: &str) -> Vec<Session> {
        let ids = self
            .chats()
            .into_iter()
            .find(|c| c.id == chat_id)
            .map(|c| c.session_ids)
            .unwrap_or_default();
        self.sessions()
            .into_iter()
            .filter(|s| ids.contains(&s.id))
            .collect()
    }

    fn check_terminal_owner(&self, chat_id: &str, session_id: &str) -> Result<()> {
        if !self
            .chat_terminals(chat_id)
            .iter()
            .any(|s| s.id == session_id && !s.closed)
        {
            bail!(
                "This terminal does not belong to this session. Use list_terminals or open_terminal for this session's terminal."
            );
        }
        Ok(())
    }

    fn migrate_terminal_ownership(&self) -> Result<()> {
        let chats = self.chats();
        let mut occupied = HashSet::new();
        for session in self.sessions().into_iter().filter(|s| !s.closed) {
            let owner = chats.iter().find(|c| c.session_ids.contains(&session.id));
            if let Some(owner) = owner
                && (owner.closing || (!owner.closed && occupied.insert(owner.id.clone())))
            {
                continue;
            }
            let chat = Chat {
                id: format!("terminal-{}", session.id),
                name: session.name.clone(),
                created_at: session.created_at.clone(),
                title_generated: true,
                ..Default::default()
            };
            self.record(
                "chat.terminal_split",
                &chat.id,
                json!({"session_id":session.id,"chat":chat}),
            )?;
        }
        Ok(())
    }

    fn session(&self, id: &str) -> Result<(Session, Device)> {
        let session = self
            .sessions()
            .into_iter()
            .find(|s| s.id == id && !s.closed)
            .context("Terminal not found or closed")?;
        let device = self
            .devices()
            .into_iter()
            .find(|d| d.id == session.device_id)
            .context("Device not found")?;
        Ok((session, device))
    }

    fn terminal_may_have_shell(&self, id: &str) -> bool {
        let store = self.store.lock().unwrap();
        if store.has_terminal_output(id) {
            return true;
        }
        let mut may_exist = true;
        let mut observed_shell = false;
        let mut legacy_initial_attempt = false;
        let mut launch_tracked = false;
        for event in store.metadata().iter().filter(|e| e.scope == id) {
            match event.kind.as_str() {
                "session.created" => {
                    may_exist = event.payload["shell_state"] != "not_started";
                    legacy_initial_attempt = event.payload["shell_state"].is_null();
                    launch_tracked = !legacy_initial_attempt;
                }
                "session.starting" => {
                    may_exist = true;
                    legacy_initial_attempt = false;
                    launch_tracked = true;
                }
                "session.not_started" => {
                    may_exist = false;
                    launch_tracked = true;
                }
                "session.attached" | "session.detached" | "terminal.input" => {
                    observed_shell = true;
                    legacy_initial_attempt = false;
                }
                "session.error" => {
                    // Explicit launch events supersede the legacy error-text
                    // inference, including authentication cancelled pre-launch.
                    if launch_tracked {
                        continue;
                    }
                    // Older releases recorded the first connection rejection
                    // after allocating the terminal, without a launch state.
                    let rejected = terminal::rejected_before_command(
                        event.payload["error"].as_str().unwrap_or(""),
                    );
                    if legacy_initial_attempt && rejected {
                        may_exist = false;
                    } else if !rejected {
                        may_exist = true;
                    }
                    legacy_initial_attempt = false;
                }
                _ => {}
            }
        }
        may_exist || observed_shell
    }
}
async fn attached(hub: &Shared, id: &str) -> Result<(Arc<Terminal>, broadcast::Receiver<Vec<u8>>)> {
    let _operation = hub.terminal_operation(id).lock_owned().await;
    let (s, d) = hub.session(id)?;
    if hub
        .chats()
        .iter()
        .any(|c| c.session_ids.iter().any(|s| s == id) && (c.closed || c.closing))
    {
        bail!("Conversation is closed or closing");
    }
    if let Some(l) = hub.terminals.lock().await.get(id) {
        return Ok((l.terminal.clone(), l.tx.subscribe()));
    }
    let may_have_shell = hub.terminal_may_have_shell(id);
    // Persist uncertainty before issuing a command that can create a detached
    // shell. A crash or ambiguous connection failure must not skip shutdown.
    hub.record("session.starting", id, json!({}))?;
    let (terminal, mut output) = match Terminal::open(id, d.target.as_deref(), &s.cwd).await {
        Ok(opened) => opened,
        Err(error) => {
            if !may_have_shell
                && (terminal::rejected_before_command(&error.to_string())
                    || hub_server::ssh::rejected_before_command(&error))
            {
                hub.record("session.not_started", id, json!({}))?;
            }
            return Err(error);
        }
    };
    hub.record("session.attached", id, json!({}))?;
    if hub.session(id).is_err() {
        terminal.disconnect();
        bail!("Terminal was closed while connecting");
    }
    let (tx, rx) = broadcast::channel(512);
    hub.terminals.lock().await.insert(
        id.into(),
        Live {
            terminal: terminal.clone(),
            tx: tx.clone(),
        },
    );
    hub.attached_ids.lock().unwrap().insert(id.into());
    let h = hub.clone();
    let id = id.to_owned();
    tokio::spawn(async move {
        while let Some(bytes) = output.recv().await {
            let _ = tx.send(bytes);
        }
        h.terminals.lock().await.remove(&id);
        h.attached_ids.lock().unwrap().remove(&id);
        let _ = h.record("session.detached", &id, json!({}));
    });
    Ok((terminal, rx))
}

/// Whether the terminal is on its alternate screen after these bytes.
fn ends_full_screen(bytes: &[u8], mut on: bool) -> bool {
    let mut rest = bytes;
    while let Some(at) = rest.windows(3).position(|w| w == b"\x1b[?") {
        rest = &rest[at + 3..];
        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        if matches!(&rest[..digits], b"1049" | b"1047" | b"47") {
            match rest.get(digits) {
                Some(b'h') => on = true,
                Some(b'l') => on = false,
                _ => {}
            }
        }
    }
    on
}

fn start_archive(h: Shared, id: String) {
    tokio::spawn(async move {
        let mut offset = h.store.lock().unwrap().archive_offset(&id);
        let mut last_error = String::new();
        // A full-screen program (htop, an editor) repaints the screen for as long as it runs.
        // Its bytes are kept for replay, but repaints are not text worth remembering.
        let mut full_screen = false;
        while let Some(session) = h.sessions().into_iter().find(|s| s.id == id) {
            let Some(device) = h.devices().into_iter().find(|d| d.id == session.device_id) else {
                break;
            };
            match terminal::read_log(&id, device.target.as_deref(), offset).await {
                Ok(bytes) if !bytes.is_empty() => {
                    let was_full_screen = full_screen;
                    full_screen = ends_full_screen(&bytes, full_screen);
                    let text = if was_full_screen || full_screen {
                        String::new()
                    } else {
                        String::from_utf8_lossy(&strip_ansi_escapes::strip(&bytes)).into_owned()
                    };
                    let end = offset + bytes.len() as u64;
                    match h.record("terminal.output", &id, json!({"bytes": B64.encode(&bytes), "offset":offset, "end":end, "text":text})) {
                        Ok(_) => { offset = end; last_error.clear(); },
                        Err(e) => { tracing::error!("Archive write failed: {e}"); tokio::time::sleep(std::time::Duration::from_secs(2)).await; },
                    }
                    continue;
                }
                Ok(_) => {
                    if session.closed {
                        break;
                    }
                    last_error.clear();
                }
                Err(e) => {
                    if session.closed {
                        break;
                    }
                    let error = e.to_string();
                    if error != last_error {
                        let _ = h.record("archive.waiting", &id, json!({"error":error}));
                        last_error = error;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

async fn open_terminal(hub: &Shared, p: &Value, chat_id: Option<&str>) -> Result<Session> {
    let _lifecycle = hub.terminal_lifecycle.lock().await;
    if let Some(id) = chat_id {
        if !hub
            .chats()
            .iter()
            .any(|c| c.id == id && !c.closed && !c.closing)
        {
            bail!("Conversation is closed or closing");
        }
        // One open terminal per machine: asking again for the same machine returns it.
        let wanted = p["device_id"].as_str().unwrap_or("local");
        if let Some(existing) = hub
            .chat_terminals(id)
            .into_iter()
            .find(|s| !s.closed && s.device_id == wanted)
        {
            drop(_lifecycle);
            attached(hub, &existing.id).await?;
            return Ok(existing);
        }
    }
    let device_id = p["device_id"].as_str().unwrap_or("local");
    let d = hub
        .devices()
        .into_iter()
        .find(|d| d.id == device_id)
        .context("Choose an existing device")?;
    let owner_id = match chat_id {
        Some(id) => id.to_owned(),
        None => {
            let chat = new_chat(State(hub.clone()), Json(json!({"name":p["name"]})))
                .await
                .map_err(|error| error.0)?
                .0;
            chat.id
        }
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let s = Session {
        id: id.clone(),
        name: p["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Terminal")
            .chars()
            .take(120)
            .collect(),
        device_id: d.id,
        cwd: p["cwd"].as_str().unwrap_or("").into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        owner: "agent".into(),
        closed: false,
        cleanup_pending: false,
        cleanup_error: None,
    };
    let mut created = serde_json::to_value(&s)?;
    created["shell_state"] = json!("not_started");
    hub.record("session.created", &id, created)?;
    // Keep a terminal with its conversation even while SSH is connecting,
    // or if the first attachment fails and the user needs to retry it.
    // Allocation holds the lifecycle lock so close includes this terminal.
    hub.record("chat.terminal_linked", &owner_id, json!({"session_id":id}))?;
    start_archive(hub.clone(), id.clone());
    drop(_lifecycle);
    match attached(hub, &id).await {
        Ok(_) => {
            hub.record("device.status", &s.device_id, json!({"status":"online"}))?;
        }
        Err(e) => {
            hub.record("session.error", &id, json!({"error":e.to_string()}))?;
            return Err(e);
        }
    }
    Ok(s)
}
async fn write_terminal(hub: &Shared, id: &str, data: &str, actor: &str) -> Result<()> {
    let (terminal, _) = attached(hub, id).await?;
    let _input_guard = hub.input_lock.lock().unwrap();
    let (s, _) = hub.session(id)?;
    if s.owner != actor {
        bail!(
            "Terminal is controlled by {}. Release control before {} sends input.",
            s.owner,
            actor
        );
    }
    hub.record("terminal.input", id, json!({"text":data,"actor":actor}))?;
    terminal.write(data.as_bytes())?;
    Ok(())
}
async fn state(State(h): State<Shared>) -> Api<Value> {
    let sessions = h.sessions();
    let chats = h.chats();
    let live: Vec<_> = h.attached_ids.lock().unwrap().iter().cloned().collect();
    let events = h.history();
    // A finished reply is its own record; the pieces it streamed in are only needed while it
    // is still arriving. Indexing flips recorded by older builds are noise.
    let finished: std::collections::HashSet<&str> = events
        .iter()
        .filter(|e| e.kind == "message.assistant")
        .filter_map(|e| e.payload["message_id"].as_str())
        .collect();
    let history: Vec<_> = events
        .iter()
        .filter(|e| match e.kind.as_str() {
            "terminal.output" | "memory.indexing" | "memory.ready" => false,
            "message.delta" => !e.payload["message_id"]
                .as_str()
                .is_some_and(|id| finished.contains(id)),
            _ => true,
        })
        .cloned()
        .map(|mut e| {
            // Reading a strand returns its recent history, which the page already has under
            // the strand itself; the step line only shows what the strand last said.
            if e.kind == "tool.result"
                && e.payload["name"] == "read_agent"
                && let Some(read) = e.payload["result"]["result"]["events"].as_array_mut()
            {
                let said = read
                    .iter()
                    .rposition(|r| r["kind"] == "message.assistant")
                    .map(|at| read.swap_remove(at));
                read.clear();
                read.extend(said);
            }
            e
        })
        .collect();
    Ok(Json(json!({
        "public_origin": std::env::var("HUB_PUBLIC_ORIGIN").ok(),
        "devices": h.devices(),
        "device_aliases": h.device_aliases(),
        "discovery": h.discovery.lock().unwrap().clone(),
        "sessions": sessions,
        "thread_id": main_thread(&chats),
        "chats": chats,
        "projects": h.projects(),
        "events": history,
        "live": live,
        "running": h.running.lock().unwrap().keys().cloned().collect::<Vec<_>>(),
        "event_count": h.store.lock().unwrap().event_count(),
        "embedding_status": h.embedding_status.lock().unwrap().clone(),
        "embedding_model": h.embedder.model(),
        "embedding_dimensions": h.embedder.dimensions(),
        "model": claude_model(),
    })))
}
/// A browser's reading of its own frame pacing. Logged for `journalctl -u gofer`, not stored:
/// it says how the page is running on his screen, which a test machine cannot.
async fn client_frames(headers: axum::http::HeaderMap, Json(reading): Json<Value>) -> Api<Value> {
    let clip = |text: &str, most: usize| text.chars().take(most).collect::<String>();
    let browser = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    tracing::info!(
        "client frames {} | {}",
        clip(&reading.to_string(), 400),
        clip(browser, 160)
    );
    Ok(Json(json!({"ok":true})))
}
/// The model Claude coordinators (the thread) and Claude sessions run.
fn claude_model() -> String {
    std::env::var("HUB_CLAUDE_MODEL")
        .ok()
        .filter(|m| !m.is_empty())
        .unwrap_or("claude-opus-5-5".into())
}
async fn image_artifact(State(h): State<Shared>, Path(id): Path<String>) -> Response {
    let path = h.store.lock().unwrap().artifacts.path(&id);
    let Some(path) = path else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = match id.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; sandbox",
            ),
        ],
        bytes,
    )
        .into_response()
}
async fn create_session(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Session> {
    let chat_id = p["chat_id"].as_str().filter(|id| !id.is_empty());
    if let Some(id) = chat_id
        && !h
            .chats()
            .iter()
            .any(|c| c.id == id && !c.closed && !c.closing)
    {
        bail_api("Conversation not found or closed")?;
    }
    Ok(Json(open_terminal(&h, &p, chat_id).await?))
}
async fn save_device(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Device> {
    let target = p["target"]
        .as_str()
        .context("SSH destination is required")?
        .trim();
    if !validate_target(target) {
        bail_api("Use an SSH alias or user@hostname")?;
    }
    let id = p["id"]
        .as_str()
        .filter(|id| *id != "local")
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if h.sessions().iter().any(|s| s.device_id == id && !s.closed) {
        bail_api("Close this device's terminals before changing its destination")?;
    }
    let previous = h
        .devices()
        .into_iter()
        .find(|d| d.id == id)
        .unwrap_or_default();
    let device = Device {
        id,
        name: p["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(target)
            .chars()
            .take(80)
            .collect(),
        target: Some(target.into()),
        status: "unknown".into(),
        source: "manual".into(),
        ..previous
    };
    h.record("device.saved", &device.id, serde_json::to_value(&device)?)?;
    Ok(Json(device))
}
fn bail_api(message: &str) -> Result<()> {
    bail!("{message}")
}
async fn probe_device(State(h): State<Shared>, Path(id): Path<String>) -> Api<Value> {
    let d = h
        .devices()
        .into_iter()
        .find(|d| d.id == id)
        .context("Device not found")?;
    let start = std::time::Instant::now();
    let result=terminal::run(d.target.as_deref(), "printf 'Connected\\n'; uname -s; command -v tmux; command -v codex || true; command -v copilot || true; command -v claude || true").await;
    let status = if result.is_ok() { "online" } else { "offline" };
    let details = result.map_err(|e| e.to_string());
    h.record(
        "device.status",
        &id,
        json!({"status":status,"details":details,"latency_ms":start.elapsed().as_millis()}),
    )?;
    Ok(Json(json!({"status":status,"details":details})))
}
async fn sync_devices(h: &Shared) -> Result<usize> {
    let _guard = h.discovery_lock.lock().await;
    let snapshot = discovery::snapshot().await?;
    let existing = h.devices();
    let changes = discovery::reconcile(&existing, &snapshot.peers);
    let added = changes
        .iter()
        .filter(|d| !existing.iter().any(|old| old.id == d.id))
        .count();
    for d in &changes {
        h.record("device.saved", &d.id, serde_json::to_value(d)?)?;
    }
    if let Some(local) = existing.iter().find(|d| d.id == "local") {
        let mut updated = local.clone();
        updated.os = snapshot.local_os;
        updated.address = snapshot.local_address;
        if &updated != local {
            h.record("device.saved", "local", serde_json::to_value(updated)?)?;
        }
    }
    let count = snapshot.peers.iter().filter(|p| p.ssh).count();
    let previous = h.discovery.lock().unwrap().status.clone();
    *h.discovery.lock().unwrap() = DiscoveryState {
        status: "connected".into(),
        message: "Synced from Tailscale".into(),
        last_sync: Some(chrono::Utc::now().to_rfc3339()),
        count,
    };
    if previous != "connected" {
        h.record("discovery.connected", "hub", json!({"devices":count}))?;
    }
    Ok(added)
}
async fn discover(State(h): State<Shared>) -> Api<Value> {
    Ok(Json(json!({"added":sync_devices(&h).await?})))
}
fn start_discovery(h: Shared) {
    if std::env::var("HUB_DISCOVERY").as_deref() == Ok("off") {
        {
            let mut state = h.discovery.lock().unwrap();
            state.status = "disabled".into();
            state.message = "Automatic discovery disabled".into();
        }
        return;
    }
    tokio::spawn(async move {
        loop {
            if let Err(error) = sync_devices(&h).await {
                let message = error.to_string();
                let changed = h.discovery.lock().unwrap().message != message;
                {
                    let mut state = h.discovery.lock().unwrap();
                    state.status = "unavailable".into();
                    state.message = message.clone();
                }
                if changed {
                    let _ = h.record("discovery.unavailable", "hub", json!({"message":message}));
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}
async fn session_action(
    State(h): State<Shared>,
    Path((id, action)): Path<(String, String)>,
    Json(p): Json<Value>,
) -> Api<Value> {
    h.session(&id)?;
    match action.as_str() {
        "control" => {
            let _input_guard = h.input_lock.lock().unwrap();
            let owner = p["owner"].as_str().unwrap_or("agent");
            if !["agent", "user"].contains(&owner) {
                bail_api("Invalid controller")?;
            }
            h.record("session.control", &id, json!({"owner":owner}))?;
        }
        "close" => {
            let _lifecycle = h.terminal_lifecycle.lock().await;
            close_terminal(&h, &id).await?;
        }
        "input" => {
            write_terminal(&h, &id, p["text"].as_str().unwrap_or(""), "user").await?;
        }
        "interrupt" => {
            let (t, _) = attached(&h, &id).await?;
            t.write(&[3])?;
            h.record("terminal.interrupted", &id, json!({"actor":"user"}))?;
        }
        _ => bail_api("Unknown terminal action")?,
    }
    Ok(Json(json!({"ok":true})))
}
async fn terminal_ws(
    State(h): State<Shared>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let (t, rx) = attached(&h, &id).await?;
    Ok(ws.on_upgrade(move |socket| stream_terminal(h, id, t, rx, socket)))
}
/// Lets a Tailscale identity check be approved from the setup panel: it keeps the link and
/// leaves the connection waiting, where a conversation would show a card.
struct SignInLink(Arc<Mutex<Option<String>>>, Arc<Notify>);
impl hub_server::ssh::AuthObserver for SignInLink {
    fn required(&self, _target: &str, url: &str) -> Result<String> {
        *self.0.lock().unwrap() = Some(url.into());
        self.1.notify_one();
        Ok("setup".into())
    }
    fn cancelled(&self, _request: &str) -> bool {
        false
    }
    fn resolved(&self, _request: &str, _outcome: &str) {}
}
/// The Gofer host's own public SSH key, for a machine that has to be told to accept it.
fn host_key() -> Option<String> {
    let ssh = PathBuf::from(std::env::var_os("HOME")?).join(".ssh");
    ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]
        .iter()
        .find_map(|name| std::fs::read_to_string(ssh.join(name)).ok())
}
/// The first thread: the one that is always there.
fn main_thread(chats: &[Chat]) -> Option<String> {
    chats
        .iter()
        .filter(|c| c.thread)
        .min_by(|a, b| a.created_at.cmp(&b.created_at))
        .map(|c| c.id.clone())
}
/// The open thread a loaded strand is shown in: where it was last loaded, if that thread is
/// still open. Closing a thread leaves its loaded strands free to be loaded somewhere else.
fn shown_in(h: &Shared, chats: &[Chat], strand: &str) -> Option<String> {
    h.history()
        .iter()
        .rev()
        .filter(|e| e.kind == "strand.loaded" && e.payload["chat"]["id"] == strand)
        .map(|e| e.scope.clone())
        .find(|thread| {
            chats
                .iter()
                .any(|c| &c.id == thread && c.thread && !c.closed && !c.closing)
        })
}
/// Opens another thread: a conversation with Gofer of its own, sharing the same memory.
async fn new_thread(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Chat> {
    let name: String = p["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("New thread")
        .chars()
        .take(60)
        .collect();
    let project_id = match p["project_id"].as_str() {
        Some(id) => Some(
            h.projects()
                .into_iter()
                .find(|project| project.id == id && !project.closed)
                .context("Project not found")?
                .id,
        ),
        None => None,
    };
    Ok(Json(open_thread(&h, name, project_id)?))
}
fn open_thread(h: &Shared, name: String, project_id: Option<String>) -> Result<Chat> {
    let thread = Chat {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        created_at: chrono::Utc::now().to_rfc3339(),
        title_generated: true,
        coordinator_provider: "claude".into(),
        thread: true,
        project_id,
        ..Default::default()
    };
    h.record("chat.created", &thread.id, serde_json::to_value(&thread)?)?;
    Ok(thread)
}
/// Starts a project: a named collection of threads, with a first thread in it.
async fn new_project(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Value> {
    let name: String = p["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .context("Give the project a name")?
        .chars()
        .take(60)
        .collect();
    if h.projects()
        .iter()
        .any(|project| !project.closed && project.name.eq_ignore_ascii_case(&name))
    {
        bail_api("There is already a project with that name")?;
    }
    let project = conversations::Project {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        created_at: chrono::Utc::now().to_rfc3339(),
        closed: false,
    };
    h.record("project.saved", "projects", serde_json::to_value(&project)?)?;
    let thread = open_thread(&h, "general".into(), Some(project.id.clone()))?;
    Ok(Json(json!({"project": project, "thread": thread})))
}
/// Puts a project away. Its threads are closed by whoever asked, one by one; memory stays.
async fn close_project(State(h): State<Shared>, Path(id): Path<String>) -> Api<Value> {
    if !h.projects().iter().any(|project| project.id == id) {
        bail_api("Project not found")?;
    }
    h.record("project.closed", "projects", json!({"id": id}))?;
    Ok(Json(json!({"closed": true})))
}
/// The Claude and Codex sessions already on a machine, each with the strand it was loaded as
/// if it is in Gofer already (loaded before, or started by Gofer in the first place).
async fn device_sessions(State(h): State<Shared>, Path(id): Path<String>) -> Api<Value> {
    let device = h
        .devices()
        .into_iter()
        .find(|d| d.id == id)
        .context("Device not found")?;
    let found = hub_server::sessions::list(device.target.as_deref()).await?;
    let chats = h.chats();
    let native = |c: &Chat, id: &str| {
        c.native_id.as_deref() == Some(id)
            || c.agent
                .as_ref()
                .is_some_and(|a| a.native_id.as_deref() == Some(id))
    };
    let sessions: Vec<Value> = found
        .into_iter()
        // What Gofer started itself is in a thread already and is not listed as something to load.
        .filter(|session| !chats.iter().any(|c| !c.loaded && native(c, &session.id)))
        .map(|session| {
            let known = chats.iter().find(|c| {
                c.native_id.as_deref() == Some(&session.id)
                    || c.agent
                        .as_ref()
                        .is_some_and(|a| a.native_id.as_deref() == Some(&session.id))
            });
            // Loaded, and still to be seen in a thread that is open.
            let shown = known
                .and_then(|c| shown_in(&h, &chats, &c.id).map(|thread| (c.id.clone(), thread)));
            let mut value = serde_json::to_value(&session).unwrap_or_default();
            value["chat_id"] = json!(shown.as_ref().map(|(chat, _)| chat));
            value["thread_id"] = json!(shown.as_ref().map(|(_, thread)| thread));
            value
        })
        .collect();
    Ok(Json(json!({"device_id": id, "sessions": sessions})))
}
/// Loads a session that exists on a machine into a thread, as a strand: what was said is
/// copied in to be read and remembered, and the strand resumes that same session when continued.
async fn load_session(
    State(h): State<Shared>,
    Path(thread): Path<String>,
    Json(p): Json<Value>,
) -> Api<Value> {
    let chats = h.chats();
    if !chats
        .iter()
        .any(|c| c.id == thread && c.thread && !c.closed)
    {
        bail_api("Load a session into a thread")?;
    }
    let provider = p["provider"].as_str().unwrap_or("");
    let native = p["native_id"].as_str().unwrap_or("");
    let device = h
        .devices()
        .into_iter()
        .find(|d| Some(d.id.as_str()) == p["device_id"].as_str())
        .context("Device not found")?;
    if let Some(known) = chats.iter().find(|c| {
        c.agent
            .as_ref()
            .is_some_and(|a| a.native_id.as_deref() == Some(native))
    }) {
        // Its thread was closed since: show it in this one. What was said is already here.
        if shown_in(&h, &chats, &known.id).is_none() {
            h.record(
                "strand.loaded",
                &thread,
                json!({"chat": known, "turns": 0, "provider": provider, "device_id": device.id}),
            )?;
        }
        return Ok(Json(json!({"chat": known, "turns": 0, "already": true})));
    }
    let read = hub_server::sessions::read(device.target.as_deref(), provider, native).await?;
    if read.turns.is_empty() {
        bail_api("That session has nothing in it to load")?;
    }
    let cwd = if read.cwd.starts_with('/') {
        read.cwd.clone()
    } else {
        "/".into()
    };
    let title = read
        .turns
        .iter()
        .find(|t| t.role == "user")
        .map(|t| t.text.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_else(|| format!("{provider} session"));
    let chat = Chat {
        id: uuid::Uuid::new_v4().to_string(),
        name: title.chars().take(80).collect(),
        created_at: chrono::Utc::now().to_rfc3339(),
        title_generated: true,
        agent: Some(AgentSession {
            provider: provider.into(),
            device_id: device.id.clone(),
            cwd,
            native_id: Some(read.id.clone()),
        }),
        parent_id: Some(thread.clone()),
        loaded: true,
        ..Default::default()
    };
    h.record("chat.created", &chat.id, serde_json::to_value(&chat)?)?;
    // Each of his turns starts a run, exactly as a turn typed here would: that is what
    // makes the session searchable and lets its facts be written to memory.
    let mut runs = Vec::new();
    for turn in &read.turns {
        let kind = if turn.role == "user" {
            "message.user"
        } else {
            "message.assistant"
        };
        let event = h.record(
            kind,
            &chat.id,
            json!({"text": turn.text, "imported": true, "at": turn.time}),
        )?;
        if turn.role == "user" {
            runs.push(event.id);
        }
    }
    h.record(
        "strand.loaded",
        &thread,
        json!({"chat": chat, "turns": read.turns.len(), "provider": provider, "device_id": device.id}),
    )?;
    // Facts are drawn from the latest exchanges; the whole of it is searchable regardless.
    let recent: Vec<u64> = runs.iter().rev().take(8).rev().copied().collect();
    let (hub, id) = (h.clone(), chat.id.clone());
    tokio::spawn(async move {
        for run in recent {
            consolidate(hub.clone(), id.clone(), run, Vec::new()).await;
        }
    });
    Ok(Json(json!({"chat": chat, "turns": read.turns.len()})))
}
/// What a machine has of what Gofer works through, and what would supply the rest.
async fn device_readiness(State(h): State<Shared>, Path(id): Path<String>) -> Api<Value> {
    let device = h
        .devices()
        .into_iter()
        .find(|d| d.id == id)
        .context("Device not found")?;
    let link = Arc::new(Mutex::new(None));
    let asked = Arc::new(Notify::new());
    let observer = Arc::new(SignInLink(link.clone(), asked.clone()));
    let target = device.target.clone();
    let mut check = tokio::spawn(hub_server::ssh::with_auth(observer, async move {
        hub_server::readiness::check(target.as_deref()).await
    }));
    let items = tokio::select! {
        result = &mut check => match result? {
            Ok(items) => items,
            Err(error) => hub_server::readiness::unreachable(
                &error.to_string(),
                host_key().as_deref(),
                device.os.eq_ignore_ascii_case("windows"),
            ),
        },
        // The check is left running: approving the link is what lets it, and the next, through.
        _ = asked.notified() => hub_server::readiness::awaiting_sign_in(
            link.lock().unwrap().as_deref().unwrap_or_default(),
        ),
    };
    Ok(Json(json!({"device_id": id, "items": items})))
}
/// Applies one setup step on a machine, at his click, and reports where it stands after.
async fn device_setup(
    State(h): State<Shared>,
    Path((id, step)): Path<(String, String)>,
) -> Api<Value> {
    let device = h
        .devices()
        .into_iter()
        .find(|d| d.id == id)
        .context("Device not found")?;
    let target = device.target.as_deref();
    let output = hub_server::readiness::apply(target, &step).await?;
    h.record("device.setup", &id, json!({"step": step}))?;
    let items = hub_server::readiness::check(target).await?;
    Ok(Json(
        json!({"device_id": id, "output": output, "items": items}),
    ))
}
/// A device's desktop, live, for the page's screen view. Frames are captured only while someone
/// is watching: the capture loop belongs to this one connection and dies with it.
async fn screen_ws(
    State(h): State<Shared>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let device = h
        .devices()
        .into_iter()
        .find(|d| d.id == id)
        .context("Device not found")?;
    Ok(ws.on_upgrade(move |socket| stream_screen(device.target, socket)))
}
/// How a video relay ended.
enum Relay {
    /// The page went away: nothing more to do.
    Left,
    /// The stream stopped after it had started; the page reconnects.
    Ended,
    /// No picture ever came (no Screen Recording grant, say): fall back to screenshots.
    Never,
}
/// Passes a Cua Spaces media socket through to the page: `M video`, then each packet as it is.
async fn relay_video(mut view: hub_server::spaces::View, socket: &mut WebSocket) -> Relay {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message as Media;
    let mut started = false;
    let mut heartbeat = heartbeat();
    let patience = tokio::time::sleep(std::time::Duration::from_secs(6));
    tokio::pin!(patience);
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if socket.send(Message::Text("H".into())).await.is_err() { return Relay::Left; }
            },
            _ = &mut patience, if !started => return Relay::Never,
            packet = view.socket.next() => match packet {
                Some(Ok(Media::Binary(bytes))) => {
                    if !started {
                        started = true;
                        if socket.send(Message::Text("M video".into())).await.is_err() { return Relay::Left; }
                    }
                    if socket.send(Message::Binary(bytes)).await.is_err() { return Relay::Left; }
                },
                Some(Ok(Media::Text(text))) => {
                    // Control: only a refusal is worth keeping.
                    if text.contains("\"type\":\"error\"") {
                        tracing::warn!("cua-spacesd media: {}", text.chars().take(300).collect::<String>());
                    }
                },
                Some(Ok(Media::Close(_))) | Some(Err(_)) | None => {
                    return if started { Relay::Ended } else { Relay::Never };
                },
                Some(Ok(_)) => {},
            },
            input = socket.recv() => match input {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Relay::Left,
                _ => {}
            },
        }
    }
}
async fn stream_screen(target: Option<String>, mut socket: WebSocket) {
    // Video from Cua Spaces where the device has it; screenshots through cua-driver where not.
    if let Some(token) = hub_server::spaces::token(target.as_deref()).await {
        match hub_server::spaces::open(target.as_deref(), &token).await {
            Ok(view) => match relay_video(view, &mut socket).await {
                Relay::Left | Relay::Ended => return,
                Relay::Never => tracing::warn!("cua-spacesd sent no picture; showing screenshots"),
            },
            Err(error) => {
                tracing::warn!("cua-spacesd view unavailable ({error:#}); showing screenshots")
            }
        }
    }
    if socket.send(Message::Text("M frames".into())).await.is_err() {
        return;
    }
    let mut feed = match terminal::screen_feed(target.as_deref()) {
        Ok(feed) => feed,
        Err(error) => {
            let _ = socket
                .send(Message::Text(format!("E {error}").into()))
                .await;
            return;
        }
    };
    let (Some(stdout), Some(stderr)) = (feed.stdout.take(), feed.stderr.take()) else {
        return;
    };
    let mut frames = BufReader::with_capacity(1 << 20, stdout).lines();
    let mut errors = BufReader::new(stderr).lines();
    let mut errors_open = true;
    let mut heartbeat = heartbeat();
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if socket.send(Message::Text("H".into())).await.is_err() { break; }
            },
            line = frames.next_line() => {
                let Ok(Some(line)) = line else {
                    let _ = socket.send(Message::Text("E The screen feed from this machine stopped.".into())).await;
                    break;
                };
                let message = if let Some(frame) = line.strip_prefix("F ") {
                    frame
                        .split_once(' ')
                        .and_then(|(_, data)| B64.decode(data).ok())
                        .map(|bytes| Message::Binary(bytes.into()))
                } else if line.starts_with("E ") {
                    Some(Message::Text(line.into()))
                } else {
                    None
                };
                if let Some(message) = message && socket.send(message).await.is_err() { break; }
            },
            line = errors.next_line(), if errors_open => match line {
                // Tailscale's identity check and SSH refusals arrive here, before any frame.
                Ok(Some(line)) => {
                    let note = hub_server::ssh::auth_url(&line)
                        .map(|url| format!("E Tailscale needs a sign-in before this machine can be reached: {url}"))
                        .or_else(|| terminal::rejected_before_command(&line).then(|| format!("E {line}")));
                    if let Some(note) = note && socket.send(Message::Text(note.into())).await.is_err() { break; }
                },
                _ => errors_open = false,
            },
            input = socket.recv() => match input {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
        }
    }
    let _ = feed.kill().await;
}
async fn terminal_history(
    State(h): State<Shared>,
    Path(id): Path<String>,
) -> Api<terminal::History> {
    let (_, device) = h.session(&id)?;
    Ok(Json(
        terminal::history(&id, device.target.as_deref()).await?,
    ))
}
async fn stream_terminal(
    h: Shared,
    id: String,
    t: Arc<Terminal>,
    mut rx: broadcast::Receiver<Vec<u8>>,
    mut socket: WebSocket,
) {
    let view = uuid::Uuid::new_v4().to_string();
    let mut heartbeat = heartbeat();
    let mut geometry = t.geometry();
    let (cols, rows) = *geometry.borrow_and_update();
    let _ = socket
        .send(Message::Text(
            json!({"type":"geometry", "cols":cols, "rows":rows})
                .to_string()
                .into(),
        ))
        .await;
    if let Ok((_, d)) = h.session(&id)
        && let Ok(screen) = terminal::capture(&id, d.target.as_deref()).await
    {
        let _ = socket
            .send(Message::Text(
                format!("\x1b[2J\x1b[H{}", screen.replace('\n', "\r\n")).into(),
            ))
            .await;
    }
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if socket.send(Message::Binary(Default::default())).await.is_err() { break; }
            },
            changed = geometry.changed() => {
                if changed.is_err() { break; }
                let (cols, rows) = *geometry.borrow_and_update();
                let update = json!({"type": "geometry", "cols": cols, "rows": rows});
                if socket.send(Message::Text(update.to_string().into())).await.is_err() { break; }
            },
            output = rx.recv() => match output {
                Ok(data) => {
                    if socket.send(Message::Binary(data.into())).await.is_err() { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = socket.close().await;
                    break;
                }
                Err(_) => break,
            },
            input = socket.recv() => match input {
                Some(Ok(Message::Text(text))) => if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    if value["type"] == "resize" {
                        let cols = value["cols"].as_u64().unwrap_or(120).clamp(20, 400) as u16;
                        let rows = value["rows"].as_u64().unwrap_or(32).clamp(5, 150) as u16;
                        let active = value["active"].as_bool().unwrap_or(true);
                        let _ = t.size_view(&view, cols, rows, active);
                    }
                    if value["type"] == "input"
                        && let Err(error) = write_terminal(&h, &id, value["data"].as_str().unwrap_or(""), "user").await
                    {
                        let _ = h.record("session.error", &id, json!({"error": error.to_string()}));
                    }
                },
                Some(Ok(Message::Ping(data))) => { let _ = socket.send(Message::Pong(data)).await; }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
    let _ = t.remove_view(&view);
}
/// Browsers cannot see WebSocket pings, so an empty binary frame proves the
/// connection is alive. Clients reconnect after missing a few of these.
fn heartbeat() -> tokio::time::Interval {
    let period = std::time::Duration::from_secs(15);
    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval
}
async fn event_ws(State(h): State<Shared>, ws: WebSocketUpgrade) -> Response {
    let mut rx = h.events.subscribe();
    ws.on_upgrade(move |mut socket| async move {
        let mut heartbeat = heartbeat();
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if socket.send(Message::Binary(Default::default())).await.is_err() { break; }
                },
                event = rx.recv() => match event {
                    Ok(event) => {
                        if event.kind != "terminal.output" {
                            let message = Message::Text(serde_json::to_string(&event).unwrap().into());
                            if socket.send(message).await.is_err() { break; }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // A reconnect reloads the durable snapshot before new events.
                        let _ = socket.close().await;
                        break;
                    }
                    Err(_) => break,
                },
                message = socket.recv() => match message {
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    _ => {}
                },
            }
        }
    })
}
async fn new_chat(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Chat> {
    Ok(Json(create_chat(&h, &p, None)?))
}
fn create_chat(h: &Shared, p: &Value, parent_id: Option<String>) -> Result<Chat> {
    let agent = p
        .get("agent")
        .filter(|value| !value.is_null())
        .map(|value| -> Result<AgentSession> {
            let agent: AgentSession = serde_json::from_value(value.clone())?;
            if !matches!(agent.provider.as_str(), "codex" | "copilot" | "claude") {
                bail!("Choose Codex, Copilot or Claude");
            }
            if !h.devices().iter().any(|d| d.id == agent.device_id) {
                bail!("Device not found");
            }
            if !agent.cwd.starts_with('/') || agent.cwd.contains('\0') || agent.cwd.len() > 4096 {
                bail!("Use an absolute project directory");
            }
            if agent
                .native_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 256)
            {
                bail!("Invalid native session ID");
            }
            Ok(agent)
        })
        .transpose()?;
    let coordinator_provider = p
        .get("coordinator_provider")
        .map(|v| v.as_str().unwrap_or(""))
        .unwrap_or("claude");
    if !matches!(coordinator_provider, "codex" | "claude") {
        bail!("Choose Codex or Claude for the coordinator");
    }
    if agent.is_some() && p.get("coordinator_provider").is_some() {
        bail!("Coordinator backend is only valid for coordinator conversations");
    }
    let chat = Chat {
        coordinator_provider: coordinator_provider.into(),
        id: uuid::Uuid::new_v4().to_string(),
        name: p["name"]
            .as_str()
            .unwrap_or("New conversation")
            .chars()
            .take(100)
            .collect(),
        created_at: chrono::Utc::now().to_rfc3339(),
        title_generated: p["name"].as_str().is_some_and(|s| !s.trim().is_empty()),
        agent,
        parent_id,
        ..Default::default()
    };
    h.record("chat.created", &chat.id, serde_json::to_value(&chat)?)?;
    Ok(chat)
}
async fn close_terminal(h: &Shared, id: &str) -> Result<()> {
    // Serialize with attachments so a reconnect cannot recreate a shell after
    // it was killed but before the closed event is committed.
    let _operation = h.terminal_operation(id).lock_owned().await;
    let session = h
        .sessions()
        .into_iter()
        .find(|s| s.id == id)
        .context("Terminal not found")?;
    if session.closed && !session.cleanup_pending {
        return Ok(());
    }
    let attached = h.terminals.lock().await.contains_key(id);
    if attached || h.terminal_may_have_shell(id) {
        let device = h
            .devices()
            .into_iter()
            .find(|d| d.id == session.device_id)
            .context("Device not found")?;
        terminal::close(id, device.target.as_deref()).await?;
    }
    h.record("session.closed", id, json!({}))?;
    if let Some(live) = h.terminals.lock().await.remove(id) {
        live.terminal.disconnect();
    }
    h.attached_ids.lock().unwrap().remove(id);
    Ok(())
}

// Close intent is durable and independent of device reachability. Retry only
// shutdown: never attach or recreate a terminal that the user has closed.
async fn cleanup_terminals(h: &Shared) {
    let mut tasks = tokio::task::JoinSet::new();
    for session in h.sessions().into_iter().filter(|s| s.cleanup_pending) {
        let h = h.clone();
        tasks.spawn(async move {
            if let Err(error) = close_terminal(&h, &session.id).await {
                let error = error.to_string();
                if session.cleanup_error.as_deref() != Some(error.as_str()) {
                    let _ = h.record(
                        "session.cleanup_failed",
                        &session.id,
                        json!({"error":error}),
                    );
                }
            }
        });
        if tasks.len() >= 8 {
            let _ = tasks.join_next().await;
        }
    }
    while tasks.join_next().await.is_some() {}
}

async fn terminal_cleanup(h: Shared) {
    loop {
        cleanup_terminals(&h).await;
        tokio::select! {
            _ = h.terminal_cleanup.notified() => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {},
        }
    }
}

async fn close_chat(h: &Shared, id: &str) -> Result<Vec<String>> {
    if let Some(chat) = h.chats().into_iter().find(|c| c.id == id && c.closed) {
        return Ok(chat.session_ids);
    }
    {
        // Publish the close intent before waiting on in-flight SSH work. New
        // messages and terminal allocations cannot slip in during shutdown.
        let mut running = h.running.lock().unwrap();
        h.record("chat.closing", id, json!({}))?;
        if let Some(handle) = running.remove(id) {
            handle.abort();
            h.record(
                "agent.stopped",
                id,
                json!({"text":"Session closing. Stopping its terminals."}),
            )?;
        }
    }
    let _lifecycle = h.terminal_lifecycle.lock().await;
    let chat = h
        .chats()
        .into_iter()
        .find(|c| c.id == id)
        .context("Conversation not found")?;
    for terminal in h
        .sessions()
        .into_iter()
        .filter(|s| !s.closed && chat.session_ids.contains(&s.id))
    {
        // A known failed allocation needs no SSH at all. If a connection is
        // in flight, retain cleanup intent until it releases its operation lock.
        let operation = h.terminal_operation(&terminal.id).try_lock_owned().ok();
        let needs_cleanup = operation.is_none() || h.terminal_may_have_shell(&terminal.id);
        h.record(
            if needs_cleanup {
                "session.close_requested"
            } else {
                "session.closed"
            },
            &terminal.id,
            json!({"chat_id":id}),
        )?;
        if let Some(live) = h.terminals.lock().await.remove(&terminal.id) {
            live.terminal.disconnect();
        }
        h.attached_ids.lock().unwrap().remove(&terminal.id);
    }
    h.record("chat.closed", id, json!({}))?;
    h.terminal_cleanup.notify_one();
    Ok(chat.session_ids)
}

async fn chat_action(
    State(h): State<Shared>,
    Path((id, action)): Path<(String, String)>,
    Json(p): Json<Value>,
) -> Api<Value> {
    let thread = h
        .chats()
        .iter()
        .find(|c| c.id == id)
        .context("Conversation not found")?
        .thread;
    match action.as_str() {
        "close" => {
            if thread && main_thread(&h.chats()).as_deref() == Some(id.as_str()) {
                bail_api("The first thread is permanent and cannot be closed")?;
            }
            // Finish shutdown even if the initiating browser disconnects.
            let h2 = h.clone();
            let closed = tokio::spawn(async move { close_chat(&h2, &id).await }).await??;
            let pending: Vec<_> = h
                .sessions()
                .into_iter()
                .filter(|s| s.cleanup_pending && closed.contains(&s.id))
                .map(|s| s.id)
                .collect();
            return Ok(Json(
                json!({"ok":true,"closed_terminals":closed,"pending_terminals":pending}),
            ));
        }
        "reopen" => {
            let _lifecycle = h.terminal_lifecycle.lock().await;
            let current = h
                .chats()
                .into_iter()
                .find(|c| c.id == id)
                .context("Conversation not found")?;
            if current.closing {
                bail_api("Wait for the session to finish closing")?;
            }
            if current.closed {
                h.record("chat.reopened", &id, json!({}))?;
            }
        }
        "terminals" => {
            let _lifecycle = h.terminal_lifecycle.lock().await;
            h.link_terminal(&id, p["session_id"].as_str().context("Terminal required")?)?;
        }
        _ => bail_api("Unknown conversation action")?,
    }
    Ok(Json(json!({"ok":true})))
}
async fn send_message(
    State(h): State<Shared>,
    Path(id): Path<String>,
    Json(p): Json<Value>,
) -> Api<Value> {
    start_turn(&h, &id, &p, None)
}
fn start_turn(h: &Shared, id: &str, p: &Value, view_action: Option<Value>) -> Api<Value> {
    if !h
        .chats()
        .iter()
        .any(|c| c.id == id && !c.closed && !c.closing)
    {
        bail_api("Conversation not found")?;
    }
    let text = p["text"].as_str().context("Message required")?.trim();
    if text.is_empty() || text.len() > 64000 {
        bail_api("Message must contain 1–64000 characters")?;
    }
    let mut running = h.running.lock().unwrap();
    if !h
        .chats()
        .iter()
        .any(|c| c.id == id && !c.closed && !c.closing)
    {
        bail_api("Conversation not found or closed")?;
    }
    if running.contains_key(id) {
        bail_api("The agent is already working in this conversation")?;
    }
    let mut message = json!({"text":text});
    if let Some(action) = view_action {
        message["view_action"] = action;
    }
    let run = h.record("message.user", id, message)?.id;
    let h2 = h.clone();
    let id2 = id.to_owned();
    let text = text.to_owned();
    let task = tokio::spawn(async move {
        let mut recalled = Vec::new();
        let result = async {
            let items = recall(&h2, &id2, &text).await?;
            recalled = items
                .iter()
                .filter(|item| item["kind"] == "claim")
                .filter_map(|item| item["id"].as_u64())
                .collect();
            h2.record("agent.started", &id2, json!({}))?;
            agent_turn(&h2, &id2, items).await
        }
        .await;
        if let Err(e) = result {
            let _ = h2.record("agent.error", &id2, json!({"text":e.to_string()}));
        }
        let _ = h2.record("agent.finished", &id2, json!({}));
        h2.running.lock().unwrap().remove(&id2);
        if h2
            .chats()
            .iter()
            .any(|c| c.id == id2 && (c.thread || c.parent_id.is_some()))
        {
            tokio::spawn(consolidate(h2.clone(), id2, run, recalled));
        }
    });
    running.insert(id.to_owned(), task.abort_handle());
    Ok(Json(json!({"ok":true})))
}
/// The conversation events a turn's context is built from.
fn context_events(h: &Shared, id: &str) -> Vec<Event> {
    h.history()
        .into_iter()
        .filter(|e| {
            e.scope == id
                && ["message.user", "message.assistant", "tool.result"].contains(&e.kind.as_str())
        })
        .collect()
}
/// Search memory for the user's message within about 1.5 seconds and record
/// what was found before the turn starts. Without a query vector in time,
/// text matches stand alone.
async fn recall(h: &Shared, id: &str, text: &str) -> Result<Vec<Value>> {
    let started = std::time::Instant::now();
    let query: String = text.chars().take(2000).collect();
    let vector = tokio::time::timeout(
        std::time::Duration::from_millis(1400),
        h.embedder.query(&query),
    )
    .await
    .ok()
    .and_then(Result::ok);
    let mode = if vector.is_some() { "hybrid" } else { "text" };
    // A chat's context window is its last 100 conversation events.
    let window = context_events(h, id)
        .iter()
        .rev()
        .nth(99)
        .map_or(0, |e| e.id);
    let (store, scope, q) = (h.clone(), id.to_owned(), query.clone());
    let items = tokio::task::spawn_blocking(move || {
        store
            .store
            .lock()
            .unwrap()
            .recall(&q, vector.as_deref(), &scope, window)
    })
    .await??;
    if !items.is_empty() {
        h.record(
            "memory.recalled",
            id,
            json!({"query":query,"mode":mode,"ms":started.elapsed().as_millis() as u64,"items":items}),
        )?;
    }
    Ok(items)
}
/// Distil a finished turn into claims in the background, one turn at a time.
async fn consolidate(h: Shared, id: String, run: u64, recalled: Vec<u64>) {
    let _queue = h.consolidation.lock().await;
    if let Err(error) = write_memory(&h, &id, run, &recalled).await {
        let _ = h.record(
            "memory.error",
            &id,
            json!({"error":error.to_string(),"run_id":run}),
        );
    }
}
async fn write_memory(h: &Shared, id: &str, run: u64, recalled: &[u64]) -> Result<()> {
    let chat = h
        .chats()
        .into_iter()
        .find(|c| c.id == id)
        .context("Conversation not found")?;
    let turn = h.store.lock().unwrap().turn_digest(run)?;
    let query: String = turn["user"]["text"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(2000)
        .collect();
    let vector = embedding::query(h, &query).await;
    let active = h
        .store
        .lock()
        .unwrap()
        .supersedable(&query, vector.as_deref(), recalled)?;
    let mut child = tokio::process::Command::new(h.root.join("agent/.venv/bin/python"))
        .arg("-u")
        .arg(h.root.join("agent/consolidate.py"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("Memory runtime missing. Run uv sync --project agent.")?;
    // In a strand the "user" message is the coordinator's brief to a worker, not the owner's
    // words. A loaded session is the exception: the owner had that conversation themselves.
    let speaker = if chat.parent_id.is_some() && !chat.loaded {
        "coordinator"
    } else {
        "owner"
    };
    let date = chrono::Utc::now().format("%-d %b %Y").to_string();
    let input =
        json!({"chat":chat.name,"speaker":speaker,"date":date,"turn":turn,"active_claims":active});
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(format!("{input}\n").as_bytes()).await?;
    drop(stdin);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        child.wait_with_output(),
    )
    .await
    .context("Memory consolidation timed out")??;
    let reply: Option<Value> = serde_json::from_slice(&output.stdout).ok();
    if !output.status.success() {
        bail!(
            "{}",
            reply
                .as_ref()
                .and_then(|r| r["error"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(500)
                    .collect())
        );
    }
    let claims: Vec<hub_server::claims::NewClaim> = serde_json::from_value(
        reply.context("Memory consolidation returned invalid JSON")?["claims"].take(),
    )
    .context("Memory consolidation returned invalid claims")?;
    if claims.is_empty() {
        return Ok(());
    }
    let written = h
        .store
        .lock()
        .unwrap()
        .write_claims(&chat.id, &chat.name, claims)?;
    h.record("memory.written", &chat.id, json!({"claims":written}))?;
    Ok(())
}
async fn claim_action(
    State(h): State<Shared>,
    Path((id, action)): Path<(u64, String)>,
) -> Api<Value> {
    if !matches!(action.as_str(), "wrong" | "restore") {
        bail_api("Unknown claim action")?;
    }
    let wrong = action == "wrong";
    let claim = h.store.lock().unwrap().mark_claim(id, wrong)?;
    h.record(
        if wrong {
            "memory.retracted"
        } else {
            "memory.restored"
        },
        &claim.scope,
        json!({"id":id,"text":claim.text}),
    )?;
    Ok(Json(json!({"ok":true,"id":id,"state":claim.state})))
}
async fn stop_agent(State(h): State<Shared>, Path(id): Path<String>) -> Api<Value> {
    if let Some(handle) = h.running.lock().unwrap().remove(&id) {
        handle.abort();
        h.record(
            "agent.stopped",
            &id,
            json!({"text":"Agent stopped. Existing terminal processes continue running."}),
        )?;
    }
    Ok(Json(json!({"ok":true})))
}
struct AgentGroup(u32, bool);
impl Drop for AgentGroup {
    fn drop(&mut self) {
        let pid = nix::unistd::Pid::from_raw(self.0 as i32);
        if self.1 {
            // Give the SDK time to interrupt the remote CLI and close SSH.
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGUSR1);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let _ = nix::sys::signal::killpg(pid, nix::sys::signal::Signal::SIGTERM);
            });
        } else {
            let _ = nix::sys::signal::killpg(pid, nix::sys::signal::Signal::SIGTERM);
        }
    }
}
/// Cuts every long string inside a value down to `max` characters, saying how much was left out.
/// What an agent reads back (a strand's history, its own thread) must not carry whole files,
/// window dumps or pictures: one of those can fill the model's context by itself.
fn slim(value: &mut Value, max: usize) {
    match value {
        Value::String(text) if text.len() > max => {
            let kept: String = text.chars().take(max).collect();
            let left = text.chars().count().saturating_sub(max);
            if left > 0 {
                *text = format!("{kept} [and {left} more characters, left out]");
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| slim(item, max)),
        Value::Object(fields) => fields.values_mut().for_each(|field| slim(field, max)),
        _ => {}
    }
}
async fn agent_turn(h: &Shared, id: &str, recall: Vec<Value>) -> Result<()> {
    let access = agent_api::Access::new(h, id);
    let conversation = h
        .chats()
        .into_iter()
        .find(|c| c.id == id)
        .context("Conversation not found")?;
    let execution = if let Some(agent) = &conversation.agent {
        let device = h
            .devices()
            .into_iter()
            .find(|d| d.id == agent.device_id)
            .context("Device not found")?;
        if agent.provider == "claude" && device.target.is_some() {
            hub_server::ssh::with_auth(
                Arc::new(ToolSshAuth {
                    hub: h.clone(),
                    chat: id.into(),
                }),
                terminal::run(device.target.as_deref(), "true"),
            )
            .await?;
        }
        json!({"target":device.target, "mcp_token":access.token})
    } else {
        json!({})
    };

    let mut history = context_events(h, id);
    for event in &mut history {
        slim(&mut event.payload, 6000);
    }
    let claude = conversation
        .agent
        .as_ref()
        .map(|a| a.provider.as_str())
        .unwrap_or(&conversation.coordinator_provider)
        == "claude";
    let mut child = tokio::process::Command::new(h.root.join("agent/.venv/bin/python"))
        .arg("-u")
        .arg(h.root.join("agent/worker.py"))
        .env("HUB_URL", format!("http://127.0.0.1:{}", h.port))
        .env("HUB_TOKEN", h.token.as_deref().unwrap_or(""))
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(!claude)
        .spawn()
        .context("Agent runtime missing. Run uv sync --project agent.")?;
    let mut process_group = AgentGroup(child.id().context("Agent process has no PID")?, claude);
    let mut stdin = child.stdin.take().unwrap();
    let task = json!({
        "chat_id": id,
        "needs_title": !conversation.title_generated,
        "execution": execution,
        "conversation": conversation,
        "project": h.project_of(id),
        "history": history,
        "recall": recall,
        "devices": h.devices(),
        "discovery": h.discovery.lock().unwrap().clone(),
        "sessions": h.chat_terminals(id),
    });
    stdin.write_all(format!("{task}\n").as_bytes()).await?;
    drop(stdin);
    let stderr = child.stderr.take().unwrap();
    let errors = tokio::spawn(async move {
        let mut r = BufReader::new(stderr).lines();
        let mut text = String::new();
        while let Ok(Some(l)) = r.next_line().await {
            if text.len() < 4000 {
                text.push_str(&l);
                text.push('\n');
            }
        }
        text
    });
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    // The worker says why it failed before it exits; its exit is then not a second failure.
    let mut explained = false;
    while let Some(line) = lines.next_line().await? {
        let frame: Value = serde_json::from_str(&line).context("Invalid agent response")?;
        explained |= frame["type"] == "error";
        if frame["type"] == "title" {
            if h.chats().iter().any(|c| c.id == id && !c.title_generated)
                && let Some(name) = frame["name"].as_str().and_then(conversations::clean_title)
            {
                h.record("chat.renamed", id, json!({"name":name}))?;
            }
            continue;
        }
        let kind = match frame["type"].as_str() {
            Some("message") => "message.assistant",
            Some("message.started") => "message.started",
            Some("message.delta") => "message.delta",
            Some("error") => "agent.error",
            Some("status") => "agent.status",
            Some("session") => "agent.session",
            Some("restarted") => "agent.restarted",
            Some("tool.started") => "tool.started",
            Some("tool.output") => "tool.output",
            Some("tool.result") => "tool.result",
            _ => continue,
        };
        h.record(kind, id, frame)?;
    }
    let status = child.wait().await?;
    process_group.1 = false;
    let errors = errors.await.unwrap_or_default();
    if !status.success() && !explained {
        bail!(
            "Agent worker exited: {}",
            errors.chars().take(1500).collect::<String>()
        );
    }
    Ok(())
}
async fn tool(State(h): State<Shared>, Json(p): Json<Value>) -> Api<Value> {
    let scope = p["chat_id"].as_str().context("Conversation required")?;
    let name = p["name"].as_str().context("Tool name required")?;
    let args = &p["arguments"];
    {
        let _lifecycle = h.terminal_lifecycle.lock().await;
        if !h.running.lock().unwrap().contains_key(scope)
            || !h
                .chats()
                .iter()
                .any(|c| c.id == scope && !c.closed && !c.closing)
        {
            bail_api("This conversation has no active agent")?;
        }
        h.record("tool.started", scope, json!({"name":name,"arguments":args}))?;
    }
    let result = hub_server::ssh::with_auth(
        Arc::new(ToolSshAuth {
            hub: h.clone(),
            chat: scope.into(),
        }),
        execute_tool(&h, scope, name, args),
    )
    .await;
    let response = match result {
        Ok(v) => json!({"ok":true,"result":v}),
        Err(e) => json!({"ok":false,"error":e.to_string()}),
    };
    h.record(
        "tool.result",
        scope,
        json!({"name":name,"arguments":args,"result":response}),
    )?;
    Ok(Json(response))
}

struct ToolSshAuth {
    hub: Shared,
    chat: String,
}
impl hub_server::ssh::AuthObserver for ToolSshAuth {
    fn required(&self, target: &str, url: &str) -> Result<String> {
        let request = uuid::Uuid::new_v4().to_string();
        self.hub.record("agent.requested", &self.chat, json!({
            "request_id":request,"kind":"tailscale_auth","title":format!("Sign in to connect to {target}"),
            "detail":"Tailscale needs you to verify your identity again. Open the sign-in link below. This connection will continue automatically after approval.",
            "auth_url":url,"options":[{"id":"cancel","label":"Cancel connection"}]
        }))?;
        Ok(request)
    }
    fn cancelled(&self, request: &str) -> bool {
        !self.hub.running.lock().unwrap().contains_key(&self.chat)
            || self
                .hub
                .chats()
                .iter()
                .any(|c| c.id == self.chat && (c.closed || c.closing))
            || self.hub.history().iter().any(|e| {
                e.scope == self.chat
                    && e.kind == "agent.answered"
                    && e.payload["request_id"] == request
                    && e.payload["answer"]["choice"] == "cancel"
            })
    }
    fn resolved(&self, request: &str, outcome: &str) {
        let _input = self.hub.input_lock.lock().unwrap();
        if hub_server::requests::pending(&self.hub.history(), &self.chat, request).is_some() {
            let _ = self.hub.record(
                "agent.answered",
                &self.chat,
                json!({"request_id":request,"answer":{"choice":outcome}}),
            );
        }
    }
}
async fn execute_tool(h: &Shared, chat_id: &str, name: &str, args: &Value) -> Result<Value> {
    let id = args["session_id"].as_str().unwrap_or("");
    if matches!(
        name,
        "terminal_send" | "terminal_read" | "terminal_interrupt"
    ) {
        h.check_terminal_owner(chat_id, id)?;
    }
    match name {
        "show_ui" => {
            let _input = h.input_lock.lock().unwrap();
            let previous = hub_server::views::latest(
                &h.history(),
                chat_id,
                args["view_id"].as_str().unwrap_or(""),
            );
            let view = hub_server::views::update(previous.as_ref(), args)?;
            h.record("ui.updated", chat_id, view.clone())?;
            Ok(json!({"view_id":view["view_id"],"revision":view["revision"],"title":view["title"]}))
        }
        "list_devices" => Ok(serde_json::to_value(h.devices())?),
        "list_terminals" => Ok(serde_json::to_value(h.chat_terminals(chat_id))?),
        "show_image" => {
            let path = args["path"]
                .as_str()
                .context("Image path required")?
                .to_owned();
            let caption = args["caption"].as_str().unwrap_or("").to_owned();
            let device_id = args["device_id"].as_str().unwrap_or("local");
            let device = h
                .devices()
                .into_iter()
                .find(|d| d.id == device_id)
                .context("Device not found")?;
            let artifacts = h.store.lock().unwrap().artifacts.clone();
            let image = if let Some(target) = device.target {
                let bytes = terminal::read_image(&target, &path).await?;
                tokio::task::spawn_blocking(move || {
                    artifacts.save(&bytes, &caption, Some(&path), Some(&device.id))
                })
                .await??
            } else {
                tokio::task::spawn_blocking(move || artifacts.local(&path, &caption)).await??
            };
            Ok(json!({"images":[image], "displayed":true}))
        }
        "open_terminal" => Ok(serde_json::to_value(
            open_terminal(h, args, Some(chat_id)).await?,
        )?),
        "terminal_send" => {
            write_terminal(
                h,
                id,
                args["text"].as_str().context("text required")?,
                "agent",
            )
            .await?;
            Ok(json!({"sent":true}))
        }
        "terminal_read" => {
            let (_, d) = h.session(id)?;
            let text = terminal::capture(id, d.target.as_deref()).await?;
            Ok(json!({"output":text}))
        }
        "terminal_interrupt" => {
            write_terminal(h, id, "\u{3}", "agent").await?;
            Ok(json!({"interrupted":true}))
        }
        "wait" => {
            tokio::time::sleep(std::time::Duration::from_secs(
                args["seconds"].as_u64().unwrap_or(2).min(10),
            ))
            .await;
            Ok(json!({"waited":true}))
        }
        "list_agents" => Ok(
            json!({"agents": h.chats().into_iter().filter(|c| c.agent.is_some() && !c.closed).map(|chat| {
            let running = h.running.lock().unwrap().contains_key(&chat.id);
            json!({"chat":chat,"running":running})
        }).collect::<Vec<_>>() }),
        ),
        "read_agent" => {
            let target = args["chat_id"].as_str().context("Session required")?;
            let chat = h
                .chats()
                .into_iter()
                .find(|c| c.id == target && c.agent.is_some())
                .context("Agent session not found")?;
            let mut events: Vec<_> = h
                .history()
                .into_iter()
                .filter(|e| {
                    e.scope == target
                        && !matches!(
                            e.kind.as_str(),
                            "message.started" | "message.delta" | "tool.output"
                        )
                })
                .rev()
                .take(40)
                .collect();
            events.reverse();
            // What was said is read whole (within reason); what tools returned is cut short.
            for event in &mut events {
                let said = event.kind.starts_with("message.");
                slim(&mut event.payload, if said { 24_000 } else { 2000 });
            }
            Ok(
                json!({"chat":chat,"running":h.running.lock().unwrap().contains_key(target),"events":events}),
            )
        }
        "stop_agent" => {
            if h.chats()
                .iter()
                .find(|c| c.id == chat_id)
                .is_none_or(|c| c.agent.is_some())
            {
                bail!("Only the coordinator can stop delegated agents")
            }
            let target = args["chat_id"].as_str().context("Agent session required")?;
            if !h
                .chats()
                .iter()
                .any(|c| c.id == target && c.agent.is_some())
            {
                bail!("Native agent session not found")
            }
            Ok(stop_agent(State(h.clone()), Path(target.into()))
                .await
                .map_err(|e| e.0)?
                .0)
        }
        "start_agent" | "send_agent" => {
            if h.chats()
                .into_iter()
                .find(|c| c.id == chat_id)
                .is_none_or(|c| c.agent.is_some())
            {
                bail!("Only the coordinator can delegate sessions");
            }
            let (chat, text) = if name == "start_agent" {
                let prompt = args["prompt"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 64000)
                    .context("Provide the work to do")?;
                let child = create_chat(
                    h,
                    &json!({"name":args["name"],"agent":{"provider":args["provider"],"device_id":args["device_id"],"cwd":args["cwd"]}}),
                    Some(chat_id.into()),
                )?;
                (child, prompt)
            } else {
                let target = args["chat_id"].as_str().context("Session required")?;
                let chat = h
                    .chats()
                    .into_iter()
                    .find(|c| c.id == target && c.agent.is_some())
                    .context("Agent session not found")?;
                (chat, args["text"].as_str().context("Message required")?)
            };
            let _ = send_message(
                State(h.clone()),
                Path(chat.id.clone()),
                Json(json!({"text":text})),
            )
            .await
            .map_err(|e| e.0)?;
            Ok(json!({"chat":chat,"started":true}))
        }
        "read_memory_run" => {
            let id = args["run_id"].as_u64().context("Run ID required")?;
            h.store.lock().unwrap().memory_run(
                id,
                args["anchor"].as_u64(),
                args["offset"].as_u64().map(|v| v as usize),
            )
        }
        "search_memory" => {
            let q = args["query"].as_str().context("query required")?;
            let v = embedding::query(h, q).await;
            Ok(serde_json::to_value(
                h.store.lock().unwrap().search(q, v.as_deref())?,
            )?)
        }
        _ => bail!("Unknown tool: {name}"),
    }
}
#[derive(Deserialize)]
struct Search {
    q: String,
}
async fn search(State(h): State<Shared>, Query(q): Query<Search>) -> Api<Value> {
    if q.q.trim().is_empty() {
        return Ok(Json(json!({"results":[],"semantic":false})));
    }
    let (v, pending) = h.embedder.search_query(q.q.trim()).await;
    let hits = h.store.lock().unwrap().search(&q.q, v.as_deref())?;
    Ok(Json(
        json!({"results":hits,"semantic":v.is_some(),"semantic_pending":pending}),
    ))
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct MemoryQuery {
    q: String,
    kind: String,
    mode: String,
    node: Option<u64>,
    anchor: Option<u64>,
    offset: Option<usize>,
}
async fn memory_search(State(h): State<Shared>, Query(q): Query<MemoryQuery>) -> Api<Value> {
    if q.q.len() > 512 {
        bail_api("Search is limited to 512 bytes")?;
    }
    let kind = if q.kind.is_empty() { "all" } else { &q.kind };
    if ![
        "all", "raw", "message", "tool", "terminal", "system", "claim",
    ]
    .contains(&kind)
    {
        bail_api("Unknown source filter")?;
    }
    if !["", "text", "hybrid"].contains(&q.mode.as_str()) {
        bail_api("Unknown search mode")?;
    }
    let started = std::time::Instant::now();
    let (vector, pending) = if q.mode == "hybrid" && !q.q.trim().is_empty() {
        h.embedder.search_query(q.q.trim()).await
    } else {
        (None, false)
    };
    let warning = if pending {
        Some("Finding semantic matches… Text results are available now.")
    } else if q.mode == "hybrid" && !q.q.trim().is_empty() && vector.is_none() {
        Some("Semantic search is unavailable. Showing text matches.")
    } else if vector.is_some() && h.embedding_status.lock().unwrap().as_str() == "indexing" {
        Some("Memory is being reindexed. Semantic matches currently cover the completed portion.")
    } else {
        None
    };
    let kind = kind.to_owned();
    let mut response = tokio::task::spawn_blocking(move || {
        h.store.lock().unwrap().memory_search(
            &q.q,
            &kind,
            q.offset.unwrap_or(0).min(1_000_000),
            vector.as_deref(),
        )
    })
    .await??;
    response["elapsed_ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    response["warning"] = json!(warning);
    response["semantic_pending"] = json!(pending);
    Ok(Json(response))
}
async fn memory_graph(State(h): State<Shared>, Query(q): Query<MemoryQuery>) -> Api<Value> {
    let started = std::time::Instant::now();
    let mut response = tokio::task::spawn_blocking(move || {
        h.store
            .lock()
            .unwrap()
            .memory_graph(q.node, q.offset.unwrap_or(0).min(1_000_000))
    })
    .await??;
    response["elapsed_ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    Ok(Json(response))
}
async fn memory_element(
    State(h): State<Shared>,
    Path((kind, id)): Path<(String, u64)>,
) -> Api<Value> {
    Ok(Json(
        tokio::task::spawn_blocking(move || h.store.lock().unwrap().memory_element(&kind, id))
            .await??,
    ))
}
async fn memory_run(
    State(h): State<Shared>,
    Path(id): Path<u64>,
    Query(q): Query<MemoryQuery>,
) -> Api<Value> {
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            h.store.lock().unwrap().memory_run(id, q.anchor, q.offset)
        })
        .await??,
    ))
}
/// Whether an offered secret is the access token, in time that does not depend on where they
/// first differ: both are hashed, and every byte of the digests is compared.
fn is_token(token: &str, offered: Option<&str>) -> bool {
    use sha2::{Digest, Sha256};
    let Some(offered) = offered else {
        return false;
    };
    let (a, b) = (Sha256::digest(token), Sha256::digest(offered));
    a.iter()
        .zip(b.iter())
        .fold(0u8, |diff, (x, y)| diff | (x ^ y))
        == 0
}
async fn login(State(h): State<Shared>, Json(p): Json<Value>) -> Response {
    if h.token
        .as_deref()
        .is_none_or(|token| is_token(token, p["token"].as_str()))
    {
        let secure = std::env::var("HUB_PUBLIC_ORIGIN")
            .unwrap_or_default()
            .starts_with("https://");
        let cookie = format!(
            "gofer_token={}; HttpOnly; SameSite=Strict; Path=/{}",
            h.token.as_deref().unwrap_or("local"),
            if secure { "; Secure" } else { "" }
        );
        ([(header::SET_COOKIE, cookie)], Json(json!({"ok":true}))).into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Access token did not match"})),
        )
            .into_response()
    }
}
async fn guard(State(h): State<Shared>, req: axum::extract::Request, next: Next) -> Response {
    if let Some(chat) = req.uri().path().strip_prefix("/api/agent-mcp/") {
        // SSH reverse forwards have a different Host port. The short-lived,
        // conversation-scoped bearer is the only authentication accepted here.
        if !agent_api::authorized(&h, chat, req.headers()) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        return next.run(req).await;
    }
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !h.allowed_hosts.contains(host) {
        return (StatusCode::FORBIDDEN, "Unrecognized host").into_response();
    }
    if let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok())
    {
        let origin_host = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"));
        if origin_host != Some(host) {
            return (StatusCode::FORBIDDEN, "Cross-origin request rejected").into_response();
        }
    }
    if req.uri().path().starts_with("/api/")
        && req.uri().path() != "/api/login"
        && let Some(token) = &h.token
    {
        let bearer = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        let cookie = req
            .headers()
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|c| {
                c.split(';')
                    .map(str::trim)
                    .find_map(|v| v.strip_prefix("gofer_token="))
            });
        if !is_token(token, bearer) && !is_token(token, cookie) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"Sign in to Gofer"})),
            )
                .into_response();
        }
    }
    let is_app_metadata = matches!(
        req.uri().path(),
        "/build.json" | "/sw.js" | "/manifest.webmanifest"
    );
    let mut response = next.run(req).await;
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/html"));
    if is_html || is_app_metadata {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    response
}
/// The thread is the one permanent Claude coordinator conversation.
fn ensure_thread(hub: &Shared) -> Result<()> {
    if !hub.chats().iter().any(|c| c.thread) {
        let thread = Chat {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Thread".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            title_generated: true,
            coordinator_provider: "claude".into(),
            thread: true,
            ..Default::default()
        };
        hub.record("chat.created", &thread.id, serde_json::to_value(&thread)?)?;
    }
    Ok(())
}
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("hub_server=info,tower_http=info")
        .init();
    let root = std::env::var_os("HUB_ROOT")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let data = std::env::var_os("HUB_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(root.join("data"));
    let port = std::env::var("HUB_PORT")
        .unwrap_or("4318".into())
        .parse::<u16>()?;
    let bind = std::env::var("HUB_BIND").unwrap_or("127.0.0.1".into());
    let token = std::env::var("HUB_TOKEN").ok().filter(|s| !s.is_empty());
    if bind != "127.0.0.1" && token.as_ref().is_none_or(|s| s.len() < 32) {
        bail!("Set HUB_TOKEN to at least 32 characters before listening beyond localhost");
    }
    let mut allowed_hosts: HashSet<String> = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        "127.0.0.1:4317".into(),
        "localhost:4317".into(),
    ]
    .into_iter()
    .collect();
    if let Ok(origin) = std::env::var("HUB_PUBLIC_ORIGIN") {
        let url = reqwest::Url::parse(&origin)?;
        if let Some(host) = url.host_str() {
            allowed_hosts.insert(match url.port() {
                Some(p) => format!("{host}:{p}"),
                None => host.into(),
            });
        }
    }
    if let Ok(hosts) = std::env::var("HUB_ALLOWED_HOSTS") {
        allowed_hosts.extend(
            hosts
                .split(',')
                .map(str::trim)
                .filter(|host| !host.is_empty())
                .map(str::to_owned),
        );
    }
    let embedder = embedding::Embedder::from_env()?;
    let mut store = Store::open(&data.join("history.vg"))?;
    if store
        .prepare_embeddings(&embedder.profile(), embedder.dimensions())?
        .is_some()
    {
        tracing::info!(
            "Previous embedding index backed up; reindexing will resume in the background"
        );
    }
    let (events, _) = broadcast::channel(1024);
    let hub = Arc::new(Hub {
        store: Mutex::new(store),
        input_lock: Mutex::new(()),
        agent_tokens: Mutex::new(HashMap::new()),
        push: Mutex::new(hub_server::push::PushStore::open(&data.join("push.json"))?),
        events,
        terminals: AsyncMutex::new(HashMap::new()),
        terminal_operations: Mutex::new(HashMap::new()),
        attached_ids: Mutex::new(HashSet::new()),
        terminal_lifecycle: AsyncMutex::new(()),
        terminal_cleanup: Notify::new(),
        running: Mutex::new(HashMap::new()),
        consolidation: AsyncMutex::new(()),
        embedder,
        embedding_status: Mutex::new("starting".into()),
        discovery: Mutex::new(DiscoveryState::default()),
        discovery_lock: AsyncMutex::new(()),
        root: root.clone(),
        token,
        port,
        allowed_hosts,
    });
    tokio::spawn(push_api::deliver(hub.clone()));
    if hub.devices().is_empty() {
        hub.record(
            "device.saved",
            "local",
            serde_json::to_value(Device {
                id: "local".into(),
                name: "This machine".into(),
                target: None,
                status: "online".into(),
                source: "local".into(),
                ..Default::default()
            })?,
        )?;
    }
    ensure_thread(&hub)?;
    hub.migrate_terminal_ownership()?;
    tokio::spawn(terminal_cleanup(hub.clone()));
    for chat in hub.chats().into_iter().filter(|c| c.closing) {
        let h = hub.clone();
        tokio::spawn(async move {
            if let Err(error) = close_chat(&h, &chat.id).await {
                tracing::warn!("Could not finish closing session {}: {error}", chat.id);
            }
        });
    }
    // Interrupted decisions aren't replayed automatically: commands may already have run.
    let mut interrupted = HashSet::new();
    for event in hub.history() {
        match event.kind.as_str() {
            "agent.started" => {
                interrupted.insert(event.scope);
            }
            "agent.finished" | "agent.stopped" => {
                interrupted.remove(&event.scope);
            }
            _ => {}
        }
    }
    for id in interrupted {
        hub.record("agent.stopped", &id, json!({"text":"Gofer restarted during this turn. Terminal processes continue; send a message to resume."}))?;
    }
    for session in hub.sessions() {
        start_archive(hub.clone(), session.id);
    }
    hub.record(
        "hub.started",
        "hub",
        json!({"version":env!("CARGO_PKG_VERSION")}),
    )?;
    embedding::start(hub.clone());
    start_discovery(hub.clone());
    let app = Router::new()
        .route("/api/state", get(state))
        .route("/api/artifacts/{id}", get(image_artifact))
        .route("/api/login", post(login))
        .route("/api/events", get(event_ws))
        .route("/api/devices", post(save_device))
        .route("/api/devices/discover", post(discover))
        .route("/api/devices/{id}/probe", post(probe_device))
        .route("/api/devices/{id}/screen", get(screen_ws))
        .route("/api/devices/{id}/readiness", get(device_readiness))
        .route("/api/devices/{id}/sessions", get(device_sessions))
        .route("/api/threads", post(new_thread))
        .route("/api/projects", post(new_project))
        .route("/api/projects/{id}/close", post(close_project))
        .route("/api/chats/{id}/load", post(load_session))
        .route("/api/devices/{id}/setup/{step}", post(device_setup))
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/{id}/stream", get(terminal_ws))
        .route("/api/sessions/{id}/history", get(terminal_history))
        .route("/api/sessions/{id}/{action}", post(session_action))
        .route("/api/chats", post(new_chat))
        .route("/api/client/frames", post(client_frames))
        .route("/api/push/config", get(push_api::config))
        .route("/api/push/subscribe", post(push_api::subscribe))
        .route("/api/push/unsubscribe", post(push_api::unsubscribe))
        .route("/api/push/presence", post(push_api::presence))
        .route("/api/push/test", post(push_api::test))
        .route("/api/chats/{id}/messages", post(send_message))
        .route("/api/chats/{id}/stop", post(stop_agent))
        .route("/api/chats/{id}/{action}", post(chat_action))
        .route("/api/tools", post(tool))
        .route("/api/search", get(search))
        .route("/api/devices/{id}/agents", get(agent_api::device_agents))
        .route("/api/chats/{id}/requests", post(agent_api::request_input))
        .route(
            "/api/chats/{chat}/views/{view}/actions",
            post(agent_api::view_action),
        )
        .route(
            "/api/chats/{chat}/requests/{id}",
            get(agent_api::get_request).post(agent_api::answer_request),
        )
        .route("/api/agent-mcp/{chat}", post(agent_api::mcp))
        .route("/api/memory/search", get(memory_search))
        .route("/api/memory/graph", get(memory_graph))
        .route("/api/memory/element/{kind}/{id}", get(memory_element))
        .route("/api/memory/runs/{id}", get(memory_run))
        .route("/api/memory/claims/{id}/{action}", post(claim_action))
        .route_service(
            "/sessions",
            ServeFile::new(root.join("web/dist/index.html")),
        )
        .route_service("/devices", ServeFile::new(root.join("web/dist/index.html")))
        .route_service(
            "/activity",
            ServeFile::new(root.join("web/dist/index.html")),
        )
        .route_service("/memory", ServeFile::new(root.join("web/dist/index.html")))
        .fallback_service(
            ServeDir::new(root.join("web/dist"))
                .not_found_service(ServeFile::new(root.join("web/dist/index.html"))),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(hub.clone(), guard))
        .with_state(hub);
    let listener = tokio::net::TcpListener::bind((bind.as_str(), port)).await?;
    tracing::info!("Gofer listening on http://{bind}:{port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn full_screen_programs_are_followed_through_their_escape_codes() {
        assert!(ends_full_screen(b"$ htop\r\n\x1b[?1049h\x1b[H 0[||", false));
        assert!(ends_full_screen(b"\x1b[H 1[|||", true));
        assert!(!ends_full_screen(b"\x1b[?1049l$ ", true));
        assert!(!ends_full_screen(b"\x1b[?25l plain \x1b[?25h", false));
    }

    #[tokio::test]
    async fn coordinator_backend_is_validated_separately_from_native_provider() {
        let directory = tempfile::tempdir().unwrap();
        let h = test_hub(directory.path());
        h.record(
            "device.saved",
            "local",
            json!({"id":"local","name":"Local","target":null,"status":"online"}),
        )
        .unwrap();
        let chat = create_chat(&h, &json!({"coordinator_provider":"claude"}), None).unwrap();
        assert!(chat.agent.is_none());
        assert_eq!(chat.coordinator_provider, "claude");
        for value in [json!("copilot"), json!("shell"), json!(null), json!(42)] {
            assert!(create_chat(&h, &json!({"coordinator_provider":value}), None).is_err());
        }
        let native = json!({"agent":{"provider":"claude","device_id":"local","cwd":"/project"}});
        assert_eq!(
            create_chat(&h, &native, Some(chat.id))
                .unwrap()
                .agent
                .unwrap()
                .provider,
            "claude"
        );
        let mut mixed = native;
        mixed["coordinator_provider"] = json!("claude");
        assert!(create_chat(&h, &mixed, None).is_err());
    }

    #[tokio::test]
    async fn the_thread_is_one_permanent_claude_coordinator_and_parents_its_strands() {
        let directory = tempfile::tempdir().unwrap();
        let h = test_hub(directory.path());
        h.record(
            "device.saved",
            "local",
            json!({"id":"local","name":"Local","target":null,"status":"online"}),
        )
        .unwrap();
        ensure_thread(&h).unwrap();
        ensure_thread(&h).unwrap();
        let threads: Vec<_> = h.chats().into_iter().filter(|c| c.thread).collect();
        assert_eq!(threads.len(), 1);
        let thread = &threads[0];
        assert_eq!(thread.coordinator_provider, "claude");
        assert_eq!(thread.name, "Thread");
        let snapshot = state(State(h.clone())).await.map_err(|e| e.0).unwrap().0;
        assert_eq!(snapshot["thread_id"], json!(thread.id));
        assert_eq!(snapshot["model"], json!(claude_model()));
        let closing = chat_action(
            State(h.clone()),
            Path((thread.id.clone(), "close".into())),
            Json(json!({})),
        )
        .await;
        assert!(
            closing
                .map_err(|e| e.0.to_string())
                .unwrap_err()
                .contains("cannot be closed")
        );
        assert!(
            !h.chats()
                .iter()
                .any(|c| c.thread && (c.closed || c.closing))
        );
        let default = create_chat(&h, &json!({}), None).unwrap();
        assert_eq!(default.coordinator_provider, "claude");
        let started = execute_tool(
            &h,
            &thread.id,
            "start_agent",
            &json!({"provider":"claude","device_id":"local","cwd":"/tmp","prompt":"Check the disk","name":"Disk"}),
        )
        .await
        .unwrap();
        let strand = started["chat"]["id"].as_str().unwrap();
        let strand = h.chats().into_iter().find(|c| c.id == strand).unwrap();
        assert_eq!(strand.parent_id.as_deref(), Some(thread.id.as_str()));
        h.running
            .lock()
            .unwrap()
            .drain()
            .for_each(|(_, task)| task.abort());
    }

    #[tokio::test]
    async fn recall_precedes_the_turn_and_consolidation_failures_are_visible() {
        let directory = tempfile::tempdir().unwrap();
        let h = test_hub(directory.path());
        ensure_thread(&h).unwrap();
        let thread = h.chats().into_iter().find(|c| c.thread).unwrap().id;
        let said = h
            .record(
                "message.user",
                "garage",
                json!({"text":"I use uv for Python"}),
            )
            .unwrap();
        let claim = h
            .store
            .lock()
            .unwrap()
            .write_claims(
                "garage",
                "Garage",
                serde_json::from_value(json!([{"text":"Sam uses uv for Python packages.","about":["uv"],"supersedes":[],"evidence":[said.id]}]))
                    .unwrap(),
            )
            .unwrap()[0]["id"]
            .as_u64()
            .unwrap();
        let started = start_turn(
            &h,
            &thread,
            &json!({"text":"Which tool installs my Python packages?"}),
            None,
        );
        assert!(started.is_ok());
        let events = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let events: Vec<_> = h
                    .history()
                    .into_iter()
                    .filter(|e| e.scope == thread)
                    .collect();
                if events.iter().any(|e| e.kind == "memory.error") {
                    break events;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let kinds: Vec<_> = events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(
            kinds[1..],
            [
                "message.user",
                "memory.recalled",
                "agent.started",
                "agent.error",
                "agent.finished",
                "memory.error"
            ]
        );
        let recalled = &events[2].payload;
        assert_eq!(recalled["mode"], "text");
        assert_eq!(recalled["query"], "Which tool installs my Python packages?");
        assert_eq!(recalled["items"][0]["id"], claim);
        assert_eq!(recalled["items"][0]["kind"], "claim");
        assert_eq!(recalled["items"][0]["source"], "Garage");
        assert!(recalled["ms"].as_u64().unwrap() < 1500);
        assert!(
            events[6].payload["error"]
                .as_str()
                .unwrap()
                .contains("Memory runtime missing")
        );
    }

    #[test]
    fn long_strings_are_cut_wherever_they_sit_and_short_ones_are_left() {
        let mut value = json!({"a": "x".repeat(50), "b": ["short", {"c": "y".repeat(12)}], "n": 7});
        slim(&mut value, 10);
        assert_eq!(
            value["a"],
            format!("{} [and 40 more characters, left out]", "x".repeat(10))
        );
        assert_eq!(value["b"][0], "short");
        assert_eq!(
            value["b"][1]["c"],
            format!("{} [and 2 more characters, left out]", "y".repeat(10))
        );
        assert_eq!(value["n"], 7);
    }

    #[tokio::test]
    async fn marking_a_claim_wrong_is_recorded_in_its_scope_and_can_be_undone() {
        let directory = tempfile::tempdir().unwrap();
        let h = test_hub(directory.path());
        let said = h
            .record("message.user", "thread", json!({"text":"I use uv"}))
            .unwrap();
        let claim = h
            .store
            .lock()
            .unwrap()
            .write_claims(
                "thread",
                "Thread",
                serde_json::from_value(json!([{"text":"Sam uses uv.","about":["uv"],"supersedes":[],"evidence":[said.id]}]))
                    .unwrap(),
            )
            .unwrap()[0]["id"]
            .as_u64()
            .unwrap();
        for (action, kind, state) in [
            ("wrong", "memory.retracted", "retracted"),
            ("restore", "memory.restored", "active"),
        ] {
            let reply = claim_action(State(h.clone()), Path((claim, action.into())))
                .await
                .map_err(|e| e.0)
                .unwrap()
                .0;
            assert_eq!(reply["state"], state);
            let event = h.history().into_iter().last().unwrap();
            assert_eq!(
                (event.kind.as_str(), event.scope.as_str()),
                (kind, "thread")
            );
            assert_eq!(event.payload, json!({"id":claim,"text":"Sam uses uv."}));
        }
        assert!(
            claim_action(State(h.clone()), Path((claim, "restore".into())))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn native_chat_creation_validates_provider_device_and_project_before_saving() {
        let directory = tempfile::tempdir().unwrap();
        let h = test_hub(directory.path());
        h.record(
            "device.saved",
            "desktop",
            json!({"id":"desktop","name":"Desktop","target":"desktop","status":"online"}),
        )
        .unwrap();
        let payload =
            json!({"agent":{"provider":"codex","device_id":"desktop","cwd":"/work/game"}});
        let chat = new_chat(State(h.clone()), Json(payload.clone()))
            .await
            .map_err(|e| e.0)
            .unwrap()
            .0;
        assert_eq!(
            serde_json::to_value(chat).unwrap()["agent"]["device_id"],
            "desktop"
        );
        for patch in [
            json!({"provider":"shell"}),
            json!({"device_id":"missing"}),
            json!({"cwd":"relative/path"}),
        ] {
            let mut invalid = payload.clone();
            for (key, value) in patch.as_object().unwrap() {
                invalid["agent"][key] = value.clone();
            }
            assert!(new_chat(State(h.clone()), Json(invalid)).await.is_err());
        }
        assert_eq!(h.chats().len(), 1);
    }

    #[tokio::test]
    async fn dropping_an_old_turn_does_not_revoke_its_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let hub = test_hub(dir.path());
        let old = agent_api::Access::new(&hub, "chat");
        let current = agent_api::Access::new(&hub, "chat");
        drop(old);
        assert_eq!(
            hub.agent_tokens.lock().unwrap().get("chat"),
            Some(&current.token)
        );
        drop(current);
        assert!(!hub.agent_tokens.lock().unwrap().contains_key("chat"));
    }

    #[tokio::test]
    async fn workspace_snapshot_does_not_wait_for_a_remote_terminal_connection() {
        let dir = tempfile::tempdir().unwrap();
        let hub = test_hub(dir.path());
        let _connection = hub.terminals.lock().await;
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                state(State(hub.clone()))
            )
            .await
            .is_ok()
        );
    }

    fn test_hub(path: &std::path::Path) -> Shared {
        let (events, _) = broadcast::channel(16);
        Arc::new(Hub {
            store: Mutex::new(Store::open(&path.join("history.vg")).unwrap()),
            input_lock: Mutex::new(()),
            agent_tokens: Mutex::new(HashMap::new()),
            push: Mutex::new(hub_server::push::PushStore::open(&path.join("push.json")).unwrap()),
            events,
            terminals: AsyncMutex::new(HashMap::new()),
            terminal_operations: Mutex::new(HashMap::new()),
            attached_ids: Mutex::new(HashSet::new()),
            terminal_lifecycle: AsyncMutex::new(()),
            terminal_cleanup: Notify::new(),
            running: Mutex::new(HashMap::new()),
            consolidation: AsyncMutex::new(()),
            embedder: embedding::Embedder::new(
                None,
                hub_server::embeddings::ENDPOINT,
                hub_server::embeddings::MODEL,
                hub_server::embeddings::DIMENSIONS,
            )
            .unwrap(),
            embedding_status: Mutex::new("starting".into()),
            discovery: Mutex::new(DiscoveryState::default()),
            discovery_lock: AsyncMutex::new(()),
            root: PathBuf::from("."),
            token: None,
            port: 0,
            allowed_hosts: HashSet::new(),
        })
    }

    #[tokio::test]
    async fn legacy_terminals_get_exclusive_owners_without_stopping_shells() {
        let path = std::env::temp_dir().join(format!("hub-ownership-{}", uuid::Uuid::new_v4()));
        let h = test_hub(&path);
        for id in ["a", "b"] {
            h.record(
                "chat.created",
                id,
                json!({"id":id,"name":id,"created_at":"now"}),
            )
            .unwrap();
        }
        for (id, time) in [("one", "1"), ("two", "2"), ("orphan", "3")] {
            h.record(
                "session.created",
                id,
                json!({"id":id,"name":id,"device_id":"local","cwd":"","created_at":time}),
            )
            .unwrap();
        }
        for id in ["one", "two"] {
            h.record("chat.terminal_linked", "a", json!({"session_id":id}))
                .unwrap();
        }
        h.record("chat.terminal_linked", "b", json!({"session_id":"one"}))
            .unwrap();
        h.migrate_terminal_ownership().unwrap();
        assert_eq!(
            h.chat_terminals("a")
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["two"]
        );
        assert!(h.chat_terminals("b").is_empty());
        for terminal in h.sessions() {
            assert!(!terminal.closed);
            let owners: Vec<_> = h
                .chats()
                .into_iter()
                .filter(|c| c.session_ids.contains(&terminal.id))
                .collect();
            assert_eq!(owners.len(), 1);
            assert_eq!(owners[0].session_ids.len(), 1);
        }
        for name in ["terminal_send", "terminal_read", "terminal_interrupt"] {
            let rejected = execute_tool(
                &h,
                "b",
                name,
                &json!({"session_id":"two","text":"should never run\n"}),
            )
            .await
            .unwrap_err();
            assert!(rejected.to_string().contains("does not belong"));
        }
        assert_eq!(
            execute_tool(&h, "a", "list_terminals", &json!({}))
                .await
                .unwrap()[0]["id"],
            "two"
        );
        assert_eq!(
            execute_tool(&h, "b", "list_terminals", &json!({}))
                .await
                .unwrap(),
            json!([])
        );
        let before = h.history().len();
        h.migrate_terminal_ownership().unwrap();
        assert_eq!(h.history().len(), before);
        drop(h);
        let restored = test_hub(&path);
        restored.migrate_terminal_ownership().unwrap();
        assert_eq!(restored.history().len(), before);
        assert_eq!(restored.chat_terminals("a")[0].id, "two");
        drop(restored);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn unreachable_terminals_never_prevent_closing_their_conversation() {
        for (suffix, extra, should_close) in [
            ("never-started", None, true),
            (
                "input",
                Some(("terminal.input", json!({"text":"echo ready\n"}))),
                false,
            ),
            (
                "output",
                Some(("terminal.output", json!({"text":"ready"}))),
                false,
            ),
            ("detached", Some(("session.detached", json!({}))), false),
            (
                "uncertain-retry",
                Some(("session.starting", json!({}))),
                false,
            ),
        ] {
            let path = std::env::temp_dir().join(format!(
                "hub-failed-close-{suffix}-{}",
                uuid::Uuid::new_v4()
            ));
            let h = test_hub(&path);
            h.record(
                "device.saved",
                "remote",
                json!({"id":"remote","name":"Remote","target":"-invalid"}),
            )
            .unwrap();
            h.record(
                "chat.created",
                "chat",
                json!({"id":"chat","name":"Failed connection","created_at":"now"}),
            )
            .unwrap();
            h.record("session.created", "shell", json!({"id":"shell","name":"Logs","device_id":"remote","cwd":"","created_at":"now"})).unwrap();
            h.record(
                "chat.terminal_linked",
                "chat",
                json!({"session_id":"shell"}),
            )
            .unwrap();
            h.record(
                "session.error",
                "shell",
                json!({"error":"Host key verification failed."}),
            )
            .unwrap();
            if let Some((kind, payload)) = extra {
                h.record(kind, "shell", payload).unwrap();
            }
            // A later failed shutdown is not evidence that the shell was created.
            h.record(
                "session.close_failed",
                "shell",
                json!({"error":"SSH denied"}),
            )
            .unwrap();
            drop(h);
            let restored = test_hub(&path);
            let result = close_chat(&restored, "chat").await;
            assert!(result.is_ok(), "{suffix}: {result:?}");
            assert!(restored.chats()[0].closed, "{suffix}");
            assert!(restored.sessions()[0].closed, "{suffix}");
            assert_eq!(
                serde_json::to_value(&restored.sessions()[0]).unwrap()["cleanup_pending"],
                !should_close,
                "Only terminals that may have a process require cleanup: {suffix}"
            );
            drop(restored);
            let recovered = test_hub(&path);
            recovered.migrate_terminal_ownership().unwrap();
            assert_eq!(
                recovered.chats().len(),
                1,
                "Restart resurrected a closed session"
            );
            assert!(recovered.chats()[0].closed);
            assert_eq!(
                serde_json::to_value(&recovered.sessions()[0]).unwrap()["cleanup_pending"],
                !should_close,
                "Cleanup intent must survive restart"
            );
            let restored = recovered;
            drop(restored);
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[tokio::test]
    async fn closing_returns_without_waiting_for_an_in_flight_terminal_connection() {
        let path =
            std::env::temp_dir().join(format!("hub-close-connecting-{}", uuid::Uuid::new_v4()));
        let h = test_hub(&path);
        h.record(
            "device.saved",
            "remote",
            json!({"id":"remote","name":"Offline","target":"-invalid"}),
        )
        .unwrap();
        h.record(
            "chat.created",
            "chat",
            json!({"id":"chat","name":"Connecting","created_at":"now"}),
        )
        .unwrap();
        h.record(
            "session.created",
            "shell",
            json!({"id":"shell","name":"Shell","device_id":"remote","cwd":"","created_at":"now"}),
        )
        .unwrap();
        h.record(
            "chat.terminal_linked",
            "chat",
            json!({"session_id":"shell"}),
        )
        .unwrap();
        let connection = h.terminal_operation("shell").lock_owned().await;
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            close_chat(&h, "chat"),
        )
        .await;
        assert!(result.is_ok(), "Closing waited for an unreachable device");
        result.unwrap().unwrap();
        assert!(h.chats()[0].closed);
        assert!(h.sessions()[0].closed);
        drop(connection);
        drop(h);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn restart_retries_pending_shutdown_and_stops_the_original_shell() {
        let path = std::env::temp_dir().join(format!("hub-cleanup-{}", uuid::Uuid::new_v4()));
        let h = test_hub(&path);
        let id = uuid::Uuid::new_v4().simple().to_string();
        h.record(
            "device.saved",
            "device",
            json!({"id":"device","name":"Offline","target":"-invalid"}),
        )
        .unwrap();
        h.record(
            "chat.created",
            "chat",
            json!({"id":"chat","name":"Close me","created_at":"now"}),
        )
        .unwrap();
        h.record(
            "session.created",
            &id,
            json!({"id":id,"name":"Shell","device_id":"device","cwd":"","created_at":"now"}),
        )
        .unwrap();
        h.record("chat.terminal_linked", "chat", json!({"session_id":id}))
            .unwrap();
        let (attachment, output) = Terminal::open(&id, None, path.to_str().unwrap())
            .await
            .unwrap();
        h.record("session.attached", &id, json!({})).unwrap();
        attachment.disconnect();
        drop((attachment, output));
        let exists = format!("tmux -L gofer has-session -t hub_{id}");
        assert!(terminal::run(None, &exists).await.is_ok());

        close_chat(&h, "chat").await.unwrap();
        cleanup_terminals(&h).await;
        assert!(h.chats()[0].closed);
        assert!(h.sessions()[0].cleanup_pending);
        assert!(h.sessions()[0].cleanup_error.is_some());
        assert!(
            terminal::run(None, &exists).await.is_ok(),
            "Unconfirmed shutdown must not be reported as stopped"
        );
        let events = h.history().len();
        close_chat(&h, "chat").await.unwrap();
        assert_eq!(h.history().len(), events, "Close must be idempotent");
        drop(h);

        let restored = test_hub(&path);
        restored.migrate_terminal_ownership().unwrap();
        assert_eq!(restored.chats().len(), 1);
        assert!(restored.chats()[0].closed);
        // Simulate the destination becoming reachable after the restart.
        restored
            .record(
                "device.saved",
                "device",
                json!({"id":"device","name":"Online","target":null}),
            )
            .unwrap();
        let worker = tokio::spawn(terminal_cleanup(restored.clone()));
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while restored.sessions()[0].cleanup_pending {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            terminal::run(None, &exists).await.is_err(),
            "Deferred shutdown did not kill the original shell"
        );
        assert!(restored.sessions()[0].cleanup_error.is_none());
        assert!(restored.chats()[0].closed);
        worker.abort();
        let _ = worker.await;
        drop(restored);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn closing_stops_the_agent_and_blocks_queued_terminal_creation() {
        let path = std::env::temp_dir().join(format!("hub-close-{}", uuid::Uuid::new_v4()));
        let h = test_hub(&path);
        h.record(
            "chat.created",
            "chat",
            json!({"id":"chat","name":"Closing check","created_at":"now"}),
        )
        .unwrap();
        let worker = tokio::spawn(std::future::pending::<()>());
        h.running
            .lock()
            .unwrap()
            .insert("chat".into(), worker.abort_handle());
        let held = h.terminal_lifecycle.lock().await;
        let opener = {
            let h = h.clone();
            tokio::spawn(async move { open_terminal(&h, &json!({}), Some("chat")).await })
        };
        let closer = {
            let h = h.clone();
            tokio::spawn(async move { close_chat(&h, "chat").await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !h.chats()[0].closing {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(h.running.lock().unwrap().is_empty());
        assert!(worker.await.unwrap_err().is_cancelled());
        let rejected = send_message(
            State(h.clone()),
            Path("chat".into()),
            Json(json!({"text":"Too late"})),
        )
        .await;
        assert!(
            rejected.is_err(),
            "No new agent turn may start while terminals are closing"
        );
        drop(held);
        assert!(opener.await.unwrap().is_err());
        closer.await.unwrap().unwrap();
        assert!(
            h.sessions().is_empty(),
            "Queued creation escaped the close boundary"
        );
        assert!(h.chats()[0].closed && !h.chats()[0].closing);
        drop(h);
        std::fs::remove_dir_all(path).unwrap();
    }
}
