//! The loopback listener the authorization server redirects back to.
//!
//! # Why this is forty lines and not a web framework
//!
//! This server accepts **one** request, on loopback, from a browser this
//! process just opened, and answers it with a fixed string. Pulling in `axum`
//! or `hyper` for that would add a router, a middleware stack, a TLS
//! integration and a connection pool to a program whose threat model already
//! assumes the loopback interface is private.
//!
//! More to the point, it would add all of that to the dependency tree of a
//! secrets manager, where every crate is something a reviewer has to account
//! for. An HTTP request line is `METHOD SP TARGET SP VERSION CRLF`. Parsing it
//! is the small job it looks like.
//!
//! # What it deliberately does not do
//!
//! It does not parse headers, support keep-alive, chunked bodies, HTTP/2, or
//! anything but `GET`. It reads a bounded prefix, answers, and closes. A
//! request that is not the callback gets a `404` and the listener keeps
//! waiting, because browsers speculatively fetch `/favicon.ico` and treating
//! that as the login response would fail every login on some platforms.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use percent_encoding::percent_decode_str;

use crate::error::AuthError;

/// The loopback address the callback listener binds to.
///
/// `127.0.0.1`, never `localhost`: on a dual-stack host `localhost` may resolve
/// to `::1`, and the redirect URI registered with the authorization server is a
/// literal string that must match byte for byte.
pub const CALLBACK_HOST: &str = "127.0.0.1";

/// The path the authorization server redirects back to.
pub const CALLBACK_PATH: &str = "/callback";

/// The most of a request line that is ever read.
///
/// A real callback is a few hundred bytes. Anything larger is a client that is
/// not a browser answering a redirect, and reading it without a bound would let
/// whatever is on the other end decide how much memory this process uses.
pub const MAX_REQUEST_LINE: usize = 8 * 1024;

/// How long a single accepted connection has to send its request line.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// How often the accept loop wakes to check its deadline.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Builds the redirect URI for an OS-assigned port.
///
/// The port is only known after the listener binds, which is why this takes it
/// as an argument rather than owning it.
pub fn redirect_uri(port: u16) -> String {
    format!("http://{CALLBACK_HOST}:{port}{CALLBACK_PATH}")
}

/// Extracts the authorization response from what an operator pasted.
///
/// Accepts the whole redirect -- `http://127.0.0.1:1234/callback?code=...` --
/// because that is what the address bar holds, and also a bare query string for
/// anyone who trimmed it themselves. A fragment is dropped: no authorization
/// response this client asks for puts anything there, and a browser that
/// appends one must not turn a good paste into a failure.
///
/// A bare authorization code is deliberately **not** accepted. `state` is the
/// only thing tying a redirect to the login that started it, so a spelling that
/// let the operator omit it would be a spelling with the forgery check turned
/// off -- and it would be the convenient one to reach for.
///
/// # Errors
///
/// [`AuthError::RedirectUnreadable`] if there is no authorization response in
/// it at all, which is what pasting the wrong line looks like.
pub fn parse_redirect(pasted: &str) -> Result<Vec<(String, String)>, AuthError> {
    let trimmed = pasted.trim();
    let after_query = trimmed.split_once('?').map_or(trimmed, |(_, query)| query);
    let query = after_query.split_once('#').map_or(after_query, |(before, _)| before);

    let params = parse_query(query);
    if params.iter().any(|(key, _)| key == "code" || key == "error") {
        Ok(params)
    } else {
        Err(AuthError::RedirectUnreadable)
    }
}

/// A parsed HTTP request line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestLine<'a> {
    /// The method, uppercased by the client. Compared as-is.
    pub method: &'a str,
    /// The request target: a path, optionally followed by `?` and a query.
    pub target: &'a str,
}

impl<'a> RequestLine<'a> {
    /// The path, without the query string.
    pub fn path(&self) -> &'a str {
        self.target.split(['?', '#']).next().unwrap_or(self.target)
    }

    /// The raw query string, if there is one.
    pub fn query(&self) -> Option<&'a str> {
        self.target.split_once('?').map(|(_, query)| query.split('#').next().unwrap_or(""))
    }
}

/// Parses `METHOD SP TARGET SP VERSION`.
///
/// Returns `None` for anything that is not shaped like a request line,
/// including a TLS `ClientHello` sent to a plaintext port, which is what
/// happens when something tries `https://127.0.0.1:<port>/callback`.
pub fn parse_request_line(line: &str) -> Option<RequestLine<'_>> {
    let line = line.trim_end_matches(['\r', '\n']);
    let mut parts = line.split(' ');

    let method = parts.next().filter(|part| !part.is_empty())?;
    let target = parts.next().filter(|part| part.starts_with('/'))?;
    let version = parts.next()?;
    if !version.starts_with("HTTP/") || parts.next().is_some() {
        return None;
    }
    if !method.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return None;
    }

    Some(RequestLine { method, target })
}

/// Splits a query string into decoded key/value pairs.
///
/// `+` is decoded as a space, because that is what
/// `application/x-www-form-urlencoded` means and it is what authorization
/// servers emit. Invalid UTF-8 in a percent escape is replaced rather than
/// rejected: the values that matter here are compared, not interpreted, and a
/// mangled `state` fails its comparison anyway.
pub fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_component(key), decode_component(value))
        })
        .collect()
}

/// Percent-decodes one query component.
fn decode_component(raw: &str) -> String {
    let plus_decoded = raw.replace('+', " ");
    percent_decode_str(&plus_decoded).decode_utf8_lossy().into_owned()
}

/// Which channel a redirect arrived on.
///
/// Reported so the CLI can say how the login completed. The two are equally
/// valid: the same authorization response, carried by whichever route worked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedirectSource {
    /// The browser reached the loopback listener.
    Loopback,
    /// The operator pasted the address the browser was redirected to.
    Pasted,
}

/// Reads a pasted redirect from stdin, ignoring blank lines.
///
/// Blank lines are skipped rather than treated as an answer, because pressing
/// Enter while reading the instructions must not end the login. `Ok(None)` is
/// end of input -- Ctrl-D, or a terminal that went away -- and is not an error:
/// the loopback listener is still waiting, and reporting a failure here would
/// end a login that was about to succeed on the other channel.
///
/// # Errors
///
/// [`AuthError::RedirectUnreadable`] if a line arrives that carries no
/// authorization response, or an I/O failure reading the terminal.
fn read_pasted_redirect() -> Result<Option<Vec<(String, String)>>, AuthError> {
    let stdin = std::io::stdin();
    let mut line = String::new();

    loop {
        line.clear();
        if stdin.lock().read_line(&mut line)? == 0 {
            return Ok(None);
        }
        if !line.trim().is_empty() {
            return parse_redirect(&line).map(Some);
        }
    }
}

/// Waits for the authorization response on whichever channel delivers it.
///
/// # Why race rather than choose
///
/// Whether the browser can reach this machine's loopback is not knowable from
/// here. It depends on the network path between a browser that has not opened
/// yet, on a host this process cannot observe, and a port on this one. An
/// `ssh -L` tunnel is built entirely on the client side: the forwarded and
/// unforwarded cases are the same `bind` and the same `accept`, with no
/// syscall, environment variable or probe that separates them.
///
/// Guessing therefore has to be wrong somewhere -- `SSH_CONNECTION` is unset
/// inside `tmux` and stripped by `sudo`, and WSL looks remote while its
/// loopback is shared with the browser's. So both channels are opened and the
/// first answer wins, which is correct in every topology without asking.
///
/// # Threads, not tasks
///
/// Both waits are detached OS threads rather than `spawn_blocking` tasks. A
/// blocked read on a terminal cannot be cancelled on any platform, and a tokio
/// runtime waits for its blocking tasks at shutdown -- so the losing channel
/// would hold the process open until its own deadline passed. A detached thread
/// ends with the process instead.
///
/// # Errors
///
/// Whatever the winning channel reported: [`AuthError::LoginTimeout`] if the
/// browser never arrived and nothing was pasted, or
/// [`AuthError::RedirectUnreadable`] for a paste that carried no response.
pub fn await_redirect(
    listener: CallbackListener,
    timeout: Duration,
    accept_pasted: bool,
) -> Result<(Vec<(String, String)>, RedirectSource), AuthError> {
    await_redirect_from(listener, timeout, accept_pasted.then_some(read_pasted_redirect))
}

/// [`await_redirect`] with the paste channel supplied rather than assumed.
///
/// Exists so the race can be driven from both sides by a test: reading the real
/// stdin unconditionally would leave the paste channel untestable, because a
/// test harness owns stdin and has nothing to write to it.
fn await_redirect_from<P>(
    listener: CallbackListener,
    timeout: Duration,
    paste: Option<P>,
) -> Result<(Vec<(String, String)>, RedirectSource), AuthError>
where
    P: FnOnce() -> Result<Option<Vec<(String, String)>>, AuthError> + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::channel();

    let loopback = sender.clone();
    std::thread::spawn(move || {
        let arrival =
            listener.wait_for_callback(timeout).map(|params| (params, RedirectSource::Loopback));
        // A closed receiver means the other channel won. Nothing to report.
        let _ = loopback.send(arrival);
    });

    match paste {
        Some(paste) => {
            std::thread::spawn(move || match paste() {
                // End of input is not an answer, so it does not become one: the
                // sender is dropped and the loopback keeps its full deadline.
                Ok(None) => (),
                Ok(Some(params)) => {
                    let _ = sender.send(Ok((params, RedirectSource::Pasted)));
                }
                Err(err) => {
                    let _ = sender.send(Err(err));
                }
            });
        }
        // Without a second sender the receiver ends as soon as the loopback
        // thread finishes, which is what turns its timeout into this one.
        None => drop(sender),
    }

    // The first definitive answer, from either channel. Both send only once
    // they have one, so there is nothing to filter here.
    receiver.recv().unwrap_or(Err(AuthError::LoginTimeout { seconds: timeout.as_secs() }))
}

/// A single-shot loopback listener for the OAuth redirect.
#[derive(Debug)]
pub struct CallbackListener {
    listener: TcpListener,
    port: u16,
}

impl CallbackListener {
    /// Binds to an OS-assigned port on loopback.
    ///
    /// Port zero, so two concurrent logins cannot collide and no firewall rule
    /// or reserved-range assumption is needed. The port becomes part of the
    /// redirect URI that is dynamically registered moments later.
    ///
    /// # Errors
    ///
    /// Whatever the operating system reported. On a machine with loopback
    /// disabled there is no way to complete an interactive login at all.
    pub fn bind() -> Result<Self, AuthError> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        Ok(Self { listener, port })
    }

    /// The port the OS assigned.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The redirect URI to register and to send in the authorization request.
    pub fn redirect_uri(&self) -> String {
        redirect_uri(self.port)
    }

    /// Waits for the callback and returns its query parameters.
    ///
    /// Requests for anything other than [`CALLBACK_PATH`] are answered with a
    /// `404` and ignored, so a browser's speculative `/favicon.ico` does not
    /// consume the one request this listener was going to accept.
    ///
    /// # Errors
    ///
    /// [`AuthError::LoginTimeout`] if nothing arrives before the deadline, or
    /// an I/O failure from the socket.
    pub fn wait_for_callback(&self, timeout: Duration) -> Result<Vec<(String, String)>, AuthError> {
        let deadline = Instant::now() + timeout;

        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Some(params) = Self::serve(&stream)? {
                        return Ok(params);
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(AuthError::LoginTimeout { seconds: timeout.as_secs() });
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
                Err(err) => return Err(AuthError::Io(err)),
            }
        }
    }

    /// Reads one request and answers it.
    ///
    /// Returns the query parameters when the request was the callback, and
    /// `None` when it was anything else.
    fn serve(stream: &TcpStream) -> Result<Option<Vec<(String, String)>>, AuthError> {
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(READ_TIMEOUT))?;

        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        // `take` bounds the read: a client that never sends a newline cannot
        // make this allocate without limit.
        let read = (&mut reader).take(MAX_REQUEST_LINE as u64).read_line(&mut line);
        if read.is_err() {
            // A client that connected and said nothing useful. Drop it and keep
            // waiting; the deadline in the caller is what ends the wait.
            return Ok(None);
        }

        let Some(request) = parse_request_line(&line) else {
            respond(stream, 400, "Bad request.");
            return Ok(None);
        };

        if request.method != "GET" || request.path() != CALLBACK_PATH {
            respond(stream, 404, "Not found.");
            return Ok(None);
        }

        let params = request.query().map(parse_query).unwrap_or_default();
        respond(stream, 200, SUCCESS_BODY);
        Ok(Some(params))
    }
}

/// What the browser tab shows once the redirect has been received.
///
/// Deliberately plain: no script, no external resource, no styling that would
/// need one. The page exists to tell someone they can close the tab.
const SUCCESS_BODY: &str = "Signed in. You can close this tab and return to the terminal.";

/// Writes a minimal HTTP response and closes the connection.
///
/// Failures are ignored on purpose. The response is a courtesy to the browser;
/// the login has already succeeded or failed by the time it is written, and
/// turning a broken pipe here into a login failure would be perverse.
fn respond(mut stream: &TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;

    use super::*;

    #[test]
    fn the_redirect_uri_uses_a_literal_loopback_address() {
        assert_eq!(redirect_uri(49152), "http://127.0.0.1:49152/callback");
        // `localhost` may resolve to ::1 and break the byte-for-byte match.
        assert!(!redirect_uri(1).contains("localhost"));
    }

    #[test]
    fn the_redirect_uri_is_plain_http() {
        // Loopback is exempt from the HTTPS requirement in RFC 8252, and a
        // self-signed certificate here would only produce browser warnings.
        assert!(redirect_uri(8080).starts_with("http://"));
    }

    #[test]
    fn a_request_line_is_split_into_a_method_and_a_target() {
        let parsed = parse_request_line("GET /callback?code=abc&state=xyz HTTP/1.1\r\n")
            .expect("a well-formed request line");
        assert_eq!(parsed.method, "GET");
        assert_eq!(parsed.path(), "/callback");
        assert_eq!(parsed.query(), Some("code=abc&state=xyz"));
    }

    #[test]
    fn a_request_with_no_query_reports_none() {
        let parsed = parse_request_line("GET /callback HTTP/1.1").expect("well-formed");
        assert_eq!(parsed.path(), "/callback");
        assert_eq!(parsed.query(), None);
    }

    #[test]
    fn a_fragment_is_not_part_of_the_query() {
        let parsed = parse_request_line("GET /callback?code=a#frag HTTP/1.1").expect("well-formed");
        assert_eq!(parsed.query(), Some("code=a"));
        assert_eq!(parsed.path(), "/callback");
    }

    #[test]
    fn malformed_request_lines_are_rejected() {
        for line in [
            "",
            "GET",
            "GET /callback",
            "GET callback HTTP/1.1",
            "GET /callback HTTP/1.1 extra",
            "GET /callback NOTHTTP/1.1",
            " /callback HTTP/1.1",
            "G3T /callback HTTP/1.1",
            // A TLS ClientHello sent to the plaintext port.
            "\x16\x03\x01\x02\x00\x01",
        ] {
            assert!(parse_request_line(line).is_none(), "accepted {line:?}");
        }
    }

    #[test]
    fn a_query_string_is_split_and_decoded() {
        let params = parse_query("code=abc%2Fdef&state=x%20y&empty=");
        assert_eq!(
            params,
            [
                ("code".to_owned(), "abc/def".to_owned()),
                ("state".to_owned(), "x y".to_owned()),
                ("empty".to_owned(), String::new()),
            ]
        );
    }

    #[test]
    fn a_plus_decodes_to_a_space() {
        let params = parse_query("state=a+b");
        assert_eq!(params[0].1, "a b");
    }

    #[test]
    fn a_parameter_with_no_value_is_kept_with_an_empty_one() {
        assert_eq!(parse_query("error"), [("error".to_owned(), String::new())]);
    }

    #[test]
    fn an_empty_query_yields_no_parameters() {
        assert!(parse_query("").is_empty());
        assert!(parse_query("&&").is_empty());
    }

    #[test]
    fn a_repeated_parameter_is_preserved_rather_than_collapsed() {
        // A redirect carrying two `state` values is an attack shape, not a
        // convenience. Keeping both means the comparison sees them.
        let params = parse_query("state=a&state=b");
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn the_listener_binds_an_ephemeral_port_on_loopback() {
        let listener = CallbackListener::bind().expect("binding loopback must succeed");
        assert_ne!(listener.port(), 0, "an OS-assigned port is never zero");
        assert_eq!(listener.redirect_uri(), redirect_uri(listener.port()));
    }

    #[test]
    fn two_listeners_do_not_collide() {
        let first = CallbackListener::bind().expect("bind");
        let second = CallbackListener::bind().expect("bind");
        assert_ne!(first.port(), second.port());
    }

    #[test]
    fn the_callback_is_received_and_answered() {
        let listener = CallbackListener::bind().expect("bind");
        let port = listener.port();

        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .expect("connecting to the listener");
            stream
                .write_all(
                    b"GET /callback?code=the-code&state=the-state HTTP/1.1\r\nHost: x\r\n\r\n",
                )
                .expect("write");
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            response
        });

        let params =
            listener.wait_for_callback(Duration::from_secs(10)).expect("the callback arrives");
        assert_eq!(
            params,
            [
                ("code".to_owned(), "the-code".to_owned()),
                ("state".to_owned(), "the-state".to_owned()),
            ]
        );

        let response = client.join().expect("the client thread");
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("close this tab"), "{response}");
        // Nothing about the login may be cached by the browser.
        assert!(response.contains("no-store"), "{response}");
    }

    #[test]
    fn a_speculative_favicon_request_does_not_consume_the_login() {
        let listener = CallbackListener::bind().expect("bind");
        let port = listener.port();

        std::thread::spawn(move || {
            // What a browser actually does: fetch the favicon first, then the
            // redirect target. Treating the first as the callback would fail
            // every login on the platforms that do this.
            let mut favicon = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            favicon.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n").expect("write");
            let mut discarded = String::new();
            let _ = favicon.read_to_string(&mut discarded);
            assert!(discarded.starts_with("HTTP/1.1 404"), "{discarded}");

            let mut real = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            real.write_all(b"GET /callback?code=c&state=s HTTP/1.1\r\n\r\n").expect("write");
            let mut response = String::new();
            let _ = real.read_to_string(&mut response);
        });

        let params =
            listener.wait_for_callback(Duration::from_secs(10)).expect("the callback arrives");
        assert_eq!(params[0], ("code".to_owned(), "c".to_owned()));
    }

    #[test]
    fn waiting_times_out_rather_than_blocking_forever() {
        let listener = CallbackListener::bind().expect("bind");
        let err = listener
            .wait_for_callback(Duration::from_millis(150))
            .expect_err("nothing will connect");
        assert!(matches!(err, AuthError::LoginTimeout { .. }));
    }

    #[test]
    fn an_over_long_request_line_is_bounded() {
        let listener = CallbackListener::bind().expect("bind");
        let port = listener.port();

        std::thread::spawn(move || {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            // Far more than the cap, with no newline at all.
            let _ = stream.write_all(&vec![b'a'; MAX_REQUEST_LINE * 4]);
            let mut discarded = String::new();
            let _ = stream.read_to_string(&mut discarded);

            let mut real = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            let _ = real.write_all(b"GET /callback?code=c&state=s HTTP/1.1\r\n\r\n");
            let mut response = String::new();
            let _ = real.read_to_string(&mut response);
        });

        let params = listener
            .wait_for_callback(Duration::from_secs(15))
            .expect("the real callback still arrives");
        assert_eq!(params[0].1, "c");
    }

    /// The lookup `oauth` does on the parsed pairs, spelled here so these tests
    /// assert on values rather than on positions.
    fn value<'a>(params: &'a [(String, String)], name: &str) -> Option<&'a str> {
        params.iter().find(|(key, _)| key == name).map(|(_, found)| found.as_str())
    }

    #[test]
    fn a_pasted_address_yields_what_a_delivered_callback_would() {
        let params =
            parse_redirect("http://127.0.0.1:54321/callback?code=abc&state=xyz").expect("parses");
        assert_eq!(value(&params, "code"), Some("abc"));
        assert_eq!(value(&params, "state"), Some("xyz"));
    }

    #[test]
    fn the_newline_a_terminal_paste_carries_is_tolerated() {
        let params = parse_redirect("  http://127.0.0.1:1/callback?code=a&state=b\r\n  ")
            .expect("a pasted line still has its line ending on it");
        assert_eq!(value(&params, "state"), Some("b"));
    }

    #[test]
    fn a_bare_query_string_is_accepted_for_anyone_who_trimmed_it_themselves() {
        let params = parse_redirect("code=a&state=b").expect("parses");
        assert_eq!(value(&params, "code"), Some("a"));
    }

    #[test]
    fn a_fragment_a_browser_appended_is_not_mistaken_for_a_value() {
        let params =
            parse_redirect("http://127.0.0.1:1/callback?code=a&state=b#/").expect("parses");
        assert_eq!(value(&params, "state"), Some("b"));
    }

    #[test]
    fn an_error_redirect_is_carried_through_rather_than_rejected() {
        // No `code`, but a real authorization response: the caller turns it into
        // the server's own reason for refusing, which is more use than "that is
        // not a redirect".
        let params = parse_redirect("http://127.0.0.1:1/callback?error=access_denied&state=b")
            .expect("an error response is still a response");
        assert_eq!(value(&params, "error"), Some("access_denied"));
    }

    #[test]
    fn a_bare_authorization_code_is_refused() {
        // The security property. `state` is the only thing binding a redirect to
        // the login that started it, so there must be no spelling that lets an
        // operator hand over a code without one -- and "just paste the code"
        // would be the convenient thing to reach for.
        let err = parse_redirect("abc123").expect_err("a bare code is not a redirect");
        assert!(matches!(err, AuthError::RedirectUnreadable), "{err:?}");

        assert!(parse_redirect("http://127.0.0.1:54321/callback").is_err());
        assert!(parse_redirect("").is_err());
    }

    #[test]
    fn a_blank_line_is_not_an_answer() {
        // Pressing Enter while reading the instructions must not end the login.
        assert!(matches!(parse_redirect("   \r\n"), Err(AuthError::RedirectUnreadable)));
    }

    #[test]
    fn the_loopback_wins_when_the_browser_can_reach_it() {
        let listener = CallbackListener::bind().expect("bind");
        let port = listener.port();

        std::thread::spawn(move || {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            let _ = stream.write_all(b"GET /callback?code=loop&state=s HTTP/1.1\r\n\r\n");
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
        });

        // With the paste channel off: stdin belongs to the test harness, so the
        // race is driven from the side a test can actually supply.
        let (params, source) =
            await_redirect(listener, Duration::from_secs(15), false).expect("the callback arrives");
        assert_eq!(value(&params, "code"), Some("loop"));
        assert_eq!(source, RedirectSource::Loopback);
    }

    #[test]
    fn a_login_nothing_completes_times_out_rather_than_hanging() {
        let listener = CallbackListener::bind().expect("bind");
        let err = await_redirect(listener, Duration::from_millis(200), false)
            .expect_err("nothing was going to arrive");
        assert!(matches!(err, AuthError::LoginTimeout { .. }), "{err:?}");
    }

    #[test]
    fn a_paste_completes_a_login_the_loopback_never_receives() {
        // The whole point of the feature: nothing ever connects to the listener,
        // which is what a browser on another machine looks like from here.
        let listener = CallbackListener::bind().expect("bind");

        let (params, source) = await_redirect_from(
            listener,
            Duration::from_secs(30),
            Some(|| parse_redirect("http://127.0.0.1:1/callback?code=pasted&state=s").map(Some)),
        )
        .expect("the paste completes it");

        assert_eq!(value(&params, "code"), Some("pasted"));
        assert_eq!(source, RedirectSource::Pasted);
    }

    #[test]
    fn a_paste_that_never_comes_leaves_the_loopback_its_full_deadline() {
        // End of input on the paste channel must not decide the login. The
        // loopback still wins here, well after stdin has given up.
        let listener = CallbackListener::bind().expect("bind");
        let port = listener.port();

        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            let _ = stream.write_all(b"GET /callback?code=slow&state=s HTTP/1.1\r\n\r\n");
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
        });

        let (params, source) =
            await_redirect_from(listener, Duration::from_secs(30), Some(|| Ok(None)))
                .expect("the browser still gets there");

        assert_eq!(value(&params, "code"), Some("slow"));
        assert_eq!(source, RedirectSource::Loopback);
    }

    #[test]
    fn a_bad_paste_ends_the_login_rather_than_being_swallowed() {
        // Someone who pasted the wrong line is told so, instead of watching a
        // listener nothing is going to reach sit there until it times out.
        let listener = CallbackListener::bind().expect("bind");

        let err = await_redirect_from(
            listener,
            Duration::from_secs(30),
            Some(|| parse_redirect("not a redirect").map(Some)),
        )
        .expect_err("a paste that carries no response is a failure");

        assert!(matches!(err, AuthError::RedirectUnreadable), "{err:?}");
    }
}
