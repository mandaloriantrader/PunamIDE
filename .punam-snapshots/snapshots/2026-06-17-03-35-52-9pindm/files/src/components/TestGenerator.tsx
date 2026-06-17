/**
 * TestGenerator — AI-powered unit test generator.
 * Detects test framework from package.json/pyproject, generates tests,
 * shows preview, and creates the test file with one click.
 */

import { useState } from "react";
import { FlaskConical, Loader2, Check, X, FileText } from "lucide-react";
import { sendToProviderStreaming } from "../utils/providers";
import type { AIProviderConfig } from "../utils/providers";

interface Props {
  filePath: string;
  fileContent: string;
  language: string;
  aiProviders: AIProviderConfig[];
  projectFiles: string[]; // all file paths for framework detection
  onCreateFile: (path: string, content: string) => void;
  onClose: () => void;
}

/** Detect test framework from file list */
function detectTestFramework(files: string[]): { framework: string; ext: string; runner: string } {
  const all = files.join("\n").toLowerCase();
  if (all.includes("vitest") || all.includes("vite.config")) return { framework: "vitest", ext: ".test.ts", runner: "npx vitest run" };
  if (all.includes("jest.config") || all.includes('"jest"')) return { framework: "jest", ext: ".test.ts", runner: "npx jest" };
  if (all.includes("pytest") || all.includes("pyproject.toml")) return { framework: "pytest", ext: "_test.py", runner: "python -m pytest" };
  if (all.includes("cargo.toml")) return { framework: "rust-test", ext: ".rs", runner: "cargo test" };
  if (all.includes("go.mod")) return { framework: "go-test", ext: "_test.go", runner: "go test ./..." };
  // Default
  return { framework: "vitest", ext: ".test.ts", runner: "npx vitest run" };
}

/** Generate test file path from source path */
function getTestPath(sourcePath: string, ext: string, framework: string): string {
  const parts = sourcePath.replace(/\\/g, "/").split("/");
  const filename = parts.pop() ?? "";
  const base = filename.replace(/\.[^.]+$/, "");

  if (framework === "pytest") return [...parts, `test_${base}${ext}`].join("/");
  if (framework === "rust-test") return sourcePath; // tests go in same file for Rust
  if (framework === "go-test") return [...parts, `${base}${ext}`].join("/");

  // JS/TS: check for __tests__ folder pattern
  const hasTestsFolder = parts.some((p) => p === "__tests__");
  if (hasTestsFolder) {
    const testIdx = parts.lastIndexOf("__tests__");
    return [...parts.slice(0, testIdx + 1), `${base}${ext}`].join("/");
  }
  return [...parts, `${base}${ext}`].join("/");
}

const TEST_SYSTEM_PROMPT = `You are an expert test engineer. Generate comprehensive unit tests for the provided code.

Rules:
- Use the specified test framework
- Cover happy paths, edge cases, and error cases
- Mock external dependencies appropriately
- Use descriptive test names (describe what is being tested and expected outcome)
- Aim for 80%+ code coverage
- Output ONLY the test file content — no explanation, no markdown fences
- Preserve correct imports relative to the file location
- Keep tests focused and fast`;

export default function TestGenerator({
  filePath, fileContent, language, aiProviders, projectFiles, onCreateFile, onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  const { framework, ext, runner } = detectTestFramework(projectFiles);
  const testPath = getTestPath(filePath, ext, framework);
  const filename = filePath.split(/[\\/]/).pop() ?? filePath;
  const testFilename = testPath.split(/[\\/]/).pop() ?? testPath;

  const generate = async () => {
    const provider = aiProviders.find((p) => p.apiKey && p.models.some((m) => m.enabled));
    if (!provider) { setError("No AI provider configured."); return; }
    const model = provider.models.find((m) => m.enabled);
    if (!model) { setError("No model enabled."); return; }

    setLoading(true);
    setError(null);
    setGenerated(null);
    setCreated(false);

    const userPrompt =
      `Framework: ${framework}\n` +
      `Source file: ${filePath}\n` +
      `Language: ${language}\n` +
      `Test file will be: ${testPath}\n\n` +
      `Source code:\n\`\`\`${language}\n${fileContent.slice(0, 8000)}\n\`\`\`\n\n` +
      `Generate the complete test file for this code using ${framework}.`;

    try {
      const resp = await sendToProviderStreaming(provider, model.id, {
        systemPrompt: TEST_SYSTEM_PROMPT,
        userPrompt,
      });
      if (resp.success) {
        const cleaned = resp.text
          .replace(/^```[\w]*\n?/, "")
          .replace(/\n?```$/, "")
          .trim();
        setGenerated(cleaned);
      } else {
        setError(resp.error || "Unknown error");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    if (!generated) return;
    onCreateFile(testPath, generated);
    setCreated(true);
  };

  return (
    <div className="test-gen-panel">
      {/* Header */}
      <div className="tg-header">
        <div className="tg-title">
          <FlaskConical size={14} />
          <span>Generate Tests</span>
          <span className="tg-filename">{filename}</span>
        </div>
        <button className="icon-btn small" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>

      <div className="tg-body">
        {/* Framework info */}
        <div className="tg-info-card">
          <div className="tg-info-row">
            <span className="tg-info-label">Framework</span>
            <span className="tg-info-value tg-badge">{framework}</span>
          </div>
          <div className="tg-info-row">
            <span className="tg-info-label">Test file</span>
            <span className="tg-info-value tg-mono">{testFilename}</span>
          </div>
          <div className="tg-info-row">
            <span className="tg-info-label">Run with</span>
            <span className="tg-info-value tg-mono">{runner}</span>
          </div>
        </div>

        {/* Generate button */}
        {!generated && !loading && (
          <button className="btn-primary" onClick={generate} disabled={loading}>
            <FlaskConical size={14} />
            Generate Tests for {filename}
          </button>
        )}

        {/* Loading */}
        {loading && (
          <div className="tg-loading">
            <Loader2 size={20} className="spin" />
            <span>Analyzing code and writing tests…</span>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="tg-error">
            <X size={14} />
            <span>{error}</span>
            <button className="btn-secondary compact" onClick={generate}>Retry</button>
          </div>
        )}

        {/* Generated preview */}
        {generated && !loading && (
          <>
            <div className="tg-preview-header">
              <FileText size={13} />
              <span className="tg-mono">{testFilename}</span>
              <span className="tg-line-count">{generated.split("\n").length} lines</span>
            </div>
            <pre className="tg-preview">{generated}</pre>

            <div className="tg-actions">
              {!created ? (
                <>
                  <button className="btn-primary" onClick={handleCreate}>
                    <Check size={14} /> Create {testFilename}
                  </button>
                  <button className="btn-secondary compact" onClick={generate}>
                    Regenerate
                  </button>
                </>
              ) : (
                <div className="tg-created">
                  <Check size={16} className="tg-created-icon" />
                  <span><strong>{testFilename}</strong> created!</span>
                  <span className="tg-created-hint">Run: <code>{runner}</code></span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
