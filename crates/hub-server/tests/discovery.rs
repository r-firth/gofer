use hub_server::discovery::{Device, parse_status, reconcile, without_self};
use serde_json::json;

#[test]
fn discovers_ssh_hosts_offline_too_but_excludes_self_sharees_and_vpn_relays() {
    let snapshot = parse_status(&json!({"BackendState":"Running", "Self":{"ID":"self"}, "Peer":{
        "a":{"ID":"server", "HostName":"Home server", "DNSName":"server.tail.test.", "OS":"linux", "Online":true,"sshHostKeys":["ssh-ed25519 key"]},
        "b":{"ID":"offline", "HostName":"Laptop", "DNSName":"laptop.tail.test.", "Online":false,"sshHostKeys":["ssh-ed25519 key"]},
        "c":{"ID":"phone", "HostName":"Phone", "DNSName":"phone.tail.test.", "Online":true,"TailscaleIPs":["100.64.0.3"]},
        "d":{"ID":"vpn", "HostName":"Relay", "DNSName":"us-test.mullvad.ts.net.", "Online":true,"sshHostKeys":["key"]},
        "e":{"ID":"self", "DNSName":"self.tail.test.", "sshHostKeys":["key"]},
        "f":{"ID":"sharee", "DNSName":"sharee.tail.test.", "ShareeNode":true, "sshHostKeys":["key"]},
        "g":{"ID":"invalid", "DNSName":"-oProxyCommand=bad", "sshHostKeys":["key"]}
    }})).unwrap();
    let peers = snapshot.peers;
    assert_eq!(peers.len(), 3);
    assert!(
        peers
            .iter()
            .any(|p| p.id == "server" && p.ssh && p.target == "server.tail.test")
    );
    assert!(
        peers
            .iter()
            .any(|p| p.id == "offline" && p.ssh && !p.online)
    );
    assert!(peers.iter().any(|p| p.id == "phone" && !p.ssh));
}

#[test]
fn sync_is_idempotent_updates_stable_nodes_and_preserves_manual_login() {
    let snapshot = parse_status(&json!({"BackendState":"Running","Peer":{
        "a":{"ID":"node", "HostName":"Renamed server", "DNSName":"new.tail.test.", "Online":true,"OS":"linux","sshHostKeys":["key"]}
    }})).unwrap();
    let old = Device {
        id: "saved-device".into(),
        name: "My custom name".into(),
        target: Some("operator@old.tail.test".into()),
        status: "offline".into(),
        source: "manual".into(),
        tailscale_id: Some("node".into()),
        ..Default::default()
    };
    let changes = reconcile(std::slice::from_ref(&old), &snapshot.peers);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].id, "saved-device");
    assert_eq!(changes[0].name, "My custom name");
    assert_eq!(changes[0].target.as_deref(), Some("operator@old.tail.test"));
    assert_eq!(changes[0].status, "online");
    assert!(reconcile(&changes, &snapshot.peers).is_empty());
    let added = reconcile(&[], &snapshot.peers);
    assert_eq!(added[0].id, "tailscale-node");
    assert_eq!(added[0].target.as_deref(), Some("new"));
    assert!(reconcile(&added, &snapshot.peers).is_empty());
    let missing = reconcile(&added, &[]);
    assert_eq!(missing[0].status, "offline");
}

#[test]
fn automatic_targets_use_magic_dns_short_names_and_migrate_saved_devices() {
    let snapshot = parse_status(&json!({"BackendState":"Running", "Peer":{
        "a":{"ID":"node", "HostName":"Home server", "DNSName":"server.tail.test.", "Online":true,"sshHostKeys":["key"]}
    }})).unwrap();
    for tailscale_id in [None, Some("node".into())] {
        let old = Device {
            id: "existing-device".into(),
            name: "Home server".into(),
            target: Some("server.tail.test".into()),
            status: "online".into(),
            source: "tailscale".into(),
            tailscale_id,
            ..Default::default()
        };
        let changes = reconcile(&[old], &snapshot.peers);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].id, "existing-device");
        assert_eq!(changes[0].target.as_deref(), Some("server"));
        assert_eq!(changes[0].tailscale_id.as_deref(), Some("node"));
        assert!(reconcile(&changes, &snapshot.peers).is_empty());
    }
}

#[test]
fn targets_without_dns_keep_the_complete_ip_address() {
    for address in ["100.64.0.2", "fd7a:115c:a1e0::1234"] {
        let snapshot = parse_status(&json!({"BackendState":"Running", "Peer":{
            "a":{"ID":"node", "HostName":"Display name", "DNSName":"", "TailscaleIPs":[address], "Online":true,"sshHostKeys":["key"]}
        }})).unwrap();
        let devices = reconcile(&[], &snapshot.peers);
        assert_eq!(devices[0].target.as_deref(), Some(address));
    }
}

#[test]
fn existing_full_and_short_manual_targets_match_without_duplicate_devices() {
    let snapshot = parse_status(&json!({"BackendState":"Running", "Peer":{
        "a":{"ID":"node", "DNSName":"server.tail.test.", "Online":true,"sshHostKeys":["key"]}
    }}))
    .unwrap();
    for target in ["operator@server.tail.test", "operator@server"] {
        let old = Device {
            id: "custom-device".into(),
            target: Some(target.into()),
            source: "manual".into(),
            ..Default::default()
        };
        let changes = reconcile(&[old], &snapshot.peers);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].id, "custom-device");
        assert_eq!(changes[0].target.as_deref(), Some(target));
        assert_eq!(changes[0].tailscale_id.as_deref(), Some("node"));
    }
}

#[test]
fn failed_tailnet_does_not_look_like_an_empty_successful_sync() {
    assert!(parse_status(&json!({"BackendState":"NeedsLogin","Peer":{}})).is_err());
    assert!(parse_status(&json!({"BackendState":"Running"})).is_err());
}

#[tokio::test]
async fn detects_an_ssh_banner_without_authentication_or_commands() {
    use tokio::{io::AsyncWriteExt, net::TcpListener};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        stream
            .write_all(b"Welcome\r\nSSH-2.0-OpenSSH_9.9\r\n")
            .await
            .unwrap();
    });
    assert!(hub_server::discovery::ssh_banner(addr).await);
    task.await.unwrap();
    assert!(!hub_server::discovery::ssh_banner(addr).await);
}

#[test]
fn the_host_itself_is_not_also_listed_as_a_peer_after_moving() {
    let device = |id: &str, source: &str, address: Option<&str>| Device {
        id: id.into(),
        name: id.into(),
        source: source.into(),
        address: address.map(Into::into),
        ..Default::default()
    };
    let kept = without_self(vec![
        device("local", "", Some("100.64.0.1")),
        device("tailscale-homeserver", "tailscale", Some("100.64.0.1")),
        device("tailscale-mac", "tailscale", Some("100.64.0.2")),
        device("manual-alias", "manual", Some("100.64.0.1")),
    ]);
    let ids: Vec<_> = kept.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, ["local", "tailscale-mac", "manual-alias"]);
    // Before discovery has filled in the host's own address nothing is dropped.
    assert_eq!(
        without_self(vec![
            device("local", "", None),
            device("tailscale-x", "tailscale", None)
        ])
        .len(),
        2
    );
}
