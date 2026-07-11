import { useRef, useState, useCallback, useEffect } from "react";
import Editor from "@monaco-editor/react";
import type { BeforeMount, OnMount } from "@monaco-editor/react";
import type { editor, IDisposable } from "monaco-editor";
import type { AIProviderConfig } from "../utils/providers";
import { registerAutocompleteProvider } from "../services/autocomplete/AutocompleteEngine";
import { gitBlameFile, type BlameLine } from "../utils/tauri";
import InlineEditWidget from "./InlineEditWidget";
import type { InlineEditPosition } from "./InlineEditWidget";
import BreakpointGlyphs from "./BreakpointGlyphs";

// LSP integration
import { lspManager } from "../services/lsp/lspManager";
import { lspService } from "../services/lsp/lspClient";
import { registerLspProviders } from "../services/lsp/monacoLspBridge";

interface Problem {
  severity: string;
  message: string;
  path: string;
  line: number;
  column?: number;
}

interface Props {
  content: string;
  language: string;
  path: string;
  projectPath?: string;
  line?: number;
  problems?: Problem[];
  onChange: (value: string) => void;
  onSelectionChange?: (selection: string) => void;
  onCursorChange?: (position: { line: number; column: number }) => void;
  onAskPunam?: (text: string, mode: string) => void;
  onSave?: () => void | Promise<void>;
  theme?: string;
  aiProviders?: AIProviderConfig[];
  inlineCompletionEnabled?: boolean;
  lspEnabled?: boolean;
  fontSize?: number;
  showMinimap?: boolean;
  wordWrap?: "on" | "off";
  breakpoints?: number[];
  onToggleBreakpoint?: (line: number) => void;
  currentDebugSource?: { path: string; line: number; } | null;
  /** When true, shows git blame annotations in the editor gutter */
  blameEnabled?: boolean;
  /** Called when the Monaco editor instance is mounted, for external integrations */
  onEditorReady?: (editorInstance: editor.IStandaloneCodeEditor) => void;
  /** Called to open the TestGenPanel with the selected function code */
  onOpenTestGenPanel?: (functionCode: string) => void;
  /** Called with the exact Monaco selection range for refactoring operations. */
  onSelectionRangeChange?: (selection: { startLine: number; startColumn: number; endLine: number; endColumn: number; text: string } | null) => void;
  /** Called when the user triggers a refactoring operation from the context menu */
  onOpenRefactorPanel?: (mode?: "rename" | "extract" | "move") => void;
}

const EXT_TO_LANG: Record<string, string> = {
  py: "python",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  dart: "dart",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  md: "markdown",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  dockerfile: "dockerfile",
  gradle: "groovy",
};

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function defineRuntimeTheme(monaco: typeof import("monaco-editor"), type?: "dark" | "light") {
  const isLight = type === "light" || (!type && document.documentElement.classList.contains("theme-light"));
  const accent = cssVar("--accent", isLight ? "#0969da" : "#89b4fa");
  const border = cssVar("--border", isLight ? "#d0d7de" : "#45475a");
  const bgPrimary = cssVar("--bg-primary", isLight ? "#ffffff" : "#1e1e2e");
  const bgSecondary = cssVar("--bg-secondary", isLight ? "#f6f8fa" : "#181825");
  const bgHover = cssVar("--bg-hover", isLight ? "#eaeef2" : "#313244");
  const textPrimary = cssVar("--text-primary", isLight ? "#1f2328" : "#cdd6f4");
  const textMuted = cssVar("--text-muted", isLight ? "#6e7781" : "#6c7086");
  const yellow = cssVar("--yellow", isLight ? "#9a6700" : "#f9e2af");

  monaco.editor.defineTheme("punam-runtime", {
    base: isLight ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": bgPrimary,
      "editor.foreground": textPrimary,
      "editor.lineHighlightBackground": `${bgHover}99`,
      "editor.lineHighlightBorder": `${accent}44`,
      "editorCursor.foreground": accent,
      "editorLineNumber.foreground": textMuted,
      "editorLineNumber.activeForeground": accent,
      "editorIndentGuide.background1": `${border}88`,
      "editorIndentGuide.activeBackground1": `${accent}88`,
      "editor.selectionBackground": `${accent}3d`,
      "editor.inactiveSelectionBackground": `${accent}24`,
      "editor.wordHighlightBackground": `${accent}24`,
      "editor.findMatchBackground": `${yellow}66`,
      "editor.findMatchHighlightBackground": `${yellow}33`,
      "scrollbarSlider.background": `${border}99`,
      "scrollbarSlider.hoverBackground": `${border}cc`,
      "editorWidget.background": bgSecondary,
      "editorWidget.border": border,
      "input.background": cssVar("--bg-input", bgSecondary),
      "input.foreground": textPrimary,
      "input.border": border,
    },
  });
}

const handleBeforeMount: BeforeMount = (monaco) => {
  const tsDefaults = monaco.languages.typescript.typescriptDefaults;
  const jsDefaults = monaco.languages.typescript.javascriptDefaults;

  const compilerOptions = {
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
    isolatedModules: true,
    allowSyntheticDefaultImports: true,
  };

  tsDefaults.setCompilerOptions(compilerOptions);
  jsDefaults.setCompilerOptions(compilerOptions);

  tsDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  });

  jsDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  });

  monaco.editor.defineTheme("punam-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1e1e2e",
      "editor.foreground": "#cdd6f4",
      "editor.lineHighlightBackground": "#31324466",
      "editor.lineHighlightBorder": "#89b4fa44",
      "editorCursor.foreground": "#89b4fa",
      "editorLineNumber.foreground": "#6c7086",
      "editorLineNumber.activeForeground": "#89b4fa",
      "editorIndentGuide.background1": "#45475a66",
      "editorIndentGuide.activeBackground1": "#89b4fa88",
      "editor.selectionBackground": "#89b4fa3d",
      "editor.inactiveSelectionBackground": "#89b4fa24",
      "editor.wordHighlightBackground": "#89b4fa24",
      "editor.findMatchBackground": "#fab38766",
      "editor.findMatchHighlightBackground": "#fab38733",
      "scrollbarSlider.background": "#45475a99",
      "scrollbarSlider.hoverBackground": "#585b70cc",
    },
  });

  monaco.editor.defineTheme("punam-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#1e1e1e",
      "editor.lineHighlightBackground": "#e8f2ff",
      "editor.lineHighlightBorder": "#0078d455",
      "editorCursor.foreground": "#0078d4",
      "editorLineNumber.foreground": "#888888",
      "editorLineNumber.activeForeground": "#0078d4",
      "editorIndentGuide.background1": "#d4d4d4",
      "editorIndentGuide.activeBackground1": "#0078d488",
      "editor.selectionBackground": "#0078d42e",
      "editor.inactiveSelectionBackground": "#0078d41f",
    },
  });

  defineRuntimeTheme(monaco);
};

export function getLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const name = filename.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return EXT_TO_LANG[ext] || "plaintext";
}

// ─── Inline Edit decoration ID ───────────────────────────────────────────────
const INLINE_EDIT_DECORATION_CLASSNAME = "iew-applied-flash";

export default function CodeEditor({
  content, language, path, projectPath, line, problems, onChange,
  onSelectionChange, onCursorChange, onAskPunam, onSave,
  theme, aiProviders = [], inlineCompletionEnabled = true,
  lspEnabled = true,
  fontSize = 14, showMinimap = true, wordWrap = "on",
  breakpoints = [], onToggleBreakpoint,
  currentDebugSource,
  blameEnabled = false,
  onEditorReady,
  onOpenTestGenPanel, onSelectionRangeChange,
  onOpenRefactorPanel,
}: Props) {
  // ── Inline edit state ──────────────────────────────────────────────────────
  const [inlineEditOpen, setInlineEditOpen] = useState(false);
  const [inlineEditPos, setInlineEditPos] = useState<InlineEditPosition>({ top: 0, left: 0, lineHeight: 20 });
  const [inlineEditSelection, setInlineEditSelection] = useState<{
    selectedCode: string;
    prefix: string;
    suffix: string;
    range: { startLine: number; startCol: number; endLine: number; endCol: number };
    multiSelections: Array<{
      startLine: number; startCol: number; endLine: number; endCol: number;
      originalText: string;
    }> | null;
  } | null>(null);

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const autocompleteDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const [saveFlashKey, setSaveFlashKey] = useState(0);
  const onSaveRef = useRef<Props["onSave"]>(onSave);
  const pathRef = useRef(path);
  const lspEnabledRef = useRef(lspEnabled);
  const decorationIdsRef = useRef<string[]>([]);
  const lspDisposablesRef = useRef<IDisposable[]>([]);
  const lspRegisteredLangsRef = useRef<Set<string>>(new Set());
  const lspOpenedFileRef = useRef<string | null>(null);

  useEffect(() => {
    onSaveRef.current = onSave;
    pathRef.current = path;
    lspEnabledRef.current = lspEnabled;
  }, [lspEnabled, onSave, path]);

  // ── LSP Lifecycle ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!lspEnabled || !projectPath) return;
    lspManager.setProjectPath(projectPath);
    lspManager.connect().catch((err) => { console.warn("[LSP] Failed to connect:", err); });
    return () => {};
  }, [lspEnabled, projectPath]);

  useEffect(() => {
    if (!lspEnabled || !projectPath || !path) return;
    const monaco = monacoRef.current;
    const languageId = lspManager.getLanguageForFile(path);
    if (!languageId) return;
    let cancelled = false;
    const initLsp = async () => {
      const started = await lspManager.startServer(languageId);
      if (!started || cancelled) return;
      if (monaco && !lspRegisteredLangsRef.current.has(languageId)) {
        const disposables = registerLspProviders(monaco, lspService, [languageId]);
        lspDisposablesRef.current.push(...disposables);
        lspRegisteredLangsRef.current.add(languageId);
      }
    };
    initLsp();
    return () => { cancelled = true; };
  }, [lspEnabled, projectPath, path]);

  useEffect(() => {
    if (!lspEnabled || !projectPath || !path) return;
    const languageId = lspManager.getLanguageForFile(path);
    if (!languageId) return;
    const prevFile = lspOpenedFileRef.current;
    if (prevFile && prevFile !== path) {
      const prevLangId = lspManager.getLanguageForFile(prevFile);
      if (prevLangId) lspManager.notifyDocumentClose(prevFile, prevLangId);
    }
    let attempts = 0;
    const maxAttempts = 6;
    let timer: ReturnType<typeof setTimeout>;
    const tryOpen = () => {
      attempts++;
      if (lspManager.isServerRunning(languageId)) {
        lspManager.notifyDocumentOpen(path, languageId, content);
        lspOpenedFileRef.current = path;
      } else if (attempts < maxAttempts) {
        timer = setTimeout(tryOpen, 500);
      }
    };
    timer = setTimeout(tryOpen, 500);
    return () => { clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lspEnabled, projectPath, path]);

  const notifyLspChange = useCallback((newContent: string) => {
    if (!lspEnabled || !path) return;
    const languageId = lspManager.getLanguageForFile(path);
    if (!languageId) return;
    lspManager.notifyDocumentChange(path, languageId, newContent);
  }, [lspEnabled, path]);

  useEffect(() => {
    return () => {
      for (const d of lspDisposablesRef.current) d.dispose();
      lspDisposablesRef.current = [];
      lspRegisteredLangsRef.current.clear();
      const openedFile = lspOpenedFileRef.current;
      if (openedFile) {
        const langId = lspManager.getLanguageForFile(openedFile);
        if (langId) lspManager.notifyDocumentClose(openedFile, langId);
        lspOpenedFileRef.current = null;
      }
      autocompleteDisposableRef.current?.dispose();
      autocompleteDisposableRef.current = null;
    };
  }, []);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    defineRuntimeTheme(monaco, theme === "light" ? "light" : "dark");
    monaco.editor.setTheme("punam-runtime");
  }, [theme]);

  useEffect(() => {
    const handleThemeChange = (event: Event) => {
      const nextType = (event as CustomEvent<{ type?: "dark" | "light" }>).detail?.type;
      const monaco = monacoRef.current;
      if (!monaco) return;
      defineRuntimeTheme(monaco, nextType);
      monaco.editor.setTheme("punam-runtime");
    };
    window.addEventListener("punam-theme-change", handleThemeChange);
    return () => window.removeEventListener("punam-theme-change", handleThemeChange);
  }, []);

  // ── Git Blame Gutter Annotations ──────────────────────────────────────────
  const blameDecorationsRef = useRef<string[]>([]);

  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;

    if (!blameEnabled || !path) {
      // Clear existing blame decorations
      if (blameDecorationsRef.current.length > 0) {
        blameDecorationsRef.current = ed.deltaDecorations(blameDecorationsRef.current, []);
      }
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const blameData = await gitBlameFile(path);
        if (cancelled || !blameData || blameData.length === 0) return;

        const decorations = blameData.map((blame: BlameLine) => {
          const dateStr = blame.date ? new Date(blame.date).toLocaleDateString() : "";
          const label = `${blame.author.slice(0, 12).padEnd(12)} ${dateStr}`;
          return {
            range: new monaco.Range(blame.line, 1, blame.line, 1),
            options: {
              isWholeLine: false,
              glyphMarginClassName: "blame-glyph",
              glyphMarginHoverMessage: {
                value: `**${blame.author}** — ${dateStr}\n\n\`${blame.commit_id.slice(0, 7)}\` ${blame.summary}`,
              },
              after: {
                content: ` ${label}`,
                inlineClassName: "blame-inline-annotation",
              },
            },
          };
        });

        if (!cancelled && editorRef.current) {
          blameDecorationsRef.current = ed.deltaDecorations(blameDecorationsRef.current, decorations);
        }
      } catch {
        // Blame fetch failed (not a git repo, file not committed, etc.) — silently ignore
      }
    })();

    return () => {
      cancelled = true;
      if (editorRef.current && blameDecorationsRef.current.length > 0) {
        blameDecorationsRef.current = editorRef.current.deltaDecorations(blameDecorationsRef.current, []);
      }
    };
  }, [blameEnabled, path]);

  // ── Open inline edit widget ────────────────────────────────────────────────
  const openInlineEdit = useCallback(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    const model = ed.getModel();
    if (!model) return;
    const position = ed.getPosition();
    if (!position) return;
    const selections = ed.getSelections() ?? [];
    const nonEmptySelections = selections.filter(s => !s.isEmpty());
    if (nonEmptySelections.length > 1) {
      const snippets = nonEmptySelections.map(s => model.getValueInRange(s));
      const combined = snippets.join("\n---\n");
      const lastSel = nonEmptySelections[nonEmptySelections.length - 1];
      const scrollTop = ed.getScrollTop();
      const editorLayout = ed.getLayoutInfo();
      const lineHeightPx = ed.getOption(monaco.editor.EditorOption.lineHeight);
      const contentTop = ed.getTopForLineNumber(lastSel.endLineNumber);
      setInlineEditSelection({
        selectedCode: combined,
        prefix: `${snippets.length} selections`,
        suffix: "",
        range: { startLine: lastSel.startLineNumber, startCol: lastSel.startColumn, endLine: lastSel.endLineNumber, endCol: lastSel.endColumn },
        multiSelections: nonEmptySelections.map(s => ({
          startLine: s.startLineNumber, startCol: s.startColumn, endLine: s.endLineNumber, endCol: s.endColumn,
          originalText: model.getValueInRange(s),
        })),
      });
      setInlineEditPos({ top: contentTop - scrollTop, left: editorLayout.contentLeft, lineHeight: lineHeightPx });
      setInlineEditOpen(true);
      return;
    }
    const selection = ed.getSelection();
    const hasSelection = selection && !selection.isEmpty();
    const range = hasSelection
      ? { startLine: selection.startLineNumber, startCol: selection.startColumn, endLine: selection.endLineNumber, endCol: selection.endColumn }
      : { startLine: position.lineNumber, startCol: 1, endLine: position.lineNumber, endCol: model.getLineMaxColumn(position.lineNumber) };
    const selectedCode = model.getValueInRange({ startLineNumber: range.startLine, startColumn: range.startCol, endLineNumber: range.endLine, endColumn: range.endCol });
    const fullText = model.getValue();
    const lines = fullText.split("\n");
    const prefixLines = lines.slice(Math.max(0, range.startLine - 61), range.startLine - 1);
    const suffixLines = lines.slice(range.endLine, Math.min(lines.length, range.endLine + 20));
    const scrollTop = ed.getScrollTop();
    const editorLayout = ed.getLayoutInfo();
    const lineHeightPx = ed.getOption(monaco.editor.EditorOption.lineHeight);
    const contentTop = ed.getTopForLineNumber(range.endLine);
    setInlineEditSelection({ selectedCode, prefix: prefixLines.join("\n"), suffix: suffixLines.join("\n"), range, multiSelections: null });
    setInlineEditPos({ top: contentTop - scrollTop, left: editorLayout.contentLeft, lineHeight: lineHeightPx });
    setInlineEditOpen(true);
  }, []);

  // ── Apply AI result ──────────────────────────────────────────────────────
  const handleInlineApply = useCallback(
    (newCode: string) => {
      const ed = editorRef.current;
      const monaco = monacoRef.current;
      if (!ed || !monaco || !inlineEditSelection) return;
      if (inlineEditSelection.multiSelections && inlineEditSelection.multiSelections.length > 0) {
        const parts = newCode.split(/\n---\n/);
        const edits = inlineEditSelection.multiSelections.map((sel, i) => ({
          range: new monaco.Range(sel.startLine, sel.startCol, sel.endLine, sel.endCol),
          text: (parts[i] ?? parts[0] ?? newCode).trimEnd(),
        }));
        ed.executeEdits("inline-edit-multi", edits);
        const flashDecorations = inlineEditSelection.multiSelections.map(sel => ({
          range: new monaco.Range(sel.startLine, 1, sel.endLine, 1),
          options: { isWholeLine: true, className: INLINE_EDIT_DECORATION_CLASSNAME },
        }));
        const newDecorations = ed.deltaDecorations(decorationIdsRef.current, flashDecorations);
        decorationIdsRef.current = newDecorations;
        setTimeout(() => { if (editorRef.current) decorationIdsRef.current = editorRef.current.deltaDecorations(decorationIdsRef.current, []); }, 1400);
        onChange(ed.getModel()?.getValue() ?? "");
        setInlineEditOpen(false);
        setInlineEditSelection(null);
        setTimeout(() => ed.focus(), 50);
        return;
      }
      const { range } = inlineEditSelection;
      const editRange = new monaco.Range(range.startLine, range.startCol, range.endLine, range.endCol);
      ed.executeEdits("inline-edit", [{ range: editRange, text: newCode }]);
      const newEndLine = range.startLine + newCode.split("\n").length - 1;
      const flashRange = new monaco.Range(range.startLine, 1, newEndLine, 1);
      const newDecorations = ed.deltaDecorations(decorationIdsRef.current, [
        { range: flashRange, options: { isWholeLine: true, className: INLINE_EDIT_DECORATION_CLASSNAME } },
      ]);
      decorationIdsRef.current = newDecorations;
      setTimeout(() => { if (editorRef.current) decorationIdsRef.current = editorRef.current.deltaDecorations(decorationIdsRef.current, []); }, 1400);
      onChange(ed.getModel()?.getValue() ?? "");
      setInlineEditOpen(false);
      setInlineEditSelection(null);
      setTimeout(() => ed.focus(), 50);
    },
    [inlineEditSelection, onChange],
  );

  const handleInlineDismiss = useCallback(() => {
    setInlineEditOpen(false);
    setInlineEditSelection(null);
    setTimeout(() => editorRef.current?.focus(), 50);
  }, []);

  /** Revert the last inline edit using Monaco's built-in undo */
  const handleInlineRevert = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.trigger("inline-edit-revert", "undo", null);
    onChange(ed.getModel()?.getValue() ?? "");
  }, [onChange]);

  const handleManualSave = useCallback(async () => {
    const currentPath = pathRef.current;
    if (lspEnabledRef.current && currentPath) {
      const langId = lspManager.getLanguageForFile(currentPath);
      if (langId) lspManager.notifyDocumentSave(currentPath, langId);
    }
    if (onSaveRef.current) { await onSaveRef.current(); setSaveFlashKey((key) => key + 1); }
  }, []);

  // ── Monaco onMount ─────────────────────────────────────────────────────────
  const handleMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;
    defineRuntimeTheme(monaco, theme === "light" ? "light" : "dark");
    monaco.editor.setTheme("punam-runtime");

    // Notify parent of editor instance for inline diff integration
    onEditorReady?.(editorInstance);

    if (onSelectionChange) {
      editorInstance.onDidChangeCursorSelection(() => {
        const sel = editorInstance.getSelection();
        const text = sel && !sel.isEmpty() ? editorInstance.getModel()?.getValueInRange(sel) || "" : "";
        onSelectionChange(text);
        onSelectionRangeChange?.(sel && !sel.isEmpty() ? {
          startLine: sel.startLineNumber,
          startColumn: sel.startColumn,
          endLine: sel.endLineNumber,
          endColumn: sel.endColumn,
          text,
        } : null);
      });
    }
    if (onCursorChange) {
      editorInstance.onDidChangeCursorPosition((e) => onCursorChange({ line: e.position.lineNumber, column: e.position.column }));
    }
    if (problems && problems.length > 0) setMarkers(editorInstance, monaco, problems, path);
    editorInstance.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && onToggleBreakpoint) {
        onToggleBreakpoint(e.target.position!.lineNumber);
      }
    });

    editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => openInlineEdit());
    editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void handleManualSave(); });
    editorInstance.addAction({ id: "punam-save-file", label: "Save File  (Ctrl+S)", contextMenuGroupId: "navigation", contextMenuOrder: -10, run: () => { void handleManualSave(); } });

    if (onAskPunam) {
      editorInstance.addAction({ id: "punam-inline-edit", label: "Punam: Edit Here  (Ctrl+K)", contextMenuGroupId: "punam", contextMenuOrder: 0, run: () => openInlineEdit() });
      editorInstance.addAction({ id: "punam-explain", label: "Punam: Explain This", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE], contextMenuGroupId: "punam", contextMenuOrder: 1, run: (ed) => { const sel = ed.getSelection(); const text = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) || "" : ed.getModel()?.getLineContent(ed.getPosition()?.lineNumber || 1) || ""; if (text.trim()) onAskPunam(text, "explain"); } });
      editorInstance.addAction({ id: "punam-fix", label: "Punam: Fix This", contextMenuGroupId: "punam", contextMenuOrder: 2, run: (ed) => { const sel = ed.getSelection(); const text = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) || "" : ed.getModel()?.getLineContent(ed.getPosition()?.lineNumber || 1) || ""; if (text.trim()) onAskPunam(text, "fix"); } });
      editorInstance.addAction({ id: "punam-refactor", label: "Punam: Refactor This", contextMenuGroupId: "punam", contextMenuOrder: 3, run: (ed) => { const sel = ed.getSelection(); const text = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) || "" : ed.getModel()?.getLineContent(ed.getPosition()?.lineNumber || 1) || ""; if (text.trim()) onAskPunam(text, "refactor"); } });
      editorInstance.addAction({ id: "punam-gen-tests", label: "Punam: Generate Tests  (Ctrl+Shift+T)", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyT], contextMenuGroupId: "punam", contextMenuOrder: 4, run: (ed) => { const sel = ed.getSelection(); const text = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) || "" : ed.getModel()?.getValue() || ""; if (text.trim() && onOpenTestGenPanel) { onOpenTestGenPanel(text); } else if (text.trim()) { onAskPunam(`Generate comprehensive unit tests for this code:\n\n${text}`, "fix"); } } });
      editorInstance.addAction({ id: "punam-gen-docs", label: "Punam: Generate Docs", contextMenuGroupId: "punam", contextMenuOrder: 5, run: (ed) => { const sel = ed.getSelection(); const text = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) || "" : ed.getModel()?.getLineContent(ed.getPosition()?.lineNumber || 1) || ""; if (text.trim()) onAskPunam(`Add JSDoc/docstring documentation to this code:\n\n${text}`, "explain"); } });
    }

    // Refactor context menu actions (open RefactorPanel)
    if (onOpenRefactorPanel) {
      editorInstance.addAction({ id: "punam-refactor-rename", label: "Refactor: Rename Symbol", contextMenuGroupId: "refactor", contextMenuOrder: 0, keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyR], run: () => { onOpenRefactorPanel("rename"); } });
      editorInstance.addAction({ id: "punam-refactor-extract", label: "Refactor: Extract Function", contextMenuGroupId: "refactor", contextMenuOrder: 1, run: () => { onOpenRefactorPanel("extract"); } });
      editorInstance.addAction({ id: "punam-refactor-move", label: "Refactor: Move File", contextMenuGroupId: "refactor", contextMenuOrder: 2, run: () => { onOpenRefactorPanel("move"); } });
    }

    // Register inline completion provider (new modular autocomplete engine)
    if (inlineCompletionEnabled) {
      autocompleteDisposableRef.current?.dispose();
      autocompleteDisposableRef.current = registerAutocompleteProvider(editorInstance);
    }
  };

  return (
    <div className="code-editor" style={{ position: "relative" }}>
      <Editor
        height="100%" path={path} line={line} language={language} value={content}
        beforeMount={handleBeforeMount} onMount={handleMount} theme="punam-runtime"
        onChange={(val) => { const newVal = val || ""; onChange(newVal); notifyLspChange(newVal); }}
        onValidate={() => {}}
        options={{
          fontSize, lineHeight: Math.round(fontSize * 1.6),
          fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace",
          minimap: { enabled: showMinimap, maxColumn: 80 }, wordWrap,
          lineNumbers: "on", lineNumbersMinChars: 4,
          renderLineHighlight: "all", renderLineHighlightOnlyWhenFocus: false,
          renderWhitespace: "selection",
          guides: { indentation: true, highlightActiveIndentation: true },
          bracketPairColorization: { enabled: true },
          autoClosingBrackets: "always", autoClosingQuotes: "always",
          formatOnPaste: true, scrollBeyondLastLine: false, smoothScrolling: true,
          cursorBlinking: "smooth", cursorSmoothCaretAnimation: "on", cursorWidth: 2,
          padding: { top: 10, bottom: 10 }, tabSize: 2, glyphMargin: true,
          inlineSuggest: { enabled: true },
          quickSuggestions: { other: true, comments: false, strings: true },
        }}
      />
      <BreakpointGlyphs editor={editorRef.current} monaco={monacoRef.current} breakpoints={breakpoints} currentDebugSource={currentDebugSource || null} currentFilePath={path} />
      {saveFlashKey > 0 && <div key={saveFlashKey} className="editor-save-flash" aria-label="Saved" role="status" />}
      {inlineEditOpen && inlineEditSelection && (
        <InlineEditWidget
          position={inlineEditPos}
          selectedCode={inlineEditSelection.selectedCode}
          prefixContext={inlineEditSelection.multiSelections ? "" : inlineEditSelection.prefix}
          suffixContext={inlineEditSelection.multiSelections ? "" : inlineEditSelection.suffix}
          language={language} aiProviders={aiProviders}
          multiCursorCount={inlineEditSelection.multiSelections?.length ?? 0}
          onApply={handleInlineApply}
          onRevert={handleInlineRevert}
          onDismiss={handleInlineDismiss}
        />
      )}
    </div>
  );
}

// ─── Problem markers ──────────────────────────────────────────────────────────

function setMarkers(editorInstance: editor.IStandaloneCodeEditor, monaco: typeof import("monaco-editor"), problems: Problem[], currentPath: string) {
  const model = editorInstance.getModel();
  if (!model) return;
  const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const currentNorm = normPath(currentPath);
  const fileProblems = problems.filter((p) => {
    const pNorm = normPath(p.path);
    return currentNorm.endsWith(pNorm) || pNorm.endsWith(currentNorm.split("/").pop() || "");
  });
  const markers: editor.IMarkerData[] = fileProblems.map((p) => {
    let severity: number;
    switch (p.severity) { case "error": severity = monaco.MarkerSeverity.Error; break; case "warning": severity = monaco.MarkerSeverity.Warning; break; default: severity = monaco.MarkerSeverity.Info; }
    return { severity, message: p.message, startLineNumber: p.line, startColumn: p.column || 1, endLineNumber: p.line, endColumn: 1000, source: "PunamIDE" };
  });
  monaco.editor.setModelMarkers(model, "punamide-problems", markers);
}
