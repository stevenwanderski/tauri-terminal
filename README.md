# tauri-terminal

A minimal macOS terminal built with Tauri 2, xterm.js and a Rust PTY running zsh.

## Features

- Tabs, which you can rename and drag to reorder
- Projects: color-coded groups of tabs that you can save and reopen with their working directories and startup commands
- Bundled color themes

## Stack

- **Frontend:** vanilla JavaScript with no framework or bundler, and xterm.js with the fit and WebGL addons
- **Backend:** Rust, using `portable-pty`

## Run it

You'll need Xcode Command Line Tools, Rust and Node.

```bash
npm install
npm run tauri dev     # run in development
npm run tauri build   # build the app
```

## Layout

```
src/          frontend (index.html, main.js, themes.js, vendor/xterm)
src-tauri/    Rust backend (PTY sessions, saved state)
```

## Credits

Themes other than the default come from [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (MIT).
