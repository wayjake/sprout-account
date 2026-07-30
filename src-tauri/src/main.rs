#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the sidecar server process so it can be killed on exit.
struct ServerChild(Mutex<Option<CommandChild>>);

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("no free port")
        .local_addr()
        .unwrap()
        .port()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = free_port();

            let (_rx, child) = app
                .shell()
                .sidecar("sprout-server")?
                .env("SPROUT_NO_WINDOW", "1")
                .env("SPROUT_PORT", port.to_string())
                .spawn()?;
            app.manage(ServerChild(Mutex::new(Some(child))));

            // Wait for the server to accept connections (max ~15s).
            let addr = format!("127.0.0.1:{port}");
            for _ in 0..150 {
                if TcpStream::connect_timeout(
                    &addr.parse().unwrap(),
                    Duration::from_millis(200),
                )
                .is_ok()
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }

            let url = format!("http://127.0.0.1:{port}").parse().unwrap();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Sprout Account — Household Ledger")
                .inner_size(1280.0, 900.0)
                .min_inner_size(760.0, 520.0)
                .decorations(false)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<ServerChild>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
