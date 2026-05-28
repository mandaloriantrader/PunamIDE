/**
 * LivePreview — renders HTML/Markdown/SVG in an iframe sandbox,
 * or proxies a dev server URL.
 * Now auto-detects running dev server from terminal output.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { RefreshCw, ExternalLink, Monitor, X, Globe, Zap } from "lucide-react";

interface Props {
  filePath: string;
  content: string;
  language: string;
  projectPath?: string;
  terminalOutput?: string;  // NEW: pass terminal output for auto-detection
  onClose: () => void;
}

/** Detect localhost URLs from terminal output (Vite, CRA, Next, etc.) */
function detectDevServerUrl(terminal: string): string | null {
  if (!terminal) return null;
  // Match patterns like: Local: http://localhost:5173/ or ➜ Local: http://localhost:3000
  const patterns = [
    /(?:Local|localhost|server).*?(https?:\/\/localhost:\d+)/i,
    /➜\s+Local:\s+(https?:\/\/localhost:\d+)/i,
    /running at\s+(https?:\/\/localhost:\d+)/i,
    /listening on\s+(https?:\/\/localhost:\d+)/i,
    /started.*?(https?:\/\/localhost:\d+)/i,
    /(https?:\/\/localhost:\d+(?:\/[^\s]*)?)/i, // fallback: any localhost URL
  ];
  for (const re of patterns) {
    const m = terminal.match(re);
    if (m?.[1]) return m[1].replace(/\/$/, ""); // strip trailing slash
  }
  return null;
}

/** Languages that can be previewed directly */
function isDirectPreviewable(language: string, path: string): boolean {
  const lower = path.toLowerCase();
  return (
    language === "html" || lower.endsWith(".html") || lower.endsWith(".htm") ||
    language === "markdown" || lower.endsWith(".md") ||
    language === "svg" || lower.endsWith(".svg")
  );
}

function markdownToHtml(md: string): string {
  return md
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^## (.+)$/gm, "<h2>$2</h2>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/```[\w]*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/\n\n/g, "</p><p>");
}

function buildPreviewHtml(content: string, language: string, path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".svg") || language === "svg") {
    return `<!DOCTYPE html><html><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;height:100vh">${content}</body></html>`;
  }
  if (lower.endsWith(".md") || language === "markdown") {
    const body = markdownToHtml(content);
    return `<!DOCTYPE html><html><head><style>
      body{font-family:system-ui;max-width:720px;margin:32px auto;padding:0 20px;color:#1e1e1e;line-height:1.6}
      h1,h2,h3{border-bottom:1px solid #e5e5e5;padding-bottom:8px}
      code{background:#f3f3f3;padding:2px 5px;border-radius:3px;font-family:monospace}
      pre{background:#f3f3f3;padding:14px;border-radius:6px;overflow-x:auto}
      pre code{background:none;padding:0} a{color:#0969da} li{margin:4px 0}
    </style></head><body><p>${body}</p></body></html>`;
  }
  return content;
}

export default function LivePreview({ filePath, content, language, terminalOutput, onClose }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [mode, setMode] = useState<"direct" | "url">(
    isDirectPreviewable(language, filePath) ? "direct" : "url"
  );
  const [urlInput, setUrlInput] = useState("http://localhost:5174");
  const [activeUrl, setActiveUrl] = useState("http://localhost:5174");
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [autoRefreshOnSave, setAutoRefreshOnSave] = useState(true);
  const prevContentRef = useRef(content);

  const filename = filePath.split(/[\\/]/).pop() ?? filePath;
  const canDirectPreview = isDirectPreviewable(language, filePath);

  // Auto-detect dev server URL from terminal output
  useEffect(() => {
    const url = detectDevServerUrl(terminalOutput ?? "");
    if (url && url !== detectedUrl) {
      setDetectedUrl(url);
    }
  }, [terminalOutput]);

  // Auto-refresh on file save (content change) in URL mode
  useEffect(() => {
    if (!autoRefreshOnSave || mode !== "url") return;
    if (content !== prevContentRef.current) {
      prevContentRef.current = content;
      setRefreshKey(k => k + 1);
    }
  }, [content, mode, autoRefreshOnSave]);

  // Apply direct mode preview
  useEffect(() => {
    if (mode !== "direct") return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const html = buildPreviewHtml(content, language, filePath);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    iframe.src = url;
    return () => URL.revokeObjectURL(url);
  }, [content, language, filePath, refreshKey, mode]);

  const handleGoUrl = useCallback(() => {
    setActiveUrl(urlInput);
    setRefreshKey(k => k + 1);
  }, [urlInput]);

  const handleUseDetected = useCallback(() => {
    if (!detectedUrl) return;
    setUrlInput(detectedUrl);
    setActiveUrl(detectedUrl);
    setMode("url");
    setRefreshKey(k => k + 1);
  }, [detectedUrl]);

  return (
    <div className="live-preview-panel">
      {/* Header */}
      <div className="lp-header">
        <div className="lp-title">
          <Monitor size={14} />
          <span>Preview</span>
          <span className="lp-filename">{filename}</span>
        </div>
        <div className="lp-header-actions">
          <div className="lp-mode-toggle">
            {canDirectPreview && (
              <button className={`lp-mode-btn ${mode === "direct" ? "active" : ""}`} onClick={() => setMode("direct")} title="Preview file directly">
                <Monitor size={12} /> File
              </button>
            )}
            <button className={`lp-mode-btn ${mode === "url" ? "active" : ""}`} onClick={() => setMode("url")} title="Preview dev server">
              <Globe size={12} /> URL
            </button>
          </div>
          {/* Auto-refresh toggle */}
          <button
            className={`lp-mode-btn ${autoRefreshOnSave ? "active" : ""}`}
            onClick={() => setAutoRefreshOnSave(v => !v)}
            title={autoRefreshOnSave ? "Auto-refresh on save: ON" : "Auto-refresh on save: OFF"}
          >
            <Zap size={12} />
          </button>
          <button className="icon-btn small" onClick={() => setRefreshKey(k => k + 1)} title="Refresh" aria-label="Refresh">
            <RefreshCw size={13} />
          </button>
          <button className="icon-btn small" onClick={() => window.open(activeUrl, "_blank")} title="Open in browser" disabled={mode === "direct"} aria-label="Open in browser">
            <ExternalLink size={13} />
          </button>
          <button className="icon-btn small" onClick={onClose} aria-label="Close preview">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Auto-detected dev server banner */}
      {detectedUrl && mode !== "url" && (
        <div className="lp-detected-banner">
          <Zap size={12} />
          <span>Dev server detected: <code>{detectedUrl}</code></span>
          <button className="btn-primary compact" onClick={handleUseDetected}>
            Open
          </button>
          <button className="icon-btn small" onClick={() => setDetectedUrl(null)} aria-label="Dismiss">
            <X size={11} />
          </button>
        </div>
      )}

      {/* URL bar */}
      {mode === "url" && (
        <div className="lp-url-bar">
          <Globe size={12} className="lp-url-icon" />
          <input
            className="lp-url-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleGoUrl(); }}
            placeholder="http://localhost:5174"
            spellCheck={false}
          />
          {detectedUrl && detectedUrl !== activeUrl && (
            <button className="lp-detected-btn" onClick={handleUseDetected} title={`Use detected: ${detectedUrl}`}>
              <Zap size={11} /> {detectedUrl.replace("http://", "")}
            </button>
          )}
          <button className="btn-primary compact" onClick={handleGoUrl}>Go</button>
        </div>
      )}

      {/* Non-previewable notice */}
      {mode === "direct" && !canDirectPreview && (
        <div className="lp-notice">
          <Monitor size={16} />
          <div>
            <p><strong>{filename}</strong> cannot be previewed directly.</p>
            <p>{detectedUrl ? `Dev server detected at ${detectedUrl}.` : "Start your dev server, then switch to URL mode."}</p>
            {detectedUrl && (
              <button className="btn-primary compact" onClick={handleUseDetected} style={{ marginTop: 8 }}>
                <Zap size={12} /> Use {detectedUrl}
              </button>
            )}
          </div>
        </div>
      )}

      {/* iframe */}
      {(mode === "direct" && canDirectPreview) || mode === "url" ? (
        <iframe
          key={`${refreshKey}-${activeUrl}`}
          ref={iframeRef}
          className="lp-iframe"
          title="Live Preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          src={mode === "url" ? activeUrl : undefined}
          aria-label="Live preview"
        />
      ) : null}
    </div>
  );
}
