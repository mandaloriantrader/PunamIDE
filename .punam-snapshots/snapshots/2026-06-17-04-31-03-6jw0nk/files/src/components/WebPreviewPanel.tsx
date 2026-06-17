/**
 * WebPreviewPanel — Full browser-like preview with URL bar, navigation history,
 * back/forward, refresh, and open in external browser.
 * Ported from Zenith IDE, adapted for Punam IDE.
 */

import { useEffect, useState } from "react";
import { Globe, RefreshCw, ExternalLink, ChevronLeft, ChevronRight, X } from "lucide-react";

interface Props {
  initialUrl?: string;
  onClose?: () => void;
}

export default function WebPreviewPanel({ initialUrl = "http://localhost:5173", onClose }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<string[]>([initialUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);

  useEffect(() => {
    setUrl(initialUrl);
    setInputUrl(initialUrl);
    setHistory([initialUrl]);
    setHistoryIndex(0);
  }, [initialUrl]);

  const navigate = (newUrl: string) => {
    setUrl(newUrl);
    setInputUrl(newUrl);
    setIsLoading(true);
    const newHistory = [...history.slice(0, historyIndex + 1), newUrl];
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const goBack = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setUrl(history[newIndex]);
      setInputUrl(history[newIndex]);
    }
  };

  const goForward = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setUrl(history[newIndex]);
      setInputUrl(history[newIndex]);
    }
  };

  const refresh = () => {
    setIsLoading(true);
    const iframe = document.getElementById("web-preview-iframe") as HTMLIFrameElement;
    if (iframe) {
      iframe.src = url;
    }
  };

  return (
    <div className="web-preview-panel">
      <div className="web-preview-toolbar">
        <button
          className="preview-nav-btn"
          onClick={goBack}
          disabled={historyIndex === 0}
          title="Back"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          className="preview-nav-btn"
          onClick={goForward}
          disabled={historyIndex >= history.length - 1}
          title="Forward"
        >
          <ChevronRight size={14} />
        </button>
        <button className="preview-nav-btn" onClick={refresh} title="Refresh">
          <RefreshCw size={14} className={isLoading ? "spinning" : ""} />
        </button>

        <div className="preview-url-bar">
          <Globe size={12} />
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                let navUrl = inputUrl;
                if (!navUrl.startsWith("http")) navUrl = `http://${navUrl}`;
                navigate(navUrl);
              }
            }}
            placeholder="Enter URL..."
          />
        </div>

        <button
          className="preview-nav-btn"
          onClick={() => window.open(url, "_blank")}
          title="Open in browser"
        >
          <ExternalLink size={14} />
        </button>
        {onClose && (
          <button className="preview-nav-btn" onClick={onClose} title="Close preview" aria-label="Close preview">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="web-preview-content">
        <iframe
          id="web-preview-iframe"
          src={url}
          title="Web Preview"
          onLoad={() => setIsLoading(false)}
          onError={() => setIsLoading(false)}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
      </div>
    </div>
  );
}
