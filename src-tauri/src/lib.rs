use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_window_state::StateFlags;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn ping() -> String {
    "pong from Rust".to_string()
}

#[tauri::command]
fn run_once(cmd: String) -> Result<String, String> {
    let out = std::process::Command::new("/bin/zsh")
        .arg("-c")
        .arg(&cmd)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    ))
}

// One PTY per tab. The master is kept alive here so we can resize the PTY later.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

// Sessions are keyed by tab id. Ids come from `pty_new_id` and never repeat while the
// app runs, even across page reloads, so a leftover shell's events can't reach a new
// tab that happens to share its id.
#[derive(Default)]
struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    last_id: AtomicU32,
}

#[tauri::command]
fn pty_new_id(state: State<PtyState>) -> u32 {
    state.last_id.fetch_add(1, Ordering::Relaxed) + 1
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: u32,
    data: Vec<u8>,
}

// `cwd` is where zsh starts (used when restoring tabs). portable-pty falls back to the
// home directory if it's missing or no longer exists.
#[tauri::command]
fn pty_start(
    id: u32,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    app: AppHandle,
    state: State<PtyState>,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    // xterm.js draws 24-bit color. Programs only send it when COLORTERM says so, and
    // otherwise round their colors to the 256-color palette.
    cmd.env("COLORTERM", "truecolor");
    // Apps opened from Finder or the Dock don't get a terminal's LANG, and without it
    // zsh and other programs fall back to ASCII (non-ASCII text shows as codes).
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // zsh holds its own copy of the slave; dropping ours lets reads end when zsh exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            child,
        },
    );

    // Send raw bytes, not a String, so multi-byte characters split across reads survive.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    let _ = app.emit("pty-output", PtyOutput { id, data });
                }
            }
        }
        // zsh exited (e.g. the user typed `exit`), so the frontend can close the tab.
        let _ = app.emit("pty-exit", id);
    });

    Ok(())
}

#[tauri::command]
fn pty_write(id: u32, data: String, state: State<PtyState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("No such PTY")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(id: u32, cols: u16, rows: u16, state: State<PtyState>) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    // A tab may be fitted before its PTY has started; that's fine to ignore.
    let Some(session) = sessions.get(&id) else {
        return Ok(());
    };
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_close(id: u32, state: State<PtyState>) {
    // Take the session out first so the lock isn't held while killing.
    let session = state.sessions.lock().unwrap().remove(&id);
    if let Some(mut session) = session {
        // Also reaps zsh if it already exited on its own.
        let _ = session.child.kill();
    }
}

// Whether the tab's shell is waiting at its prompt: zsh's line editor turns off the
// terminal's line mode (ICANON) while it reads a command line. Input sent before that
// is echoed by the terminal itself, above where the prompt is then drawn.
#[tauri::command]
fn pty_at_prompt(id: u32, state: State<PtyState>) -> bool {
    let sessions = state.sessions.lock().unwrap();
    let Some(fd) = sessions.get(&id).and_then(|s| s.master.as_raw_fd()) else {
        return false;
    };
    let mut termios: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(fd, &mut termios) } != 0 {
        return false;
    }
    termios.c_lflag & libc::ICANON == 0
}

// Ends every shell. The page calls this as it loads: after a reload, the previous
// page's shells are still running but no tab shows them anymore.
#[tauri::command]
fn pty_close_all(state: State<PtyState>) {
    let sessions: Vec<Session> = state.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
    for mut session in sessions {
        let _ = session.child.kill();
    }
}

// Each tab's current directory (zsh's own, even while a command runs), keyed by tab id.
#[tauri::command]
fn pty_cwds(state: State<PtyState>) -> HashMap<u32, String> {
    let sessions = state.sessions.lock().unwrap();
    sessions
        .iter()
        .filter_map(|(id, s)| Some((*id, process_cwd(s.child.process_id()?)?)))
        .collect()
}

// Asks macOS for another process's working directory.
#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
    let written = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if written != size {
        return None;
    }
    // vip_path is a NUL-terminated C string (declared as nested arrays by libc).
    let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
    Some(path.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "macos"))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}

// Installed font families with a monospaced face, sorted, for the terminal font
// setting. Async so it runs off the main thread (macOS has hundreds of fonts).
#[tauri::command]
async fn mono_fonts() -> Vec<String> {
    mono_font_families()
}

#[cfg(target_os = "macos")]
fn mono_font_families() -> Vec<String> {
    use core_text::font_descriptor::{SymbolicTraitAccessors, TraitAccessors};
    let Some(descriptors) = core_text::font_collection::create_for_all_families().get_descriptors()
    else {
        return Vec::new();
    };
    let families: std::collections::BTreeSet<String> = descriptors
        .iter()
        .filter(|d| d.traits().symbolic_traits().is_monospace())
        .map(|d| d.family_name())
        // Names starting with "." are system-internal fonts.
        .filter(|name| !name.starts_with('.'))
        .collect();
    families.into_iter().collect()
}

#[cfg(not(target_os = "macos"))]
fn mono_font_families() -> Vec<String> {
    Vec::new()
}

// Frontend data (the open tabs, projects and settings) lives in JSON files in the
// app's data directory. The frontend owns the formats; Rust just stores them. Keys are
// limited to a known list so they can't be used as arbitrary paths.
const STORE_KEYS: [&str; 3] = ["session", "projects", "settings"];

fn store_path(app: &AppHandle, key: &str) -> Result<std::path::PathBuf, String> {
    if !STORE_KEYS.contains(&key) {
        return Err(format!("unknown store key: {key}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{key}.json")))
}

#[tauri::command]
fn store_save(app: AppHandle, key: String, data: String) -> Result<(), String> {
    let path = store_path(&app, &key)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    // Write a temp file then rename, so a crash mid-write can't leave a corrupt file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn store_load(app: AppHandle, key: String) -> Option<String> {
    std::fs::read_to_string(store_path(&app, &key).ok()?).ok()
}

// Sizes the window to its saved size (or its default) and centers it in the screen's
// usable area, below the menu bar and above the Dock.
// - The saved size is read from the window-state plugin's file rather than applied
//   with its restore and measured back: during setup, window changes are only queued
//   (the event loop isn't running yet), so measuring would still give the old size.
// - Not `window.center()`: on macOS that's AppKit's `center`, which puts the window
//   somewhat above center vertically.
// - In logical points, from the screen's scale factor: a hidden window can report a
//   different one, which would throw off physical pixels.
fn place_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (area_x, area_y) = (area.position.x as f64 / scale, area.position.y as f64 / scale);
    let (area_w, area_h) = (area.size.width as f64 / scale, area.size.height as f64 / scale);

    let saved = saved_window_size(app).map(|(w, h)| (w as f64 / scale, h as f64 / scale));
    let Some((w, h)) = saved.or_else(|| {
        let size = window.inner_size().ok()?.to_logical::<f64>(window.scale_factor().ok()?);
        Some((size.width, size.height))
    }) else {
        return;
    };
    let (w, h) = (w.min(area_w), h.min(area_h));

    let _ = window.set_size(tauri::LogicalSize::new(w, h));
    let _ = window.set_position(tauri::LogicalPosition::new(
        area_x + (area_w - w) / 2.0,
        area_y + (area_h - h) / 2.0,
    ));
}

// The main window's size (physical pixels) as last saved by the window-state plugin.
fn saved_window_size(app: &AppHandle) -> Option<(u32, u32)> {
    let path = app.path().app_config_dir().ok()?.join(tauri_plugin_window_state::DEFAULT_FILENAME);
    let state: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let main = state.get("main")?;
    let size = |key: &str| main.get(key)?.as_u64().filter(|&v| v > 0).map(|v| v as u32);
    Some((size("width")?, size("height")?))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Native folder picker for project tab directories.
        .plugin(tauri_plugin_dialog::init())
        // Saves the window's size when the app quits (applied in setup below).
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE)
                .skip_initial_state("main")
                .build(),
        )
        // Reopen at the last size, centered on the screen. The window starts hidden
        // (tauri.conf.json) and is shown once it's in place.
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                place_window(app.handle(), &window);
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            ping,
            run_once,
            pty_new_id,
            pty_start,
            pty_write,
            pty_resize,
            pty_close,
            pty_close_all,
            pty_at_prompt,
            pty_cwds,
            mono_fonts,
            store_save,
            store_load
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
