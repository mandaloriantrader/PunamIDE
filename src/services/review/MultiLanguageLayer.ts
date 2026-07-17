/**
 * @phase P7
 * @purpose AnalysisLayer wrapper for multi-language detection.
 *          Uses file extension-based language detection directly.
 *          Gate: enabledLayers includes "multi-language".
 */

import type { AnalysisLayer, AnalysisContext, Finding, UnifiedAnalysisConfig } from "./types";

type ExtLang = "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "rs" | "java" | "cs";

const ASPIRATIONAL_EXTS: Set<string> = new Set(["py", "go", "rs", "java", "cs"]);

function extFromPath(file: string): string | null {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cs"].includes(ext)) return ext;
  return null;
}

export class MultiLanguageLayer implements AnalysisLayer {
  name = "multi-language";

  isEnabled(config: UnifiedAnalysisConfig): boolean {
    return config.enabledLayers?.includes("multi-language") ?? false;
  }

  async analyze(files: string[], _context: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of files) {
      const lang = extFromPath(file);
      if (!lang) continue;
      if (ASPIRATIONAL_EXTS.has(lang)) {
        findings.push({
          id: "multi-lang:" + file,
          file,
          source: "review-agent" as const,
          severity: "info",
          confidence: "heuristic",
          title: "Aspirational language: " + lang,
          description: lang + " file detected but grammar not loaded (aspirational). Regex fallback scoring active.",
          whyFlagged: "Language " + lang + " grammar state: aspirational",
          fix: "Install tree-sitter-" + lang + ".wasm to enable AST analysis",
        });
      }
    }
    return findings;
  }
}

let instance: MultiLanguageLayer | null = null;
export function getMultiLanguageLayer(): MultiLanguageLayer {
  if (!instance) instance = new MultiLanguageLayer();
  return instance;
}
