//! Input requests and their resolutions remain inspectable in the conversation.
use crate::store::Event;
use anyhow::{Result, bail};
use serde_json::Value;
use std::collections::HashSet;

pub fn validate_request(value: &Value) -> Result<()> {
    if value["title"]
        .as_str()
        .is_none_or(|v| v.trim().is_empty() || v.len() > 200)
        || value.to_string().len() > 32_000
    {
        bail!("Provide a short title and a request under 32 KB");
    }
    let (field, limit) = match (value.get("options"), value.get("questions")) {
        (Some(_), None) => ("options", 12),
        (None, Some(_)) => ("questions", 8),
        _ => bail!("Request must contain choices or questions"),
    };
    let entries = value[field]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= limit)
        .ok_or_else(|| anyhow::anyhow!("Invalid request fields"))?;
    let mut ids = HashSet::new();
    for entry in entries {
        let id = entry["id"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 128)
            .ok_or_else(|| anyhow::anyhow!("Request field needs an ID"))?;
        if !ids.insert(id)
            || entry["label"]
                .as_str()
                .is_none_or(|v| v.trim().is_empty() || v.len() > 1000)
        {
            bail!("Request fields need unique IDs and readable labels");
        }
    }
    Ok(())
}

pub fn validate_answer(request: &Value, answer: &Value) -> Result<()> {
    if answer.to_string().len() > 16_000 {
        bail!("Answer is too large");
    }
    if let Some(options) = request["options"].as_array() {
        if !options
            .iter()
            .any(|v| v["id"].is_string() && v["id"] == answer["choice"])
        {
            bail!("Choose one of the requested options");
        }
    } else if let Some(questions) = request["questions"].as_array() {
        for question in questions {
            let id = question["id"].as_str().unwrap_or("");
            if answer["answers"][id]
                .as_str()
                .is_none_or(|v| v.trim().is_empty() || v.len() > 2000)
            {
                bail!("Answer each question before continuing");
            }
        }
    }
    Ok(())
}

pub fn pending(events: &[Event], chat: &str, id: &str) -> Option<Value> {
    let mut request = None;
    for event in events.iter().filter(|event| event.scope == chat) {
        match event.kind.as_str() {
            "agent.finished" | "agent.error" | "agent.stopped" | "chat.closed" => request = None,
            "agent.requested" if event.payload["request_id"] == id => {
                request = Some(event.payload.clone())
            }
            "agent.answered" if event.payload["request_id"] == id => request = None,
            _ => {}
        }
    }
    request
}
