//! Disposable archive for Memory UI/latency checks; refuses an existing database.
use anyhow::{Context, Result, ensure};
use hub_server::store::Store;
use serde_json::json;
use std::path::PathBuf;
fn main() -> Result<()> {
    let directory = PathBuf::from(
        std::env::args()
            .nth(1)
            .context("pass a new fixture directory")?,
    );
    let count = std::env::args()
        .nth(2)
        .unwrap_or("10000".into())
        .parse::<usize>()?;
    let path = directory.join("history.vg");
    ensure!(!path.exists(), "fixture already exists");
    let mut s = Store::open(&path)?;
    let names = [
        "Renderer investigation",
        "Desktop build",
        "Home server backup",
        "Network discovery",
        "Agent streaming",
        "Memory indexing",
        "Deployment review",
        "Terminal fonts",
    ];
    for (i, name) in names.iter().enumerate() {
        s.append("chat.created",&format!("fixture-{i}"),json!({"id":format!("fixture-{i}"),"name":name,"created_at":"2026-09-23T12:00:00Z","closed":true}))?;
    }
    for i in 0..count {
        let scope = format!("fixture-{}", (i / 10) % names.len());
        let (kind, payload) = match i % 10 {
            0 => (
                "message.user",
                json!({"text":format!("Investigate {} and record the evidence for pass {i}.",names[(i/10)%names.len()])}),
            ),
            1 => ("agent.started", json!({})),
            2 => (
                "tool.started",
                json!({"name":"command_execution","arguments":{"command":"cargo test --workspace"}}),
            ),
            3 => (
                "tool.result",
                json!({"name":"command_execution","result":{"ok":true,"output":format!("Validation pass {i}: renderer latency stable; tests passed.")}}),
            ),
            4 => ("message.delta", json!({"delta":"The renderer is stable."})),
            5 => (
                "message.assistant",
                json!({"text":"The renderer is stable. All workspace tests passed.\n\nThe terminal uses the viewer's current dimensions; the persistent session survives reconnects."}),
            ),
            6 => (
                "tool.result",
                json!({"name":"search_memory","result":{"matches":3,"query":"renderer stability"}}),
            ),
            7 => (
                "message.assistant",
                json!({"text":format!("Archived evidence marker-{i:05}. No changes to running processes.")}),
            ),
            8 => ("agent.finished", json!({})),
            _ => ("chat.closed", json!({})),
        };
        let e = s.append(kind, &scope, payload)?;
        // Explicitly synthetic embeddings, only in this disposable test archive.
        if i % 10 == 5 {
            s.embed(
                e.id,
                (0..hub_server::embeddings::DIMENSIONS)
                    .map(|j| ((j * 7 + i) % 61) as f32 / 305.0 - 0.1)
                    .collect(),
            )?;
        }
    }
    println!(
        "Seeded {} fixture events at {}",
        s.event_count(),
        directory.display()
    );
    Ok(())
}
