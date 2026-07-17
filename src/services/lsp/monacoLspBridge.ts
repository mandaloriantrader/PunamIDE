/**
 * Monaco-LSP Bridge — Registers Monaco providers that delegate to LSP.
 * Provides real autocomplete, hover, diagnostics, and go-to-definition.
 */

import type { IDisposable } from "monaco-editor";
import { type LspClient } from "./lspClient";

// Map LSP completion kinds to Monaco completion kinds
const LSP_TO_MONACO_KIND: Record<number, number> = {
  1: 18,  // Text
  2: 0,   // Method
  3: 1,   // Function
  4: 8,   // Constructor
  5: 4,   // Field
  6: 5,   // Variable
  7: 7,   // Class
  8: 7,   // Interface
  9: 8,   // Module
  10: 9,  // Property
  11: 12, // Unit
  12: 11, // Value
  13: 15, // Enum
  14: 13, // Keyword
  15: 14, // Snippet
  16: 15, // Color
  17: 16, // File
  18: 17, // Reference
  19: 18, // Folder
  20: 19, // EnumMember
  21: 20, // Constant
  22: 21, // Struct
  23: 22, // Event
  24: 23, // Operator
  25: 24, // TypeParameter
};

// Map LSP severity to Monaco severity
const LSP_TO_MONACO_SEVERITY: Record<number, number> = {
  1: 8, // Error
  2: 4, // Warning
  3: 2, // Info
  4: 1, // Hint
};

export function filePathToUri(filePath: string): string {
  // Convert Windows path to file:// URI
  const normalized = filePath.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized)) {
    return `file:///${normalized}`;
  }
  return `file://${normalized}`;
}

export function uriToFilePath(uri: string): string {
  return uri.replace("file:///", "").replace("file://", "").replace(/\//g, "\\");
}

/**
 * Register Monaco providers backed by an LSP client.
 * Returns a dispose function to clean up all registrations.
 */
export function registerLspProviders(
  monaco: typeof import("monaco-editor"),
  client: LspClient,
  languageIds: string[]
): IDisposable[] {
  const disposables: IDisposable[] = [];

  // --- Completion Provider ---
  for (const langId of languageIds) {
    const completionProvider = monaco.languages.registerCompletionItemProvider(langId, {
      triggerCharacters: [".", "/", "<", '"', "'", "@", "#"],
      provideCompletionItems: async (model, position) => {
        const uri = filePathToUri(model.uri.path || model.uri.toString());
        const items = await client.completion(uri, position.lineNumber - 1, position.column - 1);

        return {
          suggestions: items.map((item, idx) => ({
            label: item.label,
            kind: LSP_TO_MONACO_KIND[item.kind] ?? 18,
            detail: item.detail,
            documentation: item.documentation,
            insertText: item.insertText || item.label,
            insertTextRules: item.insertTextFormat === 2
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
            sortText: item.sortText || String(idx).padStart(5, "0"),
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
          })),
        };
      },
    });
    disposables.push(completionProvider);
  }

  // --- Hover Provider ---
  for (const langId of languageIds) {
    const hoverProvider = monaco.languages.registerHoverProvider(langId, {
      provideHover: async (model, position) => {
        const uri = filePathToUri(model.uri.path || model.uri.toString());
        const result = await client.hover(uri, position.lineNumber - 1, position.column - 1);

        if (!result) return null;

        return {
          contents: [{ value: result.contents, isTrusted: true }],
          range: result.range ? new monaco.Range(
            result.range.startLine + 1,
            result.range.startCol + 1,
            result.range.endLine + 1,
            result.range.endCol + 1
          ) : undefined,
        };
      },
    });
    disposables.push(hoverProvider);
  }

  // --- Definition Provider ---
  for (const langId of languageIds) {
    const defProvider = monaco.languages.registerDefinitionProvider(langId, {
      provideDefinition: async (model, position) => {
        const uri = filePathToUri(model.uri.path || model.uri.toString());
        const locations = await client.definition(uri, position.lineNumber - 1, position.column - 1);

        return locations.map((loc) => ({
          uri: monaco.Uri.parse(loc.uri),
          range: new monaco.Range(
            loc.range.startLine + 1,
            loc.range.startCol + 1,
            loc.range.endLine + 1,
            loc.range.endCol + 1
          ),
        }));
      },
    });
    disposables.push(defProvider);
  }

  // --- References Provider ---
  // NOTE: Disabled until Rust backend implements lsp_references command.
  // Calling a non-existent Tauri command would throw an unhandled error.
  // for (const langId of languageIds) {
  //   const refProvider = monaco.languages.registerReferenceProvider(langId, { ... });
  //   disposables.push(refProvider);
  // }

  // --- Diagnostics (via listener) ---
  const removeDiagListener = client.onDiagnostics((uri, diagnostics) => {
    // Find the model for this URI
    const models = monaco.editor.getModels();
    const targetModel = models.find((m) => {
      const modelUri = filePathToUri(m.uri.path || m.uri.toString());
      return modelUri === uri || m.uri.toString() === uri;
    });

    if (!targetModel) return;

    const markers = diagnostics.map((d) => ({
      severity: LSP_TO_MONACO_SEVERITY[d.severity] ?? 8,
      message: d.message,
      source: d.source || "lsp",
      startLineNumber: d.range.startLine + 1,
      startColumn: d.range.startCol + 1,
      endLineNumber: d.range.endLine + 1,
      endColumn: d.range.endCol + 1,
      code: d.code?.toString(),
    }));

    monaco.editor.setModelMarkers(targetModel, "lsp", markers);
  });

  disposables.push({ dispose: removeDiagListener });

  return disposables;
}
