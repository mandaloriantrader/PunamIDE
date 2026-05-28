/**
 * NotepadsPanel — Multi-notepad system with create, edit, pin, and delete.
 * Each notepad is stored per-project in localStorage.
 * Ported from Zenith IDE's multi-notepad feature, adapted for Punam IDE.
 */

import { useState, useEffect } from "react";
import { Plus, Pin, Trash2, StickyNote, ArrowLeft } from "lucide-react";
import { generateId } from "../utils/ids";

interface Notepad {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
}

interface Props {
  projectPath: string;
  onClose: () => void;
}

const STORAGE_KEY_PREFIX = "punam-notepads:";

function getStorageKey(projectPath: string) {
  return STORAGE_KEY_PREFIX + projectPath.replace(/\\/g, "/").toLowerCase();
}

function loadNotepads(projectPath: string): Notepad[] {
  try {
    const raw = localStorage.getItem(getStorageKey(projectPath));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveNotepads(projectPath: string, notepads: Notepad[]) {
  try {
    localStorage.setItem(getStorageKey(projectPath), JSON.stringify(notepads));
  } catch { /* storage full */ }
}

export default function NotepadsPanel({ projectPath, onClose: _onClose }: Props) {
  const [notepads, setNotepads] = useState<Notepad[]>(() => loadNotepads(projectPath));
  const [activeNotepadId, setActiveNotepadId] = useState<string>("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  // Persist on every change
  useEffect(() => {
    saveNotepads(projectPath, notepads);
  }, [notepads, projectPath]);

  // Reload when project changes
  useEffect(() => {
    setNotepads(loadNotepads(projectPath));
    setActiveNotepadId("");
  }, [projectPath]);

  const activeNotepad = notepads.find((n) => n.id === activeNotepadId);

  const handleNew = () => {
    const notepad: Notepad = {
      id: generateId("notepad"),
      title: `Note ${notepads.length + 1}`,
      content: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
    };
    setNotepads((prev) => [...prev, notepad]);
    setActiveNotepadId(notepad.id);
  };

  const updateNotepad = (id: string, update: Partial<Notepad>) => {
    setNotepads((prev) =>
      prev.map((n) => (n.id === id ? { ...n, ...update } : n))
    );
  };

  const deleteNotepad = (id: string) => {
    setNotepads((prev) => prev.filter((n) => n.id !== id));
    if (activeNotepadId === id) setActiveNotepadId("");
    setContextMenu(null);
  };

  const renameNotepad = (id: string) => {
    const notepad = notepads.find((n) => n.id === id);
    if (!notepad) return;
    const title = window.prompt("Rename notepad", notepad.title)?.trim();
    if (title) updateNotepad(id, { title, updatedAt: Date.now() });
    setContextMenu(null);
  };

  const sorted = [...notepads].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  return (
    <div className="notepads-panel">
      <div className="notepads-header">
        <StickyNote size={16} />
        <span>NOTEPADS</span>
        <div className="notepads-header-actions">
          <button className="notepads-add-btn" onClick={handleNew} title="New Notepad">
            <Plus size={14} />
          </button>
        </div>
      </div>

      {!activeNotepad ? (
        <div className="notepads-list">
          {sorted.map((n) => (
            <div
              key={n.id}
              className="notepad-list-item"
              onClick={() => setActiveNotepadId(n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, id: n.id });
              }}
            >
              <div className="notepad-list-item-header">
                {n.pinned && <Pin size={12} className="notepad-pin-icon" />}
                <span className="notepad-list-title">{n.title}</span>
              </div>
              <span className="notepad-list-preview">
                {n.content.slice(0, 60) || "Empty note"}
              </span>
              <span className="notepad-list-date">
                {new Date(n.updatedAt).toLocaleDateString()}
              </span>
            </div>
          ))}
          {notepads.length === 0 && (
            <div className="notepads-empty">
              <StickyNote size={24} />
              <p>No notepads yet</p>
              <button className="notepads-create-btn" onClick={handleNew}>
                Create one
              </button>
            </div>
          )}
          {contextMenu && (() => {
            const target = notepads.find((n) => n.id === contextMenu.id);
            if (!target) return null;
            return (
              <div
                className="context-menu notepad-context-menu"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onMouseLeave={() => setContextMenu(null)}
              >
                <button type="button" onClick={() => renameNotepad(target.id)}>Rename</button>
                <button
                  type="button"
                  onClick={() => {
                    updateNotepad(target.id, { pinned: !target.pinned, updatedAt: Date.now() });
                    setContextMenu(null);
                  }}
                >
                  {target.pinned ? "Unpin" : "Pin"}
                </button>
                <button type="button" onClick={() => deleteNotepad(target.id)}>Delete</button>
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="notepad-editor">
          <div className="notepad-editor-header">
            <button
              className="notepad-back-btn"
              onClick={() => setActiveNotepadId("")}
              title="Back to list"
            >
              <ArrowLeft size={14} /> Back
            </button>
            <input
              className="notepad-title-input"
              value={activeNotepad.title}
              onChange={(e) =>
                updateNotepad(activeNotepad.id, { title: e.target.value, updatedAt: Date.now() })
              }
              placeholder="Note title..."
            />
            <div className="notepad-editor-actions">
              <button
                className={`notepad-action-btn ${activeNotepad.pinned ? "active" : ""}`}
                onClick={() =>
                  updateNotepad(activeNotepad.id, { pinned: !activeNotepad.pinned })
                }
                title={activeNotepad.pinned ? "Unpin" : "Pin"}
              >
                <Pin size={14} />
              </button>
              <button
                className="notepad-action-btn danger"
                onClick={() => {
                  deleteNotepad(activeNotepad.id);
                }}
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          <textarea
            className="notepad-content-area"
            value={activeNotepad.content}
            onChange={(e) =>
              updateNotepad(activeNotepad.id, { content: e.target.value, updatedAt: Date.now() })
            }
            placeholder="Write notes here... You can reference these in chat with @notepad"
            spellCheck={false}
          />
          <div className="notepad-editor-footer">
            <span>{activeNotepad.content.split("\n").length} lines</span>
            <span>{activeNotepad.content.length} chars</span>
            <span>Last edited: {new Date(activeNotepad.updatedAt).toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}
