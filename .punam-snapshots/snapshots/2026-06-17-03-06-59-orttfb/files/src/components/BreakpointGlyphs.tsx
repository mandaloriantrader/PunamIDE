import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";

interface BreakpointGlyphsProps {
  editor: editor.IStandaloneCodeEditor | null;
  monaco: typeof import("monaco-editor") | null;
  breakpoints: number[]; // lines with breakpoints for the current file
  currentDebugSource: { path: string; line: number; } | null;
  /** The current file path shown in the editor (for matching against currentDebugSource) */
  currentFilePath?: string;
}

const BREAKPOINT_DECORATION_CLASS_NAME = "debug-breakpoint";
const CURRENT_LINE_DECORATION_CLASS_NAME = "debug-current-line";

export default function BreakpointGlyphs({
  editor,
  monaco,
  breakpoints,
  currentDebugSource,
  currentFilePath,
}: BreakpointGlyphsProps) {
  const breakpointDecorations = useRef<string[]>([]);
  const currentLineDecoration = useRef<string[]>([]);

  useEffect(() => {
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    // Clear previous breakpoint decorations
    breakpointDecorations.current = editor.deltaDecorations(
      breakpointDecorations.current,
      [],
    );

    // Add new breakpoint decorations (red dots in glyph margin)
    const newBreakpointDecorations = breakpoints.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: BREAKPOINT_DECORATION_CLASS_NAME,
        glyphMarginClassName: BREAKPOINT_DECORATION_CLASS_NAME,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
    breakpointDecorations.current = editor.deltaDecorations(
      breakpointDecorations.current,
      newBreakpointDecorations,
    );

    // Handle current debug source line highlighting (yellow highlight)
    currentLineDecoration.current = editor.deltaDecorations(
      currentLineDecoration.current,
      [],
    );

    if (currentDebugSource && currentFilePath) {
      // Normalize both paths for comparison
      const normalizePath = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const sourcePath = normalizePath(currentDebugSource.path);
      const editorPath = normalizePath(currentFilePath);

      if (editorPath === sourcePath || editorPath.endsWith(sourcePath) || sourcePath.endsWith(editorPath)) {
        currentLineDecoration.current = editor.deltaDecorations(
          currentLineDecoration.current,
          [
            {
              range: new monaco.Range(currentDebugSource.line, 1, currentDebugSource.line, 1),
              options: {
                isWholeLine: true,
                className: CURRENT_LINE_DECORATION_CLASS_NAME,
                overviewRuler: {
                  color: "rgba(255, 255, 0, 0.7)",
                  darkColor: "rgba(255, 255, 0, 0.7)",
                  position: monaco.editor.OverviewRulerLane.Full,
                },
              },
            },
          ],
        );
        editor.revealLineInCenterIfOutsideViewport(currentDebugSource.line);
      }
    }

    return () => {
      editor.deltaDecorations(breakpointDecorations.current, []);
      editor.deltaDecorations(currentLineDecoration.current, []);
    };
  }, [editor, monaco, breakpoints, currentDebugSource, currentFilePath]);

  return null;
}
