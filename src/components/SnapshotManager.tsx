import { useState, useEffect, useCallback } from "react";
import { Shield, RotateCcw, Download, Trash2, Eye, X, Plus, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SnapshotManifest {
  id: string;
  name: string;
  createdAt: string;
  files: number;
  sizeMB: number;
  punamVersion: string;
  reason: string;
}

interface RestorePreview {
  modified: string[];
  added: string[];
  deleted: string[];
}

interface CreateResult {
  success: boolean;
  snapshotId: string;
  files: number;
  sizeMB: number;
}

interface ExportResult {
  success: boolean;
  path: string;
}

interface Props {
  projectPath: string;
  onClose: () => void;
  showToast: (message: string, type: "info" | "success" | "error" | "warning") => void;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function SnapshotManager({ projectPath, onClose, showToast }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [previewSnapshot, setPreviewSnapshot] = useState<SnapshotManifest | null>(null);
  const [previewData, setPreviewData] = useState<RestorePreview | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [lastExportPath, setLastExportPath] = useState("");
  const [filter, setFilter] = useState("");

  const loadSnapshots = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<SnapshotManifest[]>("list_snapshots", { projectRoot: projectPath });
      setSnapshots(list);
    } catch (err) {
      showToast(`Failed to load snapshots: ${err}`, "error");
    } finally {
      setLoading(false);
    }
  }, [projectPath, showToast]);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  const handleCreate = async (name: string, reason: string) => {
    setCreating(true);
    try {
      const result = await invoke<CreateResult>("create_snapshot", {
        projectRoot: projectPath, name, reason,
      });
      setShowCreate(false);
      await loadSnapshots();
      showToast(`Snapshot "${name}" created — ${result.files} files, ${result.sizeMB} MB`, "success");
    } catch (err) {
      showToast(`Failed to create snapshot: ${err}`, "error");
    } finally {
      setCreating(false);
    }
  };

  const handlePreview = async (snapshot: SnapshotManifest) => {
    try {
      const data = await invoke<RestorePreview>("get_restore_preview", {
        projectRoot: projectPath, snapshotId: snapshot.id,
      });
      setPreviewSnapshot(snapshot);
      setPreviewData(data);
    } catch (err) {
      showToast(`Failed to load preview: ${err}`, "error");
    }
  };

  const handleRestore = async () => {
    if (!previewSnapshot) return;
    setRestoring(true);
    try {
      await invoke<boolean>("restore_snapshot", {
        projectRoot: projectPath, snapshotId: previewSnapshot.id,
      });
      showToast(`Restored to "${previewSnapshot.name}" successfully`, "success");
      setPreviewSnapshot(null);
      setPreviewData(null);
    } catch (err) {
      showToast(`Restore failed: ${err}`, "error");
    } finally {
      setRestoring(false);
    }
  };

  const handleExport = async (snapshot: SnapshotManifest) => {
    const defaultName = `${safeFileName(snapshot.name || snapshot.id)}.punam`;
    const exportPath = await save({
      title: "Export Punam snapshot",
      defaultPath: defaultName,
      filters: [{ name: "Punam Snapshot", extensions: ["punam"] }],
    });

    if (!exportPath) return;

    setExportingId(snapshot.id);
    try {
      const result = await invoke<ExportResult>("export_snapshot_zip", {
        projectRoot: projectPath,
        snapshotId: snapshot.id,
        exportPath,
      });
      setLastExportPath(result.path);
      showToast(`Exported snapshot to ${result.path}`, "success");
    } catch (err) {
      showToast(`Export failed: ${err}`, "error");
    } finally {
      setExportingId(null);
    }
  };

  const handleDelete = async (snapshot: SnapshotManifest) => {
    if (!confirm(`Delete snapshot "${snapshot.name}"? This cannot be undone.`)) return;
    try {
      await invoke<boolean>("delete_snapshot", {
        projectRoot: projectPath, snapshotId: snapshot.id,
      });
      await loadSnapshots();
      showToast(`Deleted "${snapshot.name}"`, "info");
    } catch (err) {
      showToast(`Delete failed: ${err}`, "error");
    }
  };

  const filtered = snapshots.filter(s =>
    !filter || s.name.toLowerCase().includes(filter.toLowerCase())
  );

  const timeAgo = (iso: string) => {
    const diff = Date.now() - parseInt(iso) * 1000;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const safeFileName = (value: string) =>
    value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "punam-snapshot";

  return (
    <div className="snapshot-manager">
      {/* Header */}
      <div className="snapshot-header">
        <div className="snapshot-title">
          <Shield size={14} />
          <span>SNAPSHOTS</span>
          <span className="snapshot-count">{snapshots.length}</span>
        </div>
        <div className="snapshot-header-actions">
          <button className="icon-btn" onClick={() => setShowCreate(true)} title="Create Snapshot">
            <Plus size={14} />
          </button>
          <button className="icon-btn" onClick={loadSnapshots} title="Refresh">
            <RotateCcw size={13} />
          </button>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Quick Create */}
      <div className="snapshot-quick-create">
        <button
          className="snapshot-create-btn"
          onClick={() => setShowCreate(true)}
          disabled={creating}
        >
          <Shield size={13} />
          {creating ? "Creating..." : "Create Snapshot"}
        </button>
      </div>

      <div className="snapshot-export-note">
        <FolderOpen size={12} />
        <span>
          {lastExportPath ? `Last export: ${lastExportPath}` : "Export asks where to save the .punam file."}
        </span>
      </div>

      {/* Filter */}
      {snapshots.length > 3 && (
        <div className="snapshot-filter">
          <input
            type="text"
            placeholder="Filter snapshots..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      {/* List */}
      <div className="snapshot-list">
        {loading ? (
          <p className="snapshot-empty">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="snapshot-empty">
            {snapshots.length === 0
              ? "No snapshots yet. Create one before making risky changes."
              : "No matching snapshots."}
          </p>
        ) : (
          filtered.map(snap => (
            <div key={snap.id} className="snapshot-card">
              <div className="snapshot-card-header">
                <span className="snapshot-card-name">{snap.name}</span>
                <span className="snapshot-card-time">{timeAgo(snap.createdAt)}</span>
              </div>
              <div className="snapshot-card-meta">
                <span>📁 {snap.files} files</span>
                <span>💾 {snap.sizeMB} MB</span>
              </div>
              <div className="snapshot-card-actions">
                <button onClick={() => handlePreview(snap)} title="Preview & Restore">
                  <Eye size={11} /> Restore
                </button>
                <button
                  onClick={() => handleExport(snap)}
                  title="Choose where to save this .punam snapshot archive"
                  disabled={exportingId === snap.id}
                >
                  <Download size={11} /> {exportingId === snap.id ? "Exporting..." : "Export"}
                </button>
                <button onClick={() => handleDelete(snap)} title="Delete" className="snapshot-delete-btn">
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <CreateModal
          onConfirm={handleCreate}
          onCancel={() => setShowCreate(false)}
          creating={creating}
        />
      )}

      {/* Restore Preview Modal */}
      {previewSnapshot && previewData && (
        <RestorePreviewModal
          snapshot={previewSnapshot}
          preview={previewData}
          onConfirm={handleRestore}
          onCancel={() => { setPreviewSnapshot(null); setPreviewData(null); }}
          restoring={restoring}
        />
      )}
    </div>
  );
}

// ─── Create Modal ────────────────────────────────────────────────────────────

function CreateModal({ onConfirm, onCancel, creating }: {
  onConfirm: (name: string, reason: string) => void;
  onCancel: () => void;
  creating: boolean;
}) {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("manual");

  const reasons = [
    { value: "manual", label: "Manual Backup" },
    { value: "before-ai-edit", label: "Before AI Edit" },
    { value: "before-debugger", label: "Before Debugger" },
    { value: "before-refactor", label: "Before Refactor" },
    { value: "before-deps", label: "Before Deps Install" },
    { value: "stable-checkpoint", label: "Stable Checkpoint" },
  ];

  return (
    <div className="snapshot-modal-overlay" onClick={onCancel}>
      <div className="snapshot-modal" onClick={e => e.stopPropagation()}>
        <div className="snapshot-modal-header">
          <Shield size={16} />
          <span>Create Snapshot</span>
          <button className="icon-btn" onClick={onCancel}><X size={14} /></button>
        </div>
        <div className="snapshot-modal-body">
          <label>Snapshot Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. before-ai-refactor"
            autoFocus
          />
          <label>Reason</label>
          <div className="snapshot-reason-grid">
            {reasons.map(r => (
              <button
                key={r.value}
                className={`snapshot-reason-btn ${reason === r.value ? "active" : ""}`}
                onClick={() => setReason(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="snapshot-includes-info">
            <div className="includes">✓ src/ · src-tauri/src/ · configs · styles · assets</div>
            <div className="excludes">✗ node_modules/ · target/ · dist/ · .git/</div>
          </div>
        </div>
        <div className="snapshot-modal-footer">
          <button className="btn-secondary" onClick={onCancel} disabled={creating}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => onConfirm(name || reason, reason)}
            disabled={creating}
          >
            <Shield size={13} />
            {creating ? "Creating..." : "Create Snapshot"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Restore Preview Modal ───────────────────────────────────────────────────

function RestorePreviewModal({ snapshot, preview, onConfirm, onCancel, restoring }: {
  snapshot: SnapshotManifest;
  preview: RestorePreview;
  onConfirm: () => void;
  onCancel: () => void;
  restoring: boolean;
}) {
  const total = preview.modified.length + preview.added.length + preview.deleted.length;

  return (
    <div className="snapshot-modal-overlay" onClick={onCancel}>
      <div className="snapshot-modal snapshot-modal-wide" onClick={e => e.stopPropagation()}>
        <div className="snapshot-modal-header">
          <Eye size={16} />
          <span>Restore Preview — {snapshot.name}</span>
          <button className="icon-btn" onClick={onCancel}><X size={14} /></button>
        </div>

        <div className="snapshot-safety-notice">
          ⚠️ <strong>Safe Restore:</strong> node_modules, target/, .git, and caches will NOT be touched.
        </div>

        <div className="snapshot-preview-stats">
          <div className="stat modified">{preview.modified.length} modified</div>
          <div className="stat added">{preview.added.length} added</div>
          <div className="stat deleted">{preview.deleted.length} deleted</div>
          <div className="stat total">{total} total</div>
        </div>

        <div className="snapshot-preview-files">
          {preview.modified.length > 0 && (
            <div className="file-group">
              <div className="file-group-label modified">~ Modified</div>
              {preview.modified.map((f, i) => <div key={i} className="file-item">{f}</div>)}
            </div>
          )}
          {preview.added.length > 0 && (
            <div className="file-group">
              <div className="file-group-label added">+ Added</div>
              {preview.added.map((f, i) => <div key={i} className="file-item">{f}</div>)}
            </div>
          )}
          {preview.deleted.length > 0 && (
            <div className="file-group">
              <div className="file-group-label deleted">- Deleted</div>
              {preview.deleted.map((f, i) => <div key={i} className="file-item">{f}</div>)}
            </div>
          )}
        </div>

        <div className="snapshot-modal-footer">
          <button className="btn-secondary" onClick={onCancel} disabled={restoring}>Cancel</button>
          <button className="btn-primary" onClick={onConfirm} disabled={restoring}>
            <RotateCcw size={13} />
            {restoring ? "Restoring..." : "Confirm Restore"}
          </button>
        </div>
      </div>
    </div>
  );
}
