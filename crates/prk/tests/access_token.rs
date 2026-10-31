//! `prk access token` against a stub server, through the real binary.
//!
//! Two properties only a whole process shows: the "writing to" line is printed
//! only once the deployment has said service tokens can be managed, and the
//! `--json` failure envelope carries the server's own code beside the client's.
//!
//! The stub is a few lines of `std::net` rather than a mock-server crate: it
//! answers `/whoami` and `/capabilities` and nothing else, which is all a
//! refusal at the capabilities check ever reaches.

use std::io::{BufRead as _, BufReader, Write as _};
use std::net::TcpListener;
use std::process::{Command, Stdio};

const INSTANCE: &str = "3f9c01ab3f9c01ab3f9c01ab3f9c01ab";

/// Serves canned JSON by path on a loopback port, until the test ends.
///
/// Returns the base URL. `/api/v1/capabilities` answers with `feature` as the
/// `serviceTokens` entry; every other path but `/api/v1/whoami` is a 404.
fn serve(feature: serde_json::Value) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
    let url = format!("http://{}", listener.local_addr().expect("bound"));
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().expect("clone the stream"));
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }
            // Drain the headers; neither route has a body worth reading.
            let mut header = String::new();
            while reader.read_line(&mut header).is_ok_and(|n| n > 2) {
                header.clear();
            }
            let path = request_line.split_whitespace().nth(1).unwrap_or("");
            let (status, body) = match path {
                "/api/v1/whoami" => (
                    "200 OK",
                    serde_json::json!({
                        "kind": "service_token", "subject": "ci.access", "instance": INSTANCE,
                    }),
                ),
                "/api/v1/capabilities" => (
                    "200 OK",
                    serde_json::json!({
                        "api": 1, "version": "2026.10.31", "instance": INSTANCE,
                        "features": { "serviceTokens": feature },
                    }),
                ),
                _ => (
                    "404 Not Found",
                    serde_json::json!({ "code": "NOT_FOUND", "message": "no such route" }),
                ),
            };
            let body = body.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\
                 connection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    url
}

/// Runs `prk` against `url` with a throwaway configuration directory.
fn prk(url: &str, args: &[&str]) -> (Option<i32>, String) {
    let config = tempfile::tempdir().expect("a configuration directory");
    let output = Command::new(env!("CARGO_BIN_EXE_prk"))
        .args(["--api-url", url, "--yes", "--no-input"])
        .args(args)
        .env("PRK_CONFIG_DIR", config.path())
        .env("PRK_ACCESS_CLIENT_ID", "ci.access")
        .env("PRK_ACCESS_CLIENT_SECRET", "not-a-real-secret")
        .env_remove("CF_ACCESS_CLIENT_ID")
        .env_remove("CF_ACCESS_CLIENT_SECRET")
        .env_remove("PRK_PROFILE")
        .env_remove("PRK_API_URL")
        .env_remove("PRK_EXPECT_INSTANCE")
        .stdin(Stdio::null())
        .output()
        .expect("the binary under test must be runnable");
    (output.status.code(), String::from_utf8_lossy(&output.stderr).into_owned())
}

#[test]
fn an_unconfigured_deployment_refuses_before_announcing_a_write() {
    let url = serve(serde_json::json!({
        "state": "unavailable", "allowed": false, "reason": "unconfigured",
        "hint": "Set the CF_API_TOKEN secret.",
    }));

    let (code, stderr) = prk(&url, &["access", "token", "create", "ci"]);
    assert_eq!(code, Some(8), "{stderr}");
    assert!(!stderr.contains("writing to"), "a refused write announced itself:\n{stderr}");
    assert!(stderr.contains("SERVICE_TOKENS_UNCONFIGURED"), "{stderr}");
}

#[test]
fn the_json_refusal_names_the_servers_code_in_its_own_field() {
    let url = serve(serde_json::json!({
        "state": "unavailable", "allowed": false, "reason": "unconfigured",
        "hint": "Set the CF_API_TOKEN secret.",
    }));

    let (code, stderr) = prk(&url, &["--json", "access", "token", "rotate", "ci"]);
    assert_eq!(code, Some(8), "{stderr}");
    assert!(!stderr.contains("writing to"), "{stderr}");
    let envelope: serde_json::Value = serde_json::from_str(
        stderr.lines().rev().find(|line| line.starts_with('{')).expect("a JSON envelope"),
    )
    .expect("the envelope parses");
    assert_eq!(envelope["error"]["code"], "SERVICE_UNAVAILABLE");
    assert_eq!(envelope["error"]["server_code"], "SERVICE_TOKENS_UNCONFIGURED");
    assert_eq!(envelope["error"]["hint"], "Set the CF_API_TOKEN secret.");
}

#[test]
fn an_allowed_deployment_announces_the_write_once_checked() {
    let url = serve(serde_json::json!({ "state": "enabled", "allowed": true }));

    // The stub has no `/service-tokens`, so the listing behind `rotate` is a
    // 404 -- after the capabilities check, which is the point.
    let (code, stderr) = prk(&url, &["access", "token", "rotate", "ci"]);
    assert_ne!(code, Some(0), "{stderr}");
    let announced = stderr.find("writing to").expect("the write was announced");
    let failed = stderr.find("no such route").expect("the listing failed");
    assert!(announced < failed, "announced only after the failure:\n{stderr}");
}
