// The app's default theme: the terminal font, font size, line height and colors from the iTerm2
// "Steven" profile (light-mode set, converted from Display P3 to sRGB). `terminal` is
// an xterm.js theme (background, foreground, cursor, selection and the 16 ANSI
// colors); `app` is the CSS variables in styles.css. All of it can be changed in the
// Theme panel; changes are saved on top of these.

export const DEFAULT_THEME = {
  fontFamily: "Monaco",
  fontSize: 16,
  lineHeight: 1.1,
  terminal: {
    background: "#262427",
    // Slightly dimmer than iTerm2's #fcfcfa so text reads closer to its thin strokes.
    foreground: "#e6e6e4",
    cursor: "#fcfcfa",
    cursorAccent: "#000000",
    selectionBackground: "#fcfcfa",
    selectionForeground: "#262427",
    black: "#262427",
    red: "#ff666d",
    green: "#b3e03a",
    yellow: "#ffc739",
    blue: "#00cde8",
    magenta: "#a392e8",
    cyan: "#9deaf6",
    white: "#fcfcfa",
    brightBlack: "#545452",
    brightRed: "#ff7f83",
    brightGreen: "#bee55e",
    brightYellow: "#ffd05e",
    brightBlue: "#1cd5eb",
    brightMagenta: "#b0a3eb",
    brightCyan: "#acedf8",
    brightWhite: "#fcfcfa",
  },
  app: {
    bg: "#262427",
    fg: "#fcfcfa",
    bar: "#1b1a1c",
    sunken: "#18171a",
    tint: "#252227",
    raised: "#2e2b30",
    "raised-hover": "#3a373c",
    highlight: "#4a4550",
    divider: "#2e2b30",
    border: "#3a383c",
    "border-strong": "#545452",
    muted: "#9a989c",
    placeholder: "#6c6a6e",
    accent: "#a392e8",
    "accent-hover": "#b0a3eb",
    "on-accent": "#1b1a1c",
    danger: "#ff666d",
  },
};
