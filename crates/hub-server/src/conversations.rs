use crate::store::Event;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub provider: String,
    pub device_id: String,
    pub cwd: String,
    #[serde(default)]
    pub native_id: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Chat {
    pub id: String,
    pub name: String,
    pub created_at: String,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub closing: bool,
    #[serde(default)]
    pub close_error: Option<String>,
    #[serde(default)]
    pub title_generated: bool,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub agent: Option<AgentSession>,
    #[serde(
        default = "default_coordinator_provider",
        skip_serializing_if = "String::is_empty"
    )]
    pub coordinator_provider: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// A coordinator conversation the owner talks to Gofer in. There is always the first one, which
    /// cannot be closed; others are opened for a topic and can be.
    #[serde(default)]
    pub thread: bool,
    /// A strand loaded from a session that already existed on the machine: its "user" turns
    /// are the owner's own words, not a coordinator's brief.
    #[serde(default)]
    pub loaded: bool,
    /// The coordinator's own provider session, resumed every turn.
    #[serde(default)]
    pub native_id: Option<String>,
    /// The project a thread belongs to, if it belongs to one.
    #[serde(default)]
    pub project_id: Option<String>,
}

/// A named collection of threads.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
    #[serde(default)]
    pub closed: bool,
}

/// The projects, oldest first, as their events leave them.
pub fn projects(events: &[Event]) -> Vec<Project> {
    let mut projects = Vec::<Project>::new();
    for event in events.iter().filter(|e| e.scope == "projects") {
        match event.kind.as_str() {
            "project.saved" => {
                if let Ok(project) = serde_json::from_value::<Project>(event.payload.clone()) {
                    match projects.iter_mut().find(|p| p.id == project.id) {
                        Some(known) => *known = project,
                        None => projects.push(project),
                    }
                }
            }
            "project.closed" => {
                if let Some(project) = projects
                    .iter_mut()
                    .find(|p| Some(p.id.as_str()) == event.payload["id"].as_str())
                {
                    project.closed = true;
                }
            }
            _ => {}
        }
    }
    projects
}

pub fn default_coordinator_provider() -> String {
    "claude".into()
}

pub fn project(events: &[Event]) -> Vec<Chat> {
    let mut chats = std::collections::HashMap::<String, Chat>::new();
    let mut fallback_named = std::collections::HashSet::new();
    let mut terminal_owners = std::collections::HashMap::<String, String>::new();
    for event in events {
        // Upgrade old shared/standalone terminals without stopping their shells.
        if event.kind == "chat.terminal_split" {
            if let (Some(id), Ok(mut chat)) = (
                event.payload["session_id"].as_str(),
                serde_json::from_value::<Chat>(event.payload["chat"].clone()),
            ) {
                for previous in chats.values_mut() {
                    previous.session_ids.retain(|value| value != id);
                }
                chat.updated_at = chat.created_at.clone();
                chat.session_ids = vec![id.into()];
                terminal_owners.insert(id.into(), chat.id.clone());
                chats.insert(chat.id.clone(), chat);
            }
            continue;
        }
        if event.kind == "chat.created"
            && let Ok(mut chat) = serde_json::from_value::<Chat>(event.payload.clone())
        {
            chat.updated_at = chat.created_at.clone();
            // A pre-existing custom title belongs to the user.
            chat.title_generated |=
                !matches!(chat.name.as_str(), "Workspace" | "New conversation" | "");
            chats.insert(chat.id.clone(), chat);
        }
        let Some(chat) = chats.get_mut(&event.scope) else {
            continue;
        };
        match event.kind.as_str() {
            "agent.session" => {
                let native_id = event.payload["native_id"].as_str().map(str::to_owned);
                match &mut chat.agent {
                    Some(agent) => agent.native_id = native_id,
                    None => chat.native_id = native_id,
                }
            }
            "chat.closing" => {
                chat.closing = true;
                chat.close_error = None;
            }
            "chat.close_failed" => {
                chat.closed = false;
                chat.closing = false;
                chat.close_error = event.payload["error"].as_str().map(str::to_owned);
            }
            "chat.closed" => {
                chat.closed = true;
                chat.closing = false;
                chat.close_error = None;
            }
            "chat.reopened" => {
                chat.closed = false;
                chat.close_error = None;
            }
            "chat.renamed" => {
                if let Some(name) = event.payload["name"].as_str().and_then(clean_title) {
                    chat.name = name;
                    chat.title_generated = true;
                }
            }
            "message.user" => {
                chat.updated_at = event.time.clone();
                if !chat.title_generated
                    && !fallback_named.contains(&chat.id)
                    && let Some(name) = event.payload["text"].as_str().and_then(fallback_title)
                {
                    chat.name = name;
                    fallback_named.insert(chat.id.clone());
                }
            }
            _ => {}
        }
        let terminal = if event.kind == "chat.terminal_linked" {
            event.payload["session_id"].as_str()
        } else if event.kind == "tool.result" && event.payload["result"]["ok"] == true {
            match event.payload["name"].as_str() {
                Some("open_terminal") => event.payload["result"]["result"]["id"].as_str(),
                Some("terminal_read" | "terminal_send" | "terminal_interrupt") => {
                    event.payload["arguments"]["session_id"].as_str()
                }
                _ => None,
            }
        } else {
            None
        };
        if let Some(id) = terminal.filter(|id| !id.is_empty()) {
            let owner = terminal_owners
                .entry(id.into())
                .or_insert_with(|| chat.id.clone());
            if owner != &chat.id {
                continue;
            }
            if !chat.session_ids.iter().any(|s| s == id) {
                chat.session_ids.push(id.into());
            }
        }
    }
    let mut result: Vec<_> = chats.into_values().collect();
    result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    result
}

pub fn clean_title(text: &str) -> Option<String> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = text.trim_matches(['"', '\'']);
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(80).collect())
}

fn fallback_title(text: &str) -> Option<String> {
    let title = clean_title(text)?;
    if matches!(
        title
            .trim_end_matches(['!', '.', '?'])
            .to_lowercase()
            .as_str(),
        "hi" | "hey" | "hello" | "alright" | "hello mate" | "hey mate" | "thanks" | "thank you"
    ) {
        return None;
    }
    if title.chars().count() <= 56 {
        return Some(title);
    }
    let short: String = title.chars().take(53).collect();
    Some(format!(
        "{}…",
        short.rsplit_once(' ').map_or(short.as_str(), |(s, _)| s)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn event(kind: &str, scope: &str, payload: Value) -> Event {
        Event {
            id: 0,
            kind: kind.into(),
            scope: scope.into(),
            time: "2026-09-23".into(),
            payload,
        }
    }
    fn chat(id: &str) -> Event {
        event(
            "chat.created",
            id,
            json!({"id":id,"name":"New conversation","created_at":"2026-09-23"}),
        )
    }
    #[test]
    fn names_legacy_chats_and_preserves_generated_titles() {
        let mut events = vec![
            chat("a"),
            event("message.user", "a", json!({"text":"hey"})),
            event(
                "message.user",
                "a",
                json!({"text":"Check the game build on my desktop"}),
            ),
        ];
        assert_eq!(
            project(&events)[0].name,
            "Check the game build on my desktop"
        );
        events.push(event(
            "chat.renamed",
            "a",
            json!({"name":"Desktop game build"}),
        ));
        events.push(event(
            "message.user",
            "a",
            json!({"text":"Another request"}),
        ));
        let chats = project(&events);
        assert_eq!(chats[0].name, "Desktop game build");
        assert!(chats[0].title_generated);
    }
    #[test]
    fn terminal_receipts_cannot_claim_another_conversations_terminal() {
        let events = vec![
            chat("a"),
            chat("b"),
            event(
                "tool.result",
                "a",
                json!({"name":"open_terminal","result":{"ok":true,"result":{"id":"one"}}}),
            ),
            event(
                "tool.result",
                "a",
                json!({"name":"terminal_read","arguments":{"session_id":"one"},"result":{"ok":true}}),
            ),
            event(
                "tool.result",
                "a",
                json!({"name":"terminal_read","arguments":{"session_id":"failed"},"result":{"ok":false}}),
            ),
            event(
                "tool.result",
                "a",
                json!({"name":"list_terminals","result":{"ok":true,"result":[{"id":"unrelated"}]}}),
            ),
            event("chat.terminal_linked", "b", json!({"session_id":"one"})),
        ];
        let chats = project(&events);
        assert_eq!(
            chats.iter().find(|c| c.id == "a").unwrap().session_ids,
            ["one"]
        );
        assert!(
            chats
                .iter()
                .find(|c| c.id == "b")
                .unwrap()
                .session_ids
                .is_empty()
        );
    }
    #[test]
    fn close_and_reopen_preserve_history_and_links() {
        let mut events = vec![
            chat("a"),
            event("chat.terminal_linked", "a", json!({"session_id":"one"})),
            event("chat.closed", "a", json!({})),
        ];
        assert!(project(&events)[0].closed);
        events.push(event("chat.reopened", "a", json!({})));
        assert!(!project(&events)[0].closed);
        assert_eq!(project(&events)[0].session_ids, ["one"]);
    }
}
