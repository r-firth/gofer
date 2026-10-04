//! The Claude Code and Codex sessions that already exist on a machine.
//!
//! Both tools keep every session as a JSON-lines file under the home directory and can resume
//! one by its id. A short Python script, run on the machine over SSH, lists them or reads one
//! out as plain turns, so a session started anywhere (the desktop app, a terminal) can be
//! loaded into a thread, read there, continued, and taken into memory.
use crate::terminal;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const SCRIPT: &str = r#"
import glob, html, json, os, re, sys

HOME = os.path.expanduser("~")
INJECTED = re.compile(r"<(remembered_context|system-reminder|environment_context|user_instructions|recommended_plugins|multi_agent_role|multi_agent_mode|coordinator-context|command-name|command-message|command-args|local-command-stdout|local-command-caveat)\b[^>]*>.*?</\1>", re.S)
# A message relayed by an app arrives wrapped; what the person wrote is the message inside.
WRAPPED = re.compile(r"<(wake|project_claude_message)\b[^>]*>.*?</\1>", re.S)
INNER = re.compile(r"<(message|cited)\b[^>]*>(.*?)</\1>", re.S)
TAG = re.compile(r"</?[A-Za-z_][^>]*>")

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in ("text", "input_text", "output_text"))
    return ""

def unwrap(block):
    said = [TAG.sub("", m.group(2)).strip() for m in INNER.finditer(block.group(0))]
    return "\n".join(s for s in said if s)

def clean(text):
    return html.unescape(WRAPPED.sub(unwrap, INJECTED.sub("", text))).strip()

def claude(path, limit):
    out = {"provider": "claude", "id": os.path.basename(path)[:-6], "cwd": "", "turns": []}
    with open(path, errors="replace") as lines:
        for n, line in enumerate(lines):
            if limit and (n > 400 or out["turns"]):
                break
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("isSidechain") or o.get("isMeta") or o.get("type") not in ("user", "assistant"):
                continue
            out["cwd"] = out["cwd"] or o.get("cwd", "")
            text = clean(text_of((o.get("message") or {}).get("content")))
            if text and not (limit and o["type"] != "user"):
                out["turns"].append({"role": o["type"], "text": text[:6000], "time": o.get("timestamp", "")})
    return out

def codex(path, limit):
    out = {"provider": "codex", "id": "", "cwd": "", "turns": []}
    with open(path, errors="replace") as lines:
        for n, line in enumerate(lines):
            if limit and (n > 400 or out["turns"]):
                break
            try:
                o = json.loads(line)
            except ValueError:
                continue
            p = o.get("payload") or {}
            if o.get("type") == "session_meta":
                out["id"], out["cwd"] = p.get("id", ""), p.get("cwd", "")
            elif o.get("type") == "response_item" and p.get("type") == "message" and p.get("role") in ("user", "assistant"):
                text = clean(text_of(p.get("content")))
                if text and not (limit and p["role"] != "user"):
                    out["turns"].append({"role": p["role"], "text": text[:6000], "time": o.get("timestamp", "")})
    return out

FILES = {
    "claude": lambda: glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")),
    "codex": lambda: glob.glob(os.path.join(HOME, ".codex", "sessions", "**", "*.jsonl"), recursive=True),
}
READ = {"claude": claude, "codex": codex}

if sys.argv[1] == "list":
    found = []
    for provider in ("claude", "codex"):
        paths = sorted(FILES[provider](), key=os.path.getmtime, reverse=True)[:40]
        for path in paths:
            try:
                s = READ[provider](path, True)
            except OSError:
                continue
            # Nothing said, or a coordinator's own session (its turns are event records, not talk).
            if not s["id"] or not s["turns"] or s["turns"][0]["text"].startswith('{"history"'):
                continue
            found.append({"provider": provider, "id": s["id"], "cwd": s["cwd"], "title": " ".join(TAG.sub(" ", s["turns"][0]["text"]).split())[:140], "updated": int(os.path.getmtime(path)), "bytes": os.path.getsize(path)})
    found.sort(key=lambda s: -s["updated"])
    print(json.dumps({"sessions": found}))
else:
    provider, wanted = sys.argv[2], sys.argv[3]
    match = [p for p in FILES[provider]() if wanted in os.path.basename(p)]
    if not match:
        print(json.dumps({"error": "That session is no longer on this machine."}))
    else:
        s = READ[provider](max(match, key=os.path.getmtime), False)
        s["turns"] = s["turns"][-300:]
        print(json.dumps(s))
"#;

/// A session found on a machine.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Found {
    pub provider: String,
    pub id: String,
    pub cwd: String,
    /// What it was first asked, in a line.
    pub title: String,
    /// When it was last written to, in seconds since 1970.
    pub updated: i64,
    pub bytes: u64,
}

#[derive(Deserialize, Debug)]
pub struct Turn {
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub time: String,
}

/// A session read out: where it ran, and what was said.
#[derive(Deserialize, Debug)]
pub struct Read {
    pub id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub turns: Vec<Turn>,
}

fn command(arguments: &str) -> String {
    format!(
        "export PATH=\"$PATH:/opt/homebrew/bin:/usr/local/bin\"; command -v python3 >/dev/null 2>&1 || {{ echo '{{\"error\":\"python3 is not installed on this machine, so its sessions cannot be read.\"}}'; exit 0; }}; python3 - {arguments} <<'GOFER_SESSIONS'\n{SCRIPT}\nGOFER_SESSIONS"
    )
}

fn refused(reply: &serde_json::Value) -> Result<()> {
    if let Some(error) = reply["error"].as_str() {
        bail!("{error}");
    }
    Ok(())
}

/// The most recent Claude and Codex sessions on the machine, newest first.
pub async fn list(target: Option<&str>) -> Result<Vec<Found>> {
    let output = terminal::run_for(target, &command("list"), Duration::from_secs(40)).await?;
    let reply: serde_json::Value = serde_json::from_str(output.trim())
        .context("The machine's session list was not readable")?;
    refused(&reply)?;
    Ok(serde_json::from_value(reply["sessions"].clone())?)
}

/// Whether `id` is a session id as either tool writes one, safe to hand to a shell.
pub fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// One session's turns, oldest first (the last 300 of a long one).
pub async fn read(target: Option<&str>, provider: &str, id: &str) -> Result<Read> {
    if !matches!(provider, "claude" | "codex") || !valid_id(id) {
        bail!("Not a session Gofer can load");
    }
    let output = terminal::run_for(
        target,
        &command(&format!("read {provider} {id}")),
        Duration::from_secs(60),
    )
    .await?;
    let reply: serde_json::Value =
        serde_json::from_str(output.trim()).context("The session was not readable")?;
    refused(&reply)?;
    Ok(serde_json::from_value(reply)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_session_ids_reach_the_shell() {
        assert!(valid_id("01a101d5-240d-7d92-a7f0-97ddb80cc8e2"));
        assert!(!valid_id("x; rm -rf ~"));
        assert!(!valid_id("short"));
    }

    /// The script against real files in both tools' formats, when this machine has python3.
    #[tokio::test]
    async fn lists_and_reads_sessions_in_both_formats() {
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let claude = home.path().join(".claude/projects/-work");
        let codex = home.path().join(".codex/sessions/2026/10/03");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::create_dir_all(&codex).unwrap();
        std::fs::write(
            claude.join("11111111-aaaa-bbbb-cccc-222222222222.jsonl"),
            concat!(
                r#"{"type":"queue-operation","operation":"enqueue"}"#, "\n",
                r#"{"type":"user","cwd":"/work","timestamp":"2026-10-01T10:00:00Z","message":{"role":"user","content":"<recommended_plugins>a list</recommended_plugins>"}}"#, "\n",
                r#"{"type":"user","cwd":"/work","timestamp":"2026-10-01T10:00:00Z","message":{"role":"user","content":"<system-reminder>ignore</system-reminder><wake reason=\"mention\"><project id=\"p\"><message trigger=\"true\" from=\"human\">fix the build</message></project></wake>"}}"#, "\n",
                r#"{"type":"assistant","timestamp":"2026-10-01T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"Fixed: the lockfile was stale."},{"type":"tool_use","name":"Bash"}]}}"#, "\n",
                r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"a subagent's prompt"}}"#, "\n",
            ),
        )
        .unwrap();
        std::fs::write(
            codex.join("rollout-2026-10-03T13-55-08-01a101d5-240d-7d92-a7f0-97ddb80cc8e2.jsonl"),
            concat!(
                r#"{"type":"session_meta","payload":{"id":"01a101d5-240d-7d92-a7f0-97ddb80cc8e2","cwd":"/srv"}}"#, "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"rules"}]}}"#, "\n",
                r#"{"timestamp":"2026-10-03T12:55:10Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"check the disk"}]}}"#, "\n",
                r#"{"timestamp":"2026-10-03T12:55:20Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"It is 40% full."}]}}"#, "\n",
            ),
        )
        .unwrap();
        // The script reads $HOME; run it the way a device does, with this directory as home.
        let run = |arguments: &str| {
            let output = std::process::Command::new("sh")
                .arg("-c")
                .arg(command(arguments))
                .env("HOME", home.path())
                .output()
                .unwrap();
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        let listed: Vec<Found> = serde_json::from_value(run("list")["sessions"].clone()).unwrap();
        let mut seen: Vec<_> = listed
            .iter()
            .map(|s| (s.provider.as_str(), s.cwd.as_str(), s.title.as_str()))
            .collect();
        seen.sort();
        assert_eq!(
            seen,
            [
                ("claude", "/work", "fix the build"),
                ("codex", "/srv", "check the disk")
            ]
        );
        let read: Read =
            serde_json::from_value(run("read claude 11111111-aaaa-bbbb-cccc-222222222222"))
                .unwrap();
        let said: Vec<_> = read
            .turns
            .iter()
            .map(|t| (t.role.as_str(), t.text.as_str()))
            .collect();
        assert_eq!(
            said,
            [
                ("user", "fix the build"),
                ("assistant", "Fixed: the lockfile was stale.")
            ]
        );
        let read: Read =
            serde_json::from_value(run("read codex 01a101d5-240d-7d92-a7f0-97ddb80cc8e2")).unwrap();
        assert_eq!(read.turns.len(), 2);
        assert_eq!(read.cwd, "/srv");
    }
}
