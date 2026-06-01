/**
 * FileTemplatePicker — new file wizard with template selection.
 * Triggered from the file explorer context menu or Ctrl+N.
 */

import { useState, useRef, useEffect } from "react";
import { X, Search } from "lucide-react";
import { FILE_TEMPLATES, TEMPLATE_CATEGORIES } from "../utils/fileTemplates";
import type { FileTemplate } from "../utils/fileTemplates";

interface Props {
  defaultFolder?: string;
  onConfirm: (relativePath: string, content: string) => void;
  onClose: () => void;
}

export default function FileTemplatePicker({ defaultFolder = "", onConfirm, onClose }: Props) {
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<FileTemplate | null>(FILE_TEMPLATES[0]);
  const [filename, setFilename] = useState(FILE_TEMPLATES[0].filename);
  const filenameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selected) setFilename(selected.filename);
  }, [selected]);

  const filtered = FILE_TEMPLATES.filter((t) => {
    const matchCat = category === "all" || t.category === category;
    const matchQ = !query.trim() || `${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase());
    return matchCat && matchQ;
  });

  const handleConfirm = () => {
    if (!selected || !filename.trim()) return;
    const folder = defaultFolder ? defaultFolder.replace(/[\\/]+$/, "") + "/" : "";
    const path = `${folder}${filename.trim()}`;
    const content = selected.content(filename.trim());
    onConfirm(path, content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleConfirm();
    if (e.key === "Escape") onClose();
  };

  return (
    <div className="ftp-overlay" onMouseDown={onClose}>
      <div className="ftp-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        {/* Header */}
        <div className="ftp-header">
          <span className="ftp-title">New File from Template</span>
          <button className="icon-btn small" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>

        {/* Category filter */}
        <div className="ftp-categories">
          {TEMPLATE_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              className={`ftp-cat-btn ${category === cat.id ? "active" : ""}`}
              onClick={() => setCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="ftp-body">
          {/* Template list */}
          <div className="ftp-list-col">
            <div className="ftp-search-row">
              <Search size={13} className="ftp-search-icon" />
              <input
                className="ftp-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search templates…"
                autoFocus
              />
            </div>
            <div className="ftp-list">
              {filtered.map((t) => (
                <button
                  key={t.id}
                  className={`ftp-item ${selected?.id === t.id ? "active" : ""}`}
                  onClick={() => { setSelected(t); setFilename(t.filename); }}
                >
                  <span className="ftp-item-icon">{t.icon}</span>
                  <span className="ftp-item-info">
                    <span className="ftp-item-name">{t.name}</span>
                    <span className="ftp-item-desc">{t.description}</span>
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="ftp-empty">No templates match "{query}"</div>
              )}
            </div>
          </div>

          {/* Preview col */}
          {selected && (
            <div className="ftp-preview-col">
              <div className="ftp-preview-header">
                <span className="ftp-preview-title">{selected.icon} {selected.name}</span>
                <span className="ftp-preview-lang">{selected.language}</span>
              </div>
              <pre className="ftp-preview-code">
                {selected.content(filename || selected.filename).slice(0, 800)}
              </pre>
            </div>
          )}
        </div>

        {/* Footer — filename input + confirm */}
        <div className="ftp-footer">
          <div className="ftp-filename-row">
            <label className="ftp-filename-label">Filename</label>
            <input
              ref={filenameRef}
              className="ftp-filename-input"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="component.tsx"
              spellCheck={false}
            />
          </div>
          <div className="ftp-footer-actions">
            <button className="btn-secondary compact" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary compact"
              onClick={handleConfirm}
              disabled={!selected || !filename.trim()}
            >
              Create File
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
