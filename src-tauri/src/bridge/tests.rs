use super::http::{authorize, route, BridgeHost, HttpRequest};
use super::*;
use std::cell::RefCell;

const ORIGIN: &str = "chrome-extension://aippbfbebemhmeihmjnjfloboankleil";
const PORT: u16 = 43517;

#[derive(Default)]
struct FakeHost {
  state: BridgeState,
  notified: RefCell<u32>,
  opened: RefCell<Vec<(String, bool)>>,
  shown: RefCell<u32>,
}

impl BridgeHost for FakeHost {
  fn state(&self) -> &BridgeState {
    &self.state
  }
  fn notify_pending(&self) {
    *self.notified.borrow_mut() += 1;
  }
  fn window_status(&self) -> (bool, bool) {
    (true, false)
  }
  fn open_path(&self, path: &str, reveal: bool) -> Result<(), String> {
    self.opened.borrow_mut().push((path.to_string(), reveal));
    Ok(())
  }
  fn show_window(&self) {
    *self.shown.borrow_mut() += 1;
  }
  fn version(&self) -> String {
    "3.2.1".into()
  }
}

fn request<'a>(method: &'a str, path: &'a str, body: &'a [u8]) -> HttpRequest<'a> {
  HttpRequest {
    method,
    path,
    host: Some("127.0.0.1:43517"),
    origin: Some(ORIGIN),
    body,
  }
}

#[test]
fn only_the_extension_is_allowed() {
  assert!(authorize(PORT, Some("127.0.0.1:43517"), Some(ORIGIN)).is_ok());
  assert!(authorize(PORT, Some("localhost:43517"), Some(ORIGIN)).is_ok());
  // A web page, another extension, or no origin at all (e.g. an <img> tag).
  assert_eq!(
    authorize(PORT, Some("127.0.0.1:43517"), Some("https://evil.example"))
      .unwrap_err()
      .status,
    403
  );
  assert_eq!(
    authorize(
      PORT,
      Some("127.0.0.1:43517"),
      Some("chrome-extension://someoneelse")
    )
    .unwrap_err()
    .status,
    403
  );
  assert_eq!(
    authorize(PORT, Some("127.0.0.1:43517"), None)
      .unwrap_err()
      .status,
    403
  );
  // DNS rebinding: right origin can't happen there, but the host must match too.
  assert_eq!(
    authorize(PORT, Some("evil.example:43517"), Some(ORIGIN))
      .unwrap_err()
      .status,
    403
  );
  assert_eq!(
    authorize(PORT, Some("127.0.0.1:9999"), Some(ORIGIN))
      .unwrap_err()
      .status,
    403
  );
}

#[test]
fn rejected_requests_do_nothing() {
  let host = FakeHost::default();
  let mut req = request(
    "POST",
    "/v1/download",
    br#"{"url":"https://www.youtube.com/watch?v=abc"}"#,
  );
  req.origin = Some("https://evil.example");
  let response = route(&host, PORT, &req);
  assert_eq!(response.status, 403);
  assert_eq!(response.allow_origin, None);
  assert!(host.state.take_pending().is_empty());
  assert_eq!(*host.notified.borrow(), 0);
}

#[test]
fn download_is_queued_once() {
  let host = FakeHost::default();
  let body = br#"{"url":"https://www.youtube.com/watch?v=abc","requestId":"r-1","audioOnly":true}"#;
  let first = route(&host, PORT, &request("POST", "/v1/download", body));
  assert_eq!(first.status, 200);
  assert_eq!(first.allow_origin.as_deref(), Some(ORIGIN));
  assert_eq!(first.body.unwrap()["requestId"], "r-1");

  // Same click again (retry, or the deep link arriving too): ignored.
  let again = route(&host, PORT, &request("POST", "/v1/download", body));
  assert_eq!(again.body.unwrap()["duplicate"], true);

  let pending = host.state.take_pending();
  assert_eq!(pending.len(), 1);
  assert_eq!(pending[0].url, "https://www.youtube.com/watch?v=abc");
  assert!(pending[0].audio_only);
  assert!(pending[0].window_was_visible);
  assert!(!pending[0].window_was_focused);
  assert_eq!(*host.notified.borrow(), 1);
  assert!(host.state.take_pending().is_empty());
}

#[test]
fn bad_download_urls_are_refused() {
  let host = FakeHost::default();
  for body in [
    &br#"{"url":"file:///etc/passwd"}"#[..],
    br#"{"url":"javascript:alert(1)"}"#,
    br#"{"url":"--exec rm"}"#,
    br#"{"url":""}"#,
    br#"not json"#,
  ] {
    let response = route(&host, PORT, &request("POST", "/v1/download", body));
    assert_eq!(response.status, 400, "{}", String::from_utf8_lossy(body));
  }
  assert!(host.state.take_pending().is_empty());
}

#[test]
fn status_never_includes_file_paths() {
  let host = FakeHost::default();
  let file = std::env::temp_dir().join("ovd-bridge-status-test.mp4");
  std::fs::write(&file, b"x").unwrap();
  host.state.set_items(vec![BridgeItem {
    id: "g1".into(),
    state: "done".into(),
    path: Some(file.to_string_lossy().into_owned()),
    ..BridgeItem::default()
  }]);
  let response = route(&host, PORT, &request("GET", "/v1/status", b""));
  let body = response.body.unwrap();
  let item = &body["items"][0];
  assert_eq!(item["id"], "g1");
  assert_eq!(item["hasFile"], true);
  assert_eq!(item["fileName"], "ovd-bridge-status-test.mp4");
  assert!(item.get("path").is_none());
  assert!(!body
    .to_string()
    .contains(&*std::env::temp_dir().to_string_lossy()));
  let _ = std::fs::remove_file(file);
}

#[test]
fn open_uses_the_apps_own_path() {
  let host = FakeHost::default();
  let file = std::env::temp_dir().join("ovd-bridge-open-test.mp4");
  std::fs::write(&file, b"x").unwrap();
  let path = file.to_string_lossy().into_owned();
  host.state.set_items(vec![BridgeItem {
    id: "g1".into(),
    state: "done".into(),
    path: Some(path.clone()),
    ..BridgeItem::default()
  }]);

  let ok = route(
    &host,
    PORT,
    &request("POST", "/v1/open", br#"{"id":"g1","reveal":true}"#),
  );
  assert_eq!(ok.status, 200);
  assert_eq!(host.opened.borrow().as_slice(), &[(path, true)]);

  // Unknown ids, and attempts to pass a path, open nothing.
  let unknown = route(
    &host,
    PORT,
    &request("POST", "/v1/open", br#"{"id":"/etc/passwd"}"#),
  );
  assert_eq!(unknown.status, 404);
  assert_eq!(host.opened.borrow().len(), 1);

  std::fs::remove_file(&file).unwrap();
  let gone = route(&host, PORT, &request("POST", "/v1/open", br#"{"id":"g1"}"#));
  assert_eq!(gone.status, 404);
}

#[test]
fn ping_show_and_preflight() {
  let host = FakeHost::default();
  let ping = route(&host, PORT, &request("GET", "/v1/ping", b""));
  assert_eq!(ping.status, 200);
  assert_eq!(ping.body.unwrap()["version"], "3.2.1");
  // The extension sends everything as POST so Chrome includes its Origin.
  let ping = route(&host, PORT, &request("POST", "/v1/ping", b"{}"));
  assert_eq!(ping.status, 200);
  let status = route(&host, PORT, &request("POST", "/v1/status", b"{}"));
  assert_eq!(status.status, 200);

  let show = route(&host, PORT, &request("POST", "/v1/show", b""));
  assert_eq!(show.status, 200);
  assert_eq!(*host.shown.borrow(), 1);

  let preflight = route(&host, PORT, &request("OPTIONS", "/v1/download", b""));
  assert_eq!(preflight.status, 204);
  assert_eq!(preflight.allow_origin.as_deref(), Some(ORIGIN));

  let missing = route(&host, PORT, &request("GET", "/nope", b""));
  assert_eq!(missing.status, 404);
}

#[test]
fn links_are_parsed() {
  let link = url::Url::parse(
    "ovd-save-as://download?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc%26t%3D5&id=req_1&audio=1",
  )
  .unwrap();
  assert_eq!(
    parse_link(&link),
    Some(LinkAction::Download {
      url: "https://www.youtube.com/watch?v=abc&t=5".into(),
      request_id: "req_1".into(),
      audio_only: true,
    })
  );

  let show = url::Url::parse("ovd-save-as://open").unwrap();
  assert_eq!(parse_link(&show), Some(LinkAction::Show));

  for bad in [
    "ovd-save-as://download?url=file%3A%2F%2F%2Fetc%2Fpasswd",
    "ovd-save-as://download",
    "ovd-save-as://delete-everything",
    "https://download?url=https%3A%2F%2Fexample.com",
  ] {
    assert_eq!(parse_link(&url::Url::parse(bad).unwrap()), None, "{bad}");
  }
}

#[test]
fn request_ids_are_sanitized() {
  assert_eq!(normalize_request_id(Some("abc-123_X")), "abc-123_X");
  let generated = normalize_request_id(Some("../../etc"));
  assert_ne!(generated, "../../etc");
  assert_eq!(generated.len(), 36);
  assert_eq!(normalize_request_id(None).len(), 36);
}

#[test]
fn queue_has_a_limit() {
  let state = BridgeState::default();
  for i in 0..50 {
    assert_eq!(
      state.enqueue(BridgeRequest {
        request_id: format!("r{i}"),
        url: "https://example.com".into(),
        audio_only: false,
        window_was_visible: false,
        window_was_focused: false,
      }),
      EnqueueResult::Queued
    );
  }
  assert_eq!(
    state.enqueue(BridgeRequest {
      request_id: "one-too-many".into(),
      url: "https://example.com".into(),
      audio_only: false,
      window_was_visible: false,
      window_was_focused: false,
    }),
    EnqueueResult::Full
  );
}
