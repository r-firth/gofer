//! Discover SSH hosts from the local Tailscale network map. No login or remote commands.
use crate::validate_target;
use anyhow::{Context, Result, bail};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpStream,
    process::Command,
    time::timeout,
};

#[derive(Clone, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub target: Option<String>,
    pub status: String,
    pub source: String,
    pub tailscale_id: Option<String>,
    pub os: String,
    pub address: Option<String>,
    pub ssh: String,
}
#[derive(Clone, Debug)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub target: String,
    pub os: String,
    pub online: bool,
    pub ssh: bool,
    pub advertised_ssh: bool,
    pub addresses: Vec<IpAddr>,
}
pub struct Snapshot {
    pub peers: Vec<Peer>,
    pub local_os: String,
    pub local_address: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct DiscoveryState {
    pub status: String,
    pub message: String,
    pub last_sync: Option<String>,
    pub count: usize,
}
impl Default for DiscoveryState {
    fn default() -> Self {
        Self {
            status: "syncing".into(),
            message: "Finding SSH devices".into(),
            last_sync: None,
            count: 0,
        }
    }
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn tailnet_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]),
        IpAddr::V6(v) => v.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}
pub fn parse_status(value: &Value) -> Result<Snapshot> {
    if text(value, "BackendState") != "Running" {
        bail!("Tailscale is not connected");
    }
    let peers = value["Peer"]
        .as_object()
        .context("Tailscale returned no network map")?;
    let own_id = text(&value["Self"], "ID");
    let mut found = Vec::new();
    for p in peers.values() {
        let id = text(p, "ID");
        let dns = text(p, "DNSName").trim_end_matches('.');
        if id.is_empty()
            || id == own_id
            || p["ShareeNode"].as_bool() == Some(true)
            || dns.ends_with(".mullvad.ts.net")
        {
            continue;
        }
        let addresses: Vec<IpAddr> = p["TailscaleIPs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str()?.parse().ok())
            .filter(tailnet_ip)
            .collect();
        let target = if dns.is_empty() {
            addresses
                .first()
                .map(ToString::to_string)
                .unwrap_or_default()
        } else {
            dns.into()
        };
        if !validate_target(&target) {
            continue;
        }
        // CapMap's cap/ssh means permission to use SSH, not that this node runs it.
        // Advertised host keys identify Tailscale SSH servers (including offline ones).
        let ssh = p["sshHostKeys"]
            .as_array()
            .is_some_and(|keys| !keys.is_empty());
        let name = text(p, "HostName");
        found.push(Peer {
            id: id.into(),
            name: if name.is_empty() {
                target.clone()
            } else {
                name.into()
            },
            target,
            os: text(p, "OS").into(),
            online: p["Online"].as_bool().unwrap_or(false),
            ssh,
            advertised_ssh: ssh,
            addresses,
        });
    }
    found.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Snapshot {
        peers: found,
        local_os: text(&value["Self"], "OS").into(),
        local_address: value["Self"]["TailscaleIPs"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
/// Read only the SSH server's public greeting. Never send credentials or commands.
pub async fn ssh_banner(address: SocketAddr) -> bool {
    timeout(Duration::from_millis(1500), async {
        let stream = TcpStream::connect(address).await.ok()?;
        let mut reader = BufReader::new(stream);
        let mut total = 0;
        for _ in 0..8 {
            let mut line = Vec::new();
            // Bound an untrusted banner without waiting for an unbounded line.
            use tokio::io::AsyncReadExt;
            let read = (&mut reader)
                .take(512)
                .read_until(b'\n', &mut line)
                .await
                .ok()?;
            total += read;
            if read == 0 || total > 2048 {
                return None;
            }
            if line.starts_with(b"SSH-2.0-") || line.starts_with(b"SSH-1.99-") {
                return Some(());
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
    .is_some()
}
pub async fn snapshot() -> Result<Snapshot> {
    let binaries = std::env::var("HUB_TAILSCALE_BIN")
        .map(|b| vec![b])
        .unwrap_or_else(|_| {
            vec![
                "tailscale".into(),
                "/Applications/Tailscale.app/Contents/MacOS/Tailscale".into(),
            ]
        });
    let mut json = None;
    for binary in binaries {
        if let Ok(Ok(output)) = timeout(
            Duration::from_secs(5),
            Command::new(binary)
                .args(["status", "--json"])
                .kill_on_drop(true)
                .output(),
        )
        .await
            && output.status.success()
        {
            json = Some(serde_json::from_slice::<Value>(&output.stdout)?);
            break;
        }
    }
    let mut snapshot =
        parse_status(&json.context("Tailscale is unavailable on the workspace host")?)?;
    snapshot.peers = stream::iter(snapshot.peers)
        .map(|mut p| async move {
            if p.online && !p.ssh {
                for ip in &p.addresses {
                    if ssh_banner(SocketAddr::new(*ip, 22)).await {
                        p.ssh = true;
                        break;
                    }
                }
            }
            p
        })
        .buffered(8)
        .collect()
        .await;
    Ok(snapshot)
}
fn matches(d: &Device, p: &Peer) -> bool {
    if d.tailscale_id.as_deref() == Some(&p.id) {
        return true;
    }
    let host = d
        .target
        .as_deref()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("")
        .trim_end_matches('.');
    host == p.target
        || host == p.target.split('.').next().unwrap_or("")
        || p.addresses.iter().any(|ip| ip.to_string() == host)
}
/// Drop discovered peers that are this host under its tailnet name, for example the record
/// of homeserver kept from when Gofer ran on another machine and then moved to homeserver.
pub fn without_self(devices: Vec<Device>) -> Vec<Device> {
    let here = devices
        .iter()
        .find(|d| d.id == "local")
        .and_then(|d| d.address.clone());
    devices
        .into_iter()
        .filter(|d| {
            d.id == "local" || d.source != "tailscale" || d.address.is_none() || d.address != here
        })
        .collect()
}
/// Return only changed devices, retaining saved logins, IDs and unavailable hosts.
pub fn reconcile(existing: &[Device], peers: &[Peer]) -> Vec<Device> {
    let mut updates = Vec::new();
    for p in peers {
        let previous = existing.iter().find(|d| d.id != "local" && matches(d, p));
        if !p.ssh && previous.is_none() {
            continue;
        }
        let mut next = previous.cloned().unwrap_or_else(|| Device {
            id: format!("tailscale-{}", p.id),
            source: "tailscale".into(),
            ..Default::default()
        });
        if next.source == "tailscale" {
            next.name = p.name.clone();
            // Keep the full name on Peer for identity matching, but invoke SSH
            // with the MagicDNS short name used by local config and known_hosts.
            // Reconciliation also migrates previously saved automatic targets.
            let target = if p.target.parse::<IpAddr>().is_ok() {
                p.target.as_str()
            } else {
                p.target.split('.').next().unwrap_or(&p.target)
            };
            next.target = Some(target.into());
        }
        next.tailscale_id = Some(p.id.clone());
        next.status = if p.online { "online" } else { "offline" }.into();
        next.os = p.os.clone();
        next.address = p.addresses.first().map(ToString::to_string);
        if p.ssh {
            next.ssh = if p.advertised_ssh { "tailscale" } else { "ssh" }.into();
        }
        if previous != Some(&next) {
            updates.push(next);
        }
    }
    for d in existing
        .iter()
        .filter(|d| d.tailscale_id.is_some() && d.id != "local")
    {
        if !peers.iter().any(|p| matches(d, p)) && d.status != "offline" {
            let mut gone = d.clone();
            gone.status = "offline".into();
            updates.push(gone);
        }
    }
    updates
}
