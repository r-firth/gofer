//! Native sessions use scoped MCP access; approval responses stay in chat history.
use super::*;
use hub_server::requests;

pub struct Access {
    hub: Shared,
    id: String,
    pub token: String,
}
impl Access {
    pub fn new(hub: &Shared, id: &str) -> Self {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        hub.agent_tokens
            .lock()
            .unwrap()
            .insert(id.into(), token.clone());
        Self {
            hub: hub.clone(),
            id: id.into(),
            token,
        }
    }
}
impl Drop for Access {
    fn drop(&mut self) {
        let mut tokens = self.hub.agent_tokens.lock().unwrap();
        if tokens.get(&self.id) == Some(&self.token) {
            tokens.remove(&self.id);
        }
    }
}

pub fn authorized(hub: &Shared, id: &str, headers: &axum::http::HeaderMap) -> bool {
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    supplied.is_some_and(|token| {
        hub.agent_tokens
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|expected| expected == token)
    }) && !headers.contains_key(header::ORIGIN)
        && hub.running.lock().unwrap().contains_key(id)
}

pub async fn device_agents(State(h): State<Shared>, Path(id): Path<String>) -> Api<Value> {
    let device = h
        .devices()
        .into_iter()
        .find(|d| d.id == id)
        .context("Device not found")?;
    let output = terminal::run(device.target.as_deref(), "export PATH=\"$PATH:$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin\"; printf 'HOME=%s\\n' \"$HOME\"; for agent in codex copilot claude; do if command -v \"$agent\" >/dev/null 2>&1; then printf 'AGENT=%s\\n' \"$agent\"; fi; done").await?;
    let home = output
        .lines()
        .find_map(|line| line.strip_prefix("HOME="))
        .unwrap_or("");
    let available: Vec<_> = output
        .lines()
        .filter_map(|line| line.strip_prefix("AGENT="))
        .collect();
    Ok(Json(
        json!({"device_id": id, "home": home, "available": available}),
    ))
}

pub async fn request_input(
    State(h): State<Shared>,
    Path(id): Path<String>,
    Json(mut payload): Json<Value>,
) -> Api<Value> {
    let _input = h.input_lock.lock().unwrap();
    if !h.running.lock().unwrap().contains_key(&id) {
        bail_api("Agent is no longer running")?;
    }
    requests::validate_request(&payload)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    payload["request_id"] = json!(request_id);
    h.record("agent.requested", &id, payload)?;
    Ok(Json(json!({"request_id":request_id})))
}

pub async fn get_request(
    State(h): State<Shared>,
    Path((chat, id)): Path<(String, String)>,
) -> Api<Value> {
    let history = h.history();
    if let Some(answer) = history
        .iter()
        .rev()
        .find(|e| e.scope == chat && e.kind == "agent.answered" && e.payload["request_id"] == id)
    {
        return Ok(Json(
            json!({"status":"answered", "answer":answer.payload["answer"]}),
        ));
    }
    let pending = h.running.lock().unwrap().contains_key(&chat)
        && requests::pending(&history, &chat, &id).is_some();
    Ok(Json(
        json!({"status":if pending {"pending"} else {"cancelled"}}),
    ))
}

pub async fn answer_request(
    State(h): State<Shared>,
    Path((chat, id)): Path<(String, String)>,
    Json(answer): Json<Value>,
) -> Api<Value> {
    let _input = h.input_lock.lock().unwrap();
    if !h.running.lock().unwrap().contains_key(&chat) {
        bail_api("Agent is no longer waiting")?;
    }
    let request = requests::pending(&h.history(), &chat, &id)
        .context("This request has already been resolved")?;
    requests::validate_answer(&request, &answer)?;
    h.record(
        "agent.answered",
        &chat,
        json!({"request_id":id,"answer":answer}),
    )?;
    Ok(Json(json!({"ok":true})))
}

pub async fn mcp(
    State(h): State<Shared>,
    Path(chat): Path<String>,
    Json(message): Json<Value>,
) -> Response {
    let id = message.get("id").cloned();
    if id.is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let specs: Value = serde_json::from_str(include_str!("../../../agent/tools.json")).unwrap();
    let method = message["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => Ok(
            json!({"protocolVersion":message["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"), "capabilities":{"tools":{}}, "serverInfo":{"name":"gofer", "version":"0.2.0"}}),
        ),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(
            json!({"tools":specs.as_object().unwrap().iter().filter(|(name,_)| !matches!(name.as_str(),"start_agent"|"send_agent"|"stop_agent")).map(|(name,spec)| json!({"name":name,"description":spec["description"],"inputSchema":spec["inputSchema"]})).collect::<Vec<_>>()}),
        ),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or("");
            if !specs[name].is_object()
                || matches!(name, "start_agent" | "send_agent" | "stop_agent")
            {
                Err("Tool is unavailable in this session".to_owned())
            } else {
                let mut args = message["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                if matches!(name, "show_image" | "open_terminal")
                    && args.get("device_id").is_none()
                    && let Some(agent) = h
                        .chats()
                        .into_iter()
                        .find(|c| c.id == chat)
                        .and_then(|c| c.agent)
                {
                    args["device_id"] = json!(agent.device_id);
                }
                match tool(
                    State(h),
                    Json(json!({"chat_id":chat,"name":name,"arguments":args})),
                )
                .await
                {
                    Ok(result) => Ok(
                        json!({"content":[{"type":"text","text":result.0.to_string()}],"isError":result.0["ok"] != true}),
                    ),
                    Err(error) => Err(error.0.to_string()),
                }
            }
        }
        _ => Err("Unknown MCP method".to_owned()),
    };
    Json(match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(message) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":message}}),
    })
    .into_response()
}

pub async fn view_action(
    State(h): State<Shared>,
    Path((chat, view)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Api<Value> {
    let _input = h.input_lock.lock().unwrap();
    let action_id = input["request_id"]
        .as_str()
        .context("Action request ID required")?;
    uuid::Uuid::parse_str(action_id).context("Invalid action request ID")?;
    let history = h.history();
    if history.iter().any(|e| {
        e.scope == chat
            && ((e.kind == "ui.action" && e.payload["request_id"] == action_id)
                || (e.kind == "message.user"
                    && e.payload["view_action"]["request_id"] == action_id))
    }) {
        return Ok(Json(json!({"ok":true})));
    }
    let current = hub_server::views::latest(&history, &chat, &view).context("View not found")?;
    let text = hub_server::views::action(&current, &input)?;
    let result = start_turn(
        &h,
        &chat,
        &json!({"text":text}),
        Some(
            json!({"view_id":view,"request_id":action_id,"action_id":input["action_id"],"revision":input["revision"]}),
        ),
    )?;
    h.record("ui.action",&chat,json!({"view_id":view,"request_id":action_id,"action_id":input["action_id"],"revision":input["revision"]}))?;
    Ok(result)
}
