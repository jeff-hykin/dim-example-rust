//! dimos-app-server for the Rust example: serves the page (`--frontend <dir>`) and this app's API on the unix socket
//! Desktop gives.
//!
//! What Desktop passes: one env var, `DIMOS_APP`, a JSON object (Desktop's docs/apps.md, "dimos-app-server"):
//! `{ version, name, socket, url, path, dataDir, desktopUrl, zenohWebUrl, zenohConnect, zenohNamespace, zenohPrefix,
//!   dimosDir, dimosPython, recordingsDir }`. Read the fields you use and ignore the rest: new ones can appear.
//! Requests arrive with the app's path (`/apps/<name>`) already removed: `/api/hello`, `/`, `/app.js`.
//!
//! The API, as dimos.yaml declares it:
//! - `GET  /api/hello`           public (agent:): who we are + what dimos is running (a call to the gateway from here)
//! - `POST /api/notes`           public (agent:): the agent adds a note; Desktop shows a notification
//! - `GET  /api/internal/notes`  private: the page lists notes
//! - `POST /api/internal/notes`  private: the page adds one

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DimosApp {
    name: Option<String>,
    socket: Option<String>,
    data_dir: Option<String>,
    desktop_url: Option<String>,
}

struct App {
    name: String,
    desktop_url: String,
    notes_file: PathBuf,
    frontend: PathBuf,
}

fn flag(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == &format!("--{name}")).and_then(|i| args.get(i + 1).cloned())
}

// ── state: a JSON file in the app's own data folder (its checkout is replaced on update; dataDir isn't) ──
fn read_notes(app: &App) -> Vec<String> {
    std::fs::read_to_string(&app.notes_file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn add_note(app: &App, text: String) -> Vec<String> {
    let mut notes = read_notes(app);
    notes.push(text);
    if let Some(dir) = app.notes_file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&app.notes_file, serde_json::to_string_pretty(&notes).unwrap_or_default());
    notes
}

// ── calls out of the app: Desktop and the dimos gateway (declared in dimos.yaml dimos-api: too) ──
async fn desktop(app: &Arc<App>, method: &'static str, path: &'static str, body: Option<Value>) -> Option<Value> {
    let url = format!("{}{path}", app.desktop_url);
    tokio::task::spawn_blocking(move || {
        let request = ureq::request(method, &url);
        let response = match body {
            Some(body) => request.send_json(body),
            None => request.call(),
        };
        response.ok()?.into_json::<Value>().ok()
    })
    .await
    .ok()
    .flatten()
}

async fn hello(State(app): State<Arc<App>>) -> Json<Value> {
    let launch = desktop(&app, "GET", "/dimos/runs", None).await.and_then(|runs| runs.get("launch").cloned());
    let running = launch
        .filter(|l| !l.is_null())
        .map(|l| format!("{} ({})", l["blueprint"].as_str().unwrap_or("?"), l["phase"].as_str().unwrap_or("?")));
    Json(json!({
        "shape": "Rust",
        "app": app.name,
        "unixTime": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "running": running,
        "notes": read_notes(&app).len(),
    }))
}

#[derive(Deserialize)]
struct Note {
    text: String,
}

/// `POST /api/notes`: the agent's way in (public); tells the person with a Desktop notification
async fn agent_note(State(app): State<Arc<App>>, Json(note): Json<Note>) -> Response {
    let text = note.text.trim().to_string();
    if text.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "a note needs `text`" }))).into_response();
    }
    let notes = add_note(&app, text.clone());
    // a server's calls carry no Referer, so they're never refused, but they're declared in dimos.yaml all the same
    let notice = json!({ "title": "A note from the agent", "body": text, "app": app.name });
    desktop(&app, "POST", "/api/notifications", Some(notice)).await;
    Json(json!({ "notes": notes })).into_response()
}

/// `GET /api/internal/notes`, `POST /api/internal/notes`: the page's own (private)
async fn list_notes(State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!({ "notes": read_notes(&app) }))
}

async fn page_note(State(app): State<Arc<App>>, Json(note): Json<Note>) -> Response {
    let text = note.text.trim().to_string();
    if text.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "a note needs `text`" }))).into_response();
    }
    Json(json!({ "notes": add_note(&app, text) })).into_response()
}

// ── the page: static files from --frontend ──
async fn file(State(app): State<Arc<App>>, path: Option<Path<String>>) -> Response {
    let wanted = path.map(|Path(p)| p).unwrap_or_default();
    let clean: Vec<&str> = wanted.split('/').filter(|part| !part.is_empty() && *part != "..").collect();
    let relative = if clean.is_empty() { "index.html".to_string() } else { clean.join("/") };
    let kind = match relative.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };
    match tokio::fs::read(app.frontend.join(&relative)).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, kind)], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[tokio::main]
async fn main() {
    let given: DimosApp =
        std::env::var("DIMOS_APP").ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let data_dir = given.data_dir.clone().unwrap_or_else(|| ".data".into());
    let app = Arc::new(App {
        name: given.name.clone().unwrap_or_else(|| "dim-example-rust (outside Desktop)".into()),
        desktop_url: given.desktop_url.clone().unwrap_or_else(|| "http://127.0.0.1:5555".into()),
        notes_file: PathBuf::from(data_dir).join("notes.json"),
        frontend: PathBuf::from(flag("frontend").unwrap_or_else(|| "frontend".into())),
    });
    let router = Router::new()
        .route("/api/hello", get(hello))
        .route("/api/notes", axum::routing::post(agent_note))
        .route("/api/internal/notes", get(list_notes).post(page_note))
        .route("/", get(file))
        .route("/{*path}", get(file))
        .with_state(app);
    match given.socket {
        Some(socket) => {
            let _ = std::fs::remove_file(&socket);
            let listener = tokio::net::UnixListener::bind(&socket).expect("bind the socket Desktop gave");
            eprintln!("listening on {socket}");
            axum::serve(listener, router).await.expect("serve");
        }
        None => {
            // outside Desktop: `cargo run -- --port 8787` serves on a port (open http://localhost:8787/)
            let port = flag("port").unwrap_or_else(|| "8787".into());
            let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await.expect("bind the port");
            axum::serve(listener, router).await.expect("serve");
        }
    }
}
