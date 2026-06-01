/**
 * ShellTerminal — Full interactive PTY terminal using xterm.js.
 * Connects to the Rust PTY backend for a real shell experience.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface Props {
  cwd: string;
  onOpenUrl?: (url: string) => void;
}

interface PtyOutputPayload {
  terminal_id: string;
  data: string;
}

export default function ShellTerminal({ cwd, onOpenUrl }: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Spawn PTY session
  const spawnPty = useCallback(async () => {
    if (!cwd) return;

    try {
      const terminalId: string = await invoke("terminal_create", {
        projectRoot: cwd,
      });

      sessionIdRef.current = terminalId;
      setConnected(true);
      setError(null);
    } catch (err) {
      setError(`Failed to start shell: ${err}`);
      setConnected(false);
    }
  }, [cwd]);

  // Initialize xterm.js
  useEffect(() => {
    if (!termRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#45475a",
        black: "#45475a",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#cba6f7",
        cyan: "#94e2d5",
        white: "#bac2de",
        brightBlack: "#585b70",
        brightRed: "#f38ba8",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#89b4fa",
        brightMagenta: "#cba6f7",
        brightCyan: "#94e2d5",
        brightWhite: "#a6adc8",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      if (onOpenUrl) onOpenUrl(uri);
      else window.open(uri, "_blank", "noopener,noreferrer");
    });

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle user input — send to PTY
    term.onData((data) => {
      if (sessionIdRef.current) {
        invoke("terminal_write", { terminalId: sessionIdRef.current, data }).catch(() => {});
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        if (sessionIdRef.current && term.rows && term.cols) {
          invoke("terminal_resize", {
            terminalId: sessionIdRef.current,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => {});
        }
      } catch { /* ignore resize errors */ }
    });
    resizeObserver.observe(termRef.current);

    // Spawn the PTY
    spawnPty();

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;

      // Kill PTY session
      if (sessionIdRef.current) {
        invoke("terminal_kill", { terminalId: sessionIdRef.current }).catch(() => {});
        sessionIdRef.current = null;
      }
    };
  }, [cwd, spawnPty, onOpenUrl]);

  // Listen for PTY output events
  useEffect(() => {
    const unlisten = listen<PtyOutputPayload>("pty-output", (event) => {
      const { terminal_id, data } = event.payload;
      if (terminal_id === sessionIdRef.current && xtermRef.current) {
        xtermRef.current.write(data);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="shell-terminal">
      {error && (
        <div className="shell-terminal-error">
          <span>{error}</span>
          <button onClick={spawnPty}>Retry</button>
        </div>
      )}
      <div
        ref={termRef}
        className="shell-terminal-container"
        style={{ width: "100%", height: "100%" }}
      />
      {!connected && !error && (
        <div className="shell-terminal-connecting">
          Connecting to shell...
        </div>
      )}
    </div>
  );
}
