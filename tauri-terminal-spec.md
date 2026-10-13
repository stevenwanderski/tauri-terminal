# Tauri Terminal: Minimal Exploration Spec

## Goal

Build the smallest possible Tauri app that runs a real shell (zsh) inside a window, one tiny verified step at a time. This is a learning base, not a product. Tabs, tab groups, themes and settings come later.

## Ground rules

- Do one step at a time. Do not start a step until the previous step's **Done when** checks pass.
- Vanilla JavaScript only. No frontend framework, no bundler.
- Keep the Rust side as small as possible. Most future work (tabs, groups) will live in JavaScript.
- If the scaffolded project differs from the file paths below (templates change over time), adapt to what's actually there and note the difference.

## How the pieces fit

```
 You type ──► xterm.js (JS, draws the screen)
                 │  invoke("pty_write")
                 ▼
             Rust backend ──► PTY (two-way pipe) ──► zsh
                 ▲                                     │
                 │  emit("pty-output")                 │
 Screen ◄── xterm.js ◄─────── output bytes ◄───────────┘
```

---

## Step 0: Check prerequisites

Run each command in a terminal:

```bash
xcode-select -p        # should print a path like /Library/Developer/CommandLineTools
rustc --version        # Rust compiler
cargo --version        # Rust package manager
node --version         # Node.js
npm --version
```

If anything is missing:

```bash
xcode-select --install                     # Xcode Command Line Tools
curl https://sh.rustup.rs -sSf | sh        # Rust (restart terminal afterward)
```

Node: install from nodejs.org or your preferred version manager.

**Done when:** all five commands print a version or path with no errors.

---

## Step 1: Scaffold and launch the default app

```bash
npm create tauri-app@latest
```

Answer the prompts:

| Prompt | Answer |
| --- | --- |
| Project name | `tauri-term` |
| Identifier | `com.steven.tauriterm` |
| Frontend language | JavaScript |
| Package manager | npm |
| UI template | Vanilla |
| UI flavor | JavaScript |

Then:

```bash
cd tauri-term
npm install
npm run tauri dev
```

The first run compiles a lot of Rust and can take a few minutes. Later runs are much faster.

Expected layout:

```
tauri-term/
├── src/                  # Frontend: index.html, main.js, styles.css
└── src-tauri/
    ├── Cargo.toml        # Rust dependencies
    ├── tauri.conf.json   # App config
    └── src/
        ├── main.rs
        └── lib.rs        # Rust commands live here
```

**Done when:** a native window opens showing the Tauri welcome page, and typing a name in its greet box shows a greeting.

---

## Step 2: Prove the frontend edit loop

With `npm run tauri dev` still running, change the main heading in `src/index.html` to:

```html
<h1>Tauri Term</h1>
```

Save the file.

**Done when:** the window shows "Tauri Term". If it doesn't refresh on its own, right-click in the window and choose Reload. Also confirm right-click › Inspect Element opens developer tools.

---

## Step 3: Prove the JS ↔ Rust round trip

Add a `ping` command in `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn ping() -> String {
    "pong from Rust".to_string()
}
```

Register it alongside the existing `greet` command:

```rust
.invoke_handler(tauri::generate_handler![greet, ping])
```

In `src/main.js`, call it once the page loads and log the result:

```js
const { invoke } = window.__TAURI__.core;

window.addEventListener("DOMContentLoaded", async () => {
  console.log(await invoke("ping"));
});
```

Saving the Rust file triggers a recompile and app restart.

**Done when:** the developer tools console shows `pong from Rust`.

---

## Step 4: Run a one-off shell command (not a terminal yet)

Goal: prove Rust can launch zsh, and see why this alone is not a terminal.

Rust command:

```rust
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
```

Register it, then add a text input, a Run button and a `<pre>` to the page that shows the output of `invoke("run_once", { cmd })`.

Try: `ls`, `pwd`, `echo $SHELL`, then `ls -G`.

**Done when:** output appears in the `<pre>`.

**Lesson:** `ls -G` shows no colors here, and interactive programs like `vim` won't work. The command runs, finishes, and hands back plain text. A real terminal needs a live two-way connection (a PTY). That's Step 7.

---

## Step 5: Add xterm.js and draw colored text

Install and copy the files into `src/` (there's no bundler, so the page loads them directly):

```bash
npm install @xterm/xterm
mkdir -p src/vendor
cp node_modules/@xterm/xterm/lib/xterm.js src/vendor/
cp node_modules/@xterm/xterm/css/xterm.css src/vendor/
```

In `src/index.html`, replace the body content with a terminal container and load the files:

```html
<link rel="stylesheet" href="vendor/xterm.css" />
<div id="terminal"></div>
<script src="vendor/xterm.js"></script>
<script src="main.js" type="module"></script>
```

In `src/main.js`:

```js
const term = new Terminal();
term.open(document.getElementById("terminal"));
term.write("Hello from xterm.js\r\n");
term.write("\x1b[31mThis is red\x1b[0m and this is normal\r\n");
```

**Done when:** a black terminal area shows both lines, with "This is red" in red.

**Lesson:** `\x1b[31m` is an escape code (one of the "secret notes"). xterm.js reads it and changes the color instead of printing it.

---

## Step 6: Capture keystrokes (local echo, no shell)

Add:

```js
term.onData((data) => {
  if (data === "\r") {
    term.write("\r\n");
  } else {
    term.write(data);
  }
});
```

**Done when:** clicking the terminal and typing shows your characters, and Enter moves to a new line. Backspace and arrow keys will act oddly. That's expected: nothing is interpreting them yet. In Step 7, zsh takes over that job.

---

## Step 7: Connect a real shell through a PTY

Add the PTY crate:

```bash
cd src-tauri
cargo add portable-pty
cd ..
```

Rust side (`src-tauri/src/lib.rs`), in outline:

- A managed state struct holding the PTY master and its writer, each in a `Mutex<Option<...>>`. Keep the master alive in state; it's needed for resizing later.
- `pty_start` command:
  - Open a PTY sized 80 columns × 24 rows with `native_pty_system().openpty(...)`.
  - Spawn `/bin/zsh -l` on the slave side, with env `TERM=xterm-256color`.
  - Store the master and its writer in state.
  - Start a background thread that reads output in a loop and sends each chunk to the frontend with `app.emit("pty-output", bytes)`, sending raw bytes (`Vec<u8>`), not a `String`, so multi-byte characters split across reads aren't mangled.
- `pty_write(data: String)` command: write the bytes to the stored writer.
- Register state with `.manage(...)` and both commands in `generate_handler!`. `emit` requires `use tauri::Emitter;`.

Frontend (`src/main.js`), replacing the Step 6 echo handler:

```js
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const term = new Terminal();
term.open(document.getElementById("terminal"));

await listen("pty-output", (event) => {
  term.write(new Uint8Array(event.payload));
});

term.onData((data) => invoke("pty_write", { data }));

await invoke("pty_start");
```

**Done when all of these work:**

- A zsh prompt appears.
- `ls -G` shows colors (compare with Step 4).
- Backspace, arrow keys and Tab completion behave normally.
- `top` runs full-screen and `q` quits it.
- `vim` opens, and `:q` returns to the prompt.

At this point you have a working (tiny) terminal.

---

## Step 8 (stretch): Resize with the window

- Install `@xterm/addon-fit`, copy its `lib/addon-fit.js` into `src/vendor/`, and load it.
- On load and on window resize, call `fitAddon.fit()`, then send the new `term.cols` and `term.rows` to a Rust `pty_resize` command that calls `master.resize(PtySize { ... })`.
- Give `#terminal` a full-window size in CSS.

**Done when:** resizing the window reflows `ls` output and `top` redraws to fill the new size.

---

## Out of scope (for now)

- Multiple sessions, tabs and tab groups
- Closing/restarting the shell cleanly when zsh exits
- Themes, fonts, settings
- Packaging (`npm run tauri build`)

**Natural next step:** multiple terminals. Each tab is just another xterm.js instance plus another PTY in Rust, identified by an id. Tab groups are then purely a JavaScript UI concern.
