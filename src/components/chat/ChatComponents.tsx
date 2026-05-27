/**
 * Shared sub-components for the AI chat panel.
 * Extracted from AiChat.tsx for maintainability.
 */

import type { ReactNode } from "react";
import { Check, ChevronDown, Clock, Zap } from "lucide-react";
import type { AIProviderConfig, ResponseMetrics } from "../../utils/providers";
import type { ParsedResponse } from "../../utils/prompts";

// --- Inline Markdown Renderer ---

export function renderInlineMarkdown(text: string) {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`code-${match.index}`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`strong-${match.index}`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

// --- Markdown Message ---

type MessagePart =
  | { type: "text"; content: string }
  | { type: "code"; label: string; content: string };

function splitActionCodeBlocks(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const blockHeader = /===(FILE|EDIT):\s*(.+?)===\s*\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = blockHeader.exec(text)) !== null) {
    const [rawHeader, kind, rawPath] = match;
    const start = match.index;
    const codeStart = start + rawHeader.length;
    const endMarker = kind === "FILE" ? "===END_FILE===" : "===END_EDIT===";
    const explicitEnd = text.indexOf(endMarker, codeStart);
    const codeEnd = explicitEnd >= 0 ? explicitEnd : text.length;

    if (start > cursor) {
      parts.push({ type: "text", content: text.slice(cursor, start) });
    }

    parts.push({
      type: "code",
      label: rawPath.trim() || kind.toLowerCase(),
      content: text.slice(codeStart, codeEnd).replace(/^\n|\n$/g, ""),
    });

    cursor = explicitEnd >= 0 ? codeEnd + endMarker.length : text.length;
    blockHeader.lastIndex = cursor;
  }

  if (cursor < text.length) {
    parts.push({ type: "text", content: text.slice(cursor) });
  }

  return parts.length > 0 ? parts : [{ type: "text", content: text }];
}

export function MarkdownMessage({ text }: { text: string }) {
  const visibleText = text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^Used .+ \/ .+\.$/.test(trimmed)) return false;
      if (/^Adaptive Mode selected .+ \/ .+\.$/.test(trimmed)) return false;
      if (/^Using .+ \/ .+\.\.\.$/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trimStart();
  const parts = splitActionCodeBlocks(visibleText);

  return (
    <div className="markdown-message">
      {parts.map((part, partIndex) => {
        if (part.type === "code") {
          if (!part.content.trim()) return null;
          return (
            <div className="markdown-code-block action-code-block" key={`action-code-${partIndex}`}>
              <div className="markdown-code-header">
                <span>{part.label}</span>
              </div>
              <pre><code>{part.content}</code></pre>
            </div>
          );
        }

        const blocks = part.content.split(/```/g);
        return blocks.map((block, index) => {
        if (index % 2 === 1) {
          const [firstLine = "", ...rest] = block.replace(/^\n/, "").split("\n");
          const hasLanguage = firstLine.trim() && !firstLine.includes(" ") && rest.length > 0;
          const language = hasLanguage ? firstLine.trim() : "";
          const code = hasLanguage ? rest.join("\n") : block.replace(/^\n|\n$/g, "");
          if (!code.trim()) return null;

          return (
            <div className="markdown-code-block" key={`code-${index}`}>
              <div className="markdown-code-header">
                <span>{language || "code"}</span>
              </div>
              <pre><code>{code}</code></pre>
            </div>
          );
        }

        return block
          .split(/\n{2,}/)
          .map((paragraph, paragraphIndex) => {
            const trimmed = paragraph.trim();
            if (!trimmed) return null;

            if (/^#{1,3}\s+/.test(trimmed)) {
              return (
                <h4 key={`heading-${index}-${paragraphIndex}`}>
                  {renderInlineMarkdown(trimmed.replace(/^#{1,3}\s+/, ""))}
                </h4>
              );
            }

            const lines = trimmed.split("\n");
            const isList = lines.every((line) => /^(\s*[-*•]\s+|\s*\d+\.\s+)/.test(line));
            if (isList) {
              return (
                <ul key={`list-${index}-${paragraphIndex}`}>
                  {lines.map((line, lineIndex) => (
                    <li key={lineIndex}>{renderInlineMarkdown(line.replace(/^(\s*[-*•]\s+|\s*\d+\.\s+)/, ""))}</li>
                  ))}
                </ul>
              );
            }

            return (
              <p key={`paragraph-${index}-${paragraphIndex}`}>
                {renderInlineMarkdown(trimmed)}
              </p>
            );
          });
        });
      })}
    </div>
  );
}

// --- Punam Avatar ---

export function PunamAvatar({ active = false }: { active?: boolean }) {
  return (
    <img
      className={`punam-chat-avatar${active ? " active" : ""}`}
      src="/logo-Transparent.png"
      alt="Punam"
    />
  );
}

// --- Response Metrics Display ---

export function ResponseMetricsDisplay({ metrics }: { metrics: ResponseMetrics }) {
  const duration = metrics.durationMs >= 1000
    ? `${(metrics.durationMs / 1000).toFixed(1)}s`
    : `${Math.round(metrics.durationMs)}ms`;

  const formatTokens = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);

  const tokenBreakdown = metrics.promptTokens !== undefined
    ? `in ${formatTokens(metrics.promptTokens)} / out ${formatTokens(metrics.responseTokens || 0)}`
    : null;

  const cost = metrics.estimatedCostInr !== undefined
    ? metrics.estimatedCostInr < 0.01
      ? "<Rs0.01"
      : `~Rs${metrics.estimatedCostInr.toFixed(metrics.estimatedCostInr < 1 ? 2 : 1)}`
    : null;

  return (
    <div className={`response-metrics ${metrics.status}`}>
      <span className="response-metrics-stats">
        <Clock size={10} /> {duration}
        {tokenBreakdown && <span>{tokenBreakdown}</span>}
        {cost && <span>{cost} est.</span>}
      </span>
    </div>
  );
}

// --- Model Selector ---

export function ModelSelector({ providers, legacyModel, tokenEstimate, activeOverride, isOpen, onToggle, onSelect }: {
  providers: AIProviderConfig[];
  legacyModel: string;
  legacyProvider: string;
  tokenEstimate: number;
  activeOverride: { providerId: string; model: string } | null;
  isOpen: boolean;
  onToggle: () => void;
  onSelect: (selection: { providerId: string; model: string } | null) => void;
}) {
  const allModels = providers.flatMap((p) =>
    p.models.filter((m) => m.id).map((m) => ({ providerId: p.id, providerName: p.name, modelId: m.id, modelName: m.name, enabled: m.enabled }))
  );

  const tokenStr = tokenEstimate >= 1000 ? `~${(tokenEstimate / 1000).toFixed(1)}k` : `~${tokenEstimate}`;

  let activeLabel: string;
  if (activeOverride) {
    const match = allModels.find((m) => m.providerId === activeOverride.providerId && m.modelId === activeOverride.model);
    activeLabel = match ? match.modelName : activeOverride.model;
  } else if (allModels.length > 0) {
    const enabledOnes = allModels.filter((m) => m.enabled);
    if (enabledOnes.length === 1) {
      activeLabel = enabledOnes[0].modelName;
    } else if (enabledOnes.length > 1) {
      activeLabel = `${enabledOnes.length} models`;
    } else {
      activeLabel = legacyModel;
    }
  } else {
    activeLabel = legacyModel;
  }

  return (
    <div className="ai-model-selector-wrap">
      <button className="ai-model-trigger" onClick={onToggle} type="button" title="Switch model">
        <Zap size={10} />
        <span className="ai-model-name">{activeLabel}</span>
        <span className="ai-model-tokens">{tokenStr}</span>
        <span className="ai-model-status">Ready</span>
        <ChevronDown size={10} className={`model-chevron ${isOpen ? "open" : ""}`} />
      </button>
      {isOpen && (
        <>
          <div className="ai-model-dropdown-backdrop" onClick={onToggle} />
          <div className="ai-model-dropdown-menu">
            <div className="ai-model-dropdown-header">Switch Model</div>
            {allModels.length === 0 && (
              <div className="ai-model-dropdown-empty">No models configured. Go to Settings to add providers.</div>
            )}
            {activeOverride && (
              <button
                className="ai-model-dropdown-item reset"
                onClick={() => onSelect(null)}
                type="button"
              >
                <span>Use default (all enabled)</span>
              </button>
            )}
            {allModels.map((m) => {
              const isActive = activeOverride
                ? (activeOverride.providerId === m.providerId && activeOverride.model === m.modelId)
                : m.enabled;
              return (
                <button
                  key={`${m.providerId}-${m.modelId}`}
                  className={`ai-model-dropdown-item ${isActive ? "active" : ""}`}
                  onClick={() => onSelect({ providerId: m.providerId, model: m.modelId })}
                  type="button"
                >
                  <div className="ai-model-dropdown-info">
                    <span className="ai-model-dropdown-name">{m.modelName}</span>
                    <span className="ai-model-dropdown-provider">{m.providerName}</span>
                  </div>
                  {isActive && <Check size={12} className="ai-model-check" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// --- Helper Functions ---

export function getActionLabel(parsed: ParsedResponse): string {
  const hasFileChanges = parsed.fileChanges.length > 0 || parsed.deletions.length > 0;
  if (!hasFileChanges && parsed.commands.length > 0) return parsed.commands.length === 1 ? "Run Command" : "Run Commands";
  if (hasFileChanges && parsed.commands.length > 0) return "Apply & Run";
  return "Apply";
}

type AgentStep = "planning" | "proposing_fix" | "awaiting_approval" | "awaiting_run" | "running_command" | "analyzing_output" | "verifying" | "completed" | "stopped";

export function formatAgentStep(step: AgentStep): string {
  switch (step) {
    case "planning": return "Planning approach...";
    case "proposing_fix": return "Proposing fix...";
    case "awaiting_approval": return "Waiting for approval";
    case "awaiting_run": return "Suggesting command";
    case "running_command": return "Running command...";
    case "analyzing_output": return "Analyzing output...";
    case "verifying": return "Verifying completion...";
    case "completed": return "Completed ✓";
    case "stopped": return "Stopped";
    default: return step;
  }
}
