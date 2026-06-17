# PunamIDE Snapshot System — Integration Guide

## File Structure

```
your-punam-ide/
├── src/
│   ├── components/
│   │   └── SnapshotManager.jsx        ← Drop in the React UI
│   └── App.tsx                        ← Register sidebar button here
├── src-tauri/
│   └── src/
│       ├── main.rs                    ← Register Tauri commands
│       └── snapshot/
│           └── mod.rs                 ← Drop in the Rust backend
```

---

## Step 1 — Add Rust backend

Copy `snapshot_backend.rs` to `src-tauri/src/snapshot/mod.rs`

In `src-tauri/src/main.rs`:

```rust
mod snapshot;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            snapshot::create_snapshot,
            snapshot::list_snapshots,
            snapshot::get_restore_preview,
            snapshot::restore_snapshot,
            snapshot::export_snapshot_zip,
            snapshot::delete_snapshot,
            snapshot::auto_snapshot_if_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error running PunamIDE");
}
```

Add to `src-tauri/Cargo.toml`:

```toml
[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
zip = { version = "0.6", features = ["deflate"] }
walkdir = "2"
chrono = { version = "0.4", features = ["serde"] }
```

---

## Step 2 — Connect React UI to real Tauri

In `SnapshotManager.jsx`, replace the mock `invoke` with:

```ts
import { invoke } from "@tauri-apps/api/tauri";
```

Pass `project_root` from your IDE's project context:

```ts
// Example: get from Tauri app context or a global store
const PROJECT_ROOT = await invoke("get_project_root");
```

Update all invoke calls to include `project_root`:

```ts
await invoke("create_snapshot", { projectRoot, name, reason });
await invoke("list_snapshots",  { projectRoot });
await invoke("get_restore_preview", { projectRoot, snapshotId });
await invoke("restore_snapshot",    { projectRoot, snapshotId });
await invoke("export_snapshot_zip", { projectRoot, snapshotId });
await invoke("delete_snapshot",     { projectRoot, snapshotId });
```

---

## Step 3 — Sidebar activity bar button

In your IDE's sidebar component:

```tsx
import { Shield } from "lucide-react"; // or use the inline Icon component

<SidebarButton
  icon={<Shield size={18} />}
  tooltip="Create Snapshot Backup"
  onClick={() => openPanel("snapshot-manager")}
  active={activePanel === "snapshot-manager"}
/>
```

---

## Step 4 — Auto-snapshot hooks

Call before risky operations:

```ts
// Before AI agent edits files
await invoke("auto_snapshot_if_enabled", {
  projectRoot,
  trigger: "ai-edit",
  enabled: settings.autoBeforeAI,
});

// Before debugger integration
await invoke("auto_snapshot_if_enabled", {
  projectRoot,
  trigger: "debugger",
  enabled: settings.autoBeforeDebugger,
});

// Before npm install / cargo add
await invoke("auto_snapshot_if_enabled", {
  projectRoot,
  trigger: "deps",
  enabled: settings.autoBeforeDeps,
});
```

---

## Backup Storage Structure

```
.punam-backups/
├── 1748302200_before-ai-refactor/
│   ├── manifest.json
│   ├── src/
│   │   ├── main.rs
│   │   └── editor/mod.rs
│   ├── src-tauri/src/
│   ├── package.json
│   ├── Cargo.toml
│   └── ...
├── 1748215800_before-debugger/
│   └── ...
└── export-before-ai-refactor.punam   ← ZIP export
```

### manifest.json example:

```json
{
  "id": "snap_1748302200000",
  "name": "before-ai-refactor",
  "createdAt": "1748302200Z",
  "files": 342,
  "sizeMB": 12.4,
  "punamVersion": "2.0",
  "reason": "before-ai-edit"
}
```

---

## Safety Guarantees

| Rule | Implementation |
|------|----------------|
| Never overwrite without confirmation | RestorePreviewModal with confirm dialog |
| Never touch .git | Path guard in `restore_walk()` |
| Never include node_modules | `is_excluded()` + EXCLUDE_PATTERNS |
| Never block UI thread | Tauri async commands + `spawn_blocking` |
| Never delete snapshots unless retention exceeded | `enforce_retention()` only runs after create |
| Atomic file writes | Write to `.punam-restore-tmp` then `rename()` |
| Rollback on failure | Error propagates before any writes commit |

---

## Future Cloud Backup (Architecture Ready)

The backend is designed for cloud provider extension:

```rust
// Future: add to snapshot/cloud.rs
pub trait CloudProvider {
    async fn upload(&self, snapshot_path: &Path, manifest: &SnapshotManifest) -> Result<String>;
    async fn list(&self) -> Result<Vec<SnapshotManifest>>;
    async fn download(&self, id: &str, dest: &Path) -> Result<()>;
}

// Implement for:
// - GitHubProvider (Gist or private repo)
// - GoogleDriveProvider
// - DropboxProvider
// - OneDriveProvider
```

---

## UI Feature Summary

| Feature | Status |
|---------|--------|
| Sidebar shield button + tooltip | ✅ |
| Create snapshot with name + reason | ✅ |
| Progress bar during creation | ✅ |
| List snapshots (time, size, file count) | ✅ |
| Filter snapshots | ✅ |
| Quick Restore (safe, no node_modules) | ✅ |
| Restore Preview (modified/added/deleted) | ✅ |
| Confirm dialog before restore | ✅ |
| Export as .punam ZIP | ✅ |
| Delete snapshot with confirmation | ✅ |
| Auto-snapshot triggers settings | ✅ |
| Retention policy slider | ✅ |
| Toast notifications | ✅ |
| Cloud backup UI (ready, coming soon) | ✅ |
