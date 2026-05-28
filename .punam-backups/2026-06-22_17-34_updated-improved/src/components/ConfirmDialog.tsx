/**
 * ConfirmDialog — Native-feeling modal for unsaved changes confirmation.
 * Replaces window.prompt() with a proper UI dialog.
 */

import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  title: string;
  message: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, message, onSave, onDiscard, onCancel }: Props) {
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    saveRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onSave();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onSave, onCancel]);

  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-header">
          <AlertTriangle size={18} className="confirm-icon" />
          <span>{title}</span>
        </div>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button ref={saveRef} className="confirm-btn primary" onClick={onSave}>
            Save
          </button>
          <button className="confirm-btn danger" onClick={onDiscard}>
            Don't Save
          </button>
          <button className="confirm-btn secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
