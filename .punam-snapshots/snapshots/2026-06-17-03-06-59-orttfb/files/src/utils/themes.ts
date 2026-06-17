/**
 * Theme system for PunamIDE.
 * Themes are defined as CSS variable maps and applied dynamically.
 */

export interface ThemeDefinition {
  id: string;
  name: string;
  type: "dark" | "light";
  author?: string;
  colors: ThemeColors;
}

export interface ThemeColors {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgActive: string;
  bgInput: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  green: string;
  red: string;
  yellow: string;
  blue: string;
  purple: string;
  orange: string;
  tabActiveBg: string;
  tabInactiveBg: string;
  activeSoft: string;
  activeBorder: string;
  activeGlow: string;
  scrollbarThumb: string;
  scrollbarTrack: string;
}

export const DEFAULT_DARK_THEME_ID = "nord";
export const DEFAULT_LIGHT_THEME_ID = "github-light";

// --- Built-in Themes ---

export const BUILTIN_THEMES: ThemeDefinition[] = [
  {
    id: "opencode-light",
    name: "OpenCode Light",
    type: "light",
    author: "Punam",
    colors: {
      bgPrimary: "#fbfbfb",
      bgSecondary: "#f4f4f4",
      bgTertiary: "#eeeeee",
      bgHover: "#ededed",
      bgActive: "#d9d9d9",
      bgInput: "#ffffff",
      border: "#d8d8d8",
      textPrimary: "#1f1f1f",
      textSecondary: "#4d4d4d",
      textMuted: "#8a8a8a",
      accent: "#1f1f1f",
      accentHover: "#4a4a4a",
      green: "#0f8a5f",
      red: "#c43b3b",
      yellow: "#8a6a00",
      blue: "#4f7fbf",
      purple: "#c025a9",
      orange: "#a35a00",
      tabActiveBg: "#f4f4f4",
      tabInactiveBg: "#fbfbfb",
      activeSoft: "rgba(31, 31, 31, 0.08)",
      activeBorder: "rgba(31, 31, 31, 0.65)",
      activeGlow: "rgba(31, 31, 31, 0.12)",
      scrollbarThumb: "#c7c7c7",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "punam-full-dark",
    name: "Full Dark",
    type: "dark",
    author: "Punam",
    colors: {
      bgPrimary: "#050505",
      bgSecondary: "#0a0a0a",
      bgTertiary: "#000000",
      bgHover: "#151515",
      bgActive: "#222222",
      bgInput: "#0f0f0f",
      border: "#242424",
      textPrimary: "#f5f5f5",
      textSecondary: "#c9c9c9",
      textMuted: "#777777",
      accent: "#ffffff",
      accentHover: "#d7d7d7",
      green: "#7ee787",
      red: "#ff6b6b",
      yellow: "#ffd166",
      blue: "#7ab7ff",
      purple: "#d2a8ff",
      orange: "#ffa657",
      tabActiveBg: "#050505",
      tabInactiveBg: "#0a0a0a",
      activeSoft: "rgba(255, 255, 255, 0.1)",
      activeBorder: "rgba(255, 255, 255, 0.55)",
      activeGlow: "rgba(255, 255, 255, 0.18)",
      scrollbarThumb: "#2a2a2a",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "black-and-white",
    name: "Black & White",
    type: "light",
    author: "Punam",
    colors: {
      bgPrimary: "#ffffff",
      bgSecondary: "#f7f7f7",
      bgTertiary: "#efefef",
      bgHover: "#e8e8e8",
      bgActive: "#d7d7d7",
      bgInput: "#ffffff",
      border: "#bdbdbd",
      textPrimary: "#000000",
      textSecondary: "#2f2f2f",
      textMuted: "#737373",
      accent: "#000000",
      accentHover: "#333333",
      green: "#111111",
      red: "#111111",
      yellow: "#555555",
      blue: "#000000",
      purple: "#000000",
      orange: "#333333",
      tabActiveBg: "#ffffff",
      tabInactiveBg: "#f7f7f7",
      activeSoft: "rgba(0, 0, 0, 0.08)",
      activeBorder: "rgba(0, 0, 0, 0.65)",
      activeGlow: "rgba(0, 0, 0, 0.12)",
      scrollbarThumb: "#c2c2c2",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    type: "dark",
    author: "Catppuccin",
    colors: {
      bgPrimary: "#1e1e2e",
      bgSecondary: "#181825",
      bgTertiary: "#11111b",
      bgHover: "#313244",
      bgActive: "#45475a",
      bgInput: "#313244",
      border: "#45475a",
      textPrimary: "#cdd6f4",
      textSecondary: "#a6adc8",
      textMuted: "#6c7086",
      accent: "#89b4fa",
      accentHover: "#74c7ec",
      green: "#a6e3a1",
      red: "#f38ba8",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      purple: "#cba6f7",
      orange: "#fab387",
      tabActiveBg: "#1e1e2e",
      tabInactiveBg: "#181825",
      activeSoft: "rgba(137, 180, 250, 0.12)",
      activeBorder: "rgba(137, 180, 250, 0.55)",
      activeGlow: "rgba(137, 180, 250, 0.26)",
      scrollbarThumb: "#45475a",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    type: "light",
    author: "Catppuccin",
    colors: {
      bgPrimary: "#eff1f5",
      bgSecondary: "#e6e9ef",
      bgTertiary: "#dce0e8",
      bgHover: "#ccd0da",
      bgActive: "#bcc0cc",
      bgInput: "#e6e9ef",
      border: "#bcc0cc",
      textPrimary: "#4c4f69",
      textSecondary: "#5c5f77",
      textMuted: "#8c8fa1",
      accent: "#1e66f5",
      accentHover: "#7287fd",
      green: "#40a02b",
      red: "#d20f39",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      purple: "#8839ef",
      orange: "#fe640b",
      tabActiveBg: "#eff1f5",
      tabInactiveBg: "#e6e9ef",
      activeSoft: "rgba(30, 102, 245, 0.1)",
      activeBorder: "rgba(30, 102, 245, 0.5)",
      activeGlow: "rgba(30, 102, 245, 0.2)",
      scrollbarThumb: "#bcc0cc",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "nord",
    name: "Nord",
    type: "dark",
    author: "Arctic Ice Studio",
    colors: {
      bgPrimary: "#2e3440",
      bgSecondary: "#272c36",
      bgTertiary: "#20242d",
      bgHover: "#3b4252",
      bgActive: "#434c5e",
      bgInput: "#3b4252",
      border: "#434c5e",
      textPrimary: "#eceff4",
      textSecondary: "#d8dee9",
      textMuted: "#7b88a1",
      accent: "#88c0d0",
      accentHover: "#81a1c1",
      green: "#a3be8c",
      red: "#bf616a",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      purple: "#b48ead",
      orange: "#d08770",
      tabActiveBg: "#2e3440",
      tabInactiveBg: "#272c36",
      activeSoft: "rgba(136, 192, 208, 0.12)",
      activeBorder: "rgba(136, 192, 208, 0.55)",
      activeGlow: "rgba(136, 192, 208, 0.26)",
      scrollbarThumb: "#434c5e",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    type: "dark",
    author: "Dracula Theme",
    colors: {
      bgPrimary: "#282a36",
      bgSecondary: "#21222c",
      bgTertiary: "#191a21",
      bgHover: "#343746",
      bgActive: "#44475a",
      bgInput: "#343746",
      border: "#44475a",
      textPrimary: "#f8f8f2",
      textSecondary: "#c0c0c0",
      textMuted: "#6272a4",
      accent: "#bd93f9",
      accentHover: "#ff79c6",
      green: "#50fa7b",
      red: "#ff5555",
      yellow: "#f1fa8c",
      blue: "#8be9fd",
      purple: "#bd93f9",
      orange: "#ffb86c",
      tabActiveBg: "#282a36",
      tabInactiveBg: "#21222c",
      activeSoft: "rgba(189, 147, 249, 0.12)",
      activeBorder: "rgba(189, 147, 249, 0.55)",
      activeGlow: "rgba(189, 147, 249, 0.26)",
      scrollbarThumb: "#44475a",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    type: "dark",
    author: "enkia",
    colors: {
      bgPrimary: "#1a1b26",
      bgSecondary: "#16161e",
      bgTertiary: "#101014",
      bgHover: "#292e42",
      bgActive: "#33467c",
      bgInput: "#292e42",
      border: "#3b4261",
      textPrimary: "#c0caf5",
      textSecondary: "#a9b1d6",
      textMuted: "#565f89",
      accent: "#7aa2f7",
      accentHover: "#7dcfff",
      green: "#9ece6a",
      red: "#f7768e",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      purple: "#bb9af7",
      orange: "#ff9e64",
      tabActiveBg: "#1a1b26",
      tabInactiveBg: "#16161e",
      activeSoft: "rgba(122, 162, 247, 0.12)",
      activeBorder: "rgba(122, 162, 247, 0.55)",
      activeGlow: "rgba(122, 162, 247, 0.26)",
      scrollbarThumb: "#3b4261",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    type: "dark",
    author: "GitHub",
    colors: {
      bgPrimary: "#0d1117",
      bgSecondary: "#161b22",
      bgTertiary: "#010409",
      bgHover: "#21262d",
      bgActive: "#30363d",
      bgInput: "#21262d",
      border: "#30363d",
      textPrimary: "#e6edf3",
      textSecondary: "#b1bac4",
      textMuted: "#7d8590",
      accent: "#58a6ff",
      accentHover: "#79c0ff",
      green: "#3fb950",
      red: "#f85149",
      yellow: "#d29922",
      blue: "#58a6ff",
      purple: "#bc8cff",
      orange: "#f0883e",
      tabActiveBg: "#0d1117",
      tabInactiveBg: "#161b22",
      activeSoft: "rgba(88, 166, 255, 0.1)",
      activeBorder: "rgba(88, 166, 255, 0.5)",
      activeGlow: "rgba(88, 166, 255, 0.2)",
      scrollbarThumb: "#30363d",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    type: "light",
    author: "GitHub",
    colors: {
      bgPrimary: "#ffffff",
      bgSecondary: "#f6f8fa",
      bgTertiary: "#eaeef2",
      bgHover: "#eaeef2",
      bgActive: "#d0d7de",
      bgInput: "#f6f8fa",
      border: "#d0d7de",
      textPrimary: "#1f2328",
      textSecondary: "#424a53",
      textMuted: "#6e7781",
      accent: "#0969da",
      accentHover: "#0550ae",
      green: "#1a7f37",
      red: "#cf222e",
      yellow: "#9a6700",
      blue: "#0969da",
      purple: "#8250df",
      orange: "#bc4c00",
      tabActiveBg: "#ffffff",
      tabInactiveBg: "#f6f8fa",
      activeSoft: "rgba(9, 105, 218, 0.08)",
      activeBorder: "rgba(9, 105, 218, 0.5)",
      activeGlow: "rgba(9, 105, 218, 0.15)",
      scrollbarThumb: "#d0d7de",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "one-dark",
    name: "One Dark Pro",
    type: "dark",
    author: "Atom",
    colors: {
      bgPrimary: "#282c34",
      bgSecondary: "#21252b",
      bgTertiary: "#1b1f27",
      bgHover: "#2c313c",
      bgActive: "#3e4452",
      bgInput: "#2c313c",
      border: "#3e4452",
      textPrimary: "#abb2bf",
      textSecondary: "#8b929e",
      textMuted: "#5c6370",
      accent: "#61afef",
      accentHover: "#56b6c2",
      green: "#98c379",
      red: "#e06c75",
      yellow: "#e5c07b",
      blue: "#61afef",
      purple: "#c678dd",
      orange: "#d19a66",
      tabActiveBg: "#282c34",
      tabInactiveBg: "#21252b",
      activeSoft: "rgba(97, 175, 239, 0.12)",
      activeBorder: "rgba(97, 175, 239, 0.55)",
      activeGlow: "rgba(97, 175, 239, 0.26)",
      scrollbarThumb: "#3e4452",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    type: "dark",
    author: "Ethan Schoonover",
    colors: {
      bgPrimary: "#002b36",
      bgSecondary: "#073642",
      bgTertiary: "#001e26",
      bgHover: "#094959",
      bgActive: "#0a5a6b",
      bgInput: "#073642",
      border: "#094959",
      textPrimary: "#fdf6e3",
      textSecondary: "#93a1a1",
      textMuted: "#657b83",
      accent: "#268bd2",
      accentHover: "#2aa198",
      green: "#859900",
      red: "#dc322f",
      yellow: "#b58900",
      blue: "#268bd2",
      purple: "#6c71c4",
      orange: "#cb4b16",
      tabActiveBg: "#002b36",
      tabInactiveBg: "#073642",
      activeSoft: "rgba(38, 139, 210, 0.12)",
      activeBorder: "rgba(38, 139, 210, 0.55)",
      activeGlow: "rgba(38, 139, 210, 0.26)",
      scrollbarThumb: "#094959",
      scrollbarTrack: "transparent",
    },
  },
  {
    id: "monokai",
    name: "Monokai Pro",
    type: "dark",
    author: "Monokai",
    colors: {
      bgPrimary: "#2d2a2e",
      bgSecondary: "#221f22",
      bgTertiary: "#19181a",
      bgHover: "#3b383e",
      bgActive: "#4a474d",
      bgInput: "#3b383e",
      border: "#4a474d",
      textPrimary: "#fcfcfa",
      textSecondary: "#c1c0c0",
      textMuted: "#727072",
      accent: "#ffd866",
      accentHover: "#78dce8",
      green: "#a9dc76",
      red: "#ff6188",
      yellow: "#ffd866",
      blue: "#78dce8",
      purple: "#ab9df2",
      orange: "#fc9867",
      tabActiveBg: "#2d2a2e",
      tabInactiveBg: "#221f22",
      activeSoft: "rgba(255, 216, 102, 0.12)",
      activeBorder: "rgba(255, 216, 102, 0.55)",
      activeGlow: "rgba(255, 216, 102, 0.26)",
      scrollbarThumb: "#4a474d",
      scrollbarTrack: "transparent",
    },
  },
];

// --- Theme Application ---

const CSS_VAR_MAP: Record<keyof ThemeColors, string> = {
  bgPrimary: "--bg-primary",
  bgSecondary: "--bg-secondary",
  bgTertiary: "--bg-tertiary",
  bgHover: "--bg-hover",
  bgActive: "--bg-active",
  bgInput: "--bg-input",
  border: "--border",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  accent: "--accent",
  accentHover: "--accent-hover",
  green: "--green",
  red: "--red",
  yellow: "--yellow",
  blue: "--blue",
  purple: "--purple",
  orange: "--orange",
  tabActiveBg: "--tab-active-bg",
  tabInactiveBg: "--tab-inactive-bg",
  activeSoft: "--active-soft",
  activeBorder: "--active-border",
  activeGlow: "--active-glow",
  scrollbarThumb: "--scrollbar-thumb",
  scrollbarTrack: "--scrollbar-track",
};

/** Apply a theme by setting CSS variables on the root element */
export function applyTheme(theme: ThemeDefinition): void {
  const root = document.documentElement;

  // Remove existing theme classes and add the base type
  root.classList.remove("theme-dark", "theme-light");
  root.classList.add(`theme-${theme.type}`);

  // Override CSS variables
  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    const value = theme.colors[key as keyof ThemeColors];
    if (value) {
      root.style.setProperty(cssVar, value);
    }
  }

  window.dispatchEvent(new CustomEvent("punam-theme-change", { detail: theme }));
}

/** Reset to default theme (remove inline overrides) */
export function resetThemeOverrides(): void {
  const root = document.documentElement;
  for (const cssVar of Object.values(CSS_VAR_MAP)) {
    root.style.removeProperty(cssVar);
  }
}

/** Export a theme as JSON string */
export function exportTheme(theme: ThemeDefinition): string {
  return JSON.stringify(theme, null, 2);
}

/** Import a theme from JSON string */
export function importTheme(json: string): ThemeDefinition | null {
  try {
    const parsed = JSON.parse(json);
    // Validate required fields
    if (!parsed.id || !parsed.name || !parsed.type || !parsed.colors) {
      return null;
    }
    if (!["dark", "light"].includes(parsed.type)) {
      return null;
    }
    // Validate all color keys exist
    for (const key of Object.keys(CSS_VAR_MAP)) {
      if (!parsed.colors[key]) {
        return null;
      }
    }
    return parsed as ThemeDefinition;
  } catch {
    return null;
  }
}

/** Get a theme by ID (built-in or custom) */
export function getThemeById(id: string, customThemes: ThemeDefinition[] = []): ThemeDefinition | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id) || customThemes.find((t) => t.id === id);
}

/** Get the product default theme for the requested mode. */
export function getDefaultTheme(type: "dark" | "light" = "dark", customThemes: ThemeDefinition[] = []): ThemeDefinition {
  const defaultId = type === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
  return getThemeById(defaultId, customThemes) || BUILTIN_THEMES.find((theme) => theme.type === type) || BUILTIN_THEMES[0];
}
