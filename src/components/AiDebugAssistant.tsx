import { useState, useRef, useEffect } from "react";
import { Sparkles, Loader2, Copy, X, ChevronDown, ChevronUp, MapPin, Eye, Lightbulb, Play, Wrench } from "lucide-react";
import { sanitizeDebugContext } from "../utils/debugSanitizer";
import { sendToProviderStreaming, sendToProvider } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
import type { ReviewFileChange } from "./AiDiffPreview";

interface AiDebugAssistantProps {
  /** Whether the debugger is currently paused (button only active when paused) */
  isPaused: boolean;
  /** Current stack frames from DAP */
  stackFrames: Array<{ name: string; source?: { path?: string; name?: string }; line: number; column?: number }>;
  /** Current local variables */
  variables: Array<{ name: string; value: string; type?: string }>;
  /** Debug console output */
  consoleOutput: string[];
  /** Source code around the current paused line */
  currentSourceCode?: string;
  /** Current file path */
  currentFilePath?: string;
  /** Current paused line number */
  currentLine?: number;
  /** Full content of the current file (for fix suggestions) */
  fullFileContent?: string;
  /** AI provider config (from app settings) */
  aiProvider: AIProviderConfig | null;
  /** AI model to use */
  aiModel: string;
  /** Callback to show toast */
  showToast: (message: string, type: "info" | "success" | "error" | "warning") => void;
  /** Callback to set a breakpoint (Phase 5D) */
  onSetBreakpoint?: (path: string, line: number) => void;
  /** Callback to evaluate an expression in debug console (Phase 5D) */
  onEvaluateExpression?: (expression: string) => void;
  /** Callback to jump to a source location (Phase 5D) */
  onJumpToSource?: (path: string, line: number) => void;
  /** Callback to propose a fix via the diff review board (Phase 5C) */
  onProposeFix?: (changes: ReviewFileChange[]) => void;
}

interface AiResponse {
  text: string;
  timestamp: number;
  type: "explain" | "guide" | "fix";
  suggestions?: DebugSuggestion[];
  fixAvailable?: boolean;
}

/** Structured suggestion from AI guidance */
interface DebugSuggestion {
  type: "breakpoint" | "watch" | "inspect" | "step" | "tip";
  label: string;
  description?: string;
  /** For breakpoint suggestions */
  filePath?: string;
  line?: number;
  /** For watch/inspect suggestions */
  expression?: string;
}

// ─── System Prompts ────────────────────────────────────────────────────────────

const EXPLAIN_SYSTEM_PROMPT = `You are Punam, an AI debugging assistant embedded in PunamIDE. The user's program has paused (breakpoint, exception, or step).

Your job:
1. Analyze the stack trace, variables, and source code provided
2. Explain in plain language what's happening at this point in execution
3. Identify the likely root cause if there's an error or unexpected state
4. Suggest what the developer should check or do next

Rules:
- Be concise but thorough. Developers don't need hand-holding, but they want clarity.
- If you see an obvious bug, point it out directly with the fix.
- If the state looks normal (just a breakpoint), explain the current execution context briefly.
- Reference specific variable names and values when relevant.
- If you can't determine the issue from the context, say so and suggest what additional info would help.
- Format your response with markdown for readability.`;

const GUIDANCE_SYSTEM_PROMPT = `You are Punam, an AI debugging assistant embedded in PunamIDE. The user's program is paused and they want smart debugging guidance.

Your job is to provide ACTIONABLE debugging suggestions. You MUST respond with a JSON block containing structured suggestions, followed by a brief explanation.

Response format — you MUST include this JSON block:
\`\`\`json:suggestions
[
  {
    "type": "breakpoint",
    "label": "Short description",
    "description": "Why set this breakpoint",
    "filePath": "path/to/file.ts",
    "line": 42
  },
  {
    "type": "watch",
    "label": "Watch expression",
    "description": "Why watch this",
    "expression": "variable.property"
  },
  {
    "type": "inspect",
    "label": "Evaluate this",
    "description": "What this reveals",
    "expression": "someExpression()"
  },
  {
    "type": "tip",
    "label": "Debugging tip",
    "description": "Detailed explanation of what to try"
  }
]
\`\`\`

After the JSON block, add a brief 2-3 sentence explanation of your reasoning.

Rules:
- Provide 2-5 suggestions, prioritized by usefulness
- For breakpoints: use the EXACT file path from the context and suggest specific line numbers based on the source code
- For watch/inspect: suggest expressions that would reveal the bug's root cause
- For tips: suggest debugging strategies (e.g., "check if this function is called with null")
- Be specific — don't say "add a breakpoint somewhere", say exactly where and why
- If the current file path is provided, use it for breakpoint suggestions in that file`;

const FIX_SYSTEM_PROMPT = `You are Punam, an AI debugging assistant embedded in PunamIDE. The user's program is paused at a bug and they want you to suggest a code fix.

Your job is to:
1. Analyze the debug context (stack trace, variables, source code, console output)
2. Identify the bug
3. Provide the COMPLETE fixed version of the relevant code section

Response format — you MUST include:
1. A brief explanation (2-3 sentences) of what the bug is and how your fix addresses it
2. A code block with the COMPLETE fixed file content, tagged with the file path:

\`\`\`fix:FILEPATH
...complete file content with the fix applied...
\`\`\`

Rules:
- The code block MUST contain the ENTIRE file content (not just the changed lines) — this is critical for the diff system
- The FILEPATH after "fix:" must be the exact file path provided in the context
- Only fix the identified bug — don't refactor unrelated code
- If you're not confident about the fix, explain your uncertainty
- If the bug requires changes to multiple files, include multiple fix blocks
- If you cannot determine a fix from the available context, say so clearly and explain what additional information you'd need`;

// ─── Prompt Builders ───────────────────────────────────────────────────────────

function buildDebugPrompt(context: {
  stackFrames: Array<{ name: string; source?: { path?: string; name?: string }; line: number; column?: number }>;
  variables: Array<{ name: string; value: string; type?: string }>;
  consoleOutput: string[];
  sourceCode?: string;
  filePath?: string;
  line?: number;
}): string {
  const parts: string[] = [];

  if (context.filePath && context.line) {
    parts.push(`## Paused At\n\`${context.filePath}\` — line ${context.line}\n`);
  }

  if (context.sourceCode) {
    parts.push(`## Source Code (around paused line)\n\`\`\`\n${context.sourceCode}\n\`\`\`\n`);
  }

  if (context.stackFrames.length > 0) {
    const frames = context.stackFrames
      .slice(0, 15)
      .map((f, i) => `  ${i === 0 ? "→" : " "} #${i} ${f.name} (${f.source?.name || f.source?.path || "unknown"}:${f.line})`)
      .join("\n");
    parts.push(`## Call Stack\n\`\`\`\n${frames}\n\`\`\`\n`);
  }

  if (context.variables.length > 0) {
    const vars = context.variables
      .slice(0, 30)
      .map(v => `  ${v.name}: ${v.value}${v.type ? ` (${v.type})` : ""}`)
      .join("\n");
    parts.push(`## Local Variables\n\`\`\`\n${vars}\n\`\`\`\n`);
  }

  if (context.consoleOutput.length > 0) {
    const recent = context.consoleOutput.slice(-20).join("\n");
    parts.push(`## Recent Console Output\n\`\`\`\n${recent}\n\`\`\`\n`);
  }

  return parts.join("\n");
}

function buildFixPrompt(context: {
  stackFrames: Array<{ name: string; source?: { path?: string; name?: string }; line: number; column?: number }>;
  variables: Array<{ name: string; value: string; type?: string }>;
  consoleOutput: string[];
  sourceCode?: string;
  fullFileContent?: string;
  filePath?: string;
  line?: number;
}): string {
  const parts: string[] = [];

  if (context.filePath && context.line) {
    parts.push(`## Paused At\n\`${context.filePath}\` — line ${context.line}\n`);
  }

  // Include full file content for fix generation
  if (context.fullFileContent && context.filePath) {
    parts.push(`## Full File Content: ${context.filePath}\n\`\`\`\n${context.fullFileContent}\n\`\`\`\n`);
  } else if (context.sourceCode) {
    parts.push(`## Source Code (around paused line)\n\`\`\`\n${context.sourceCode}\n\`\`\`\n`);
  }

  if (context.stackFrames.length > 0) {
    const frames = context.stackFrames
      .slice(0, 10)
      .map((f, i) => `  ${i === 0 ? "→" : " "} #${i} ${f.name} (${f.source?.name || f.source?.path || "unknown"}:${f.line})`)
      .join("\n");
    parts.push(`## Call Stack\n\`\`\`\n${frames}\n\`\`\`\n`);
  }

  if (context.variables.length > 0) {
    const vars = context.variables
      .slice(0, 20)
      .map(v => `  ${v.name}: ${v.value}${v.type ? ` (${v.type})` : ""}`)
      .join("\n");
    parts.push(`## Local Variables\n\`\`\`\n${vars}\n\`\`\`\n`);
  }

  if (context.consoleOutput.length > 0) {
    const recent = context.consoleOutput.slice(-10).join("\n");
    parts.push(`## Recent Console Output\n\`\`\`\n${recent}\n\`\`\`\n`);
  }

  parts.push("\n---\nIdentify the bug and provide the complete fixed file content.");

  return parts.join("\n");
}

// ─── Parsers ───────────────────────────────────────────────────────────────────

function parseSuggestions(text: string): { suggestions: DebugSuggestion[]; explanation: string } {
  const suggestions: DebugSuggestion[] = [];
  let explanation = text;

  // Try to extract JSON suggestions block
  const jsonMatch = text.match(/```json:suggestions\s*\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.type && item.label) {
            suggestions.push({
              type: item.type,
              label: item.label,
              description: item.description,
              filePath: item.filePath,
              line: item.line ? Number(item.line) : undefined,
              expression: item.expression,
            });
          }
        }
      }
    } catch { /* JSON parse failed */ }
    explanation = text.replace(/```json:suggestions\s*\n[\s\S]*?\n```/, "").trim();
  }

  // Fallback: try plain ```json block
  if (suggestions.length === 0) {
    const plainJsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
    if (plainJsonMatch) {
      try {
        const parsed = JSON.parse(plainJsonMatch[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.type && item.label) {
              suggestions.push({
                type: item.type,
                label: item.label,
                description: item.description,
                filePath: item.filePath,
                line: item.line ? Number(item.line) : undefined,
                expression: item.expression,
              });
            }
          }
        }
      } catch { /* Ignore */ }
      explanation = text.replace(/```json\s*\n[\s\S]*?\n```/, "").trim();
    }
  }

  return { suggestions, explanation };
}

/** Parse fix blocks from AI response: ```fix:filepath\n...content...\n``` */
function parseFixBlocks(text: string): Array<{ filePath: string; content: string }> {
  const fixes: Array<{ filePath: string; content: string }> = [];
  const fixPattern = /```fix:(.+?)\s*\n([\s\S]*?)\n```/g;
  let match;

  while ((match = fixPattern.exec(text)) !== null) {
    const filePath = match[1].trim();
    const content = match[2];
    if (filePath && content) {
      fixes.push({ filePath, content });
    }
  }

  return fixes;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function AiDebugAssistant({
  isPaused,
  stackFrames,
  variables,
  consoleOutput,
  currentSourceCode,
  currentFilePath,
  currentLine,
  fullFileContent,
  aiProvider,
  aiModel,
  showToast,
  onSetBreakpoint,
  onEvaluateExpression,
  onJumpToSource,
  onProposeFix,
}: AiDebugAssistantProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [loadingType, setLoadingType] = useState<"explain" | "guide" | "fix">("explain");
  const [responses, setResponses] = useState<AiResponse[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const responseEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest response
  useEffect(() => {
    if (responseEndRef.current && responses.length > 0) {
      responseEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [responses]);

  const getSanitizedContext = () => {
    const sanitized = sanitizeDebugContext({
      stackFrames,
      variables,
      consoleOutput,
      sourceCode: currentSourceCode,
    });
    return {
      stackFrames: sanitized.stackFrames,
      variables: sanitized.variables,
      consoleOutput: sanitized.consoleOutput,
      sourceCode: sanitized.sourceCode,
      filePath: currentFilePath,
      line: currentLine,
    };
  };

  const callAi = async (systemPrompt: string, userPrompt: string) => {
    if (!aiProvider) {
      showToast("No AI provider configured. Set one up in Settings.", "warning");
      return null;
    }

    try {
      let response;
      try {
        response = await sendToProviderStreaming(aiProvider, aiModel, {
          systemPrompt,
          userPrompt,
        });
      } catch {
        response = await sendToProvider(aiProvider, aiModel, {
          systemPrompt,
          userPrompt,
        });
      }

      if (response.success && response.text) {
        return response.text;
      } else {
        showToast(response.error || "AI request failed", "error");
        return null;
      }
    } catch (err) {
      showToast(`AI debug analysis failed: ${err}`, "error");
      console.error("[AiDebugAssistant] Error:", err);
      return null;
    }
  };

  // Phase 5B: Explain what happened
  const handleExplain = async () => {
    if (!isPaused) { showToast("Debugger must be paused to analyze state.", "warning"); return; }
    setIsLoading(true);
    setLoadingType("explain");

    const ctx = getSanitizedContext();
    const userPrompt = buildDebugPrompt(ctx) + "\n\n---\nExplain what's happening here and identify any issues.";
    const text = await callAi(EXPLAIN_SYSTEM_PROMPT, userPrompt);

    if (text) {
      setResponses(prev => [...prev, { text, timestamp: Date.now(), type: "explain" }]);
    }
    setIsLoading(false);
  };

  // Phase 5D: Smart debug guidance
  const handleGuide = async () => {
    if (!isPaused) { showToast("Debugger must be paused to get guidance.", "warning"); return; }
    setIsLoading(true);
    setLoadingType("guide");

    const ctx = getSanitizedContext();
    const userPrompt = buildDebugPrompt(ctx) + "\n\n---\nProvide actionable debugging suggestions: where to set breakpoints, what to watch, what to inspect next.";
    const text = await callAi(GUIDANCE_SYSTEM_PROMPT, userPrompt);

    if (text) {
      const { suggestions, explanation } = parseSuggestions(text);
      setResponses(prev => [...prev, {
        text: explanation || text,
        timestamp: Date.now(),
        type: "guide",
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      }]);
    }
    setIsLoading(false);
  };

  // Phase 5C: Suggest a fix
  const handleSuggestFix = async () => {
    if (!isPaused) { showToast("Debugger must be paused to suggest a fix.", "warning"); return; }
    if (!currentFilePath) { showToast("No source file available for fix suggestion.", "warning"); return; }
    if (!fullFileContent) { showToast("File content not available. Open the file in the editor first.", "warning"); return; }

    setIsLoading(true);
    setLoadingType("fix");

    const sanitized = sanitizeDebugContext({
      stackFrames,
      variables,
      consoleOutput,
      sourceCode: currentSourceCode,
    });

    const userPrompt = buildFixPrompt({
      stackFrames: sanitized.stackFrames,
      variables: sanitized.variables,
      consoleOutput: sanitized.consoleOutput,
      sourceCode: sanitized.sourceCode,
      fullFileContent, // Send full file so AI can return complete fixed version
      filePath: currentFilePath,
      line: currentLine,
    });

    const text = await callAi(FIX_SYSTEM_PROMPT, userPrompt);

    if (text) {
      // Parse fix blocks from response
      const fixes = parseFixBlocks(text);

      if (fixes.length > 0 && onProposeFix) {
        // Build ReviewFileChange objects for the diff board
        const fileChanges: ReviewFileChange[] = fixes.map(fix => ({
          path: fix.filePath,
          original: fix.filePath === currentFilePath ? fullFileContent : "",
          proposed: fix.content,
          isNew: false,
        }));

        // Remove fix blocks from display text
        const displayText = text.replace(/```fix:.+?\s*\n[\s\S]*?\n```/g, "").trim();

        setResponses(prev => [...prev, {
          text: displayText || "Fix suggested — review the diff below.",
          timestamp: Date.now(),
          type: "fix",
          fixAvailable: true,
        }]);

        // Trigger the diff review board
        onProposeFix(fileChanges);
        showToast("Fix suggested — review the diff to accept or reject.", "success");
      } else {
        // AI didn't provide a parseable fix block — show the response as-is
        setResponses(prev => [...prev, {
          text,
          timestamp: Date.now(),
          type: "fix",
          fixAvailable: false,
        }]);
        showToast("AI provided analysis but no actionable fix. See response below.", "info");
      }
    }
    setIsLoading(false);
  };

  // Action handlers for suggestions
  const handleSuggestionAction = (suggestion: DebugSuggestion) => {
    switch (suggestion.type) {
      case "breakpoint":
        if (suggestion.filePath && suggestion.line && onSetBreakpoint) {
          onSetBreakpoint(suggestion.filePath, suggestion.line);
          showToast(`Breakpoint set at ${suggestion.filePath.split(/[\\/]/).pop()}:${suggestion.line}`, "success");
        } else if (currentFilePath && suggestion.line && onSetBreakpoint) {
          onSetBreakpoint(currentFilePath, suggestion.line);
          showToast(`Breakpoint set at line ${suggestion.line}`, "success");
        } else {
          showToast("Cannot set breakpoint — missing file or line info", "warning");
        }
        break;
      case "watch":
      case "inspect":
        if (suggestion.expression && onEvaluateExpression) {
          onEvaluateExpression(suggestion.expression);
          showToast(`Evaluating: ${suggestion.expression}`, "info");
        } else {
          showToast("Cannot evaluate — no expression provided", "warning");
        }
        break;
      case "tip":
        if (suggestion.description) {
          navigator.clipboard.writeText(suggestion.description).catch(() => {});
          showToast("Tip copied to clipboard", "info");
        }
        break;
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      showToast("Copied to clipboard", "success");
    }).catch(() => {
      showToast("Failed to copy", "error");
    });
  };

  const handleClear = () => {
    setResponses([]);
  };

  // Don't render anything if debugger isn't active
  if (!isPaused && responses.length === 0) return null;

  const getSuggestionIcon = (type: DebugSuggestion["type"]) => {
    switch (type) {
      case "breakpoint": return <MapPin size={12} />;
      case "watch": return <Eye size={12} />;
      case "inspect": return <Play size={12} />;
      case "tip": return <Lightbulb size={12} />;
      default: return <Lightbulb size={12} />;
    }
  };

  const getSuggestionActionLabel = (type: DebugSuggestion["type"]) => {
    switch (type) {
      case "breakpoint": return "Set";
      case "watch": return "Watch";
      case "inspect": return "Eval";
      case "tip": return "Copy";
      default: return "Use";
    }
  };

  return (
    <div className="ai-debug-assistant">
      <div className="ai-debug-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="ai-debug-title">
          <Sparkles size={14} />
          <span>Ask Punam</span>
        </div>
        <div className="ai-debug-header-actions">
          {responses.length > 0 && (
            <button
              className="icon-btn-sm"
              onClick={(e) => { e.stopPropagation(); handleClear(); }}
              title="Clear responses"
            >
              <X size={12} />
            </button>
          )}
          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </div>

      {isExpanded && (
        <div className="ai-debug-body">
          {/* Action buttons */}
          <div className="ai-debug-actions">
            <button
              className="ai-debug-ask-btn"
              onClick={handleExplain}
              disabled={isLoading || !isPaused}
              title={!isPaused ? "Debugger must be paused" : "Ask Punam to explain the current state"}
            >
              {isLoading && loadingType === "explain" ? (
                <><Loader2 size={14} className="spin" /> Analyzing...</>
              ) : (
                <><Sparkles size={14} /> Explain</>
              )}
            </button>
            <button
              className="ai-debug-guide-btn"
              onClick={handleGuide}
              disabled={isLoading || !isPaused}
              title={!isPaused ? "Debugger must be paused" : "Get smart debugging suggestions"}
            >
              {isLoading && loadingType === "guide" ? (
                <><Loader2 size={14} className="spin" /> Thinking...</>
              ) : (
                <><Lightbulb size={14} /> Guide me</>
              )}
            </button>
            <button
              className="ai-debug-fix-btn"
              onClick={handleSuggestFix}
              disabled={isLoading || !isPaused || !currentFilePath}
              title={!isPaused ? "Debugger must be paused" : !currentFilePath ? "No source file available" : "Ask Punam to suggest a code fix"}
            >
              {isLoading && loadingType === "fix" ? (
                <><Loader2 size={14} className="spin" /> Fixing...</>
              ) : (
                <><Wrench size={14} /> Fix it</>
              )}
            </button>
          </div>

          {/* Responses */}
          {responses.length > 0 && (
            <div className="ai-debug-responses">
              {responses.map((resp, idx) => (
                <div key={idx} className={`ai-debug-response ${resp.type}`}>
                  <div className="ai-debug-response-header">
                    <span className="ai-debug-response-badge">
                      {resp.type === "explain" ? "💡 Explanation" : resp.type === "guide" ? "🧭 Guidance" : resp.fixAvailable ? "🔧 Fix Suggested" : "🔧 Analysis"}
                    </span>
                    <span className="ai-debug-response-time">
                      {new Date(resp.timestamp).toLocaleTimeString()}
                    </span>
                    <button
                      className="icon-btn-sm"
                      onClick={() => handleCopy(resp.text)}
                      title="Copy response"
                    >
                      <Copy size={12} />
                    </button>
                  </div>

                  {/* Actionable suggestions (Phase 5D) */}
                  {resp.suggestions && resp.suggestions.length > 0 && (
                    <div className="ai-debug-suggestions">
                      {resp.suggestions.map((suggestion, sIdx) => (
                        <div key={sIdx} className={`ai-debug-suggestion suggestion-${suggestion.type}`}>
                          <div className="suggestion-icon">
                            {getSuggestionIcon(suggestion.type)}
                          </div>
                          <div className="suggestion-content">
                            <span className="suggestion-label">{suggestion.label}</span>
                            {suggestion.description && (
                              <span className="suggestion-desc">{suggestion.description}</span>
                            )}
                            {suggestion.filePath && suggestion.line && (
                              <span className="suggestion-location">
                                {suggestion.filePath.split(/[\\/]/).pop()}:{suggestion.line}
                              </span>
                            )}
                            {suggestion.expression && (
                              <code className="suggestion-expr">{suggestion.expression}</code>
                            )}
                          </div>
                          <button
                            className="suggestion-action-btn"
                            onClick={() => handleSuggestionAction(suggestion)}
                            title={`${getSuggestionActionLabel(suggestion.type)}: ${suggestion.label}`}
                          >
                            {getSuggestionActionLabel(suggestion.type)}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Fix applied indicator */}
                  {resp.type === "fix" && resp.fixAvailable && (
                    <div className="ai-debug-fix-notice">
                      ✓ Fix diff opened for review. Accept or reject changes in the diff board.
                    </div>
                  )}

                  {/* Text explanation */}
                  {resp.text && (
                    <div className="ai-debug-response-text">
                      {resp.text}
                    </div>
                  )}
                </div>
              ))}
              <div ref={responseEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
