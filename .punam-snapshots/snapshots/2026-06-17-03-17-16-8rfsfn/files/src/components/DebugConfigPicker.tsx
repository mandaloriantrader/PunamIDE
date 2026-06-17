import { useState, useRef, useEffect } from "react";
import { ChevronDown, Plus, Settings } from "lucide-react";
import type { DebugLaunchConfig } from "../utils/debugConfig";

interface DebugConfigPickerProps {
  configs: DebugLaunchConfig[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddConfig: () => void;
  onEditConfigs: () => void;
  disabled?: boolean;
}

export default function DebugConfigPicker({
  configs,
  selectedId,
  onSelect,
  onAddConfig,
  onEditConfigs,
  disabled = false,
}: DebugConfigPickerProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const selected = configs.find(c => c.id === selectedId);
  const displayName = selected?.name || (configs.length === 0 ? "No config" : "Select config");

  return (
    <div className="debug-config-picker" ref={dropdownRef}>
      <button
        className="debug-config-picker-btn"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title="Select debug configuration"
      >
        <span className="debug-config-picker-label">{displayName}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="debug-config-picker-dropdown">
          {configs.length === 0 ? (
            <div className="debug-config-picker-empty">
              No configurations found.
              <br />
              <button className="debug-config-picker-action" onClick={() => { onAddConfig(); setOpen(false); }}>
                <Plus size={12} /> Create launch.json
              </button>
            </div>
          ) : (
            <>
              {configs.map(config => (
                <button
                  key={config.id}
                  className={`debug-config-picker-item ${config.id === selectedId ? "active" : ""}`}
                  onClick={() => { onSelect(config.id); setOpen(false); }}
                >
                  <span className="config-type-badge">{config.type}</span>
                  <span className="config-name">{config.name}</span>
                  <span className="config-request">{config.request}</span>
                </button>
              ))}
              <div className="debug-config-picker-divider" />
              <button className="debug-config-picker-action" onClick={() => { onAddConfig(); setOpen(false); }}>
                <Plus size={12} /> Add Configuration
              </button>
              <button className="debug-config-picker-action" onClick={() => { onEditConfigs(); setOpen(false); }}>
                <Settings size={12} /> Edit launch.json
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
