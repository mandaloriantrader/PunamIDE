/**
 * PunamIDE Safe Snapshot / Backup System
 * Full UI: Sidebar button, Snapshot Manager Panel, Restore Preview, Settings
 * Architecture: React + TypeScript-style JSX | Backend: Rust/Tauri (commands below)
 */

import { useState, useEffect, useCallback, useRef } from "react";

// ─── Mock Tauri invoke (replace with: import { invoke } from "@tauri-apps/api/tauri") ───
const invoke = async (cmd, args) => {
  await new Promise(r => setTimeout(r, 600 + Math.random() * 800));
  if (cmd === "list_snapshots") {
    return [
      { name: "before-ai-refactor", createdAt: "2026-05-27T09:15:00Z", files: 342, sizeMB: 12.4, punamVersion: "2.0", id: "snap_001" },
      { name: "before-debugger-integration", createdAt: "2026-05-26T18:42:00Z", files: 318, sizeMB: 11.1, punamVersion: "2.0", id: "snap_002" },
      { name: "before-dependency-update", createdAt: "2026-05-25T14:30:00Z", files: 301, sizeMB: 10.8, punamVersion: "2.0", id: "snap_003" },
      { name: "stable-baseline-v1", createdAt: "2026-05-24T11:00:00Z", files: 289, sizeMB: 9.9, punamVersion: "2.0", id: "snap_004" },
      { name: "before-ui-overhaul", createdAt: "2026-05-23T16:20:00Z", files: 275, sizeMB: 9.2, punamVersion: "2.0", id: "snap_005" },
    ];
  }
  if (cmd === "create_snapshot") {
    return { success: true, snapshotId: `snap_${Date.now()}`, files: 347, sizeMB: 12.7 };
  }
  if (cmd === "get_restore_preview") {
    return {
      modified: ["src/main.rs", "src/editor/mod.rs", "src/debugger.rs", "src/ui/panels.rs"],
      added: ["src/snapshot/manager.rs", "src/snapshot/types.rs"],
      deleted: ["src/old_debugger.rs"],
    };
  }
  if (cmd === "restore_snapshot") return { success: true };
  if (cmd === "export_snapshot_zip") return { success: true, path: "/project/.punam-backups/export.punam" };
  if (cmd === "delete_snapshot") return { success: true };
  return { success: true };
};

// ─── Icons ───────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 18, color = "currentColor" }) => {
  const icons = {
    shield: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>),
    save: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>),
    restore: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>),
    download: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>),
    trash: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>),
    eye: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>),
    close: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>),
    check: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>),
    info: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>),
    warning: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>),
    settings: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>),
    plus: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>),
    cloud: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>),
    file: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>),
    flash: (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>),
  };
  return icons[name] || null;
};

// ─── Utilities ────────────────────────────────────────────────────────────────
const formatDate = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
};
const timeAgo = (iso) => {
  const diff = Date.now() - new Date(iso);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

// ─── Toast System ─────────────────────────────────────────────────────────────
const ToastContainer = ({ toasts, removeToast }) => (
  <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999, display: "flex", flexDirection: "column", gap: 10, pointerEvents: "none" }}>
    {toasts.map(t => (
      <div key={t.id} style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 18px",
        background: t.type === "success" ? "#0f2a1a" : t.type === "error" ? "#2a0f0f" : t.type === "warning" ? "#2a1f0a" : "#0f1a2a",
        border: `1px solid ${t.type === "success" ? "#22c55e40" : t.type === "error" ? "#ef444440" : t.type === "warning" ? "#f59e0b40" : "#3b82f640"}`,
        borderLeft: `3px solid ${t.type === "success" ? "#22c55e" : t.type === "error" ? "#ef4444" : t.type === "warning" ? "#f59e0b" : "#3b82f6"}`,
        borderRadius: 8, color: "#e2e8f0", fontSize: 13, minWidth: 280, maxWidth: 400,
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        animation: "slideInToast 0.3s ease",
        pointerEvents: "all",
      }}>
        <span style={{ color: t.type === "success" ? "#22c55e" : t.type === "error" ? "#ef4444" : t.type === "warning" ? "#f59e0b" : "#3b82f6", flexShrink: 0 }}>
          <Icon name={t.type === "success" ? "check" : t.type === "error" ? "close" : t.type === "warning" ? "warning" : "info"} size={16} color="currentColor" />
        </span>
        <span style={{ flex: 1 }}>{t.message}</span>
        <button onClick={() => removeToast(t.id)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 0, flexShrink: 0 }}>
          <Icon name="close" size={14} color="currentColor" />
        </button>
      </div>
    ))}
  </div>
);

// ─── Progress Bar ─────────────────────────────────────────────────────────────
const ProgressBar = ({ progress, label }) => (
  <div style={{ padding: "16px 20px", background: "#0a1628", borderBottom: "1px solid #1e3a5f" }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12, color: "#7dd3fc" }}>
      <span>{label}</span><span>{progress}%</span>
    </div>
    <div style={{ height: 4, background: "#1e3a5f", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg, #0ea5e9, #22d3ee)", borderRadius: 2, transition: "width 0.2s ease" }} />
    </div>
  </div>
);

// ─── Snapshot Card ────────────────────────────────────────────────────────────
const SnapshotCard = ({ snapshot, onRestore, onPreview, onExport, onDelete, isSelected, onSelect }) => {
  const [hovering, setHovering] = useState(false);
  return (
    <div
      onClick={() => onSelect(snapshot.id)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        padding: "14px 16px", borderRadius: 10, cursor: "pointer",
        background: isSelected ? "#0a1e3d" : hovering ? "#091428" : "#060e1e",
        border: isSelected ? "1px solid #1d4ed8" : "1px solid #0f1e35",
        transition: "all 0.15s ease", marginBottom: 8, position: "relative",
      }}
    >
      {/* Name + time */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#22d3ee", fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
            {snapshot.name}
          </span>
        </div>
        <span style={{ fontSize: 11, color: "#475569", background: "#0f1e35", padding: "2px 8px", borderRadius: 4 }}>
          {timeAgo(snapshot.createdAt)}
        </span>
      </div>

      {/* Meta row */}
      <div style={{ display: "flex", gap: 16, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "#64748b" }}>📁 {snapshot.files} files</span>
        <span style={{ fontSize: 11, color: "#64748b" }}>💾 {snapshot.sizeMB} MB</span>
        <span style={{ fontSize: 11, color: "#64748b" }}>🕐 {formatDate(snapshot.createdAt)}</span>
      </div>

      {/* Actions (visible on hover/select) */}
      <div style={{
        display: "flex", gap: 6,
        opacity: hovering || isSelected ? 1 : 0,
        transition: "opacity 0.15s",
      }}>
        <ActionBtn icon="restore" label="Quick Restore" color="#22c55e" onClick={e => { e.stopPropagation(); onRestore(snapshot); }} />
        <ActionBtn icon="eye" label="Preview" color="#7dd3fc" onClick={e => { e.stopPropagation(); onPreview(snapshot); }} />
        <ActionBtn icon="download" label="Export .punam" color="#a78bfa" onClick={e => { e.stopPropagation(); onExport(snapshot); }} />
        <ActionBtn icon="trash" label="Delete" color="#f87171" onClick={e => { e.stopPropagation(); onDelete(snapshot); }} />
      </div>
    </div>
  );
};

const ActionBtn = ({ icon, label, color, onClick }) => {
  const [hover, setHover] = useState(false);
  return (
    <button
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
        background: hover ? `${color}18` : "transparent",
        border: `1px solid ${hover ? color + "50" : "#1e3a5f"}`,
        borderRadius: 6, cursor: "pointer", color: hover ? color : "#475569",
        fontSize: 11, transition: "all 0.12s ease",
      }}
    >
      <Icon name={icon} size={12} color="currentColor" /> {label}
    </button>
  );
};

// ─── Restore Preview Modal ─────────────────────────────────────────────────────
const RestorePreviewModal = ({ snapshot, preview, onConfirm, onCancel, confirming }) => {
  const total = (preview?.modified?.length || 0) + (preview?.added?.length || 0) + (preview?.deleted?.length || 0);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }}>
      <div style={{ background: "#060e1e", border: "1px solid #1d4ed8", borderRadius: 14, width: 580, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 32px 80px rgba(0,0,0,0.7)" }}>
        {/* Header */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #0f1e35", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="eye" size={18} color="#7dd3fc" /> Restore Preview
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 3 }}>
              Snapshot: <span style={{ color: "#22d3ee", fontFamily: "monospace" }}>{snapshot.name}</span>
            </div>
          </div>
          <button onClick={onCancel} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}>
            <Icon name="close" size={18} color="currentColor" />
          </button>
        </div>

        {/* Safety notice */}
        <div style={{ margin: "16px 24px 0", padding: "10px 14px", background: "#1c1500", border: "1px solid #f59e0b30", borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Icon name="warning" size={14} color="#f59e0b" />
          <div style={{ fontSize: 12, color: "#fbbf24", lineHeight: 1.5 }}>
            <strong>Safe Restore:</strong> node_modules, target/, .git, and caches will NOT be touched. Only source and config files will be restored.
          </div>
        </div>

        {/* Summary */}
        <div style={{ display: "flex", gap: 12, padding: "16px 24px 0" }}>
          <StatChip label="Modified" count={preview?.modified?.length || 0} color="#f59e0b" />
          <StatChip label="Added" count={preview?.added?.length || 0} color="#22c55e" />
          <StatChip label="Deleted" count={preview?.deleted?.length || 0} color="#ef4444" />
          <StatChip label="Total" count={total} color="#7dd3fc" />
        </div>

        {/* File lists */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px" }}>
          <FileList files={preview?.modified || []} label="Modified Files" color="#f59e0b" prefix="~" />
          <FileList files={preview?.added || []} label="Added Files" color="#22c55e" prefix="+" />
          <FileList files={preview?.deleted || []} label="Deleted Files" color="#ef4444" prefix="-" />
        </div>

        {/* Actions */}
        <div style={{ padding: "16px 24px", borderTop: "1px solid #0f1e35", display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{ padding: "9px 20px", background: "transparent", border: "1px solid #1e3a5f", borderRadius: 8, color: "#94a3b8", cursor: "pointer", fontSize: 13 }}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming}
            style={{ padding: "9px 22px", background: confirming ? "#15803d80" : "#15803d", border: "1px solid #16a34a", borderRadius: 8, color: "#fff", cursor: confirming ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            {confirming ? (<><Spinner /> Restoring...</>) : (<><Icon name="restore" size={14} color="currentColor" /> Confirm Restore</>)}
          </button>
        </div>
      </div>
    </div>
  );
};

const StatChip = ({ label, count, color }) => (
  <div style={{ flex: 1, background: "#0a1628", border: `1px solid ${color}20`, borderRadius: 8, padding: "8px 12px", textAlign: "center" }}>
    <div style={{ fontSize: 18, fontWeight: 700, color }}>{count}</div>
    <div style={{ fontSize: 11, color: "#64748b" }}>{label}</div>
  </div>
);

const FileList = ({ files, label, color, prefix }) => {
  if (!files.length) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ background: `${color}20`, padding: "1px 7px", borderRadius: 4 }}>{prefix}</span> {label}
      </div>
      {files.map((f, i) => (
        <div key={i} style={{ fontSize: 12, color: "#94a3b8", padding: "3px 0 3px 12px", fontFamily: "monospace", borderLeft: `2px solid ${color}30` }}>
          {f}
        </div>
      ))}
    </div>
  );
};

// ─── Create Snapshot Modal ─────────────────────────────────────────────────────
const CreateSnapshotModal = ({ onConfirm, onCancel, creating, progress }) => {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("manual");
  const reasons = [
    { value: "manual", label: "Manual Backup" },
    { value: "before-ai-edit", label: "Before AI Edit" },
    { value: "before-debugger", label: "Before Debugger Integration" },
    { value: "before-refactor", label: "Before Bulk Refactor" },
    { value: "before-deps", label: "Before Dependency Install" },
    { value: "stable-checkpoint", label: "Stable Checkpoint" },
  ];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }}>
      <div style={{ background: "#060e1e", border: "1px solid #1d4ed8", borderRadius: 14, width: 480, boxShadow: "0 32px 80px rgba(0,0,0,0.7)", overflow: "hidden" }}>
        {creating && <ProgressBar progress={progress} label="Creating snapshot..." />}
        <div style={{ padding: "24px" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#e2e8f0", display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <span style={{ background: "#1d4ed820", padding: 8, borderRadius: 8 }}><Icon name="shield" size={18} color="#7dd3fc" /></span>
            Create Snapshot
          </div>

          <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 6 }}>Snapshot Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. before-ai-refactor"
            style={{ width: "100%", background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 8, padding: "9px 12px", color: "#e2e8f0", fontSize: 13, fontFamily: "monospace", outline: "none", boxSizing: "border-box", marginBottom: 14 }}
          />

          <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 6 }}>Reason</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
            {reasons.map(r => (
              <button key={r.value} onClick={() => setReason(r.value)} style={{
                padding: "8px 12px", background: reason === r.value ? "#0f2a4a" : "#0a1628",
                border: `1px solid ${reason === r.value ? "#1d4ed8" : "#1e3a5f"}`,
                borderRadius: 8, color: reason === r.value ? "#7dd3fc" : "#475569",
                cursor: "pointer", fontSize: 12, textAlign: "left", transition: "all 0.12s",
              }}>
                {r.label}
              </button>
            ))}
          </div>

          {/* What's included */}
          <div style={{ background: "#0a1628", border: "1px solid #0f1e35", borderRadius: 8, padding: "12px 14px", marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: "#22c55e", fontWeight: 600, marginBottom: 6 }}>✓ Included</div>
            <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.8 }}>src/ · src-tauri/src/ · package.json · Cargo.toml · configs · styles · assets · templates</div>
            <div style={{ fontSize: 11, color: "#ef4444", fontWeight: 600, margin: "8px 0 4px" }}>✗ Excluded</div>
            <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.8 }}>node_modules/ · target/ · dist/ · .git/ · logs/ · caches</div>
          </div>

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={onCancel} disabled={creating} style={{ padding: "9px 20px", background: "transparent", border: "1px solid #1e3a5f", borderRadius: 8, color: "#94a3b8", cursor: "pointer", fontSize: 13 }}>
              Cancel
            </button>
            <button
              onClick={() => onConfirm(name || reason, reason)}
              disabled={creating}
              style={{ padding: "9px 22px", background: creating ? "#1d4ed840" : "linear-gradient(135deg, #1d4ed8, #0ea5e9)", border: "none", borderRadius: 8, color: "#fff", cursor: creating ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              {creating ? (<><Spinner /> Creating...</>) : (<><Icon name="shield" size={14} color="currentColor" /> Create Snapshot</>)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Settings Panel ───────────────────────────────────────────────────────────
const SettingsPanel = ({ settings, onChange, onClose }) => (
  <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 320, background: "#060e1e", borderLeft: "1px solid #0f1e35", zIndex: 100, display: "flex", flexDirection: "column", boxShadow: "-10px 0 40px rgba(0,0,0,0.5)" }}>
    <div style={{ padding: "20px", borderBottom: "1px solid #0f1e35", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="settings" size={16} color="#7dd3fc" /> Settings
      </div>
      <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icon name="close" size={16} color="currentColor" /></button>
    </div>
    <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
      <SettingsSection title="Auto Snapshot Triggers">
        <Toggle label="Before AI agent file edits" value={settings.autoBeforeAI} onChange={v => onChange("autoBeforeAI", v)} />
        <Toggle label="Before debugger integration" value={settings.autoBeforeDebugger} onChange={v => onChange("autoBeforeDebugger", v)} />
        <Toggle label="Before dependency install" value={settings.autoBeforeDeps} onChange={v => onChange("autoBeforeDeps", v)} />
        <Toggle label="Before bulk refactors" value={settings.autoBeforeRefactor} onChange={v => onChange("autoBeforeRefactor", v)} />
      </SettingsSection>
      <SettingsSection title="Retention Policy">
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>Keep latest snapshots</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input type="range" min={5} max={50} value={settings.retentionCount} onChange={e => onChange("retentionCount", parseInt(e.target.value))} style={{ flex: 1, accentColor: "#1d4ed8" }} />
          <span style={{ fontSize: 13, color: "#7dd3fc", fontWeight: 700, minWidth: 24 }}>{settings.retentionCount}</span>
        </div>
        <div style={{ fontSize: 11, color: "#475569", marginTop: 4 }}>Older snapshots auto-deleted when limit exceeded</div>
      </SettingsSection>
      <SettingsSection title="Export Format">
        <Toggle label="Use .punam extension (custom ZIP)" value={settings.usePunamExt} onChange={v => onChange("usePunamExt", v)} />
        <Toggle label="Compress with max ratio" value={settings.maxCompress} onChange={v => onChange("maxCompress", v)} />
      </SettingsSection>
      <SettingsSection title="Cloud Backup (Coming Soon)">
        {["GitHub Sync", "Google Drive", "Dropbox", "OneDrive"].map(c => (
          <div key={c} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", opacity: 0.4 }}>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>{c}</span>
            <span style={{ fontSize: 10, color: "#475569", background: "#0f1e35", padding: "2px 8px", borderRadius: 4 }}>Soon</span>
          </div>
        ))}
      </SettingsSection>
    </div>
  </div>
);

const SettingsSection = ({ title, children }) => (
  <div style={{ marginBottom: 24 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12, paddingBottom: 6, borderBottom: "1px solid #0f1e35" }}>{title}</div>
    {children}
  </div>
);

const Toggle = ({ label, value, onChange }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0" }}>
    <span style={{ fontSize: 12, color: "#94a3b8" }}>{label}</span>
    <button onClick={() => onChange(!value)} style={{
      width: 40, height: 22, borderRadius: 11, background: value ? "#1d4ed8" : "#1e3a5f",
      border: "none", cursor: "pointer", position: "relative", transition: "background 0.2s",
    }}>
      <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: value ? 21 : 3, transition: "left 0.2s" }} />
    </button>
  </div>
);

const Spinner = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

// ─── MAIN SNAPSHOT MANAGER ────────────────────────────────────────────────────
export default function SnapshotManager() {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createProgress, setCreateProgress] = useState(0);
  const [previewModal, setPreviewModal] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [filter, setFilter] = useState("");
  const [settings, setSettings] = useState({
    autoBeforeAI: true, autoBeforeDebugger: true, autoBeforeDeps: false, autoBeforeRefactor: true,
    retentionCount: 20, usePunamExt: true, maxCompress: false,
  });
  const toastId = useRef(0);

  const addToast = useCallback((message, type = "info") => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500);
  }, []);

  const removeToast = useCallback((id) => setToasts(t => t.filter(x => x.id !== id)), []);

  const loadSnapshots = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke("list_snapshots");
      setSnapshots(list);
    } catch { addToast("Failed to load snapshots", "error"); }
    finally { setLoading(false); }
  }, [addToast]);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  const handleCreate = async (name, reason) => {
    setCreating(true);
    setCreateProgress(0);
    const interval = setInterval(() => setCreateProgress(p => Math.min(p + 12, 92)), 150);
    try {
      const result = await invoke("create_snapshot", { name, reason });
      clearInterval(interval);
      setCreateProgress(100);
      setTimeout(async () => {
        setShowCreate(false);
        setCreating(false);
        setCreateProgress(0);
        await loadSnapshots();
        addToast(`Snapshot "${name}" created — ${result.files} files, ${result.sizeMB} MB`, "success");
      }, 300);
    } catch {
      clearInterval(interval);
      setCreating(false);
      addToast("Failed to create snapshot", "error");
    }
  };

  const handlePreview = async (snapshot) => {
    setPreviewModal(snapshot);
    setLoadingPreview(true);
    try {
      const data = await invoke("get_restore_preview", { snapshotId: snapshot.id });
      setPreviewData(data);
    } catch { addToast("Failed to load preview", "error"); }
    finally { setLoadingPreview(false); }
  };

  const handleRestore = async (snapshot) => {
    // Direct quick restore
    setPreviewModal(snapshot);
    setLoadingPreview(true);
    try {
      const data = await invoke("get_restore_preview", { snapshotId: snapshot.id });
      setPreviewData(data);
    } catch { addToast("Failed to load preview", "error"); }
    finally { setLoadingPreview(false); }
  };

  const confirmRestore = async () => {
    if (!previewModal) return;
    setConfirming(true);
    try {
      await invoke("restore_snapshot", { snapshotId: previewModal.id });
      setPreviewModal(null);
      setPreviewData(null);
      addToast(`Restored to "${previewModal.name}" successfully`, "success");
    } catch {
      addToast("Restore failed — your project is unchanged", "error");
    } finally { setConfirming(false); }
  };

  const handleExport = async (snapshot) => {
    try {
      const result = await invoke("export_snapshot_zip", { snapshotId: snapshot.id });
      addToast(`Exported to ${result.path}`, "success");
    } catch { addToast("Export failed", "error"); }
  };

  const handleDelete = async (snapshot) => {
    if (!window.confirm(`Delete snapshot "${snapshot.name}"? This cannot be undone.`)) return;
    try {
      await invoke("delete_snapshot", { snapshotId: snapshot.id });
      setSnapshots(s => s.filter(x => x.id !== snapshot.id));
      addToast(`Snapshot "${snapshot.name}" deleted`, "info");
    } catch { addToast("Delete failed", "error"); }
  };

  const filtered = snapshots.filter(s => s.name.toLowerCase().includes(filter.toLowerCase()));
  const totalSize = snapshots.reduce((a, s) => a + s.sizeMB, 0).toFixed(1);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Sora:wght@300;400;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #03080f; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e3a5f; border-radius: 2px; }
        @keyframes slideInToast { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>

      {/* ── LAYOUT WRAPPER ── */}
      <div style={{ display: "flex", height: "100vh", background: "#03080f", fontFamily: "'Sora', sans-serif", color: "#e2e8f0", overflow: "hidden" }}>

        {/* ── SIDEBAR ACTIVITY BAR ── */}
        <div style={{ width: 52, background: "#060e1e", borderRight: "1px solid #0f1e35", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 16, gap: 4, flexShrink: 0 }}>
          {/* Other IDE icons (decorative) */}
          {["file", "restore", "settings"].map((ic, i) => (
            <button key={i} title={ic} style={{ width: 36, height: 36, background: "transparent", border: "none", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#334155", opacity: 0.5 }}>
              <Icon name={ic} size={18} color="currentColor" />
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {/* SNAPSHOT BUTTON — highlighted as active */}
          <div style={{ position: "relative" }}>
            <button
              title="Create Snapshot Backup"
              onClick={() => setShowCreate(true)}
              style={{ width: 36, height: 36, background: "linear-gradient(135deg, #1d4ed820, #0ea5e920)", border: "1px solid #1d4ed850", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#7dd3fc", marginBottom: 4 }}
            >
              <Icon name="shield" size={18} color="currentColor" />
            </button>
          </div>
          <div style={{ height: 16 }} />
        </div>

        {/* ── MAIN PANEL ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>

          {/* Header */}
          <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid #0f1e35", background: "#060e1e", flexShrink: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <div style={{ background: "linear-gradient(135deg, #1d4ed830, #0ea5e930)", padding: 8, borderRadius: 10, border: "1px solid #1d4ed840" }}>
                    <Icon name="shield" size={20} color="#7dd3fc" />
                  </div>
                  <div>
                    <h1 style={{ fontSize: 17, fontWeight: 700, color: "#e2e8f0", lineHeight: 1 }}>Snapshot Manager</h1>
                    <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>Fearless AI experimentation — recovery is one click away</div>
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={() => setShowSettings(s => !s)}
                  style={{ width: 34, height: 34, background: showSettings ? "#1e3a5f" : "transparent", border: "1px solid #1e3a5f", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#64748b" }}>
                  <Icon name="settings" size={16} color="currentColor" />
                </button>
                <button
                  onClick={() => setShowCreate(true)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", background: "linear-gradient(135deg, #1d4ed8, #0ea5e9)", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  <Icon name="plus" size={14} color="currentColor" /> New Snapshot
                </button>
              </div>
            </div>

            {/* Stats bar */}
            <div style={{ display: "flex", gap: 20, marginTop: 16 }}>
              <StatPill label="Total Snapshots" value={snapshots.length} cap={`/${settings.retentionCount}`} />
              <StatPill label="Storage Used" value={`${totalSize} MB`} />
              <StatPill label="Auto Triggers" value={[settings.autoBeforeAI, settings.autoBeforeDebugger, settings.autoBeforeDeps, settings.autoBeforeRefactor].filter(Boolean).length} cap="/4 active" color="#22c55e" />
            </div>
          </div>

          {/* Filter */}
          <div style={{ padding: "12px 24px", borderBottom: "1px solid #0f1e35", background: "#060e1e", flexShrink: 0 }}>
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter snapshots..."
              style={{ width: "100%", background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 8, padding: "8px 12px", color: "#e2e8f0", fontSize: 13, outline: "none" }}
            />
          </div>

          {/* Snapshot List */}
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px" }}>
            {loading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[1, 2, 3].map(i => (
                  <div key={i} style={{ height: 90, background: "#060e1e", border: "1px solid #0f1e35", borderRadius: 10, animation: "pulse 1.5s ease infinite" }} />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#334155" }}>
                <Icon name="shield" size={40} color="currentColor" />
                <div style={{ fontSize: 14, marginTop: 12 }}>No snapshots yet</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>Create your first snapshot before a risky AI edit</div>
                <button onClick={() => setShowCreate(true)} style={{ marginTop: 16, padding: "9px 20px", background: "#1d4ed8", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", fontSize: 13 }}>
                  Create First Snapshot
                </button>
              </div>
            ) : (
              <div style={{ animation: "fadeIn 0.3s ease" }}>
                {filtered.map(snap => (
                  <SnapshotCard
                    key={snap.id}
                    snapshot={snap}
                    isSelected={selectedId === snap.id}
                    onSelect={setSelectedId}
                    onRestore={handleRestore}
                    onPreview={handlePreview}
                    onExport={handleExport}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Bottom Quick-Action Bar */}
          <div style={{ padding: "12px 24px", borderTop: "1px solid #0f1e35", background: "#060e1e", display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
            <Icon name="flash" size={14} color="#f59e0b" />
            <span style={{ fontSize: 11, color: "#475569" }}>Quick actions:</span>
            {["Before AI Edit", "Before Debugger", "Stable Checkpoint"].map(label => (
              <button key={label} onClick={() => handleCreate(label.toLowerCase().replace(/ /g, "-"), label)}
                style={{ padding: "5px 12px", background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 6, color: "#64748b", cursor: "pointer", fontSize: 11, transition: "all 0.12s" }}>
                {label}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "#334155" }}>PunamIDE v2.0</span>
          </div>

          {/* Settings overlay */}
          {showSettings && (
            <SettingsPanel settings={settings} onChange={(k, v) => setSettings(s => ({ ...s, [k]: v }))} onClose={() => setShowSettings(false)} />
          )}
        </div>
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateSnapshotModal
          onConfirm={handleCreate}
          onCancel={() => !creating && setShowCreate(false)}
          creating={creating}
          progress={createProgress}
        />
      )}
      {previewModal && (
        <RestorePreviewModal
          snapshot={previewModal}
          preview={loadingPreview ? null : previewData}
          onConfirm={confirmRestore}
          onCancel={() => !confirming && (setPreviewModal(null), setPreviewData(null))}
          confirming={confirming}
        />
      )}

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </>
  );
}

function StatPill({ label, value, cap = "", color = "#7dd3fc" }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 18, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
      {cap && <span style={{ fontSize: 11, color: "#475569" }}>{cap}</span>}
      <span style={{ fontSize: 11, color: "#334155" }}>{label}</span>
    </div>
  );
}
