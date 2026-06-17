/**
 * Lightweight ANSI escape code parser.
 * Converts ANSI-colored text into an array of styled spans for React rendering.
 * Supports SGR (Select Graphic Rendition) codes: colors, bold, dim, italic, underline, reset.
 */

export interface AnsiSpan {
  text: string;
  style: React.CSSProperties;
}

// Standard 4-bit ANSI color palette
const COLORS_FG: Record<number, string> = {
  30: "#1e1e2e", // black
  31: "#f38ba8", // red
  32: "#a6e3a1", // green
  33: "#f9e2af", // yellow
  34: "#89b4fa", // blue
  35: "#cba6f7", // magenta
  36: "#94e2d5", // cyan
  37: "#cdd6f4", // white
  90: "#585b70", // bright black (gray)
  91: "#f38ba8", // bright red
  92: "#a6e3a1", // bright green
  93: "#f9e2af", // bright yellow
  94: "#89b4fa", // bright blue
  95: "#cba6f7", // bright magenta
  96: "#94e2d5", // bright cyan
  97: "#ffffff", // bright white
};

const COLORS_BG: Record<number, string> = {
  40: "#1e1e2e",
  41: "#f38ba8",
  42: "#a6e3a1",
  43: "#f9e2af",
  44: "#89b4fa",
  45: "#cba6f7",
  46: "#94e2d5",
  47: "#cdd6f4",
  100: "#585b70",
  101: "#f38ba8",
  102: "#a6e3a1",
  103: "#f9e2af",
  104: "#89b4fa",
  105: "#cba6f7",
  106: "#94e2d5",
  107: "#ffffff",
};

interface AnsiState {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function stateToStyle(state: AnsiState): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (state.color) style.color = state.color;
  if (state.background) style.backgroundColor = state.background;
  if (state.bold) style.fontWeight = "bold";
  if (state.dim) style.opacity = 0.6;
  if (state.italic) style.fontStyle = "italic";
  if (state.underline) style.textDecoration = "underline";
  return style;
}

function applyCode(state: AnsiState, code: number): AnsiState {
  if (code === 0) return {}; // reset
  if (code === 1) return { ...state, bold: true };
  if (code === 2) return { ...state, dim: true };
  if (code === 3) return { ...state, italic: true };
  if (code === 4) return { ...state, underline: true };
  if (code === 22) return { ...state, bold: false, dim: false };
  if (code === 23) return { ...state, italic: false };
  if (code === 24) return { ...state, underline: false };
  if (code === 39) return { ...state, color: undefined }; // default fg
  if (code === 49) return { ...state, background: undefined }; // default bg
  if (COLORS_FG[code]) return { ...state, color: COLORS_FG[code] };
  if (COLORS_BG[code]) return { ...state, background: COLORS_BG[code] };
  return state;
}

// Regex to match ANSI escape sequences: ESC[ ... m
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

/**
 * Parse a single line of text containing ANSI escape codes into styled spans.
 * Returns an array of { text, style } objects for rendering.
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let state: AnsiState = {};
  let lastIndex = 0;

  ANSI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ANSI_RE.exec(input)) !== null) {
    // Push text before this escape sequence
    if (match.index > lastIndex) {
      const text = input.slice(lastIndex, match.index);
      if (text) {
        spans.push({ text, style: stateToStyle(state) });
      }
    }

    // Parse the SGR codes (semicolon-separated numbers)
    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    for (const code of codes) {
      state = applyCode(state, code);
    }

    lastIndex = ANSI_RE.lastIndex;
  }

  // Push remaining text after last escape sequence
  if (lastIndex < input.length) {
    const text = input.slice(lastIndex);
    if (text) {
      spans.push({ text, style: stateToStyle(state) });
    }
  }

  // If no escape codes were found, return the whole string as one span
  if (spans.length === 0 && input.length > 0) {
    spans.push({ text: input, style: {} });
  }

  return spans;
}

/**
 * Strip all ANSI escape codes from a string (for classification/plain text).
 */
export function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}
