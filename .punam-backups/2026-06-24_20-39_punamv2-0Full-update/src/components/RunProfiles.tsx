import { Plus, Save, Trash2, X } from "lucide-react";
import type { RunProfile } from "../utils/tauri";

interface Props {
  profiles: RunProfile[];
  onChange: (profiles: RunProfile[]) => void;
  onSave: () => void;
  onClose: () => void;
}

export default function RunProfiles({ profiles, onChange, onSave, onClose }: Props) {
  const updateProfile = (id: string, patch: Partial<RunProfile>) => {
    onChange(
      profiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile
      )
    );
  };

  const addProfile = () => {
    onChange([
      ...profiles,
      {
        id: `custom-${Date.now()}`,
        name: "Custom",
        command: "",
      },
    ]);
  };

  const removeProfile = (id: string) => {
    onChange(profiles.filter((profile) => profile.id !== id));
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel run-profiles-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-title-row">
          <h2>Run Profiles</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close run profiles">
            <X size={16} />
          </button>
        </div>

        <div className="run-profile-list">
          {profiles.map((profile) => (
            <div className="run-profile-row" key={profile.id}>
              <input
                value={profile.name}
                onChange={(event) => updateProfile(profile.id, { name: event.target.value })}
                placeholder="Name"
                aria-label="Run profile name"
              />
              <input
                value={profile.command}
                onChange={(event) => updateProfile(profile.id, { command: event.target.value })}
                placeholder="Command"
                aria-label="Run profile command"
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => removeProfile(profile.id)}
                aria-label={`Delete ${profile.name}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>

        <div className="settings-actions">
          <button type="button" className="btn-secondary" onClick={addProfile}>
            <Plus size={14} />
            Add Profile
          </button>
          <button type="button" className="btn-primary" onClick={onSave}>
            <Save size={14} />
            Save Profiles
          </button>
        </div>
      </div>
    </div>
  );
}
