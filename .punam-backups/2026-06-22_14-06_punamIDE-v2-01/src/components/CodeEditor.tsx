import { useRef, useState, useCallback, useEffect } from "react";
import Editor from "@monaco-editor/react";
import type { BeforeMount, OnMount } from "@monaco-editor/react";
import type { editor, languages, CancellationToken, Position, IDisposable } from "monaco-editor";
import { sendToProviderStreaming } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";
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

  // Keep a stable ref to the editor instance for use in callbacks
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const [saveFlashKey, setSaveFlashKey] = useState(0);
  const onSaveRef = useRef<Props["onSave"]>(onSave);
  const pathRef = useRef(path);
  const lspEnabledRef = useRef(lspEnabled);
  // Decoration collection for the green-flash effect
  const decorationIdsRef = useRef<string[]>([]);
  // LSP provider disposables
  const lspDisposablesRef = useRef<IDisposable[]>([]);
  // Track which languages have providers registered
  const lspRegisteredLangsRef = useRef<Set<string>>(new Set());
  // Track whether LSP didOpen was sent for current file
  const lspOpenedFileRef = useRef<string | null>(null);

  useEffect(() => {
    onSaveRef.current = onSave;
    pathRef.current = path;
    lspEnabledRef.current = lspEnabled;
  }, [lspEnabled, onSave, path]);

  // ── LSP Lifecycle ──────────────────────────────────────────────────────────
  // Connect LSP manager once when component mounts with a project path
  useEffect(() => {
    if (!lspEnabled || !projectPath) return;

    lspManager.setProjectPath(projectPath);
    lspManager.connect().catch((err) => {
      console.warn("[LSP] Failed to connect:", err);
    });

    return () => {
      // Don't disconnect on every unmount — LSP persists across file switches.
      // Cleanup happens at app level or when project changes.
    };
  }, [lspEnabled, projectPath]);

  // Start LSP server for the current language and register Monaco providers
  useEffect(() => {
    if (!lspEnabled || !projectPath || !path) return;

    const monaco = monacoRef.current;
    const languageId = lspManager.getLanguageForFile(path);
    if (!languageId) return; // File type not supported by any LSP server

    let cancelled = false;

    const initLsp = async () => {
      // Start the server (no-op if already running)
      const started = await lspManager.startServer(languageId);
      if (!started || cancelled) return;

      // Register Monaco providers for this language if not already registered
      if (monaco && !lspRegisteredLangsRef.current.has(languageId)) {
        const disposables = registerLspProviders(monaco, lspService, [languageId]);
        lspDisposablesRef.current.push(...disposables);
        lspRegisteredLangsRef.current.add(languageId);
      }
    };

    initLsp();

    return () => {
      cancelled = true;
    };
  }, [lspEnabled, projectPath, path]);

  // Send didOpen/didClose when the active file changes
  useEffect(() => {
    if (!lspEnabled || !projectPath || !path) return;

    const languageId = lspManager.getLanguageForFile(path);
    if (!languageId) return;

    // Close previous file if different
    const prevFile = lspOpenedFileRef.current;
    if (prevFile && prevFile !== path) {
      const prevLangId = lspManager.getLanguageForFile(prevFile);
      if (prevLangId) {
        lspManager.notifyDocumentClose(prevFile, prevLangId);
      }
    }

    // Open current file — retry until server is ready (max 3 seconds)
    let attempts = 0;
    const maxAttempts = 6;
    const tryOpen = () => {
      attempts++;
      if (lspManager.isServerRunning(languageId)) {
        lspManager.notifyDocumentOpen(path, languageId, content);
        lspOpenedFileRef.current = path;
      } else if (attempts < maxAttempts) {
        timer = setTimeout(tryOpen, 500);
      }
    };
    let timer = setTimeout(tryOpen, 500);

    return () => {
      clearTimeout(timer);
    };
    // Only re-run when path changes, not content
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lspEnabled, projectPath, path]);

  // Notify LSP of content changes (debounced internally by lspService)
  const notifyLspChange = useCallback((newContent: string) => {
    if (!lspEnabled || !path) return;
    const languageId = lspManager.getLanguageForFile(path);
    if (!languageId) return;
    lspManager.notifyDocumentChange(path, languageId, newContent);
  }, [lspEnabled, path]);

  // Cleanup LSP providers on unmount
  useEffect(() => {
    return () => {
      for (const d of lspDisposablesRef.current) {
        d.dispose();
      }
      lspDisposablesRef.current = [];
      lspRegisteredLangsRef.current.clear();

      // Close the last opened file
      const openedFile = lspOpenedFileRef.current;
      if (openedFile) {
        const langId = lspManager.getLanguageForFile(openedFile);
        if (langId) {
          lspManager.notifyDocumentClose(openedFile, langId);
        }
        lspOpenedFileRef.current = null;
      }
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

  // ── Open inline edit widget ────────────────────────────────────────────────
  const openInlineEdit = useCallback(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;

    const model = ed.getModel();
    if (!model) return;

    const position = ed.getPosition();
    if (!position) return;

    // ── Multi-cursor support ──────────────────────────────────────────────────
    // If there are multiple cursor selections, handle them all at once
    const selections = ed.getSelections() ?? [];
    const nonEmptySelections = selections.filter(s => !s.isEmpty());

    if (nonEmptySelections.length > 1) {
      // Collect all selected texts
      const snippets = nonEmptySelections.map(s => model.getValueInRange(s));
      const combined = snippets.join("\n---\n");

      // Position widget below the last selection
      const lastSel = nonEmptySelections[nonEmptySelections.length - 1];
      const scrollTop = ed.getScrollTop();
      const editorLayout = ed.getLayoutInfo();
      const lineHeightPx = ed.getOption(monaco.editor.EditorOption.lineHeight);
      const contentTop = ed.getTopForLineNumber(lastSel.endLineNumber);

      setInlineEditSelection({
        selectedCode: combined,
        prefix: `${snippets.length} selections`,
        suffix: "",
        range: {
          startLine: lastSel.startLineNumber,
          startCol: lastSel.startColumn,
          endLine: lastSel.endLineNumber,
          endCol: lastSel.endColumn,
        },
        multiSelections: nonEmptySelections.map(s => ({
          startLine: s.startLineNumber,
          startCol: s.startColumn,
          endLine: s.endLineNumber,
          endCol: s.endColumn,
          originalText: model.getValueInRange(s),
        })),
      });
      setInlineEditPos({ top: contentTop - scrollTop, left: editorLayout.contentLeft, lineHeight: lineHeightPx });
      setInlineEditOpen(true);
      return;
    }

    // ── Single cursor (original behaviour) ───────────────────────────────────
    const selection = ed.getSelection();
    const hasSelection = selection && !selection.isEmpty();
    const range = hasSelection
      ? {
          startLine: selection.startLineNumber,
          startCol: selection.startColumn,
          endLine: selection.endLineNumber,
          endCol: selection.endColumn,
        }
      : {
          startLine: position.lineNumber,
          startCol: 1,
          endLine: position.lineNumber,
          endCol: model.getLineMaxColumn(position.lineNumber),
        };

    const selectedCode = model.getValueInRange({
      startLineNumber: range.startLine,
      startColumn: range.startCol,
      endLineNumber: range.endLine,
      endColumn: range.endCol,
    });

    const fullText = model.getValue();
    const lines = fullText.split("\n");
    const prefixLines = lines.slice(Math.max(0, range.startLine - 61), range.startLine - 1);
    const suffixLines = lines.slice(range.endLine, Math.min(lines.length, range.endLine + 20));

    const scrollTop = ed.getScrollTop();
    const editorLayout = ed.getLayoutInfo();
    const lineHeightPx = ed.getOption(monaco.editor.EditorOption.lineHeight);
    const contentTop = ed.getTopForLineNumber(range.endLine);

    setInlineEditSelection({
      selectedCode,
      prefix: prefixLines.join("\n"),
      suffix: suffixLines.join("\n"),
      range,
      multiSelections: null,
    });
    setInlineEditPos({ top: contentTop - scrollTop, left: editorLayout.contentLeft, lineHeight: lineHeightPx });
    setInlineEditOpen(true);
  }, []);

  // ── Apply AI result back into the editor ──────────────────────────────────
  const handleInlineApply = useCallback(
    (newCode: string) => {
      const ed = editorRef.current;
      const monaco = monacoRef.current;
      if (!ed || !monaco || !inlineEditSelection) return;

      // ── Multi-cursor apply ───────────────────────────────────────────────
      if (inlineEditSelection.multiSelections && inlineEditSelection.multiSelections.length > 0) {
        // The AI response may contain multiple sections separated by ---
        const parts = newCode.split(/\n---\n/);
        const edits = inlineEditSelection.multiSelections.map((sel, i) => ({
          range: new monaco.Range(sel.startLine, sel.startCol, sel.endLine, sel.endCol),
          text: (parts[i] ?? parts[0] ?? newCode).trimEnd(),
        }));

        // Apply all at once — Monaco handles offset adjustments automatically
        ed.executeEdits("inline-edit-multi", edits);

        // Flash all edited ranges green
        const flashDecorations = inlineEditSelection.multiSelections.map(sel => ({
          range: new monaco.Range(sel.startLine, 1, sel.endLine, 1),
          options: { isWholeLine: true, className: INLINE_EDIT_DECORATION_CLASSNAME },
        }));
        const newDecorations = ed.deltaDecorations(decorationIdsRef.current, flashDecorations);
        decorationIdsRef.current = newDecorations;
        setTimeout(() => {
          if (editorRef.current) {
            decorationIdsRef.current = editorRef.current.deltaDecorations(decorationIdsRef.current, []);
          }
        }, 1400);

        onChange(ed.getModel()?.getValue() ?? "");
        setInlineEditOpen(false);
        setInlineEditSelection(null);
        setTimeout(() => ed.focus(), 50);
        return;
      }

      // ── Single-cursor apply (original) ──────────────────────────────────
      const { range } = inlineEditSelection;
      const editRange = new monaco.Range(range.startLine, range.startCol, range.endLine, range.endCol);
      ed.executeEdits("inline-edit", [{ range: editRange, text: newCode }]);

      const newEndLine = range.startLine + newCode.split("\n").length - 1;
      const flashRange = new monaco.Range(range.startLine, 1, newEndLine, 1);
      const newDecorations = ed.deltaDecorations(decorationIdsRef.current, [
        { range: flashRange, options: { isWholeLine: true, className: INLINE_EDIT_DECORATION_CLASSNAME } },
      ]);
      decorationIdsRef.current = newDecorations;
      setTimeout(() => {
        if (editorRef.current) {
          decorationIdsRef.current = editorRef.current.deltaDecorations(decorationIdsRef.current, []);
        }
      }, 1400);

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

  const handleManualSave = useCallback(async () => {
    const currentPath = pathRef.current;

    if (lspEnabledRef.current && currentPath) {
      const langId = lspManager.getLanguageForFile(currentPath);
      if (langId) {
        lspManager.notifyDocumentSave(currentPath, langId);
      }
    }

    if (onSaveRef.current) {
      await onSaveRef.current();
      setSaveFlashKey((key) => key + 1);
    }
  }, []);

  // ── Monaco onMount ─────────────────────────────────────────────────────────
  const handleMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;
    defineRuntimeTheme(monaco, theme === "light" ? "light" : "dark");
    monaco.editor.setTheme("punam-runtime");

    // Selection changes
    if (onSelectionChange) {
      editorInstance.onDidChangeCursorSelection(() => {
        const sel = editorInstance.getSelection();
        if (sel && !sel.isEmpty()) {
          onSelectionChange(editorInstance.getModel()?.getValueInRange(sel) || "");
        } else {
          onSelectionChange("");
        }
      });
    }

    // Cursor position changes
    if (onCursorChange) {
      editorInstance.onDidChangeCursorPosition((e) => {
        onCursorChange({ line: e.position.lineNumber, column: e.position.column });
      });
    }

    // Initial problem markers
    if (problems && problems.length > 0) {
      setMarkers(editorInstance, monaco, problems, path);
    }

    // Debugger breakpoint glyphs
    // We add a click handler to the glyph margin to toggle breakpoints
    editorInstance.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && onToggleBreakpoint) {
        const line = e.target.position!.lineNumber;
        onToggleBreakpoint(line);
      }
    });

    // ── Ctrl+K → open inline edit ──────────────────────────────────────────
    editorInstance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
      () => {
        openInlineEdit();
      },
    );

    // ── Ctrl+S → notify LSP of save ──────────────────────────────────────────
    editorInstance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => { void handleManualSave(); },
    );

    editorInstance.addAction({
      id: "punam-save-file",
      label: "Save File  (Ctrl+S)",
      contextMenuGroupId: "navigation",
      contextMenuOrder: -10,
      run: () => { void handleManualSave(); },
    });

    // Context menu: Punam actions
    if (onAskPunam) {
      // Inline edit (Ctrl+K)
      editorInstance.addAction({
        id: "punam-inline-edit",
        label: "Punam: Edit Here  (Ctrl+K)",
        contextMenuGroupId: "punam",
        contextMenuOrder: 0,
        run: () => openInlineEdit(),
      });

      editorInstance.addAction({
        id: "punam-explain",
        label: "Punam: Explain This",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
        contextMenuGroupId: "punam",
        contextMenuOrder: 1,
        run: (ed) => {
          const sel = ed.getSelection();
          const text =
            sel && !sel.isEmpty()
              ? ed.getModel()?.getValueInRange(sel) || ""
              : ed.getModel()?.getLineContent(ed.getPosition()?.lineNumber || 1) || "";
          if (text.trim()) onAskPunam(text, "explain");
        },
      });

      editorInstance.addAction({
        id: "punam-fix",
        label: "Punam: Fix This",
        contextMenuGroupId: "punam",
        contextMenuOrder: 2,
        run: (ed) => {
          const sel = ed.getSelection();
          const text =
            sel && !sel.isEmpty()
              ? ed.getModel()?.getValueInRange(sel) || ""
              : ed.getModel()?.getLineContent(ed.getPosition()?.lineNumber || 1) || "";
          if (text.trim()) onAskPunam(text, "fix");
        },
      });

      editorInstance.addAction({
        id: "punam-refactor",
        label: "Punam: Refactor This",
        contextMenuGroupId: "punam",
        contextMenuOrder: 3,
        run: (ed) => {
          const sel = ed.getSelection();
          const text =
            sel && !sel.isEmpty()
              ? ed.getModel()?.getValueInRange(sel) || ""
              : ed.getModel()?.getLineContent(ed.getPosition()?.lineNumber || 1) || "";
          if (text.trim()) onAskPunam(text, "refactor");
        },
      });

      // Generate tests
      editorInstance.addAction({
        id: "punam-gen-tests",
        label: "Punam: Generate Tests",
        contextMenuGroupId: "punam",
        contextMenuOrder: 4,
        run: (ed) => {
          const sel = ed.getSelection();
          const text =
            sel && !sel.isEmpty()
              ? ed.getModel()?.getValueInRange(sel) || ""
              : ed.getModel()?.getValue() || "";
          if (text.trim()) onAskPunam(`Generate comprehensive unit tests for this code:\n\n${text}`, "fix");
        },
      });

      // AI Docs
      editorInstance.addAction({
        id: "punam-gen-docs",
        label: "Punam: Generate Docs",
        contextMenuGroupId: "punam",
        contextMenuOrder: 5,
        run: (ed) => {
          const sel = ed.getSelection();
          const text =
            sel && !sel.isEmpty()
              ? ed.getModel()?.getValueInRange(sel) || ""
              : ed.getModel()?.getLineContent(ed.getPosition()?.lineNumber || 1) || "";
          if (text.trim()) onAskPunam(`Add JSDoc/docstring documentation to this code:\n\n${text}`, "explain");
        },
      });
    }

    // Inline completion provider (Copilot-style)
    if (inlineCompletionEnabled && aiProviders.length > 0) {
      registerInlineCompletionProvider(monaco, aiProviders);
    }
  };

  return (
    <div className="code-editor" style={{ position: "relative" }}>
      <Editor
        height="100%"
        path={path}
        line={line}
        language={language}
        value={content}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        theme="punam-runtime"
        onChange={(val) => {
          const newVal = val || "";
          onChange(newVal);
          notifyLspChange(newVal);
        }}
        onValidate={() => {}}
        options={{
          fontSize: fontSize,
          lineHeight: Math.round(fontSize * 1.6),
          fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace",
          minimap: { enabled: showMinimap, maxColumn: 80 },
          wordWrap: wordWrap,
          lineNumbers: "on",
          lineNumbersMinChars: 4,
          renderLineHighlight: "all",
          renderLineHighlightOnlyWhenFocus: false,
          renderWhitespace: "selection",
          guides: {
            indentation: true,
            highlightActiveIndentation: true,
          },
          bracketPairColorization: { enabled: true },
          autoClosingBrackets: "always",
          autoClosingQuotes: "always",
          formatOnPaste: true,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          cursorWidth: 2,
          padding: { top: 10, bottom: 10 },
          tabSize: 2,
          glyphMargin: true,
          inlineSuggest: { enabled: true },
          quickSuggestions: { other: true, comments: false, strings: true },
        }}
      />

      {/* Breakpoint glyphs */}
      <BreakpointGlyphs editor={editorRef.current} monaco={monacoRef.current} breakpoints={breakpoints} currentDebugSource={currentDebugSource} currentFilePath={path} />

      {/* ── Inline edit widget overlay ── */}
      {saveFlashKey > 0 && (
        <div
          key={saveFlashKey}
          className="editor-save-flash"
          aria-label="Saved"
          role="status"
        />
      )}

      {inlineEditOpen && inlineEditSelection && (
        <InlineEditWidget
          position={inlineEditPos}
          selectedCode={inlineEditSelection.selectedCode}
          prefixContext={inlineEditSelection.multiSelections ? "" : inlineEditSelection.prefix}
          suffixContext={inlineEditSelection.multiSelections ? "" : inlineEditSelection.suffix}
          language={language}
          aiProviders={aiProviders}
          multiCursorCount={inlineEditSelection.multiSelections?.length ?? 0}
          onApply={handleInlineApply}
          onDismiss={handleInlineDismiss}
        />
      )}
    </div>
  );
}

// ─── Problem markers ──────────────────────────────────────────────────────────

function setMarkers(
  editorInstance: editor.IStandaloneCodeEditor,
  monaco: typeof import("monaco-editor"),
  problems: Problem[],
  currentPath: string,
) {
  const model = editorInstance.getModel();
  if (!model) return;

  const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const currentNorm = normPath(currentPath);

  const fileProblems = problems.filter((p) => {
    const pNorm = normPath(p.path);
    return (
      currentNorm.endsWith(pNorm) ||
      pNorm.endsWith(currentNorm.split("/").pop() || "")
    );
  });

  const markers: editor.IMarkerData[] = fileProblems.map((p) => {
    let severity: number;
    switch (p.severity) {
      case "error":
        severity = monaco.MarkerSeverity.Error;
        break;
      case "warning":
        severity = monaco.MarkerSeverity.Warning;
        break;
      default:
        severity = monaco.MarkerSeverity.Info;
    }
    return {
      severity,
      message: p.message,
      startLineNumber: p.line,
      startColumn: p.column || 1,
      endLineNumber: p.line,
      endColumn: 1000,
      source: "PunamIDE",
    };
  });

  monaco.editor.setModelMarkers(model, "punamide-problems", markers);
}

// ─── Inline Completion Provider (Copilot-style) ───────────────────────────────

let inlineProviderRegistered = false;
let lastCompletionRequest = 0;
let currentAiProviders: AIProviderConfig[] = [];

const COMPLETION_DEBOUNCE_MS = 800;
const COMPLETION_SYSTEM_PROMPT = `You are a code completion engine. Given the code context (prefix before cursor and suffix after cursor), output ONLY the code that should be inserted at the cursor position. Rules:
- Output ONLY the completion text, nothing else
- No explanations, no markdown, no code fences
- Complete the current line or add 1-3 logical next lines
- Match the existing code style, indentation, and naming conventions
- If the context doesn't suggest a clear completion, output nothing (empty string)
- Keep completions short and focused (max 3-4 lines)`;

function registerInlineCompletionProvider(
  monaco: typeof import("monaco-editor"),
  aiProviders: AIProviderConfig[],
) {
  currentAiProviders = aiProviders;
  if (inlineProviderRegistered) return;
  inlineProviderRegistered = true;

  const provider: languages.InlineCompletionsProvider = {
    provideInlineCompletions: async (
      model: editor.ITextModel,
      position: Position,
      _context: languages.InlineCompletionContext,
      token: CancellationToken,
    ): Promise<languages.InlineCompletions> => {
      const now = Date.now();
      lastCompletionRequest = now;
      await new Promise((r) => setTimeout(r, COMPLETION_DEBOUNCE_MS));
      if (lastCompletionRequest !== now || token.isCancellationRequested) {
        return { items: [] };
      }

      const fullText = model.getValue();
      const offset = model.getOffsetAt(position);
      const prefix = fullText.slice(Math.max(0, offset - 1500), offset);
      const suffix = fullText.slice(offset, offset + 500);

      const currentLine = model.getLineContent(position.lineNumber);
      const beforeCursor = currentLine.slice(0, position.column - 1);
      if (
        !beforeCursor.trim() &&
        !prefix.trim().endsWith("{") &&
        !prefix.trim().endsWith("(")
      ) {
        return { items: [] };
      }

      const activeProvider = currentAiProviders.find(
        (p) => p.apiKey && p.models.some((m) => m.enabled),
      );
      if (!activeProvider) return { items: [] };
      const activeModel = activeProvider.models.find((m) => m.enabled);
      if (!activeModel) return { items: [] };

      try {
        const resp = await sendToProviderStreaming(activeProvider, activeModel.id, {
          systemPrompt: COMPLETION_SYSTEM_PROMPT,
          userPrompt: `Language: ${model.getLanguageId()}\n\n// Code before cursor:\n${prefix}\n\n// Code after cursor:\n${suffix}\n\n// Complete from cursor position:`,
        });

        if (token.isCancellationRequested || lastCompletionRequest !== now) {
          return { items: [] };
        }

        if (resp.success && resp.text.trim()) {
          let completion = resp.text
            .replace(/^```[\w]*\n?/, "")
            .replace(/\n?```$/, "")
            .replace(/^\n/, "");

          if (
            completion.length > 500 ||
            /^(Here|This|The|I |Note)/i.test(completion)
          ) {
            return { items: [] };
          }

          return {
            items: [
              {
                insertText: completion,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                },
              },
            ],
          };
        }
      } catch {
        // Silently fail
      }

      return { items: [] };
    },

    disposeInlineCompletions: () => {},
  } as languages.InlineCompletionsProvider;

  monaco.languages.registerInlineCompletionsProvider({ pattern: "**" }, provider);
}
