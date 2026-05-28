/**
 * Chat input area with context chips, file picker, attachments, and send button.
 * Extracted from AiChat.tsx.
 */

import { useRef, useEffect, useState } from "react";
import { Send, FileText, Layers, SearchCode, Wrench, MessageCircle, Paperclip, Plus, X, ChevronDown } from "lucide-react";
import type { ChatAttachment } from "../../utils/tauri";
import type { AIProviderConfig } from "../../utils/providers";
import { ModelSelector } from "./ChatComponents";

interface ChatInputAreaProps {
  input: string;
  setInput: (value: string | ((prev: string) => string)) => void;
  loading: boolean;
  cooldown: boolean;
  agentModePlaceholder: string;
  // Context info
  openTabsCount: number;
  activeFileRelPath: string;
  hasSelection: boolean;
  problemsCount: number;
  hasTerminalOutput: boolean;
  // Multi-file selection
  selectedProjectFiles: string[];
  setSelectedProjectFiles: React.Dispatch<React.SetStateAction<string[]>>;
  showFilePicker: boolean;
  setShowFilePicker: React.Dispatch<React.SetStateAction<boolean>>;
  allProjectFiles: string[];
  // Attachments
  attachments: ChatAttachment[];
  removeAttachment: (id: string) => void;
  handleFileAttach: () => void;
  handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  // Model selector
  aiProviders: AIProviderConfig[];
  configModel: string;
  configProvider: string;
  tokenEstimate: number;
  activeModelOverride: { providerId: string; model: string } | null;
  adaptivePreview?: string;
  modelDropdownOpen: boolean;
  setModelDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveModelOverride: React.Dispatch<React.SetStateAction<{ providerId: string; model: string } | null>>;
  // Session tokens
  sessionTokens: { totalIn: number; totalOut: number; totalCostInr: number; requestCount: number };
  // Actions
  onSend: () => void;
  onSendBackground?: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onRevert?: () => Promise<void>;
  hasAppliedMessages: number;
  sendDisabled: boolean;
  isAgentMode?: boolean;
}

export function ChatInputArea({
  input,
  setInput,
  loading,
  cooldown,
  agentModePlaceholder,
  openTabsCount,
  activeFileRelPath,
  hasSelection,
  problemsCount,
  hasTerminalOutput,
  selectedProjectFiles,
  setSelectedProjectFiles,
  showFilePicker,
  setShowFilePicker,
  allProjectFiles,
  attachments,
  removeAttachment,
  handleFileAttach,
  handleFileInputChange,
  fileInputRef,
  aiProviders,
  configModel,
  configProvider,
  tokenEstimate,
  activeModelOverride,
  adaptivePreview,
  modelDropdownOpen,
  setModelDropdownOpen,
  setActiveModelOverride,
  sessionTokens,
  onSend,
  onSendBackground,
  onKeyDown,
  onRevert,
  hasAppliedMessages,
  sendDisabled,
  isAgentMode,
}: ChatInputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [adaptiveDropdownOpen, setAdaptiveDropdownOpen] = useState(false);
  const activeModelIds = aiProviders.flatMap((provider) =>
    provider.models.filter((model) => model.enabled && model.id).map((model) => model.id)
  );

  // Auto-resize textarea after every input change (Kiro-style)
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
  }, [input]);

  return (
    <div className="ai-input-area">
      {/* Context chips row - always shows file tree + add files */}
      <div className="ai-input-context">
        <span className="ai-ctx-chip">
          <Layers size={10} />
          {openTabsCount > 0 ? `${openTabsCount} tab${openTabsCount === 1 ? "" : "s"}` : "File tree"}
        </span>
        {activeFileRelPath && (
          <span className="ai-ctx-chip active">
            <FileText size={10} />
            {activeFileRelPath.split("/").pop()}
          </span>
        )}
        {hasSelection && (
          <span className="ai-ctx-chip active">
            <SearchCode size={10} />
            Selection
          </span>
        )}
        {problemsCount > 0 && (
          <span className="ai-ctx-chip error">
            <Wrench size={10} />
            {problemsCount}
          </span>
        )}
        {hasTerminalOutput && (
          <span className="ai-ctx-chip">
            <MessageCircle size={10} />
            Terminal
          </span>
        )}
        {/* @-mention quick-insert chips */}
        <button
          className="ai-ctx-chip ai-ctx-mention-chip"
          title="Insert @codebase — loads all project files into context"
          onClick={() => setInput((prev) => prev + (prev.endsWith(" ") || prev === "" ? "" : " ") + "@codebase ")}
        >
          @codebase
        </button>
        <button
          className="ai-ctx-chip ai-ctx-mention-chip"
          title="Insert @git — includes git history and diff in context"
          onClick={() => setInput((prev) => prev + (prev.endsWith(" ") || prev === "" ? "" : " ") + "@git ")}
        >
          @git
        </button>
        <button
          className="ai-ctx-chip ai-ctx-mention-chip"
          title="Insert @web — search the web before asking"
          onClick={() => setInput((prev) => prev + (prev.endsWith(" ") || prev === "" ? "" : " ") + "@web ")}
        >
          @web
        </button>
        <button
          className="ai-ctx-chip ai-ctx-mention-chip"
          title="Insert @notes — includes your project notes in context"
          onClick={() => setInput((prev) => prev + (prev.endsWith(" ") || prev === "" ? "" : " ") + "@notes ")}
        >
          @notes
        </button>
        {selectedProjectFiles.length > 0 && (
          <span className="ai-ctx-chip active" title={selectedProjectFiles.join(", ")}>
            <Layers size={10} />
            {selectedProjectFiles.length} file{selectedProjectFiles.length > 1 ? "s" : ""}
            <button
              className="ai-ctx-chip-clear"
              onClick={() => setSelectedProjectFiles([])}
              title="Clear file selection"
            >
              <X size={8} />
            </button>
          </span>
        )}
        <button
          className="ai-ctx-chip ai-ctx-add-files"
          onClick={() => setShowFilePicker(!showFilePicker)}
          title="Select files for context"
        >
          <Plus size={10} />
          Files
        </button>
      </div>

      {/* Multi-file Picker Dropdown */}
      {showFilePicker && (
        <div className="ai-file-picker">
          <div className="ai-file-picker-header">
            <span>Select files for refactoring context</span>
            <button className="ai-file-picker-close" onClick={() => setShowFilePicker(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="ai-file-picker-list">
            {allProjectFiles.map((filePath) => (
              <label key={filePath} className="ai-file-picker-item">
                <input
                  type="checkbox"
                  checked={selectedProjectFiles.includes(filePath)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedProjectFiles((prev) => [...prev, filePath]);
                    } else {
                      setSelectedProjectFiles((prev) => prev.filter((f) => f !== filePath));
                    }
                  }}
                />
                <span className="ai-file-picker-path">{filePath}</span>
              </label>
            ))}
          </div>
          <div className="ai-file-picker-footer">
            <span>{selectedProjectFiles.length} selected</span>
            <button className="btn-secondary compact" onClick={() => setShowFilePicker(false)}>Done</button>
          </div>
        </div>
      )}

      <div className="ai-input-box">
        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="ai-attachments-preview">
            {attachments.map((att) => (
              <div key={att.id} className="ai-attachment-chip">
                {att.type === "image" ? (
                  <img
                    src={`data:${att.mimeType};base64,${att.base64}`}
                    alt={att.name}
                    className="ai-attachment-thumb"
                  />
                ) : (
                  <FileText size={14} />
                )}
                <span className="ai-attachment-name">{att.name}</span>
                <button
                  className="ai-attachment-remove"
                  onClick={() => removeAttachment(att.id)}
                  title="Remove attachment"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="ai-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={agentModePlaceholder}
          rows={3}
          disabled={loading || cooldown}
          aria-label="Chat message input"
        />
        <div className="ai-input-row">
          <button
            className="ai-attach-btn"
            onClick={handleFileAttach}
            disabled={loading || cooldown}
            title="Attach image or file"
            aria-label="Attach file"
          >
            <Paperclip size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html"
            multiple
            onChange={handleFileInputChange}
            style={{ display: "none" }}
          />
          <ModelSelector
            providers={aiProviders}
            legacyModel={configModel}
            legacyProvider={configProvider}
            tokenEstimate={tokenEstimate}
            activeOverride={activeModelOverride}
            isOpen={modelDropdownOpen}
            onToggle={() => setModelDropdownOpen(!modelDropdownOpen)}
            onSelect={(selection) => { setActiveModelOverride(selection); setModelDropdownOpen(false); }}
          />
          {adaptivePreview && (
            <div className="ai-adaptive-wrap">
              <button
                className="ai-session-stats ai-adaptive-preview"
                title={adaptivePreview}
                type="button"
                onClick={() => setAdaptiveDropdownOpen((open) => !open)}
              >
                Adaptive mode
                <ChevronDown size={10} className={`model-chevron ${adaptiveDropdownOpen ? "open" : ""}`} />
              </button>
              {adaptiveDropdownOpen && (
                <>
                  <div className="ai-model-dropdown-backdrop" onClick={() => setAdaptiveDropdownOpen(false)} />
                  <div className="ai-adaptive-dropdown-menu">
                    <div className="ai-model-dropdown-header">Active Models</div>
                    {activeModelIds.length > 0 ? (
                      activeModelIds.map((modelId) => (
                        <div key={modelId} className="ai-adaptive-model-id" title={modelId}>
                          {modelId}
                        </div>
                      ))
                    ) : (
                      <div className="ai-model-dropdown-empty">No enabled models</div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          <span className="ai-input-spacer" />
          {sessionTokens.requestCount > 0 && (
            <span className="ai-session-stats ai-cost-preview" title={`Session: ${sessionTokens.totalIn} in / ${sessionTokens.totalOut} out tokens across ${sessionTokens.requestCount} requests`}>
              ₹{sessionTokens.totalCostInr < 0.01 ? "<0.01" : sessionTokens.totalCostInr.toFixed(sessionTokens.totalCostInr < 1 ? 2 : 1)}
            </span>
          )}
          <button
            className="ai-send-btn"
            onClick={onSend}
            disabled={sendDisabled}
            aria-label="Send message"
          >
            <Send size={14} />
          </button>
          {isAgentMode && onSendBackground && (
            <button
              className="ai-send-bg-btn"
              onClick={onSendBackground}
              disabled={sendDisabled}
              title="Run in background — keep coding while Punam works"
              aria-label="Send to background"
            >
              ↗
            </button>
          )}
          {onRevert && hasAppliedMessages && (
            <button
              className="ai-undo-btn"
              onClick={onRevert}
              title="Undo last AI edit"
              aria-label="Undo last AI edit"
            >
              ↩{hasAppliedMessages > 1 ? ` ${hasAppliedMessages}` : ""}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
