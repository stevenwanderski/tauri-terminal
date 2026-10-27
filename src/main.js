import { DEFAULT_THEME } from "./theme.js";
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Terminal settings shared by every tab. `fontFamily`, `fontSize`, `lineHeight` and
// `theme` (the colors) are set by applyTheme.
const termOptions = {
  cursorBlink: true,
  fontWeightBold: "normal",
  drawBoldTextInBrightColors: false,
  // Effectively unlimited history (xterm.js needs a finite number). Lines only take
  // memory once they're written, roughly 12 bytes per column each.
  scrollback: 1_000_000,
  // Hyperlinks programs mark with OSC 8 (Vite, Claude Code). Plain-text URLs go
  // through WebLinksAddon in newTab. xterm.js's default here uses confirm(), which
  // Tauri's webview ignores.
  linkHandler: { activate: (e, url) => openLink(e, url) },
};

// Cmd+click opens a URL in the default browser (the pointer only shows with Cmd held; see styles.css).
function openLink(e, url) {
  if (e.metaKey) window.__TAURI__.opener.openUrl(url).catch((err) => console.error("openUrl failed", url, err));
}

// Tracks whether Cmd is held, so links show the pointer cursor only then.
for (const type of ["keydown", "keyup", "mousemove"]) {
  window.addEventListener(type, (e) => document.body.classList.toggle("cmd-held", e.metaKey), true);
}
window.addEventListener("blur", () => document.body.classList.remove("cmd-held"));

// Tabs are either loose or in a project. The top bar holds loose tabs and open
// projects (▣) side by side; selecting a project shows its tabs in a second bar
// underneath. An open project may be linked to a saved project (see "Projects" below)
// or be unsaved. With no projects open, the top bar is just a plain tab bar.
const barEl = document.getElementById("bar");
const newTabEl = document.getElementById("new-tab");
const projectsMenuEl = document.getElementById("projects-menu");
const projectBarEl = document.getElementById("project-bar");
const newProjectTabEl = document.getElementById("new-project-tab");
const terminalsEl = document.getElementById("terminals");
const menuEl = document.getElementById("menu");
const projectsEl = document.getElementById("projects");
const themeEl = document.getElementById("theme");
const preferencesEl = document.getElementById("preferences");

// Each tab is an xterm.js instance plus a PTY in Rust, matched by an id from Rust
// (pty_new_id), unique for as long as the app runs.
const sessions = new Map(); // id -> { term, fitAddon, el, tabEl, labelEl, pending, project, ... }
let activeId = null;

const openProjects = new Map(); // id -> { name, color, savedId, chipEl, stripEl, lastTabId }
let nextProjectId = 1;
let activeProject = null; // the active tab's project, or null when a loose tab is active

// Project colors are slots in the ANSI palette, so they follow color
// changes. (A custom "#rrggbb" also works and stays fixed.)
const PROJECT_SLOTS = ["magenta", "green", "yellow", "blue", "red", "cyan"];
const colorOf = (slot) => theme.terminal[slot] ?? slot;

// Older saves stored hex colors from the default palette; map those back to their slot.
function toSlot(color) {
  if (!color || PROJECT_SLOTS.includes(color)) return color;
  return PROJECT_SLOTS.find((slot) => DEFAULT_THEME.terminal[slot] === color.toLowerCase()) ?? color;
}

// The slot used least among `colors`, first in palette order on ties, so each new
// project gets a color the others don't have until all six are taken.
function leastUsedColor(colors) {
  const uses = (c) => colors.filter((x) => x === c).length;
  return PROJECT_SLOTS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
}

// If this page was reloaded, the previous page's shells are still running in Rust.
// End them; their exit events name ids no tab here has, so they're ignored.
await invoke("pty_close_all");

await listen("pty-output", (event) => {
  const { id, data } = event.payload;
  const s = sessions.get(id);
  if (!s) return;
  s.term.write(new Uint8Array(data));
  if (s.pending !== null) sendPendingWhenReady(id, s);
});

// A new tab holds typed keys and its project command (`pending`) until zsh's line
// editor is reading, i.e. its prompt is up. Sent any earlier, they'd be echoed at the
// top of the screen with the prompt drawn below them. Each burst of output prompts a
// check (Rust looks at the terminal mode); a fallback sends anyway after a few
// seconds, for shells that never switch modes.
function sendPendingWhenReady(id, s) {
  s.pendingFallback ??= setTimeout(() => sendPending(id, s), 5000);
  clearTimeout(s.pendingCheck);
  s.pendingCheck = setTimeout(async () => {
    if (await invoke("pty_at_prompt", { id })) sendPending(id, s);
  }, 30);
}

function sendPending(id, s) {
  if (s.pending === null) return;
  const typed = s.pending;
  s.pending = null;
  clearTimeout(s.pendingCheck);
  clearTimeout(s.pendingFallback);
  if (typed && sessions.has(id)) invoke("pty_write", { id, data: typed }).catch(() => {});
}

// zsh exited on its own (e.g. `exit`), so close its tab.
await listen("pty-exit", (event) => closeTab(event.payload));

// Files dropped on the window are pasted into the active tab as backslash-escaped
// paths, like Terminal.app does, so Claude Code (and the shell) pick them up.
await listen("tauri://drag-drop", (event) => {
  const s = sessions.get(activeId);
  if (!s) return;
  const paths = event.payload.paths.map((p) => p.replace(/[^\w\-.,:/@+=%]/g, "\\$&"));
  s.term.paste(paths.join(" ") + " ");
  s.term.focus();
});

// ---- Claude Code status ----
// Claude Code reports what it's doing with OSC 7501 ("program status") once the
// terminal answers its probe. Each report is colon-separated fields: `state=` (working,
// blocked, done, idle, error, or clear as it exits), `kind=` for what a blocked
// session waits on (permission, question, auth), and others unused here. Reports with
// an `id=` are about its background tasks and are ignored. A tab shows the state as a
// colored dot, a project chip shows its most urgent tab's, and a chime plays when
// Claude finishes or needs an answer.
const PROGRAM_STATUS = 7501;
// Most urgent first.
const CLAUDE_STATES = ["blocked", "done", "working", "error", "idle"];
const CLAUDE_LABELS = {
  blocked: "Claude needs your input",
  done: "Claude finished",
  working: "Claude is working",
  error: "Claude hit an error",
  idle: "Claude is ready",
};
const BLOCKED_LABELS = { permission: "Claude is asking for permission", question: "Claude has a question" };

function programStatus(id, data) {
  const fields = Object.fromEntries(
    data.split(":").map((field) => {
      const i = field.indexOf("=");
      return i === -1 ? [field, ""] : [field.slice(0, i), field.slice(i + 1)];
    }),
  );
  if (fields.id !== undefined) return;
  if (fields.state === "clear") setClaudeStatus(id, null);
  else if (CLAUDE_STATES.includes(fields.state)) setClaudeStatus(id, { state: fields.state, kind: fields.kind });
}

function setClaudeStatus(id, status) {
  const s = sessions.get(id);
  if (!s) return;
  const before = s.claude;
  s.claude = status;
  // Claude resends its status whenever its message or progress changes.
  if (before?.state === status?.state && before?.kind === status?.kind) return;
  if (status) {
    s.tabEl.dataset.claude = status.state;
    s.dotEl.title = (status.state === "blocked" && BLOCKED_LABELS[status.kind]) || CLAUDE_LABELS[status.state];
  } else {
    delete s.tabEl.dataset.claude;
  }
  if (status?.state === "done" || status?.state === "blocked") chime(status.state);
  showProjectStatus(s.project);
}

// The project chip's dot: the most urgent status among its tabs.
function showProjectStatus(projectId) {
  const p = openProjects.get(projectId);
  if (!p) return;
  const states = tabIds(projectId).map((id) => sessions.get(id)?.claude?.state);
  const state = CLAUDE_STATES.find((st) => states.includes(st));
  if (state) p.chipEl.dataset.claude = state;
  else delete p.chipEl.dataset.claude;
}

// If Claude Code ends without clearing its status (it crashed or was killed), its
// shell is back in the foreground; clear the dot then.
setInterval(async () => {
  for (const [id, s] of sessions) {
    if (s.claude && (await invoke("pty_shell_foreground", { id }))) setClaudeStatus(id, null);
  }
}, 2000);

// Two soft notes: falling when Claude finishes, rising when it needs an answer. Audio
// can only start after a user gesture, so the first key or click resumes it.
const audio = new AudioContext();
for (const type of ["keydown", "pointerdown"]) {
  window.addEventListener(type, () => audio.state === "suspended" && audio.resume(), true);
}

function chime(state) {
  const notes = state === "done" ? [1046.5, 784] : [784, 1046.5]; // C6 and G5
  notes.forEach((frequency, i) => {
    const t = audio.currentTime + i * 0.12;
    const osc = new OscillatorNode(audio, { frequency });
    const gain = new GainNode(audio, { gain: 0 });
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  });
}

// `projectId` null makes a loose tab. `cwd` and `name` are used when restoring tabs
// and opening saved projects. `command` runs once the shell is ready, unless `run` is
// false (restored tabs keep their command for saving, but don't rerun it).
async function newTab(projectId = activeProject, { cwd = null, name = null, command = null, color = null, run = true } = {}) {
  const id = await invoke("pty_new_id");

  const el = document.createElement("div");
  el.className = "terminal";
  terminalsEl.appendChild(el);

  const term = new Terminal(termOptions);
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon(openLink));
  term.open(el);
  // The WebGL renderer draws block and box-drawing characters itself instead of using
  // the font. Monaco lacks most of them (e.g. ▐ ▛ ▜ ▌), and fallback fonts don't line
  // up with its cells. If WebGL is unavailable or lost, xterm.js keeps its DOM renderer.
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (err) {
    console.warn("WebGL renderer unavailable, using DOM renderer", err);
  }
  // Hold keystrokes until zsh is at its prompt (pending becomes null then).
  // Sent earlier, the PTY echoes them before the prompt and zsh marks that line with "%".
  term.onData((data) => {
    const s = sessions.get(id);
    if (s.pending === null) invoke("pty_write", { id, data });
    else s.pending += data;
  });
  // xterm.js sends a plain Enter for Shift+Enter. Send ESC + Enter instead, which
  // Claude Code (and other line editors) take as a line break rather than submit.
  term.attachCustomKeyEventHandler((e) => {
    if (e.key !== "Enter" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return true;
    if (e.type === "keydown") term.input("\x1b\r");
    return false;
  });

  const tabEl = document.createElement("div");
  tabEl.className = "bar-item tab";
  tabEl.dataset.id = id;
  tabEl.addEventListener("click", () => activate(id));
  tabEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, tabMenuItems(id));
  });
  tabEl.addEventListener("dblclick", (e) => {
    if (!e.target.closest(".close")) renameTab(id);
  });
  makeDraggable(tabEl);

  // Claude Code's status (see "Claude Code status" below), left of the label.
  const dotEl = document.createElement("span");
  dotEl.className = "claude-dot";
  tabEl.appendChild(dotEl);

  const labelEl = document.createElement("span");
  labelEl.className = "label";
  labelEl.textContent = name ?? "zsh";
  tabEl.appendChild(labelEl);

  // Claude Code asks whether the terminal takes status reports ("?"), then sends them.
  // The reply goes out like xterm.js's own replies, so it stays in order with them.
  term.parser.registerOscHandler(PROGRAM_STATUS, (data) => {
    if (data.startsWith("?")) term.input(`\x1b]${PROGRAM_STATUS};?\x1b\\`, false);
    else programStatus(id, data);
    return true;
  });

  // The shell names the tab with OSC 1 (oh-my-zsh sends the current directory at
  // the prompt and the command name while one runs) or OSC 0 (title + tab name).
  // A name set by the user wins; the shell's title is kept for when it's cleared.
  // Returning false lets xterm.js run its own handling for these too.
  for (const osc of [0, 1]) {
    term.parser.registerOscHandler(osc, (title) => {
      const s = sessions.get(id);
      s.autoTitle = title || "zsh";
      if (s.customName === null && !s.renaming) labelEl.textContent = s.autoTitle;
      return false;
    });
  }

  const closeEl = document.createElement("button");
  closeEl.className = "close";
  closeEl.textContent = "×";
  closeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  tabEl.appendChild(closeEl);
  if (projectId === null) barEl.insertBefore(tabEl, newTabEl);
  else openProjects.get(projectId).stripEl.appendChild(tabEl);

  sessions.set(id, {
    term,
    fitAddon,
    el,
    tabEl,
    labelEl,
    dotEl,
    // A project's command goes first in the queue, as if typed and Enter pressed.
    pending: command && run ? `${command}\r` : "",
    project: projectId,
    // Kept so saving the project writes the command back.
    command,
    autoTitle: "zsh",
    customName: name,
    // A palette slot (like project colors), shown as the tab's bottom border, or null.
    color: null,
    // Saved until zsh reports its own directory, so an early save doesn't lose it.
    startCwd: cwd,
    renaming: false,
    // Claude Code's last reported status, or null when it isn't running.
    claude: null,
  });
  setTabColor(id, color);
  // Show and fit the tab first so the PTY starts at the right size.
  activate(id);
  await invoke("pty_start", { id, cols: term.cols, rows: term.rows, cwd });
  return id;
}

function activate(id) {
  const s = sessions.get(id);
  activeId = id;
  activeProject = s.project;
  if (activeProject !== null) openProjects.get(activeProject).lastTabId = id;
  projectBarEl.hidden = activeProject === null;
  for (const [pid, p] of openProjects) {
    p.stripEl.hidden = pid !== activeProject;
    p.chipEl.classList.toggle("active", pid === activeProject);
  }
  for (const [sid, other] of sessions) {
    other.el.hidden = sid !== id;
    other.tabEl.classList.toggle("active", sid === id);
  }
  fit();
  s.term.focus();
  scheduleSave();
}

function closeTab(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  invoke("pty_close", { id });
  s.term.dispose();
  s.el.remove();
  s.tabEl.remove();
  const projectGone = s.project !== null && removeProjectIfEmpty(s.project);
  if (!projectGone) showProjectStatus(s.project);

  if (sessions.size === 0) {
    newTab(null);
  } else if (id === activeId) {
    // Show another tab in the same project if it has any left, else the last top-bar item.
    if (s.project !== null && !projectGone) switchProject(s.project);
    else openItem(barItems().at(-1));
  }
  scheduleSave();
}

// Top-bar items (loose tabs and open projects) in order; dragging can reorder them.
function barItems() {
  return [...barEl.querySelectorAll(":scope > .bar-item")];
}

// Show a top-bar item: a loose tab, or a project (its last-used tab).
function openItem(el) {
  if (el.classList.contains("project-chip")) switchProject(Number(el.dataset.project));
  else activate(Number(el.dataset.id));
}

// Tab ids of an open project in the order they appear in its strip.
function tabIds(projectId) {
  const strip = openProjects.get(projectId).stripEl;
  return [...strip.querySelectorAll(".tab")].map((el) => Number(el.dataset.id));
}

// Open projects exist only while they have tabs. Returns whether it was removed.
function removeProjectIfEmpty(projectId) {
  if (tabIds(projectId).length > 0) return false;
  const p = openProjects.get(projectId);
  p.chipEl.remove();
  p.stripEl.remove();
  openProjects.delete(projectId);
  return true;
}

// Adds an empty project to the top bar; callers move or open a tab into it right away
// (and call renameProject last, so later focus changes don't end the rename at once).
// `savedId` links it to a saved project.
function createProject(name = null, color = null, savedId = null) {
  const id = nextProjectId++;
  name ??= `Project ${id}`;
  color ??= leastUsedColor([...openProjects.values()].map((p) => p.color));

  const stripEl = document.createElement("div");
  stripEl.className = "tab-strip";
  stripEl.hidden = true;
  projectBarEl.insertBefore(stripEl, newProjectTabEl);

  // A div rather than a button, so a rename <input> can live inside it.
  const chipEl = document.createElement("div");
  chipEl.className = "bar-item project-chip";
  chipEl.dataset.project = id;
  chipEl.textContent = name;
  chipEl.addEventListener("click", () => switchProject(id));
  chipEl.addEventListener("dblclick", () => renameProject(id));
  chipEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: "Rename Project", action: () => renameProject(id) },
      { label: "Save Project", action: () => saveOpenProject(id) },
      { label: "Edit Project…", action: () => editOpenProject(id) },
      // Reversed because each tab is placed right after the project.
      {
        label: "Move Tabs Out of Project",
        action: () => tabIds(id).reverse().forEach((t) => moveTab(t, null)),
      },
      "-",
      { swatches: PROJECT_SLOTS, selected: openProjects.get(id).color, pick: (c) => setProjectColor(id, c) },
      "-",
      { label: "Close Project", action: () => tabIds(id).forEach(closeTab) },
    ]);
  });
  makeDraggable(chipEl);
  barEl.insertBefore(chipEl, newTabEl);

  openProjects.set(id, { name, color, savedId, chipEl, stripEl, lastTabId: null });
  setProjectColor(id, color);
  return id;
}

// The project's ▣ icon reads its color from this CSS variable.
function setProjectColor(projectId, color) {
  const p = openProjects.get(projectId);
  p.color = toSlot(color);
  p.chipEl.style.setProperty("--project-color", colorOf(p.color));
  scheduleSave();
}

function setTabColor(id, color) {
  const s = sessions.get(id);
  s.color = toSlot(color);
  if (s.color) s.tabEl.style.setProperty("--tab-color", colorOf(s.color));
  else s.tabEl.style.removeProperty("--tab-color");
  scheduleSave();
}

function switchProject(projectId) {
  const ids = tabIds(projectId);
  const last = openProjects.get(projectId).lastTabId;
  activate(ids.includes(last) ? last : ids.at(-1));
}

// Move a tab into a project, or out of its project when `target` is null. If the
// moved tab was showing, the view stays in its old project when that still has tabs,
// and otherwise follows the tab.
function moveTab(id, target) {
  const s = sessions.get(id);
  const from = s.project;
  if (from === target) return;
  s.project = target;
  if (target === null) {
    // A tab leaving its project lands right after the project in the top bar.
    barEl.insertBefore(s.tabEl, openProjects.get(from).chipEl.nextSibling);
  } else {
    openProjects.get(target).stripEl.appendChild(s.tabEl);
  }
  const fromGone = from !== null && removeProjectIfEmpty(from);
  if (!fromGone) showProjectStatus(from);
  showProjectStatus(target);

  if (id === activeId) {
    if (from !== null && !fromGone) switchProject(from);
    else activate(id);
  }
  scheduleSave();
}

function tabMenuItems(id) {
  const s = sessions.get(id);
  const items = [
    { label: "Rename Tab", action: () => renameTab(id) },
    "-",
    {
      label: "Move to New Project",
      action: () => {
        const projectId = createProject();
        moveTab(id, projectId);
        renameProject(projectId);
      },
    },
  ];
  for (const [pid, p] of openProjects) {
    if (pid !== s.project) items.push({ label: `Move to ${p.name}`, action: () => moveTab(id, pid) });
  }
  if (s.project !== null) items.push({ label: "Remove from Project", action: () => moveTab(id, null) });
  items.push("-", { swatches: PROJECT_SLOTS, selected: s.color, pick: (c) => setTabColor(id, c) });
  if (s.color) items.push({ label: "Remove Color", action: () => setTabColor(id, null) });
  items.push("-", { label: "Close Tab", action: () => closeTab(id) });
  return items;
}

function renameProject(projectId) {
  const p = openProjects.get(projectId);
  editInline(p.chipEl, p.name, (name) => {
    if (name) p.name = name;
    p.chipEl.textContent = p.name;
    scheduleSave();
  });
}

// An empty name returns the tab to the shell's automatic title.
function renameTab(id) {
  const s = sessions.get(id);
  if (s.renaming) return;
  s.renaming = true;
  editInline(s.labelEl, s.customName ?? s.autoTitle, (name) => {
    s.renaming = false;
    if (name !== null) s.customName = name || null;
    s.labelEl.textContent = s.customName ?? s.autoTitle;
    scheduleSave();
  });
}

// Swap el's contents for a text box (browser dialogs like prompt() don't work well in
// Tauri's webview). Enter or clicking away commits, Escape cancels. onDone gets the
// trimmed text, or null if cancelled, and must restore el's contents.
function editInline(el, value, onDone) {
  const input = document.createElement("input");
  input.className = "rename";
  input.value = value;
  el.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    onDone(commit ? input.value.trim() : null);
    sessions.get(activeId)?.term.focus();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    // finish() refocuses the terminal mid-keydown; without preventDefault the key's
    // follow-up keypress lands there and the shell receives the Enter too.
    e.preventDefault();
    finish(e.key === "Enter");
  });
  input.addEventListener("blur", () => finish(true));
  // Clicks in the box shouldn't also switch tabs/projects, start a drag, or re-trigger
  // a double-click rename.
  for (const type of ["click", "dblclick", "pointerdown"]) {
    input.addEventListener(type, (e) => e.stopPropagation());
  }
}

// One shared right-click menu. Items are { label, action }, "-" for a separator,
// { header } for a non-clickable section label, or { swatches, selected, pick } for a
// row of project color slots.
function showMenu(x, y, items) {
  const choose = (action) => {
    hideMenu();
    if (projectsEl.hidden) sessions.get(activeId)?.term.focus();
    action();
  };
  menuEl.replaceChildren(
    ...items.map((item) => {
      const el = document.createElement("div");
      if (item === "-") {
        el.className = "separator";
        return el;
      }
      if (item.header) {
        el.className = "header";
        el.textContent = item.header;
        return el;
      }
      if (item.swatches) {
        el.className = "swatches";
        for (const color of item.swatches) {
          const swatch = document.createElement("span");
          swatch.className = "swatch";
          swatch.classList.toggle("selected", color === toSlot(item.selected));
          swatch.style.backgroundColor = colorOf(color);
          swatch.addEventListener("click", () => choose(() => item.pick(color)));
          el.appendChild(swatch);
        }
        return el;
      }
      el.className = "item";
      el.textContent = item.label;
      el.addEventListener("click", () => choose(item.action));
      return el;
    }),
  );
  menuEl.hidden = false;
  // Keep the menu inside the window.
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(0, Math.min(x, innerWidth - r.width - 4))}px`;
  menuEl.style.top = `${Math.max(0, Math.min(y, innerHeight - r.height - 4))}px`;
}

function hideMenu() {
  menuEl.hidden = true;
}

window.addEventListener(
  "pointerdown",
  (e) => {
    if (!menuEl.contains(e.target)) hideMenu();
  },
  true,
);
window.addEventListener("blur", hideMenu);

// Drag a tab or project to reorder it within its bar (up and down in the sidebar).
// Uses pointer events
// rather than HTML5 drag-and-drop, which Tauri's file-drop handling can intercept.
function makeDraggable(itemEl) {
  itemEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".close")) return;
    const vertical = getComputedStyle(itemEl.parentElement).flexDirection === "column";
    const [pos, start, end] = vertical ? ["clientY", "top", "bottom"] : ["clientX", "left", "right"];
    const startX = e[pos];
    let lastX = startX;
    let dragging = false;

    const onMove = (e) => {
      // A few pixels of slack so a plain click doesn't count as a drag.
      if (!dragging && Math.abs(e[pos] - startX) < 5) return;
      dragging = true;
      document.body.classList.add("tab-dragging");

      // Swap as soon as the pointer enters a neighbor, but only the neighbor in the
      // direction of travel; otherwise a wider neighbor would swap straight back.
      const container = itemEl.parentElement;
      const x = e[pos];
      if (x > lastX) {
        let next = itemEl.nextElementSibling;
        while (next?.classList.contains("bar-item") && x > next.getBoundingClientRect()[start]) {
          container.insertBefore(next, itemEl);
          next = itemEl.nextElementSibling;
        }
      } else if (x < lastX) {
        let prev = itemEl.previousElementSibling;
        while (prev && x < prev.getBoundingClientRect()[end]) {
          container.insertBefore(itemEl, prev);
          prev = itemEl.previousElementSibling;
        }
      }
      lastX = x;
    };

    // Listen on window, not the item: moving it in the DOM would drop pointer capture.
    const onUp = () => {
      document.body.classList.remove("tab-dragging");
      if (dragging) scheduleSave();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

// Only the visible tab can be measured, so hidden tabs are fitted when activated.
function fit() {
  const s = sessions.get(activeId);
  if (!s) return;
  s.fitAddon.fit();
  invoke("pty_resize", { id: activeId, cols: s.term.cols, rows: s.term.rows });
}

// Shift+Cmd+] / [: inside a project, cycle its tabs; otherwise cycle the top-bar items
// (loose tabs and projects). Wraps around.
function cycle(step) {
  if (activeProject !== null) {
    const ids = tabIds(activeProject);
    activate(ids[(ids.indexOf(activeId) + step + ids.length) % ids.length]);
  } else {
    const items = barItems();
    const i = items.indexOf(sessions.get(activeId).tabEl);
    openItem(items[(i + step + items.length) % items.length]);
  }
}

// Escape closes an open menu, then the preferences, theme or projects panel.
// Cmd+, opens Preferences.
// While the projects panel is open (Shift+Cmd+P, from the menu bar), Cmd+S saves the
// project being edited and the tab shortcuts below are off.
// Cmd+T opens a new tab in the current project (or a loose tab if none is selected).
// Cmd+K clears the active tab's screen and scrollback, keeping the prompt line.
// Capture phase so this runs before xterm.js handles the key.
window.addEventListener(
  "keydown",
  (e) => {
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Escape" && !menuEl.hidden) {
      handled();
      hideMenu();
      return;
    }
    if (!preferencesEl.hidden) {
      if (e.key === "Escape") {
        handled();
        closePreferences();
      }
      return;
    }
    if (!themeEl.hidden) {
      if (e.key === "Escape") {
        handled();
        closeTheme();
      }
      return;
    }
    if (!projectsEl.hidden) {
      if (e.key === "Escape") {
        handled();
        closeProjects();
      } else if (e.metaKey && e.code === "KeyS") {
        handled();
        saveDraft();
      }
      return;
    }
    if (!e.metaKey) return;
    if (!e.shiftKey && e.code === "Comma") {
      handled();
      showPreferences();
      return;
    }
    if (!e.shiftKey && e.code === "KeyT") {
      handled();
      newTabHere();
      return;
    }
    if (!e.shiftKey && e.code === "KeyK") {
      handled();
      sessions.get(activeId)?.term.clear();
      return;
    }
    if (!e.shiftKey) return;
    const step = { BracketRight: 1, BracketLeft: -1 }[e.code];
    if (!step) return;
    handled();
    cycle(step);
  },
  true,
);

// A new tab that starts in the active tab's current directory (or where that tab
// started, if its shell hasn't reported one yet).
async function newTabHere(projectId = activeProject) {
  const s = sessions.get(activeId);
  const cwd = s ? ((await invoke("pty_cwds"))[activeId] ?? s.startCwd) : null;
  return newTab(projectId, { cwd });
}

// The top bar's + makes a loose tab; the project bar's + adds to the selected project.
newTabEl.addEventListener("click", () => newTabHere(null));
newProjectTabEl.addEventListener("click", () => newTabHere(activeProject));

// A new (unsaved) project with one tab, its name ready to edit.
function startNewProject() {
  const projectId = createProject();
  newTab(projectId);
  renameProject(projectId);
}

// The ▾ menu: a new (unsaved) project, saved projects to open, the projects panel, the
// theme panel and preferences.
// The Projects menu in the macOS menu bar has the same project items.
projectsMenuEl.addEventListener("click", () => {
  const items = [
    { label: "New Project", action: startNewProject },
    "-",
    ...savedProjects.map((p) => ({ label: `Open ${p.name}`, action: () => openSavedProject(p) })),
    { label: "Manage Projects…  ⇧⌘P", action: () => showProjects() },
    "-",
    { label: "Edit Theme…", action: () => showTheme() },
    { label: "Preferences…  ⌘,", action: () => showPreferences() },
  ];
  const r = projectsMenuEl.getBoundingClientRect();
  // In the sidebar the button is at the bottom, so open beside it rather than over it.
  if (document.body.classList.contains("tabs-left")) showMenu(r.right + 4, r.top, items);
  else showMenu(r.left, r.bottom, items);
});

// Refit whenever the terminal area changes size (window resizes, project bar showing).
new ResizeObserver(fit).observe(terminalsEl);

// ---- Session: what's open, restored on the next launch ----
// The top bar's items in order (loose tabs, and projects with their tabs), each tab's
// directory, custom name and command, and what's showing go to a JSON file via Rust.
// Directories change without any event here (the user just runs `cd`), so also save
// every few seconds and when the window loses focus. Nothing is saved until restoring
// has finished.
let restored = false;
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

// A tab as saved data. `cwds` comes from pty_cwds; tabs whose zsh hasn't reported
// yet use their start directory.
function snapshotTab(id, cwds) {
  const s = sessions.get(id);
  return { cwd: cwds[id] ?? s.startCwd, name: s.customName, command: s.command, color: s.color };
}

async function save() {
  if (!restored) return;
  const cwds = await invoke("pty_cwds");
  const items = barItems();
  const shown =
    activeProject === null ? sessions.get(activeId)?.tabEl : openProjects.get(activeProject).chipEl;
  const data = {
    version: 3,
    active: items.indexOf(shown),
    items: items.map((el) => {
      if (!el.classList.contains("project-chip")) {
        return { type: "tab", ...snapshotTab(Number(el.dataset.id), cwds) };
      }
      const pid = Number(el.dataset.project);
      const p = openProjects.get(pid);
      const ids = tabIds(pid);
      return {
        type: "project",
        name: p.name,
        color: p.color,
        savedId: p.savedId,
        activeTab: Math.max(0, ids.indexOf(p.lastTabId)),
        tabs: ids.map((id) => snapshotTab(id, cwds)),
      };
    }),
  };
  await invoke("store_save", { key: "session", data: JSON.stringify(data) });
}

setInterval(save, 5000);
window.addEventListener("blur", save);

async function restore() {
  const saved = await loadStore("session");
  // Version 1 files held only groups; versions 1-2 called projects "groups".
  const v1 = saved?.version === 1;
  const items = (v1 ? saved.groups?.map((g) => ({ type: "group", ...g })) : saved?.items) ?? [];
  const active = v1 ? saved.activeGroup : saved?.active;

  // One "show this" function per restored item, to show the saved active one at the end.
  const shows = [];
  for (const item of items) {
    if (item.type === "group" || item.type === "project") {
      if (!item.tabs?.length) continue;
      // Old groups had no link; link one to the saved project with its exact name, if unique.
      const sameName = savedProjects.filter((p) => p.name === item.name);
      const savedId = item.type === "group" && sameName.length === 1 ? sameName[0].id : item.savedId ?? null;
      const projectId = createProject(item.name, item.color, savedId);
      for (const t of item.tabs) await newTab(projectId, { ...t, run: false });
      const ids = tabIds(projectId);
      shows.push(() => activate(ids[Math.min(item.activeTab ?? 0, ids.length - 1)]));
    } else {
      const id = await newTab(null, { cwd: item.cwd, name: item.name, command: item.command, color: item.color, run: false });
      shows.push(() => activate(id));
    }
  }
  if (shows.length === 0) {
    await newTab(null);
    return;
  }
  shows[Math.min(Math.max(active ?? 0, 0), shows.length - 1)]();
}

// Read a JSON store file; null if it doesn't exist yet or can't be parsed.
async function loadStore(key) {
  try {
    return JSON.parse(await invoke("store_load", { key }));
  } catch {
    return null;
  }
}

// ---- Projects ----
// A saved project is a name, a color and a list of tabs, each with an optional name,
// a directory and a command that runs when the tab opens. Opening one adds it to the
// top bar as an open project linked to it (or shows it, if it's already open).
// "Save Project" on an open project writes its current tabs back. Stored via Rust:
//   [{ id, name, color, tabs: [{ name, cwd, command }] }]   (cwd may start with "~")

const home = await window.__TAURI__.path.homeDir();
const expandHome = (p) => (p === "~" || p?.startsWith("~/") ? home + p.slice(1) : p || null);
const tildify = (p) => (p && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p ?? "");

let savedProjects = await loadStore("projects");
if (!Array.isArray(savedProjects)) savedProjects = [];
// Earlier projects held groups and loose tabs ("items"); flatten them into one tab list.
savedProjects = savedProjects.map((p) =>
  p.items
    ? {
        id: p.id,
        name: p.name,
        color: toSlot(p.items.find((i) => i.type === "group")?.color) ?? PROJECT_SLOTS[0],
        tabs: p.items.flatMap((i) => (i.type === "group" ? i.tabs : [{ name: i.name, cwd: i.cwd, command: i.command }])),
      }
    : { ...p, color: toSlot(p.color) },
);

function persistProjects() {
  refreshProjectsMenu();
  return invoke("store_save", { key: "projects", data: JSON.stringify(savedProjects) });
}

const openInstance = (savedId) => [...openProjects].find(([, p]) => p.savedId === savedId)?.[0];

async function openSavedProject(project) {
  const already = openInstance(project.id);
  if (already !== undefined) {
    switchProject(already);
    return;
  }
  if (project.tabs.length === 0) return;
  const projectId = createProject(project.name.trim() || "Project", project.color, project.id);
  for (const t of project.tabs) {
    await newTab(projectId, {
      cwd: expandHome(t.cwd?.trim()),
      name: t.name?.trim() || null,
      command: t.command?.trim() || null,
    });
  }
  activate(tabIds(projectId)[0]);
}

// An open project's tabs as saved-project tabs (live directories, names and commands).
async function liveTabs(projectId) {
  const cwds = await invoke("pty_cwds");
  return tabIds(projectId).map((id) => {
    const s = sessions.get(id);
    return { name: s.customName ?? "", cwd: tildify(cwds[id] ?? s.startCwd ?? "~"), command: s.command ?? "" };
  });
}

// Write an open project back to its saved project, creating and linking one if it
// isn't saved yet. The chip flashes to confirm.
async function saveOpenProject(projectId) {
  const p = openProjects.get(projectId);
  const entry = {
    id: p.savedId ?? crypto.randomUUID(),
    name: p.name,
    color: p.color,
    tabs: await liveTabs(projectId),
  };
  const i = savedProjects.findIndex((q) => q.id === entry.id);
  if (i === -1) savedProjects.push(entry);
  else savedProjects[i] = entry;
  await persistProjects();
  p.savedId = entry.id;
  scheduleSave();
  // Keep an open, unedited panel showing the new version.
  if (draft?.id === entry.id && !dirty) {
    loadDraft(entry);
    renderProjects();
  }
  p.chipEl.classList.remove("flash");
  void p.chipEl.offsetWidth; // restart the animation
  p.chipEl.classList.add("flash");
}

// Open the panel on an open project's saved version, or, if it isn't saved yet, on a
// new unsaved project filled in from it (linked to it once saved).
async function editOpenProject(projectId) {
  const p = openProjects.get(projectId);
  if (p.savedId && savedProjects.some((q) => q.id === p.savedId)) {
    showProjects();
    selectProject(p.savedId);
    return;
  }
  const tabs = await liveTabs(projectId);
  showProjects();
  newProject({ name: p.name, color: p.color, tabs }, projectId);
}

const projectCount = (p) => `${p.tabs.length} tab${p.tabs.length === 1 ? "" : "s"}`;

// The panel edits a copy (`draft`) of one saved project; Save writes it back. Leaving
// a project with unsaved edits (switching, closing, New) first asks to save.
const projectListEl = document.getElementById("project-list");
const projectEditorEl = document.getElementById("project-editor");
const projectFooterEl = document.getElementById("project-footer");
let draft = null;
let dirty = false;
let pendingLeave = null; // action waiting on the "save changes?" question
let deleteArmed = false;
let linkOnSave = null; // { draftId, projectId }: open project to link when the draft is saved

const blankTab = () => ({ name: "", cwd: "~", command: "" });
const isSaved = (p) => savedProjects.some((q) => q.id === p.id);

function showProjects() {
  hideMenu();
  projectsEl.hidden = false;
  if (!draft && savedProjects.length) loadDraft(savedProjects[0]);
  renderProjects();
  projectEditorEl.querySelector(".project-name")?.focus();
}

function toggleProjects() {
  if (projectsEl.hidden) showProjects();
  else closeProjects();
}

function closeProjects() {
  leave(() => {
    projectsEl.hidden = true;
    // Next time, start from the saved version (or the first project).
    draft = draft && isSaved(draft) ? structuredClone(savedProjects.find((p) => p.id === draft.id)) : null;
    sessions.get(activeId)?.term.focus();
  });
}

function loadDraft(project) {
  draft = project ? structuredClone(project) : null;
  dirty = false;
  deleteArmed = false;
}

// Run `action` now, or after the user saves or discards unsaved edits.
function leave(action) {
  if (!dirty) return action();
  pendingLeave = action;
  renderFooter();
}

function selectProject(id) {
  leave(() => {
    loadDraft(savedProjects.find((p) => p.id === id));
    renderProjects();
  });
}

// `prefill` (from an unsaved open project) replaces the default name, color and tabs;
// `linkTo` is that open project, linked to the new saved project when it's saved.
function newProject(prefill = null, linkTo = null) {
  leave(() => {
    loadDraft({
      id: crypto.randomUUID(),
      name: "New Project",
      color: leastUsedColor(savedProjects.map((p) => p.color)),
      tabs: [blankTab()],
      ...prefill,
    });
    linkOnSave = linkTo === null ? null : { draftId: draft.id, projectId: linkTo };
    dirty = true;
    renderProjects();
    const nameInput = projectEditorEl.querySelector(".project-name");
    nameInput.focus();
    nameInput.select();
  });
}

function markDirty() {
  dirty = true;
  deleteArmed = false;
  renderList();
  renderFooter();
}

// Returns whether the draft was saved (the name is required).
function saveDraft() {
  if (!draft) return false;
  if (!draft.name.trim()) {
    const nameInput = projectEditorEl.querySelector(".project-name");
    nameInput.classList.add("invalid");
    nameInput.focus();
    return false;
  }
  draft.name = draft.name.trim();
  const i = savedProjects.findIndex((p) => p.id === draft.id);
  if (i === -1) savedProjects.push(structuredClone(draft));
  else savedProjects[i] = structuredClone(draft);
  persistProjects();
  if (linkOnSave?.draftId === draft.id && openProjects.has(linkOnSave.projectId)) {
    openProjects.get(linkOnSave.projectId).savedId = draft.id;
    linkOnSave = null;
    scheduleSave();
  }
  dirty = false;
  renderList();
  renderFooter();
  return true;
}

function revertDraft() {
  loadDraft(isSaved(draft) ? savedProjects.find((p) => p.id === draft.id) : savedProjects[0]);
  renderProjects();
}

function deleteDraft() {
  if (!deleteArmed) {
    // First click arms the button; a second click within 3 seconds deletes.
    deleteArmed = true;
    renderFooter();
    setTimeout(() => {
      if (!deleteArmed) return;
      deleteArmed = false;
      renderFooter();
    }, 3000);
    return;
  }
  const i = savedProjects.findIndex((p) => p.id === draft.id);
  savedProjects.splice(i, 1);
  persistProjects();
  // Open copies stay open, just no longer linked.
  for (const p of openProjects.values()) if (p.savedId === draft.id) p.savedId = null;
  scheduleSave();
  loadDraft(savedProjects[Math.min(i, savedProjects.length - 1)]);
  renderProjects();
}

async function openDraft() {
  if (dirty && !saveDraft()) return;
  const project = structuredClone(draft);
  closeProjects();
  await openSavedProject(project);
}

// --- Panel rendering. Typing updates `draft` in place (no re-render, so focus stays);
// adding, removing or recoloring re-renders the editor.

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== false));
  return node;
}

function renderProjects() {
  renderList();
  renderEditor();
  renderFooter();
}

function renderList() {
  const entries = savedProjects.map((p) => (draft?.id === p.id ? draft : p));
  if (draft && !isSaved(draft)) entries.push(draft);
  projectListEl.replaceChildren(
    ...entries.map((p) => {
      const dot = el("span", { className: "dot" });
      dot.style.backgroundColor = colorOf(p.color);
      return el(
        "li",
        {
          className: p.id === draft?.id ? "selected" : "",
          onclick: () => p.id !== draft?.id && selectProject(p.id),
        },
        el("div", { className: "project-title" }, dot, p.name.trim() || "Untitled"),
        el("div", {
          className: "project-meta",
          textContent: isSaved(p) ? projectCount(p) : "Unsaved",
        }),
      );
    }),
  );
}

function renderEditor() {
  if (!draft) {
    projectEditorEl.replaceChildren(
      el(
        "div",
        { className: "projects-empty" },
        el("p", { textContent: "No projects yet." }),
        el("p", {
          className: "muted",
          textContent: "A project opens a set of tabs, each starting in its own folder and optionally running a command.",
        }),
        el("button", { className: "btn primary", textContent: "New Project", onclick: () => newProject() }),
      ),
    );
    return;
  }

  const dot = el("button", {
    className: "dot",
    title: "Project color",
    onclick: () => {
      const r = dot.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, [
        {
          swatches: PROJECT_SLOTS,
          selected: draft.color,
          pick: (c) => {
            draft.color = c;
            markDirty();
            renderEditor();
          },
        },
      ]);
    },
  });
  dot.style.backgroundColor = colorOf(draft.color);
  const nameInput = el("input", {
    className: "project-name",
    value: draft.name,
    placeholder: "Project name",
    spellcheck: false,
    oninput: () => {
      nameInput.classList.remove("invalid");
      draft.name = nameInput.value;
      markDirty();
    },
  });

  const rows = draft.tabs.map((t, i) =>
    tabRow(t, () => {
      draft.tabs.splice(i, 1);
      markDirty();
      renderEditor();
    }),
  );

  projectEditorEl.replaceChildren(
    el(
      "div",
      { className: "field" },
      el("span", { textContent: "Name" }),
      el("div", { className: "name-row" }, dot, nameInput),
    ),
    el(
      "div",
      { className: "columns" },
      el("span", { textContent: "Tab name" }),
      el("span", { textContent: "Directory" }),
      el("span", { textContent: "Command" }),
    ),
    ...rows,
    el(
      "button",
      {
        className: "add",
        textContent: "+ Add tab",
        onclick: () => {
          draft.tabs.push(blankTab());
          markDirty();
          renderEditor();
          // Put the cursor in the new row's first field.
          [...projectEditorEl.querySelectorAll(".tab-row")].at(-1).querySelector("input").focus();
        },
      },
    ),
  );
}

function tabRow(tab, remove) {
  const input = (field, props) =>
    el("input", {
      value: tab[field],
      spellcheck: false,
      ...props,
      oninput: (e) => {
        tab[field] = e.target.value;
        markDirty();
      },
    });
  const cwdInput = input("cwd", { placeholder: "~" });
  return el(
    "div",
    { className: "tab-row" },
    input("name", { placeholder: "Automatic" }),
    el(
      "div",
      { className: "dir" },
      cwdInput,
      el("button", {
        className: "icon",
        title: "Choose folder…",
        textContent: "…",
        onclick: async () => {
          const dir = await window.__TAURI__.dialog.open({
            directory: true,
            defaultPath: expandHome(cwdInput.value.trim()) ?? home,
          });
          if (!dir) return;
          cwdInput.value = tab.cwd = tildify(dir);
          markDirty();
        },
      }),
    ),
    input("command", { className: "command", placeholder: "None" }),
    el("button", { className: "icon remove", title: "Remove tab", textContent: "×", onclick: remove }),
  );
}

function renderFooter() {
  if (!draft) {
    projectFooterEl.replaceChildren();
    return;
  }
  const button = (label, className, onclick, props = {}) =>
    el("button", { className: `btn ${className}`, textContent: label, onclick, ...props });

  if (pendingLeave) {
    const name = draft.name.trim() || "this project";
    const resume = (save) => {
      if (save && !saveDraft()) {
        pendingLeave = null;
        renderFooter();
        return;
      }
      const action = pendingLeave;
      pendingLeave = null;
      dirty = false;
      action();
    };
    projectFooterEl.replaceChildren(
      el("span", { className: "status", textContent: `Save changes to “${name}”?` }),
      el(
        "div",
        { className: "actions" },
        button("Don't Save", "", () => {
          if (!isSaved(draft)) loadDraft(null);
          resume(false);
        }),
        button("Keep Editing", "", () => {
          pendingLeave = null;
          renderFooter();
        }),
        button("Save", "primary", () => resume(true)),
      ),
    );
    return;
  }

  const openLabel = openInstance(draft.id) === undefined ? "Open" : "Show";
  projectFooterEl.replaceChildren(
    isSaved(draft) ? button(deleteArmed ? "Click again to delete" : "Delete", "danger", deleteDraft) : el("span"),
    el(
      "div",
      { className: "actions" },
      el("span", { className: "status", textContent: dirty ? "Unsaved changes" : "" }),
      dirty ? button("Cancel", "", revertDraft) : null,
      button("Save", "", saveDraft, { disabled: !dirty, title: "⌘S" }),
      button(openLabel, "primary", openDraft, { disabled: draft.tabs.length === 0 }),
    ),
  );
}

document.getElementById("project-new").addEventListener("click", () => newProject());
document.getElementById("projects-close").addEventListener("click", () => closeProjects());
// Clicking the dimmed backdrop (outside the panel) also closes it.
projectsEl.addEventListener("mousedown", (e) => {
  if (e.target === projectsEl) closeProjects();
});

// ---- Theme ----
// One theme: the defaults (theme.js) with the user's changes on top, saved in
// settings. The font size and terminal colors go to xterm.js, the app colors to the
// CSS variables in styles.css. The Theme panel edits them live.

// The theme's number settings: limits for their fields (xterm.js needs a line
// height of at least 1).
const NUMBER_SETTINGS = {
  fontSize: { label: "Font size", min: 8, max: 40, step: 1, integer: true },
  lineHeight: { label: "Line height", min: 1, max: 2, step: 0.05 },
};
const validNumber = (key, value) => {
  const { min, max, integer } = NUMBER_SETTINGS[key];
  return typeof value === "number" && (integer ? Number.isInteger(value) : Number.isFinite(value)) && value >= min && value <= max;
};
const savedSettings = (await loadStore("settings")) ?? {};
// Saved as "colors" before font size was added (and "theme" once held a theme name).
const savedTheme = (typeof savedSettings.theme === "object" ? savedSettings.theme : savedSettings.colors) ?? {};
const theme = {
  fontFamily: typeof savedTheme.fontFamily === "string" ? savedTheme.fontFamily : DEFAULT_THEME.fontFamily,
  fontSize: validNumber("fontSize", savedTheme.fontSize) ? savedTheme.fontSize : DEFAULT_THEME.fontSize,
  lineHeight: validNumber("lineHeight", savedTheme.lineHeight) ? savedTheme.lineHeight : DEFAULT_THEME.lineHeight,
  terminal: { ...DEFAULT_THEME.terminal, ...savedTheme.terminal },
  app: { ...DEFAULT_THEME.app, ...savedTheme.app },
};

// The CSS font list for a font name. SF Mono isn't installed as a regular font;
// WebKit reaches it as `ui-monospace`.
const fontStack = (name) => `${name === "SF Mono" ? "ui-monospace" : `"${name}"`}, monospace`;

function applyTheme() {
  termOptions.fontFamily = fontStack(theme.fontFamily);
  termOptions.fontSize = theme.fontSize;
  termOptions.lineHeight = theme.lineHeight;
  termOptions.theme = { ...theme.terminal };
  for (const s of sessions.values()) {
    s.term.options.fontFamily = termOptions.fontFamily;
    s.term.options.fontSize = theme.fontSize;
    s.term.options.lineHeight = theme.lineHeight;
    // A new object each time, so xterm.js sees the change.
    s.term.options.theme = { ...theme.terminal };
  }
  // A new font changes how many rows and columns fit (other tabs refit when shown).
  fit();
  for (const [name, value] of Object.entries(theme.app)) {
    document.documentElement.style.setProperty(`--${name}`, value);
  }
  document.documentElement.style.setProperty("--terminal-bg", theme.terminal.background);
  // Claude status dots use these palette colors.
  for (const slot of ["red", "green", "yellow", "blue"]) {
    document.documentElement.style.setProperty(`--ansi-${slot}`, theme.terminal[slot]);
  }
  // Project colors are palette slots; recolor them from the palette.
  for (const [pid, p] of openProjects) setProjectColor(pid, p.color);
  for (const [id, s] of sessions) setTabColor(id, s.color);
}

// Saves the theme and preferences. Only what differs from the default theme is saved.
let settingsTimer = null;
function persistSettings() {
  const changed = (group) =>
    Object.fromEntries(Object.entries(theme[group]).filter(([k, v]) => v !== DEFAULT_THEME[group][k]));
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    const saved = { terminal: changed("terminal"), app: changed("app") };
    if (theme.fontFamily !== DEFAULT_THEME.fontFamily) saved.fontFamily = theme.fontFamily;
    for (const key of Object.keys(NUMBER_SETTINGS)) {
      if (theme[key] !== DEFAULT_THEME[key]) saved[key] = theme[key];
    }
    invoke("store_save", { key: "settings", data: JSON.stringify({ theme: saved, preferences }) });
  }, 300);
}

const COLOR_LABELS = {
  terminal: {
    background: "Background",
    foreground: "Text",
    cursor: "Cursor",
    cursorAccent: "Text under cursor",
    selectionBackground: "Selection",
    selectionForeground: "Selected text",
    black: "Black",
    red: "Red",
    green: "Green",
    yellow: "Yellow",
    blue: "Blue",
    magenta: "Magenta",
    cyan: "Cyan",
    white: "White",
    brightBlack: "Bright black",
    brightRed: "Bright red",
    brightGreen: "Bright green",
    brightYellow: "Bright yellow",
    brightBlue: "Bright blue",
    brightMagenta: "Bright magenta",
    brightCyan: "Bright cyan",
    brightWhite: "Bright white",
  },
  app: {
    bg: "Active tab, inputs",
    fg: "Bar and panel text",
    bar: "Top bar, menus, panels",
    sunken: "Panel sidebar",
    tint: "Project chips",
    raised: "Project bar, buttons",
    "raised-hover": "Buttons (hover)",
    highlight: "Project saved flash",
    divider: "Dividers",
    border: "Borders",
    "border-strong": "Menu borders",
    muted: "Secondary text",
    placeholder: "Placeholder text",
    accent: "Accent",
    "accent-hover": "Accent (hover)",
    "on-accent": "Text on accent",
    danger: "Delete buttons",
  },
};

const themeListEl = document.getElementById("theme-list");
const themeResetEl = document.getElementById("theme-reset");
let themeUpdaters = []; // refresh each control from `theme`
let resetArmed = false;

function showTheme() {
  hideMenu();
  themeEl.hidden = false;
  renderTheme();
}

function closeTheme() {
  themeEl.hidden = true;
  sessions.get(activeId)?.term.focus();
}

function setColor(group, key, value) {
  theme[group][key] = value;
  applyTheme();
  persistSettings();
}

// Installed monospaced fonts (from Rust) plus SF Mono, fetched once.
let monoFonts = null;
const loadMonoFonts = () =>
  (monoFonts ??= invoke("mono_fonts")
    .catch(() => [])
    .then((names) => [...new Set([...(Array.isArray(names) ? names : []), "SF Mono"])].sort()));

// The terminal font: a menu of monospaced fonts. A saved font that's no longer
// installed stays listed (marked) so the menu shows what's set.
function fontFamilyRow() {
  const select = el("select", {
    className: "font-family",
    onchange: () => {
      theme.fontFamily = select.value;
      applyTheme();
      persistSettings();
    },
  });
  const update = async () => {
    const names = await loadMonoFonts();
    const options = names.map((name) => el("option", { value: name, textContent: name }));
    if (!names.includes(theme.fontFamily)) {
      options.unshift(el("option", { value: theme.fontFamily, textContent: `${theme.fontFamily} (not installed)` }));
    }
    select.replaceChildren(...options);
    select.value = theme.fontFamily;
  };
  themeUpdaters.push(update);
  update();
  return el(
    "div",
    { className: "color-row" },
    el("span", { className: "label", textContent: "Font" }),
    el("span", { className: "select" }, select),
  );
}

// A number setting (font size in pixels, line height as a multiple of it): a number
// field with arrows.
function numberRow(key) {
  const { label, min, max, step } = NUMBER_SETTINGS[key];
  const input = el("input", {
    type: "number",
    className: "number",
    min,
    max,
    step,
    oninput: () => {
      const value = Number(input.value);
      const ok = input.value.trim() !== "" && validNumber(key, value);
      input.classList.toggle("invalid", !ok);
      if (!ok) return;
      theme[key] = value;
      applyTheme();
      persistSettings();
    },
    // Leaving the field drops an unfinished value.
    onblur: () => update(),
  });
  const update = () => {
    input.value = theme[key];
    input.classList.remove("invalid");
  };
  themeUpdaters.push(update);
  update();
  return el("div", { className: "color-row" }, el("span", { className: "label", textContent: label }), input);
}

// A row per color: name, a swatch (opens the macOS color picker) and a hex field.
function colorRow(group, key) {
  const swatch = el("input", {
    type: "color",
    oninput: () => {
      setColor(group, key, swatch.value);
      hex.value = swatch.value;
    },
  });
  const hex = el("input", {
    className: "hex",
    spellcheck: false,
    maxLength: 7,
    oninput: () => {
      const value = `#${hex.value.trim().replace(/^#/, "").toLowerCase()}`;
      const ok = /^#[0-9a-f]{6}$/.test(value);
      hex.classList.toggle("invalid", !ok);
      if (!ok) return;
      setColor(group, key, value);
      swatch.value = value;
    },
    // Leaving the field drops an unfinished value.
    onblur: () => update(),
  });
  const update = () => {
    swatch.value = theme[group][key];
    hex.value = theme[group][key];
    hex.classList.remove("invalid");
  };
  themeUpdaters.push(update);
  update();
  return el("div", { className: "color-row" }, el("span", { className: "label", textContent: COLOR_LABELS[group][key] }), swatch, hex);
}

function renderTheme() {
  themeUpdaters = [];
  const section = (title, group) => [
    el("h3", { textContent: title }),
    ...Object.keys(DEFAULT_THEME[group]).map((key) => colorRow(group, key)),
  ];
  themeListEl.replaceChildren(
    el("h3", { textContent: "Font" }),
    fontFamilyRow(),
    numberRow("fontSize"),
    numberRow("lineHeight"),
    ...section("Terminal colors", "terminal"),
    ...section("App colors", "app"),
  );
}

// Two clicks, like deleting a project.
themeResetEl.addEventListener("click", () => {
  if (!resetArmed) {
    resetArmed = true;
    themeResetEl.textContent = "Click again to reset";
    setTimeout(() => {
      resetArmed = false;
      themeResetEl.textContent = "Reset to Defaults";
    }, 3000);
    return;
  }
  resetArmed = false;
  themeResetEl.textContent = "Reset to Defaults";
  theme.fontFamily = DEFAULT_THEME.fontFamily;
  theme.fontSize = DEFAULT_THEME.fontSize;
  theme.lineHeight = DEFAULT_THEME.lineHeight;
  Object.assign(theme.terminal, DEFAULT_THEME.terminal);
  Object.assign(theme.app, DEFAULT_THEME.app);
  applyTheme();
  persistSettings();
  for (const update of themeUpdaters) update();
});
document.getElementById("theme-close").addEventListener("click", () => closeTheme());
document.getElementById("theme-done").addEventListener("click", () => closeTheme());
// The panel leaves the terminal visible; clicking it closes the panel.
themeEl.addEventListener("mousedown", (e) => {
  if (e.target === themeEl) closeTheme();
});

applyTheme();

// ---- Preferences ----
// On/off settings, saved in settings next to the theme (all on by default). Each one
// that's off adds its class to body, which the CSS reads.
const PREFERENCES = {
  projectDots: { section: "Claude status dots", label: "On projects", offClass: "hide-project-dots" },
  subTabDots: { section: "Claude status dots", label: "On tabs in projects", offClass: "hide-sub-tab-dots" },
};
const preferences = Object.fromEntries(
  Object.keys(PREFERENCES).map((key) => [key, savedSettings.preferences?.[key] !== false]),
);
// Where the top bar's items (loose tabs and projects) go: "top" or a "left" sidebar.
preferences.tabsPosition = savedSettings.preferences?.tabsPosition === "left" ? "left" : "top";
preferences.sidebarWidth = Number(savedSettings.preferences?.sidebarWidth) || 200;

function applyPreferences() {
  for (const [key, { offClass }] of Object.entries(PREFERENCES)) {
    document.body.classList.toggle(offClass, !preferences[key]);
  }
  document.body.classList.toggle("tabs-left", preferences.tabsPosition === "left");
  document.body.style.setProperty("--sidebar-width", `${preferences.sidebarWidth}px`);
}

// Dragging the sidebar's right edge sets its width.
document.getElementById("sidebar-resizer").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  document.body.classList.add("sidebar-resizing");
  const onMove = (e) => {
    preferences.sidebarWidth = Math.round(Math.min(Math.max(e.clientX, 120), innerWidth / 2));
    applyPreferences();
  };
  const onUp = () => {
    document.body.classList.remove("sidebar-resizing");
    persistSettings();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
});

// A choice of tab position, then a checkbox per preference under its section's heading.
function renderPreferences() {
  const rows = [el("h3", { textContent: "Tabs and projects" })];
  for (const [value, label] of [["top", "Top bar"], ["left", "Left sidebar"]]) {
    const radio = el("input", {
      type: "radio",
      name: "tabs-position",
      checked: preferences.tabsPosition === value,
      onchange: () => {
        preferences.tabsPosition = value;
        applyPreferences();
        persistSettings();
      },
    });
    rows.push(el("label", { className: "check-row" }, radio, label));
  }
  let section = null;
  for (const [key, p] of Object.entries(PREFERENCES)) {
    if (p.section !== section) rows.push(el("h3", { textContent: (section = p.section) }));
    const box = el("input", {
      type: "checkbox",
      checked: preferences[key],
      onchange: () => {
        preferences[key] = box.checked;
        applyPreferences();
        persistSettings();
      },
    });
    rows.push(el("label", { className: "check-row" }, box, p.label));
  }
  document.getElementById("preferences-list").replaceChildren(...rows);
}

function showPreferences() {
  hideMenu();
  renderPreferences();
  preferencesEl.hidden = false;
}

function closePreferences() {
  preferencesEl.hidden = true;
  sessions.get(activeId)?.term.focus();
}

document.getElementById("preferences-close").addEventListener("click", () => closePreferences());
document.getElementById("preferences-done").addEventListener("click", () => closePreferences());
// Clicking the dimmed backdrop (outside the panel) also closes it.
preferencesEl.addEventListener("mousedown", (e) => {
  if (e.target === preferencesEl) closePreferences();
});

applyPreferences();

await restore();
restored = true;
save();

// ---- macOS menu bar ----
// Tauri's default menus (app, File, Edit, View, Window, Help) plus a Projects menu
// before Window. Its items are rebuilt whenever the saved projects change. Its
// shortcut (Shift+Cmd+P) is handled by the menu, not the keydown handler above.

const { Menu, Submenu, MenuItem, PredefinedMenuItem } = window.__TAURI__.menu;
let projectsSubmenu = null;
let menuUpdate = Promise.resolve();

function refreshProjectsMenu() {
  if (!projectsSubmenu) return;
  // One rebuild at a time, so quick successive saves can't interleave their items.
  menuUpdate = menuUpdate.then(async () => {
    const items = [
      await MenuItem.new({ text: "New Project", action: startNewProject }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      ...(await Promise.all(
        savedProjects.map((p) => MenuItem.new({ text: `Open ${p.name}`, action: () => openSavedProject(p) })),
      )),
      await MenuItem.new({ text: "Manage Projects…", accelerator: "CmdOrCtrl+Shift+P", action: toggleProjects }),
    ];
    for (const item of await projectsSubmenu.items()) await projectsSubmenu.remove(item);
    await projectsSubmenu.append(items);
  });
  menuUpdate = menuUpdate.catch((err) => console.error("Projects menu:", err));
}

try {
  const menu = await Menu.default();
  projectsSubmenu = await Submenu.new({ text: "Projects" });
  const names = await Promise.all((await menu.items()).map((m) => m.text()));
  const windowIndex = names.indexOf("Window");
  await menu.insert(projectsSubmenu, windowIndex === -1 ? names.length : windowIndex);
  await menu.setAsAppMenu();
  refreshProjectsMenu();
} catch (err) {
  console.error("Menu bar setup failed:", err);
}
