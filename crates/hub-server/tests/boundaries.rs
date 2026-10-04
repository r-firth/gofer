use hub_server::{shell_quote, validate_target};

#[test]
fn remote_hosts_cannot_inject_ssh_options_or_commands() {
    for host in [
        "-oProxyCommand=touch /tmp/oops",
        "server;id",
        "$(id)",
        "",
        "host\nother",
    ] {
        assert!(!validate_target(host), "accepted unsafe target: {host:?}");
    }
    for host in [
        "desktop",
        "admin@server",
        "100.64.0.3",
        "dev.example.ts.net",
        "[::1]",
    ] {
        assert!(validate_target(host), "rejected target: {host}");
    }
}

#[test]
fn shell_paths_round_trip_without_expanding_substitutions() {
    let input = "/tmp/my game's $(printf compromised) directory";
    let output = std::process::Command::new("sh")
        .args(["-c", &format!("printf '%s' {}", shell_quote(input))])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), input);
}
