use anyhow::Result;
use hub_server::ssh::{self, AuthObserver};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::Command;

#[derive(Default)]
struct Observer {
    events: Mutex<Vec<String>>,
    cancel: bool,
    cancel_delay: Duration,
}
impl AuthObserver for Observer {
    fn required(&self, target: &str, url: &str) -> Result<String> {
        self.events.lock().unwrap().push(format!("{target} {url}"));
        Ok("request".into())
    }
    fn cancelled(&self, _request: &str) -> bool {
        std::thread::sleep(self.cancel_delay);
        self.cancel
    }
    fn resolved(&self, _request: &str, outcome: &str) {
        self.events.lock().unwrap().push(outcome.into());
    }
}

#[tokio::test]
async fn approval_racing_with_cancellation_cannot_mark_a_shell_as_never_started() {
    let observer = Arc::new(Observer {
        cancel: true,
        cancel_delay: Duration::from_millis(400),
        ..Default::default()
    });
    // Wide margins: approval lands well before the cancellation is noticed, and the command
    // outlives both, however slow the machine running the test is.
    let error = ssh::with_auth(observer, ssh::output(
        command("printf '# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/test-auth\n' >&2; sleep 0.05; printf '# Authentication checked with Tailscale SSH.\n' >&2; sleep 1.5"),
        Some("server"), Duration::from_secs(5),
    )).await.unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    assert!(
        !ssh::rejected_before_command(&error),
        "Authentication succeeded while cancellation was being processed; a remote shell may exist"
    );
}

fn command(script: &str) -> Command {
    let mut cmd = Command::new("sh");
    cmd.args(["-c", script]).kill_on_drop(true);
    cmd
}

#[tokio::test]
async fn sign_in_banner_is_visible_while_ssh_waits_then_the_same_command_completes() {
    let observer = Arc::new(Observer::default());
    let result = ssh::with_auth(observer.clone(), ssh::output(
        command("printf '# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/test-auth\n' >&2; sleep 0.15; printf '# Authentication checked with Tailscale SSH.\n' >&2; printf connected"),
        Some("server"), Duration::from_millis(50),
    )).await.unwrap();
    assert_eq!(result.stdout, b"connected");
    assert_eq!(
        *observer.events.lock().unwrap(),
        [
            "server https://login.tailscale.com/a/test-auth",
            "connected"
        ]
    );
}

#[tokio::test]
async fn cancelling_sign_in_never_runs_the_remote_command() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("ran");
    let observer = Arc::new(Observer {
        cancel: true,
        ..Default::default()
    });
    let result = ssh::with_auth(observer.clone(), ssh::output(
        command(&format!("printf '# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/test-auth\n' >&2; sleep 0.3; touch {}", hub_server::shell_quote(marker.to_str().unwrap()))),
        Some("server"), Duration::from_secs(1),
    )).await;
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!marker.exists());
    assert_eq!(observer.events.lock().unwrap().last().unwrap(), "cancelled");
}

#[test]
fn authentication_links_require_the_tailscale_banner_and_exact_login_origin() {
    let partial = "# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/partial";
    assert!(ssh::auth_url(partial).is_none());
    assert_eq!(
        ssh::auth_url(&format!("{partial}-complete\n")),
        Some("https://login.tailscale.com/a/partial-complete".into())
    );
    for url in [
        "https://login.tailscale.com.evil.test/a/test",
        "http://login.tailscale.com/a/test",
        "https://login.tailscale.com@evil.test/a/test",
        "https://login.tailscale.com/other",
    ] {
        assert!(
            ssh::auth_url(&format!(
                "# Tailscale SSH requires an additional check.\n# To authenticate, visit: {url}\n"
            ))
            .is_none()
        );
    }
    assert!(ssh::auth_url("https://login.tailscale.com/a/test").is_none());
}

#[tokio::test]
async fn ordinary_timeouts_keep_the_diagnostic_stderr() {
    let result = ssh::output(
        command("printf 'Connecting to host\n' >&2; sleep 0.15"),
        Some("server"),
        Duration::from_millis(50),
    )
    .await;
    let message = result.unwrap_err().to_string();
    assert!(message.contains("timed out") && message.contains("Connecting to host"));
}
