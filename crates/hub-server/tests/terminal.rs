use hub_server::terminal::{Terminal, capture, close};

#[test]
fn only_definite_pre_command_rejections_prove_that_no_shell_was_created() {
    use hub_server::terminal::rejected_before_command;
    for error in [
        "Host key verification failed.",
        "ssh: Could not resolve hostname absent.invalid: nodename nor servname provided, or not known",
        "user@host: Permission denied (publickey,password).",
        "tailscale: tailnet policy does not permit you to SSH as user \"user\"\nConnection closed by 100.64.0.1 port 22",
        "ssh: connect to host server port 22: Connection refused",
    ] {
        assert!(rejected_before_command(error), "{error}");
    }
    for error in [
        "Connection timed out",
        "Connection closed by 100.64.0.1 port 22",
        "Connection reset by peer",
        "mkdir: Permission denied",
        "tmux: command not found",
        "Terminal dimensions missing",
    ] {
        assert!(!rejected_before_command(error), "{error}");
    }
}
#[tokio::test]
async fn shell_state_survives_detaching_and_reattaching() {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (terminal, mut output) = Terminal::open(&id, None, "/tmp").await.unwrap();
    let reader = tokio::spawn(async move { while output.recv().await.is_some() {} });
    terminal
        .write(b"export HUB_PERSIST_TEST=still_here; echo READY_MARKER\n")
        .unwrap();
    wait_for(&id, "READY_MARKER").await;
    drop(terminal);
    reader.abort();
    let (terminal, mut output) = Terminal::open(&id, None, "/tmp").await.unwrap();
    let reader = tokio::spawn(async move { while output.recv().await.is_some() {} });
    terminal
        .write(b"printf 'VALUE:%s\\n' \"$HUB_PERSIST_TEST\"\n")
        .unwrap();
    wait_for(&id, "VALUE:still_here").await;
    let screen = capture(&id, None).await.unwrap();
    let mut archived = Vec::new();
    loop {
        let chunk = hub_server::terminal::read_log(&id, None, archived.len() as u64)
            .await
            .unwrap();
        if chunk.is_empty() {
            break;
        }
        archived.extend(chunk);
    }
    close(&id, None).await.unwrap();
    reader.abort();
    assert!(
        String::from_utf8_lossy(&archived).contains("VALUE:still_here"),
        "Reattaching disabled output archiving"
    );
    assert!(
        screen.contains("VALUE:still_here"),
        "shell state lost: {screen}"
    );
}

async fn wait_for(id: &str, needle: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(12), async {
        loop {
            let screen = capture(id, None).await.unwrap();
            if screen.lines().any(|line| line.trim() == needle) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("shell never produced expected output");
}

#[tokio::test]
async fn terminal_output_is_spooled_while_the_hub_is_detached() {
    let id = format!("archive-{}", uuid::Uuid::new_v4().simple());
    let (terminal, mut output) = Terminal::open(&id, None, "").await.unwrap();
    let drain = tokio::spawn(async move { while output.recv().await.is_some() {} });
    terminal
        .write(b"(sleep 2; printf '\\nOFFLINE_ARCHIVE_MARKER\\n') & echo JOB_STARTED\n")
        .unwrap();
    wait_for(&id, "JOB_STARTED").await;
    drop(terminal);
    drain.abort();
    let mut bytes = Vec::new();
    for _ in 0..60 {
        bytes.extend(
            hub_server::terminal::read_log(&id, None, bytes.len() as u64)
                .await
                .unwrap(),
        );
        if String::from_utf8_lossy(&bytes)
            .lines()
            .any(|l| l.trim() == "OFFLINE_ARCHIVE_MARKER")
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let tail = hub_server::terminal::read_log(&id, None, bytes.len() as u64)
        .await
        .unwrap();
    hub_server::terminal::close(&id, None).await.unwrap();
    assert!(
        String::from_utf8_lossy(&bytes)
            .lines()
            .any(|l| l.trim() == "OFFLINE_ARCHIVE_MARKER"),
        "Detached output wasn't archived"
    );
    assert!(
        !String::from_utf8_lossy(&tail).contains("OFFLINE_ARCHIVE_MARKER"),
        "Archive cursor repeated previously read bytes"
    );
}

#[tokio::test]
async fn closing_an_already_exited_terminal_succeeds() {
    let id = uuid::Uuid::new_v4().simple().to_string();
    close(&id, None)
        .await
        .expect("A shell that already exited must not block closing its conversation");
}

#[tokio::test]
async fn reattaching_preserves_the_shell_grid_without_a_temporary_resize() {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (terminal, mut output) = Terminal::open(&id, None, "/tmp").await.unwrap();
    let drain = tokio::spawn(async move { while output.recv().await.is_some() {} });
    terminal.resize(76, 34).unwrap();
    let dimensions =
        format!("tmux -L gofer display-message -p -t hub_{id} '#{{pane_width}} #{{pane_height}}'");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if hub_server::terminal::run(None, &dimensions)
                .await
                .unwrap()
                .trim()
                == "76 34"
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    drop(terminal);
    drain.abort();
    let (terminal, mut output) = Terminal::open(&id, None, "/tmp").await.unwrap();
    let drain = tokio::spawn(async move { while output.recv().await.is_some() {} });
    // An automatically reconnected browser may have a different viewport; it
    // cannot resize the restored shell until the user returns to that viewer.
    terminal.size_view("background", 42, 20, false).unwrap();
    terminal.size_view("background", 40, 18, false).unwrap();
    let reported = *terminal.geometry().borrow();
    let actual = hub_server::terminal::run(None, &dimensions).await.unwrap();
    close(&id, None).await.unwrap();
    drain.abort();
    assert_eq!(
        reported,
        (76, 34),
        "Reattach must not reset the grid before a browser connects"
    );
    assert_eq!(
        actual.trim(),
        "76 34",
        "The shell received a spurious resize"
    );
}
