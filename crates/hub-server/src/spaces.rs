//! A device's desktop as live video, from Cua Spaces' daemon (cua-spacesd) on that device.
//!
//! The daemon listens on the device's own loopback only (`scripts/setup-spaces.sh` sets it up
//! that way), so it is reached the way everything else on a device is: over SSH, here as a port
//! forward. A media session is opened with the daemon's token (`StreamService.OpenMedia`, gRPC-Web)
//! and the media WebSocket is attached with the ticket that comes back. What flows then is the
//! rcdp v2 wire: JSON control as text, and one length-prefixed packet per H.264 access unit as
//! binary. Gofer relays the packets to the page untouched.
use crate::validate_target;
use anyhow::{Context, Result, bail};
use std::{process::Stdio, time::Duration};
use tokio::{net::TcpStream, process::Child};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// Where cua-spacesd listens on a device. `GOFER_SPACESD_PORT` moves it, for a stand-in in tests.
fn port() -> u16 {
    std::env::var("GOFER_SPACESD_PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(3211)
}
/// The long edge of the video, in pixels. A Retina desktop is twice this; the view is not.
const LONG_EDGE: u64 = 1920;
const FRAMES_PER_SECOND: u64 = 60;

/// An attached media socket, and the SSH forward it runs through when the device is remote.
pub struct View {
    pub socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    _forward: Option<Child>,
}

/// The token of a cua-spacesd that is up on the device, if there is one.
pub async fn token(target: Option<&str>) -> Option<String> {
    let script = format!(
        r#"t=$(cat "$HOME/.cua/spacesd/token" 2>/dev/null) && [ -n "$t" ] && [ "$(curl -s -m 3 -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{}/health)" = 204 ] && printf 'TOKEN=%s\n' "$t""#,
        port()
    );
    let output = crate::terminal::run(target, &script).await.ok()?;
    output
        .lines()
        .find_map(|line| line.strip_prefix("TOKEN="))
        .filter(|token| !token.is_empty() && token.chars().all(|c| c.is_ascii_graphic()))
        .map(str::to_owned)
}

/// Opens a view-only stream of the device's primary display.
pub async fn open(target: Option<&str>, token: &str) -> Result<View> {
    let (port, forward) = match target {
        None => (port(), None),
        Some(host) => {
            if !validate_target(host) {
                bail!("invalid SSH destination");
            }
            // A free port, found by binding one and letting it go for ssh to take.
            let port = std::net::TcpListener::bind("127.0.0.1:0")?
                .local_addr()?
                .port();
            let forward = tokio::process::Command::new("ssh")
                .args([
                    "-N",
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ExitOnForwardFailure=yes",
                    "-o",
                    "ConnectTimeout=8",
                    "-o",
                    "ServerAliveInterval=15",
                    "-L",
                    &format!("127.0.0.1:{port}:127.0.0.1:{}", self::port()),
                    "--",
                    host,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .context("could not start the SSH forward")?;
            let mut listening = false;
            for _ in 0..50 {
                if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                    listening = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            if !listening {
                bail!("the SSH forward to cua-spacesd did not come up");
            }
            (port, Some(forward))
        }
    };
    let base = format!("127.0.0.1:{port}");
    let path = open_media(&base, token).await?;
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(format!("ws://{base}{path}")),
    )
    .await
    .context("the media socket did not answer")?
    .context("the media socket refused the ticket")?;
    Ok(View {
        socket,
        _forward: forward,
    })
}

fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/// `cua.env.v1.OpenMediaRequest`: the primary display, H.264, view only.
fn open_media_request() -> Vec<u8> {
    let display = b"primary";
    let mut message = vec![0x0a, display.len() as u8 + 2, 0x0a, display.len() as u8];
    message.extend_from_slice(display);
    message.extend_from_slice(&[0x12, 0x01, 0x01]); // codecs: [MEDIA_CODEC_H264]
    message.push(0x18); // max_fps
    varint(&mut message, FRAMES_PER_SECOND);
    message.push(0x20); // max_dimension
    varint(&mut message, LONG_EDGE);
    message.extend_from_slice(&[0x30, 0x01]); // policy: SESSION_POLICY_VIEW_ONLY
    message
}

/// The `ws_path` (field 4) of a `cua.env.v1.OpenMediaResponse`.
fn ws_path(mut message: &[u8]) -> Option<String> {
    fn read_varint(bytes: &mut &[u8]) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let (&byte, rest) = bytes.split_first()?;
            *bytes = rest;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }
    while !message.is_empty() {
        let tag = read_varint(&mut message)?;
        match tag & 7 {
            0 => {
                read_varint(&mut message)?;
            }
            1 => message = message.get(8..)?,
            5 => message = message.get(4..)?,
            2 => {
                let length = read_varint(&mut message)? as usize;
                let value = message.get(..length)?;
                message = &message[length..];
                if tag >> 3 == 4 {
                    return String::from_utf8(value.to_vec()).ok();
                }
            }
            _ => return None,
        }
    }
    None
}

async fn open_media(base: &str, token: &str) -> Result<String> {
    let message = open_media_request();
    let mut body = vec![0u8];
    body.extend_from_slice(&(message.len() as u32).to_be_bytes());
    body.extend_from_slice(&message);
    let response = reqwest::Client::new()
        .post(format!("http://{base}/cua.env.v1.StreamService/OpenMedia"))
        .header("content-type", "application/grpc-web+proto")
        .header("x-grpc-web", "1")
        .bearer_auth(token)
        .timeout(Duration::from_secs(15))
        .body(body)
        .send()
        .await
        .context("cua-spacesd did not answer")?;
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    // A refusal can arrive in the headers alone, or in a trailer frame after an empty body.
    let mut status = header("grpc-status");
    let mut reason = header("grpc-message");
    let http = response.status();
    let bytes = response.bytes().await?;
    let mut rest = &bytes[..];
    let mut path = None;
    while rest.len() >= 5 {
        let length = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
        let Some(frame) = rest.get(5..5 + length) else {
            break;
        };
        if rest[0] & 0x80 == 0 {
            path = ws_path(frame);
        } else {
            for line in String::from_utf8_lossy(frame).lines() {
                if let Some((name, value)) = line.split_once(':') {
                    match name.trim().to_ascii_lowercase().as_str() {
                        "grpc-status" => status = Some(value.trim().into()),
                        "grpc-message" => reason = Some(value.trim().into()),
                        _ => {}
                    }
                }
            }
        }
        rest = &rest[5 + length..];
    }
    if let Some(path) = path.filter(|path| path.starts_with("/media")) {
        return Ok(path);
    }
    bail!(
        "cua-spacesd would not open the screen: {}",
        reason.unwrap_or_else(|| format!(
            "HTTP {http}, gRPC status {}",
            status.as_deref().unwrap_or("unknown")
        ))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_for_the_primary_display_as_view_only_h264() {
        assert_eq!(
            open_media_request(),
            [
                &[0x0a, 0x09, 0x0a, 0x07][..],
                b"primary",
                &[0x12, 0x01, 0x01, 0x18, 60, 0x20, 0x80, 0x0f, 0x30, 0x01],
            ]
            .concat()
        );
    }

    #[test]
    fn finds_the_socket_path_among_the_other_fields() {
        // media_session_id, ticket, a nested timestamp, ws_path, then codec.
        let mut response = vec![
            0x0a, 0x02, b'i', b'd', 0x12, 0x01, b't', 0x1a, 0x02, 0x08, 0x05,
        ];
        let path = b"/media?ticket=t";
        response.extend_from_slice(&[0x22, path.len() as u8]);
        response.extend_from_slice(path);
        response.extend_from_slice(&[0x30, 0x01]);
        assert_eq!(ws_path(&response).as_deref(), Some("/media?ticket=t"));
        assert_eq!(ws_path(&[0x22, 0x7f, b'x']), None);
    }
}
