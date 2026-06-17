#PunamIDE v2.0

A VS Code-like AI-powered code editor built with **Tauri + Rust + React + TypeScript**.

Native desktop app with file explorer, Monaco code editor, built-in terminal, AI assistant, and multi-provider LLM support (Gemini, OpenAI, OpenRouter, Groq, Mistral AI, Ollama) — all for **$0**.

## Features

- **Monaco Code Editor** — Same editor engine as VS Code, with syntax highlighting for 30+ languages
- **File Explorer** — Tree view sidebar with folder/file icons
- **Multi-Tab Support** — Open and edit multiple files in tabs
- **Built-in Terminal** — Run commands directly from the app
- **AI Chat Panel** — Natural language instructions to modify your code
- **Multi-Provider AI** — Google Gemini (free), Groq (free), OpenAI (cheap)
- **Settings Panel** — Configure API keys, models, and themes
- **Dark/Light Theme** — Catppuccin-inspired dark theme, clean light theme
- **Native Desktop App** — Built with Tauri (Rust), ~15MB binary vs Electron's 200MB+
- **Ctrl+S Save** — Save files with keyboard shortcut
- **Project-Aware AI** — AI sees your file tree and makes targeted changes

## Screenshots

The app features a VS Code-like layout with:
- Left sidebar: File explorer with tree view
- Center: Monaco editor with tabs
- Right panel: AI chat assistant
- Bottom: Terminal panel (toggleable)
- Top: Toolbar with panel toggles and settings

## Prerequisites

Install these on your system before building:

### 1. Node.js (18+)
```bash
# Check if installed
node --version

# Install via nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
```

### 2. Rust
```bash
# Check if installed
rustc --version

# Install via rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 3. System Dependencies (Linux only)
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev libgtk-3-dev libayatana-appindicator3-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel
```

### 4. Free API Key
Get a free API key from one of these providers:

| Provider | Cost | Get Key |
|---|---|---|
| **Google Gemini** | Free | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Groq** | Free | [console.groq.com/keys](https://console.groq.com/keys) |
| **Mistral AI** | Paid/free tiers vary | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) |
| **OpenAI** | $5 free credit | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run in development mode
npm run tauri dev
```

The app will open as a native window. On first launch:
1. Click **"Open Project Folder"** to select your project
2. Click the **Settings icon** (gear) in the top-right
3. Select your AI provider and paste your API key
4. Click **Save Settings**
5. Start chatting with the AI panel on the right!

## Build for Production

```bash
# Build a native binary for your OS
npm run tauri build
```

The binary will be in `src-tauri/target/release/`.

### Build outputs by OS:
- **Linux**: `.deb`, `.AppImage`, `.rpm` in `src-tauri/target/release/bundle/`
- **Windows**: `.msi`, `.exe` in `src-tauri/target/release/bundle/`
- **macOS**: `.dmg`, `.app` in `src-tauri/target/release/bundle/`

## Project Structure

```
punamide-v2/
├── src/                          # React frontend
│   ├── App.tsx                   # Main app layout & state
│   ├── App.css                   # Full app styling (dark/light themes)
│   ├── components/
│   │   ├── FileExplorer.tsx      # Sidebar file tree
│   │   ├── EditorTabs.tsx        # Tab bar for open files
│   │   ├── CodeEditor.tsx        # Monaco editor wrapper
│   │   ├── Terminal.tsx          # Built-in terminal
│   │   ├── AiChat.tsx            # AI chat panel
│   │   └── Settings.tsx          # Settings modal
│   └── utils/
│       ├── tauri.ts              # Tauri command bindings & types
│       └── prompts.ts            # AI system prompt & response parser
├── src-tauri/                    # Rust backend
│   ├── src/lib.rs                # All Tauri commands (filesystem, terminal, LLM API)
│   ├── Cargo.toml                # Rust dependencies
│   └── tauri.conf.json           # Tauri configuration
├── package.json
└── README.md
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  TAURI WINDOW                     │
│                                                   │
│  ┌─────────┐ ┌──────────────────┐ ┌───────────┐  │
│  │  File    │ │   Monaco Editor  │ │  AI Chat  │  │
│  │Explorer  │ │   (multi-tab)    │ │  Panel    │  │
│  │  Tree    │ │                  │ │           │  │
│  │         │ │                  │ │  Natural  │  │
│  │         │ │                  │ │  Language  │  │
│  │         │ │                  │ │  Input    │  │
│  │         │ ├──────────────────┤ │           │  │
│  │         │ │    Terminal      │ │  Changes  │  │
│  │         │ │                  │ │  Preview  │  │
│  └─────────┘ └──────────────────┘ └───────────┘  │
│                                                   │
│  ┌─────────────── Rust Backend ───────────────┐   │
│  │  File System  │  Terminal  │  LLM API      │   │
│  │  Operations   │  Commands  │  (Gemini/     │   │
│  │               │            │   Groq/OpenAI)│   │
│  └───────────────┴────────────┴───────────────┘   │
└──────────────────────────────────────────────────┘
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save current file |
| `Ctrl+B` | Toggle sidebar (planned) |
| `Ctrl+J` | Toggle terminal (planned) |
| `Ctrl+Shift+I` | Toggle AI panel (planned) |

## AI Usage Examples

In the AI chat panel, type natural language requests:

```
"Add a login form with email and password validation"
"Fix the TypeError in utils.ts"
"Create a REST API endpoint for /users"
"Add dark mode support to the CSS"
"Refactor this component to use React hooks"
"Add unit tests for the auth module"
```

The AI will:
1. Read your project file structure
2. Generate specific file changes
3. Show you what will change
4. Apply changes when you click "Apply"

## Configuration

Settings are saved as `.ai-editor-config.json` in your project folder.

| Setting | Options | Default |
|---|---|---|
| Provider | gemini, openai, openrouter, groq, mistral, ollama | gemini |
| Model | Any model from provider | gemini-2.0-flash |
| Theme | dark, light | dark |

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop Shell | Tauri 2.x (Rust) |
| Frontend | React 19 + TypeScript |
| Code Editor | Monaco Editor |
| Build Tool | Vite |
| Styling | Custom CSS (no framework) |
| Icons | Lucide React |
| LLM APIs | Gemini and OpenAI-compatible providers including OpenAI, OpenRouter, Groq, Mistral AI, Ollama |

## License

MIT
