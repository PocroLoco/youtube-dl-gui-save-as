//! A tiny HTTP server on 127.0.0.1 that only the browser extension can use.
//!
//! Every request must come from the extension: the browser sets the `Origin`
//! header itself and web pages can't fake it, so a page can't use this to
//! start downloads or read what you're downloading. The `Host` check stops
//! DNS-rebinding tricks. Nothing is reachable from other machines.

use super::state::{BridgeRequest, BridgeState, EnqueueResult};
use super::{normalize_request_id, validate_download_url, ALLOWED_ORIGINS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;

const MAX_BODY_BYTES: u64 = 64 * 1024;

/// What the routes need from the app. A trait so the routing can be tested
/// without a running app.
pub trait BridgeHost {
  fn state(&self) -> &BridgeState;
  /// Tells the app's window there's a new request to pick up.
  fn notify_pending(&self);
  /// (visible, focused) for the main window right now.
  fn window_status(&self) -> (bool, bool);
  fn open_path(&self, path: &str, reveal: bool) -> Result<(), String>;
  fn show_window(&self);
  fn version(&self) -> String;
}

pub struct HttpRequest<'a> {
  pub method: &'a str,
  pub path: &'a str,
  pub host: Option<&'a str>,
  pub origin: Option<&'a str>,
  pub body: &'a [u8],
}

#[derive(Debug, PartialEq)]
pub struct HttpResponse {
  pub status: u16,
  pub body: Option<Value>,
  /// Set when the request came from the extension, echoed back for CORS.
  pub allow_origin: Option<String>,
}

impl HttpResponse {
  fn json(status: u16, body: Value, origin: &str) -> Self {
    Self {
      status,
      body: Some(body),
      allow_origin: Some(origin.to_string()),
    }
  }

  fn rejected(status: u16, message: &str) -> Self {
    Self {
      status,
      body: Some(json!({ "ok": false, "error": message })),
      allow_origin: None,
    }
  }
}

/// Checks the request really comes from the extension, to this server.
/// Returns the extension's origin on success.
pub fn authorize<'a>(
  port: u16,
  host: Option<&str>,
  origin: Option<&'a str>,
) -> Result<&'a str, HttpResponse> {
  let host_ok = host.is_some_and(|host| {
    host.eq_ignore_ascii_case(&format!("127.0.0.1:{port}"))
      || host.eq_ignore_ascii_case(&format!("localhost:{port}"))
  });
  if !host_ok {
    return Err(HttpResponse::rejected(403, "bad host"));
  }
  match origin {
    Some(origin) if ALLOWED_ORIGINS.contains(&origin) => Ok(origin),
    _ => Err(HttpResponse::rejected(403, "not allowed")),
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadBody {
  url: String,
  #[serde(default)]
  request_id: Option<String>,
  #[serde(default)]
  audio_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenBody {
  id: String,
  #[serde(default)]
  reveal: bool,
}

pub fn route(host: &dyn BridgeHost, port: u16, request: &HttpRequest) -> HttpResponse {
  let origin = match authorize(port, request.host, request.origin) {
    Ok(origin) => origin,
    Err(response) => return response,
  };

  let path = request.path.split('?').next().unwrap_or_default();
  match (request.method, path) {
    ("OPTIONS", _) => HttpResponse {
      status: 204,
      body: None,
      allow_origin: Some(origin.to_string()),
    },
    // Chrome leaves the Origin header off an extension's GET requests, so the
    // extension uses POST for everything; GET still works for other callers.
    ("GET" | "POST", "/v1/ping") => HttpResponse::json(
      200,
      json!({ "ok": true, "app": "open-video-downloader-save-as", "version": host.version() }),
      origin,
    ),
    ("GET" | "POST", "/v1/status") => HttpResponse::json(
      200,
      json!({ "ok": true, "version": host.version(), "items": host.state().items() }),
      origin,
    ),
    ("POST", "/v1/download") => {
      let Ok(body) = serde_json::from_slice::<DownloadBody>(request.body) else {
        return HttpResponse::json(400, json!({ "ok": false, "error": "bad request" }), origin);
      };
      let Some(url) = validate_download_url(&body.url) else {
        return HttpResponse::json(
          400,
          json!({ "ok": false, "error": "unsupported url" }),
          origin,
        );
      };
      let request_id = normalize_request_id(body.request_id.as_deref());
      let (window_was_visible, window_was_focused) = host.window_status();
      let queued = host.state().enqueue(BridgeRequest {
        request_id: request_id.clone(),
        url,
        audio_only: body.audio_only,
        window_was_visible,
        window_was_focused,
      });
      match queued {
        EnqueueResult::Queued => {
          host.notify_pending();
          HttpResponse::json(200, json!({ "ok": true, "requestId": request_id }), origin)
        }
        EnqueueResult::Duplicate => HttpResponse::json(
          200,
          json!({ "ok": true, "requestId": request_id, "duplicate": true }),
          origin,
        ),
        EnqueueResult::Full => {
          HttpResponse::json(429, json!({ "ok": false, "error": "busy" }), origin)
        }
      }
    }
    ("POST", "/v1/open") => {
      let Ok(body) = serde_json::from_slice::<OpenBody>(request.body) else {
        return HttpResponse::json(400, json!({ "ok": false, "error": "bad request" }), origin);
      };
      // The extension only names a download; the path always comes from the app.
      let Some(path) = host.state().path_for(&body.id) else {
        return HttpResponse::json(404, json!({ "ok": false, "error": "not found" }), origin);
      };
      if !std::path::Path::new(&path).exists() {
        return HttpResponse::json(404, json!({ "ok": false, "error": "file is gone" }), origin);
      }
      match host.open_path(&path, body.reveal) {
        Ok(()) => HttpResponse::json(200, json!({ "ok": true }), origin),
        Err(error) => HttpResponse::json(500, json!({ "ok": false, "error": error }), origin),
      }
    }
    ("POST", "/v1/show") => {
      host.show_window();
      HttpResponse::json(200, json!({ "ok": true }), origin)
    }
    _ => HttpResponse::json(404, json!({ "ok": false, "error": "not found" }), origin),
  }
}

fn header<'a>(request: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
  request
    .headers()
    .iter()
    .find(|header| header.field.equiv(name))
    .map(|header| header.value.as_str())
}

/// Reads one request off the wire, routes it and writes the answer.
pub fn serve(host: &dyn BridgeHost, port: u16, mut request: tiny_http::Request) {
  let mut body = Vec::new();
  let method = request.method().as_str().to_ascii_uppercase();
  if method == "POST" {
    let _ = request
      .as_reader()
      .take(MAX_BODY_BYTES)
      .read_to_end(&mut body);
  }

  let response = {
    let parsed = HttpRequest {
      method: &method,
      path: request.url(),
      host: header(&request, "Host"),
      origin: header(&request, "Origin"),
      body: &body,
    };
    route(host, port, &parsed)
  };

  let mut out = match &response.body {
    Some(body) => tiny_http::Response::from_string(body.to_string()),
    None => tiny_http::Response::from_string(String::new()),
  }
  .with_status_code(response.status);

  let mut headers = vec![
    ("Cache-Control", "no-store".to_string()),
    ("X-Content-Type-Options", "nosniff".to_string()),
  ];
  if response.body.is_some() {
    headers.push(("Content-Type", "application/json".to_string()));
  }
  if let Some(origin) = response.allow_origin {
    headers.push(("Access-Control-Allow-Origin", origin));
    headers.push(("Vary", "Origin".to_string()));
    headers.push((
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS".to_string(),
    ));
    headers.push(("Access-Control-Allow-Headers", "Content-Type".to_string()));
    headers.push(("Access-Control-Allow-Private-Network", "true".to_string()));
  }
  for (name, value) in headers {
    if let Ok(header) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
      out = out.with_header(header);
    }
  }
  let _ = request.respond(out);
}
