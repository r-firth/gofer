//! Preserve SSH authentication banners while a connection is waiting for its user.
use anyhow::{Context, Result, bail};
use std::{
    future::Future,
    process::{Output, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{Instant, sleep_until},
};

pub trait AuthObserver: Send + Sync {
    fn required(&self, target: &str, url: &str) -> Result<String>;
    fn cancelled(&self, request: &str) -> bool;
    fn resolved(&self, request: &str, outcome: &str);
}
tokio::task_local! { static AUTH: Arc<dyn AuthObserver>; }
pub async fn with_auth<T>(observer: Arc<dyn AuthObserver>, future: impl Future<Output = T>) -> T {
    AUTH.scope(observer, future).await
}

pub fn auth_url(banner: &str) -> Option<String> {
    if !banner.contains("# Tailscale SSH requires an additional check.") {
        return None;
    }
    let url = banner
        .split_inclusive('\n')
        .filter(|line| line.ends_with('\n'))
        .find_map(|line| line.strip_prefix("# To authenticate, visit: "))?
        .trim();
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("login.tailscale.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || !parsed.path().starts_with("/a/")
        || parsed.path().len() <= 3
    {
        return None;
    }
    Some(url.into())
}

#[derive(Debug)]
struct AuthInterrupted {
    message: &'static str,
    before_command: bool,
}
impl std::fmt::Display for AuthInterrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for AuthInterrupted {}
pub fn rejected_before_command(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<AuthInterrupted>()
        .is_some_and(|e| e.before_command)
}

struct Prompt {
    observer: Arc<dyn AuthObserver>,
    request: String,
    outcome: &'static str,
}
impl Drop for Prompt {
    fn drop(&mut self) {
        self.observer.resolved(&self.request, self.outcome);
    }
}

async fn abort_before_command(
    child: &mut tokio::process::Child,
    stderr: &mut tokio::process::ChildStderr,
    err: &mut Vec<u8>,
    authenticated: bool,
) -> bool {
    // SSH may have received approval since our last stderr read. Stop it first,
    // then drain its banner before deciding whether a remote shell could exist.
    let stopped = child.kill().await.is_ok();
    let drained =
        tokio::time::timeout(Duration::from_secs(1), stderr.take(32_768).read_to_end(err)).await;
    stopped
        && !authenticated
        && matches!(drained, Ok(Ok(n)) if n < 32_768)
        && !String::from_utf8_lossy(err).contains("# Authentication checked with Tailscale SSH.")
}

pub async fn output(
    mut command: Command,
    target: Option<&str>,
    timeout: Duration,
) -> Result<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdout = child.stdout.take().context("SSH stdout missing")?;
    let mut stderr = child.stderr.take().context("SSH stderr missing")?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut out_buffer = [0; 8192];
    let mut err_buffer = [0; 2048];
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut status = None;
    let mut deadline = Instant::now() + timeout;
    let mut prompt: Option<Prompt> = None;
    let mut authenticated = false;
    let mut check = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            result = stdout.read(&mut out_buffer), if !stdout_done => {
                let n = result?;
                stdout_done = n == 0;
                out.extend_from_slice(&out_buffer[..n]);
            }
            result = stderr.read(&mut err_buffer), if !stderr_done => {
                let n = result?;
                stderr_done = n == 0;
                if err.len() < 32_768 { err.extend_from_slice(&err_buffer[..n]); }
                let banner = String::from_utf8_lossy(&err);
                if prompt.is_none() && let Some(target) = target
                    && let Some(url) = auth_url(&banner) {
                    let observer = AUTH.try_with(Arc::clone).ok();
                    let Some(observer) = observer else {
                        let before_command = abort_before_command(&mut child, &mut stderr, &mut err, authenticated).await;
                        return Err(AuthInterrupted { message: "Tailscale SSH sign-in required. Retry this operation from a conversation to show the sign-in prompt.", before_command }.into());
                    };
                    let request = observer.required(target, &url)?;
                    prompt = Some(Prompt { observer, request, outcome: "cancelled" });
                    deadline = Instant::now() + Duration::from_secs(15 * 60);
                }
                if !authenticated && prompt.is_some() && banner.contains("# Authentication checked with Tailscale SSH.") {
                    authenticated = true;
                    deadline = Instant::now() + timeout;
                }
            }
            result = child.wait(), if status.is_none() => { status = Some(result?); }
            _ = check.tick(), if prompt.is_some() => {
                let prompt = prompt.as_ref().unwrap();
                if prompt.observer.cancelled(&prompt.request) {
                    let before_command = abort_before_command(&mut child, &mut stderr, &mut err, authenticated).await;
                    return Err(AuthInterrupted { message: "Tailscale SSH sign-in cancelled. Do not retry or switch connection routes without the user's request.", before_command }.into());
                }
            }
            _ = sleep_until(deadline) => {
                if let Some(prompt) = prompt.as_mut() {
                    prompt.outcome = if authenticated { "connected" } else { "expired" };
                    let before_command = abort_before_command(&mut child, &mut stderr, &mut err, authenticated).await;
                    return Err(AuthInterrupted {
                        message: if authenticated { "SSH command timed out after authentication succeeded." } else { "Tailscale SSH sign-in expired. Retry the operation to request a new sign-in link." },
                        before_command,
                    }.into());
                }
                bail!("Connection timed out{}", if err.is_empty() { String::new() } else { format!(": {}", String::from_utf8_lossy(&err).trim()) });
            }
        }
        if let Some(status) = status
            && stdout_done
            && stderr_done
        {
            if let Some(prompt) = prompt.as_mut() {
                prompt.outcome = if status.success() || authenticated {
                    "connected"
                } else {
                    "failed"
                };
                // The sign-in card owns the link; don't copy it into command
                // errors, the agent's context, or embedded memory records.
                err = String::from_utf8_lossy(&err)
                    .lines()
                    .filter(|line| !line.starts_with("# To authenticate, visit: "))
                    .collect::<Vec<_>>()
                    .join("\n")
                    .into_bytes();
            }
            return Ok(Output {
                status,
                stdout: out,
                stderr: err,
            });
        }
    }
}
