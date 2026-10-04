//! What a machine has of the things Gofer works through, and what it takes to supply the rest.
//!
//! One script is run on the machine over SSH and reports a word per item. Each item then says
//! what it is for and, when it is missing, either a fix Gofer can apply itself (`fix`) or the
//! one command Ryan has to run there (`command`): a sign-in, an install that needs his password,
//! a permission only he can grant.
use crate::terminal;
use anyhow::{Result, bail};
use serde::Serialize;
use std::time::Duration;

const PROBE: &str = r#"export PATH="$PATH:$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin"
echo "os=$(uname -s)"
command -v tmux >/dev/null 2>&1 && echo "tmux=ok" || echo "tmux=missing"
if command -v claude >/dev/null 2>&1; then
  case "$(claude auth status 2>/dev/null | tr -d ' \n')" in *'"loggedIn":true'*) echo "claude=ok";; *) echo "claude=signin";; esac
else echo "claude=missing"; fi
if command -v codex >/dev/null 2>&1; then
  codex login status >/dev/null 2>&1 && echo "codex=ok" || echo "codex=signin"
else echo "codex=missing"; fi
if command -v cua-driver >/dev/null 2>&1; then
  if cua-driver status >/dev/null 2>&1; then
    p=$(cua-driver permissions status --json 2>/dev/null | tr -d ' \n')
    case "$p" in *'"accessibility":true'*) a=1;; *) a=;; esac
    case "$p" in *'"screen_recording":true'*) r=1;; *) r=;; esac
    if [ "$(uname -s)" != Darwin ] || { [ -n "$a" ] && [ -n "$r" ]; }; then echo "cua=ok"; else echo "cua=permissions"; fi
  else echo "cua=stopped"; fi
else echo "cua=missing"; fi
if [ -s "$HOME/.cua/spacesd/token" ]; then
  [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3211/health)" = 204 ] && echo "spaces=ok" || echo "spaces=stopped"
else echo "spaces=missing"; fi
exit 0"#;

/// One thing a machine needs, and where it stands.
#[derive(Serialize, Debug, PartialEq)]
pub struct Item {
    pub id: &'static str,
    pub label: &'static str,
    /// What it is for, or what is wrong.
    pub detail: String,
    /// `ok`, `missing` (not there), `needs_you` (there, but waiting on him) or `optional`.
    pub state: &'static str,
    /// A fix Gofer applies itself: the step for `apply`.
    pub fix: Option<&'static str>,
    /// A command for him to run on the machine.
    pub command: Option<String>,
}

fn item(id: &'static str, label: &'static str, detail: &str, state: &'static str) -> Item {
    Item {
        id,
        label,
        detail: detail.into(),
        state,
        fix: None,
        command: None,
    }
}

/// Turns the probe's words into the list shown for a machine.
pub fn items(report: &str) -> Vec<Item> {
    let word = |key: &str| {
        report
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .unwrap_or("")
            .trim()
    };
    let mac = word("os") == "Darwin";
    let mut list = vec![item(
        "ssh",
        "ssh",
        "Gofer can log in and run commands.",
        "ok",
    )];

    let mut tmux = item(
        "tmux",
        "terminal",
        "tmux keeps shells alive between visits.",
        "ok",
    );
    if word("tmux") != "ok" {
        tmux.state = "missing";
        tmux.detail = "tmux is not installed, so Gofer cannot open a terminal here.".into();
        tmux.command = Some(
            if mac {
                "brew install tmux"
            } else {
                "sudo apt install -y tmux"
            }
            .into(),
        );
    }
    list.push(tmux);

    let mut claude = item(
        "claude",
        "claude",
        "Claude Code is installed and signed in.",
        "ok",
    );
    match word("claude") {
        "ok" => {}
        "signin" => {
            claude.state = "needs_you";
            if mac {
                // Over SSH a Mac's login Keychain is locked, so the sign-in has to be a token.
                claude.detail = "Claude Code is not signed in over SSH. On a Mac that takes a token: run the command, then put the token it prints in ~/.zshenv as `export CLAUDE_CODE_OAUTH_TOKEN=...`.".into();
                claude.command = Some("claude setup-token".into());
            } else {
                claude.detail = "Claude Code is installed but not signed in.".into();
                claude.command = Some("claude auth login".into());
            }
        }
        _ => {
            claude.state = "missing";
            claude.detail =
                "Claude Code is not installed, so Claude strands cannot run here.".into();
            claude.command = Some("curl -fsSL https://claude.ai/install.sh | bash".into());
        }
    }
    list.push(claude);

    let mut codex = item("codex", "codex", "Codex is installed and signed in.", "ok");
    match word("codex") {
        "ok" => {}
        "signin" => {
            codex.state = "needs_you";
            codex.detail = "Codex is installed but not signed in.".into();
            codex.command = Some("codex login".into());
        }
        _ => {
            codex.state = "missing";
            codex.detail = "Codex is not installed, so Codex strands cannot run here.".into();
            codex.command = Some("npm install -g @openai/codex".into());
        }
    }
    list.push(codex);

    let mut cua = item(
        "cua",
        "computer use",
        "cua-driver is running with the permissions it needs.",
        "ok",
    );
    match word("cua") {
        "ok" => {}
        "stopped" => {
            cua.state = "missing";
            cua.detail = "cua-driver is installed but its daemon is not running.".into();
            cua.fix = Some("cua-start");
        }
        "permissions" => {
            cua.state = "needs_you";
            cua.detail = "cua-driver needs Accessibility and Screen Recording. The command opens both; switch on CuaDriver in each.".into();
            cua.command = Some("cua-driver permissions grant".into());
        }
        _ => {
            cua.state = if mac { "missing" } else { "optional" };
            cua.detail = if mac {
                "cua-driver is not installed, so strands here cannot see or use the screen. After the command, switch on CuaDriver under Accessibility and under Screen Recording."
            } else {
                "cua-driver is not installed. Only worth it on a machine with a desktop."
            }
            .into();
            cua.command = Some(if mac {
                r#"/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)" && open -n -g -a CuaDriver --args serve && ~/.local/bin/cua-driver permissions grant"#
            } else {
                r#"/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)""#
            }.into());
        }
    }
    list.push(cua);

    let mut spaces = item(
        "spaces",
        "screen video",
        "cua-spacesd is running: the screen view is video.",
        "ok",
    );
    match word("spaces") {
        "ok" => {}
        "stopped" => {
            spaces.state = "missing";
            spaces.detail = "cua-spacesd is installed but not answering.".into();
            spaces.fix = Some("spaces-start");
        }
        _ if mac => {
            spaces.state = "missing";
            spaces.detail = "cua-spacesd is not installed, so the screen view here is slow stills. Gofer can install it; you then switch on Cua Spacesd under Screen Recording on that Mac.".into();
            spaces.fix = Some("spaces-install");
        }
        _ => {
            spaces.state = "optional";
            spaces.detail =
                "cua-spacesd is not installed. Only worth it on a machine with a desktop.".into();
        }
    }
    list.push(spaces);
    list
}

/// The list for a machine Gofer could not log in to: why, and what would let it in.
/// `host_key` is the Gofer host's public SSH key, for a machine that does not accept it yet.
pub fn unreachable(error: &str, host_key: Option<&str>, windows: bool) -> Vec<Item> {
    let mut ssh = item("ssh", "ssh", "", "needs_you");
    if error.contains("Permission denied (publickey") {
        ssh.detail = if windows {
            // Terminals and agents run in a Unix shell; on Windows that means WSL.
            "This machine does not accept the Gofer host's ssh key. It runs Windows, and Gofer works through a Unix shell, so it needs WSL with its own ssh server. Run the command inside WSL, then check again."
        } else {
            "This machine does not accept the Gofer host's ssh key. Run the command on it to let Gofer in, then check again."
        }
        .into();
        ssh.command = host_key
            .map(str::trim)
            .filter(|key| !key.is_empty() && !key.contains('\''))
            .map(|key| format!("mkdir -p ~/.ssh && echo '{key}' >> ~/.ssh/authorized_keys"));
    } else if error.contains("tailnet policy does not permit you to SSH as user") {
        ssh.detail = format!(
            "Tailscale's rules refuse this login ({}). Add the machine again with the user it expects (user@host), or allow this user in the tailnet's SSH rules.",
            error.trim()
        );
    } else {
        ssh.detail = format!("Gofer could not log in: {}", error.trim());
    }
    vec![ssh]
}

/// The list while Tailscale waits for him to approve the connection at `link`.
pub fn awaiting_sign_in(link: &str) -> Vec<Item> {
    let mut ssh = item("ssh", "ssh", "", "needs_you");
    ssh.detail = format!(
        "Tailscale wants you to approve this connection before Gofer can reach the machine. Open the link, approve it, then check again: {link}"
    );
    vec![ssh]
}

/// Looks at the machine now.
pub async fn check(target: Option<&str>) -> Result<Vec<Item>> {
    Ok(items(
        &terminal::run_for(target, PROBE, Duration::from_secs(40)).await?,
    ))
}

/// Applies one of the fixes `items` offers, on the machine.
pub async fn apply(target: Option<&str>, step: &str) -> Result<String> {
    let path = r#"export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"; "#;
    let (command, limit) = match step {
        "cua-start" => (
            format!("{path}cua-driver status >/dev/null 2>&1 || {{ open -n -g -a CuaDriver --args serve; sleep 2; }}; cua-driver status | head -1"),
            20,
        ),
        "spaces-start" => (
            r#"launchctl kickstart -k "gui/$(id -u)/com.trycua.spacesd" && sleep 2 && curl -s -m 3 -o /dev/null -w 'cua-spacesd answered %{http_code}\n' http://127.0.0.1:3211/health"#.to_string(),
            20,
        ),
        // The same script he would run by hand, sent over SSH. It needs no password.
        "spaces-install" => (
            format!(
                "bash -c {}",
                crate::shell_quote(include_str!("../../../scripts/setup-spaces.sh"))
            ),
            300,
        ),
        _ => bail!("Unknown setup step"),
    };
    terminal::run_for(target, &command, Duration::from_secs(limit)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn states(report: &str) -> Vec<(&'static str, &'static str)> {
        items(report).into_iter().map(|i| (i.id, i.state)).collect()
    }

    #[test]
    fn a_mac_with_everything_is_ready() {
        let report = "os=Darwin\ntmux=ok\nclaude=ok\ncodex=ok\ncua=ok\nspaces=ok\n";
        assert!(
            items(report)
                .iter()
                .all(|i| i.state == "ok" && i.fix.is_none() && i.command.is_none())
        );
    }

    #[test]
    fn says_what_only_he_can_do_and_what_gofer_can() {
        let mac = items(
            "os=Darwin\ntmux=ok\nclaude=signin\ncodex=missing\ncua=permissions\nspaces=missing\n",
        );
        let by = |id: &str| mac.iter().find(|i| i.id == id).unwrap();
        assert_eq!(by("claude").command.as_deref(), Some("claude setup-token"));
        assert_eq!(by("claude").state, "needs_you");
        assert_eq!(by("codex").state, "missing");
        assert_eq!(
            by("cua").command.as_deref(),
            Some("cua-driver permissions grant")
        );
        assert_eq!(by("spaces").fix, Some("spaces-install"));
        assert_eq!(
            items("os=Darwin\ncua=stopped\nspaces=stopped\n")[4].fix,
            Some("cua-start")
        );
    }

    #[test]
    fn a_machine_it_cannot_reach_says_how_to_let_it_in() {
        let refused = unreachable(
            "me@desktop: Permission denied (publickey,password).",
            Some("ssh-ed25519 AAAA gofer@homeserver\n"),
            false,
        );
        assert_eq!(refused[0].state, "needs_you");
        assert_eq!(
            refused[0].command.as_deref(),
            Some(
                "mkdir -p ~/.ssh && echo 'ssh-ed25519 AAAA gofer@homeserver' >> ~/.ssh/authorized_keys"
            )
        );
        assert!(
            unreachable("Connection timed out", None, false)[0]
                .command
                .is_none()
        );
        assert!(
            unreachable("x: Permission denied (publickey).", None, true)[0]
                .detail
                .contains("WSL")
        );
        assert!(
            awaiting_sign_in("https://login.tailscale.com/a/1")[0]
                .detail
                .ends_with("https://login.tailscale.com/a/1")
        );
    }

    #[test]
    fn a_headless_server_is_not_nagged_about_a_screen() {
        assert_eq!(
            states("os=Linux\ntmux=ok\nclaude=ok\ncodex=signin\ncua=missing\nspaces=missing\n"),
            [
                ("ssh", "ok"),
                ("tmux", "ok"),
                ("claude", "ok"),
                ("codex", "needs_you"),
                ("cua", "optional"),
                ("spaces", "optional"),
            ]
        );
    }
}
