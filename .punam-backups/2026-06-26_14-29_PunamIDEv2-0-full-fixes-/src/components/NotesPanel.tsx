/**
 * NotesPanel — per-project persistent notepads.
 * Content is automatically injected into every AI prompt as @notes context.
 * Accessible via toolbar or @notes mention in chat.
 */

import { useEffect, useRef, useState } from "react";
import { Save, X, StickyNote, Info } from "lucide-react";

interface Props {
  projectPath: string;
  onClose: () => void;
  onChange?: (notes: string) => void;
}

const STORAGE_KEY_PREFIX = "punam-notes:";

function getStorageKey(projectPath: string) {
  return STORAGE_KEY_PREFIX + projectPath.replace(/\\/g, "/").toLowerCase();
}

export function loadNotes(projectPath: string): string {
  try {
    return localStorage.getItem(getStorageKey(projectPath)) ?? "";
  } catch {
    return "";
  }
}

function saveNotes(projectPath: string, content: string) {
  try {
    localStorage.setItem(getStorageKey(projectPath), content);
  } catch { /* storage full */ }
}

export default function NotesPanel({ projectPath, onClose, onChange }: Props) {
  const [content, setContent] = useState(() => loadNotes(projectPath));
  const [saved, setSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load when project changes
  useEffect(() => {
    const loaded = loadNotes(projectPath);
    setContent(loaded);
    onChange?.(loaded);
  }, [projectPath]);

  const handleSave = () => {
    saveNotes(projectPath, content);
    onChange?.(content);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  // Auto-save on every change with 800ms debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      saveNotes(projectPath, content);
      onChange?.(content);
    }, 800);
    return () => clearTimeout(timer);
  }, [content, projectPath]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      handleSave();
    }
    if (e.key === "Escape") onClose();
    // Tab = indent
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = textareaRef.current!;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newContent = content.slice(0, start) + "  " + content.slice(end);
      setContent(newContent);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  };

  const charCount = content.length;
  const lineCount = content.split("\n").length;

  return (
    <div className="notes-panel">
      {/* Header */}
      <div className="notes-header">
        <div className="notes-title">
          <StickyNote size={14} />
          <span>Project Notes</span>
        </div>
        <div className="notes-header-actions">
          <button
            className={`btn-secondary compact ${saved ? "notes-saved" : ""}`}
            onClick={handleSave}
            title="Save (Ctrl+S)"
          >
            <Save size={12} />
            {saved ? "Saved!" : "Save"}
          </button>
          <button className="icon-btn small" onClick={onClose} aria-label="Close notes">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Info bar */}
      <div className="notes-info-bar">
        <Info size={11} />
        <span>
          Notes are automatically injected into every AI prompt.
          Use <code>@notes</code> in chat to reference them explicitly.
        </span>
      </div>

      {/* Editor */}
      <textarea
        ref={textareaRef}
        className="notes-textarea"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`Write anything Punam should always know about this project…

Examples:
- Architecture decisions
- Coding conventions
- API endpoints and their purpose
- Known issues or tech debt
- Team preferences

This is like a punam.rules.md but editable here.`}
        spellCheck={false}
      />

      {/* Footer */}
      <div className="notes-footer">
        <span>{lineCount} line{lineCount !== 1 ? "s" : ""}</span>
        <span>{charCount} char{charCount !== 1 ? "s" : ""}</span>
        {charCount > 2000 && (
          <span className="notes-warn">⚠ Long notes may reduce context for other content</span>
        )}
      </div>
    </div>
  );
}
