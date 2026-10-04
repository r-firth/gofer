use crate::{shell_quote, validate_target};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use tokio::{
    process::Command,
    sync::{mpsc, watch},
};

/// Gofer's own tmux server and output spool on every device, so it can run
/// beside another hub on the same host.
const SOCKET: &str = "gofer";
const SPOOL: &str = "$HOME/.local/state/gofer/terminals";

#[derive(Default)]
struct Views {
    sizes: HashMap<String, (u16, u16)>,
    // Oldest to newest explicitly activated viewer. Passive reconnections
    // after a server restart must not seize the preserved shell geometry.
    recent: Vec<String>,
}

pub struct Terminal {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    views: Mutex<Views>,
    geometry: watch::Sender<(u16, u16)>,
}
impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap().kill();
    }
}
fn name(id: &str) -> Result<String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        bail!("invalid terminal ID");
    }
    Ok(format!("hub_{id}"))
}
fn remote_command(target: Option<&str>, command: &str) -> Result<Command> {
    let mut cmd = if let Some(host) = target {
        if !validate_target(host) {
            bail!("invalid SSH destination");
        }
        let mut c = Command::new("ssh");
        c.args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ServerAliveInterval=15",
            "--",
            host,
            command,
        ]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-lc", command]);
        c
    };
    cmd.kill_on_drop(true);
    Ok(cmd)
}
pub async fn run(target: Option<&str>, command: &str) -> Result<String> {
    run_for(target, command, std::time::Duration::from_secs(15)).await
}

/// `run`, for a command that needs longer than a lookup does (an install, say).
pub async fn run_for(
    target: Option<&str>,
    command: &str,
    limit: std::time::Duration,
) -> Result<String> {
    let result = crate::ssh::output(remote_command(target, command)?, target, limit).await?;
    if !result.status.success() {
        bail!("{}", String::from_utf8_lossy(&result.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&result.stdout).into_owned())
}

/// A loop on the device that captures its desktop through cua-driver and prints one line per
/// frame: `F <kind> <base64>`, or `E <reason>` when it cannot. cua-driver's daemon holds the
/// screen-recording grant, so this works over SSH. It runs until the connection drops.
const SCREEN_FEED: &str = r#"export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
command -v cua-driver >/dev/null 2>&1 || { echo "E cua-driver is not installed on this machine, so its screen cannot be shown."; exit 0; }
cua-driver status >/dev/null 2>&1 || { [ "$(uname)" = Darwin ] && open -n -g -a CuaDriver --args serve >/dev/null 2>&1 && sleep 2; }
d=$(mktemp -d /tmp/gofer-screen.XXXXXX) || exit 1
# A label of its own: cua-driver will not reuse one whose session has been ended.
s="gofer-view-$$"
trap 'rm -rf "$d"; cua-driver call end_session "{\"session\":\"$s\"}" >/dev/null 2>&1; exit 0' EXIT HUP INT TERM PIPE
while :; do
  if out=$(cua-driver call get_desktop_state "{\"max_image_dimension\":1500,\"screenshot_out_file\":\"$d/s.png\",\"session\":\"$s\"}" 2>&1); then
    if command -v sips >/dev/null 2>&1 && sips -s format jpeg -s formatOptions 55 "$d/s.png" --out "$d/s.jpg" >/dev/null 2>&1; then
      printf 'F jpeg '; base64 < "$d/s.jpg" | tr -d '\n'
    else
      printf 'F png '; base64 < "$d/s.png" | tr -d '\n'
    fi
    echo
  else
    echo "E $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
    sleep 3
  fi
  sleep 0.05
done"#;

/// Starts the screen feed on a device. Its stdout is the frames; killing it ends the capture.
pub fn screen_feed(target: Option<&str>) -> Result<tokio::process::Child> {
    let mut command = remote_command(target, SCREEN_FEED)?;
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    Ok(command.spawn()?)
}

/// These SSH failures happen before the remote command can run. A generic
/// timeout or a lost connection is ambiguous: it may have created the shell.
pub fn rejected_before_command(message: &str) -> bool {
    message.lines().any(|line| {
        line == "Host key verification failed."
            || line.starts_with("ssh: Could not resolve hostname ")
            || line.starts_with("tailscale: tailnet policy does not permit you to SSH as user ")
            || line.contains(": Permission denied (publickey")
            || (line.starts_with("ssh: connect to host ")
                && [
                    "Connection refused",
                    "No route to host",
                    "Network is unreachable",
                    "Operation timed out",
                    "Connection timed out",
                ]
                .iter()
                .any(|reason| line.ends_with(reason)))
    })
}

/// Copy an explicit image file over the device's configured short SSH target.
/// This does not create a terminal or require control of an existing one.
pub async fn read_image(target: &str, path: &str) -> Result<Vec<u8>> {
    if !path.starts_with('/') || path.contains('\0') {
        bail!("Use an absolute image path on the selected device");
    }
    let quoted = shell_quote(path);
    let limit = crate::artifacts::MAX_IMAGE_BYTES + 1;
    let command = format!(
        "if test -f {quoted}; then head -c {limit} {quoted}; else printf 'Image file not found' >&2; exit 1; fi"
    );
    let result = crate::ssh::output(
        remote_command(Some(target), &command)?,
        Some(target),
        std::time::Duration::from_secs(30),
    )
    .await?;
    if !result.status.success() {
        bail!(
            "Could not read image: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        );
    }
    if result.stdout.len() > crate::artifacts::MAX_IMAGE_BYTES {
        bail!("Images are limited to 25 MB");
    }
    Ok(result.stdout)
}
impl Terminal {
    /// Stop this host's attachment; the detached shell has its own lifecycle.
    pub fn disconnect(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    pub async fn open(
        id: &str,
        target: Option<&str>,
        cwd: &str,
    ) -> Result<(Arc<Self>, mpsc::Receiver<Vec<u8>>)> {
        let session = name(id)?;
        let cwd = if cwd.is_empty() {
            "\"$HOME\"".to_string()
        } else {
            shell_quote(cwd)
        };
        // A detached tmux server owns the shell. Closing our attachment cannot terminate it.
        let log_command = shell_quote(&format!("cat >> \"{SPOOL}/{id}.log\""));
        let setup = format!(
            "umask 077; mkdir -p \"{SPOOL}\"; command -v tmux >/dev/null || {{ echo 'Install tmux on this device to enable persistent terminals.' >&2; exit 1; }}; tmux -L {SOCKET} has-session -t {session} 2>/dev/null || tmux -L {SOCKET} new-session -d -s {session} -x 120 -y 32 -c {cwd}; tmux -L {SOCKET} set-option -t {session} status off; tmux -L {SOCKET} set-option -t {session} history-limit 50000; if test \"$(tmux -L {SOCKET} display-message -p -t {session} '#{{pane_pipe}}')\" != 1; then tmux -L {SOCKET} pipe-pane -t {session} {log_command}; fi"
        );
        // Reattach at the pane's existing size. Starting every attachment at
        // 120x32 and then fitting the browser reflows a multiline shell prompt
        // twice, leaving abandoned prompt lines in tmux's scrollback.
        let dimensions = run(
            target,
            &format!("{setup}; tmux -L {SOCKET} display-message -p -t {session} '#{{pane_width}} #{{pane_height}}'"),
        )
        .await?;
        let mut dimensions = dimensions
            .lines()
            .last()
            .context("Terminal dimensions missing")?
            .split_whitespace();
        let cols: u16 = dimensions
            .next()
            .context("Terminal width missing")?
            .parse()?;
        let rows: u16 = dimensions
            .next()
            .context("Terminal height missing")?
            .parse()?;
        if cols == 0 || rows == 0 {
            bail!("Invalid terminal dimensions");
        }
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        // Browser terminals decode UTF-8, even when launchd or the remote SSH
        // environment has an ASCII locale. Otherwise tmux substitutes '_'.
        let attach = format!("tmux -u -L {SOCKET} attach-session -t {session}");
        let mut command = if let Some(host) = target {
            let mut c = CommandBuilder::new("ssh");
            c.args([
                "-tt",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=8",
                "-o",
                "ServerAliveInterval=15",
                "--",
                host,
                &attach,
            ]);
            c
        } else {
            let mut c = CommandBuilder::new("sh");
            c.args(["-lc", &attach]);
            c
        };
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let terminal = Arc::new(Self {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            views: Mutex::new(Views::default()),
            geometry: watch::channel((cols, rows)).0,
        });
        let (tx, rx) = mpsc::channel(64);
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok((terminal, rx))
    }
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let (cols, rows) = (cols.clamp(20, 400), rows.clamp(5, 150));
        if *self.geometry.borrow() == (cols, rows) {
            return Ok(());
        }
        self.master.lock().unwrap().resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        self.geometry.send_replace((cols, rows));
        Ok(())
    }
    pub fn geometry(&self) -> watch::Receiver<(u16, u16)> {
        self.geometry.subscribe()
    }
    pub fn size_view(&self, view: &str, cols: u16, rows: u16, active: bool) -> Result<()> {
        let mut views = self.views.lock().unwrap();
        views.sizes.insert(view.into(), (cols, rows));
        if active {
            views.recent.retain(|id| id != view);
            views.recent.push(view.into());
        }
        if views.recent.last().map(String::as_str) == Some(view) {
            self.resize(cols, rows)?;
        }
        Ok(())
    }
    pub fn remove_view(&self, view: &str) -> Result<()> {
        let mut views = self.views.lock().unwrap();
        views.sizes.remove(view);
        let was_active = views.recent.last().map(String::as_str) == Some(view);
        views.recent.retain(|id| id != view);
        if was_active {
            // Restore the previous viewer, using its latest reported dimensions.
            if let Some(&(cols, rows)) = views.recent.last().and_then(|id| views.sizes.get(id)) {
                self.resize(cols, rows)?;
            }
        }
        Ok(())
    }
}
pub async fn capture(id: &str, target: Option<&str>) -> Result<String> {
    run(
        target,
        &format!(
            "tmux -L {SOCKET} capture-pane -p -e -S -2000 -t {}",
            name(id)?
        ),
    )
    .await
}

#[derive(serde::Serialize)]
pub struct History {
    pub cols: u16,
    pub rows: u16,
    pub text: String,
}

/// A read-only snapshot for one viewer. Never enter the shared pane's copy mode.
pub async fn history(id: &str, target: Option<&str>) -> Result<History> {
    let session = name(id)?;
    let output = run(target, &format!(
        "tmux -L {SOCKET} display-message -p -t {session} '#{{pane_width}} #{{pane_height}}' && tmux -L {SOCKET} capture-pane -p -e -S -10000 -t {session}"
    )).await?;
    let (dimensions, text) = output
        .split_once('\n')
        .context("Terminal dimensions missing")?;
    let mut dimensions = dimensions.split_whitespace();
    Ok(History {
        cols: dimensions
            .next()
            .context("Terminal width missing")?
            .parse()?,
        rows: dimensions
            .next()
            .context("Terminal height missing")?
            .parse()?,
        text: text.trim_end_matches('\n').into(),
    })
}
pub async fn close(id: &str, target: Option<&str>) -> Result<()> {
    match run(
        target,
        &format!("tmux -L {SOCKET} kill-session -t {}", name(id)?),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(error) => {
            let message = error.to_string();
            // An exited shell is already stopped. Transport, authentication,
            // and permission failures must still reach the caller.
            if message == "no current target"
                || message.starts_with("can't find session:")
                || message.starts_with("no server running on ")
                || (message.starts_with("error connecting to ")
                    && message.ends_with("(No such file or directory)"))
            {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

pub async fn read_log(id: &str, target: Option<&str>, offset: u64) -> Result<Vec<u8>> {
    name(id)?;
    let path = format!("\"{SPOOL}/{id}.log\"");
    let encoded = run(
        target,
        &format!(
            "if test -f {path}; then tail -c +{} {path} | head -c 4096 | base64; fi",
            offset.saturating_add(1)
        ),
    )
    .await?;
    let compact: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
    Ok(B64.decode(compact)?)
}
