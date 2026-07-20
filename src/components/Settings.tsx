import { useState, useEffect } from "react";
import type { AppConfig } from "../utils/tauri";
import { saveConfigToStore, loadAIProviders, saveAIProviders, loadCustomThemes, saveCustomThemes, loadActiveThemeId, saveActiveThemeId, loadMcpServers, saveMcpServers, exportAllSettings, importAllSettings } from "../utils/tauri";
import { Save, Plus, Trash2, CheckCircle, XCircle, Loader2, Upload, Download, FileDown, FileUp, ChevronDown } from "lucide-react";
import type { AIProviderConfig, ModelConfig } from "../utils/providers";
import { PROVIDER_PRESETS, testConnection } from "../utils/providers";
import { showToast } from "../utils/toast";
import { BUILTIN_THEMES, applyTheme, importTheme, exportTheme, getThemeById, getDefaultTheme } from "../utils/themes";
import type { ThemeDefinition } from "../utils/themes";
import type { MCPServerConfig } from "../utils/mcp";
import McpSettings from "./McpSettings";
import { AdaptiveModeSettings } from "./settings/AdaptiveModeSettings";
import type { AdaptiveStrategy } from "../lib/ai/providerCapabilities";
import ArchitectureRulesEditor from "./settings/ArchitectureRulesEditor";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  PUNAM_BUILD_NUMBER,
  PUNAM_CHANGELOG,
  PUNAM_DOCS_URL,
  PUNAM_RELEASE_NOTES_URL,
  PUNAM_ISSUES_URL,
  PUNAM_LICENSE_URL,
  PUNAM_LICENSE,
  PUNAM_RELEASE_CHANNEL,
  PUNAM_RELEASE_DATE,
  PUNAM_VERSION,
  PUNAM_ARCHITECTURE,
  PUNAM_WEBSITE_URL,
} from "../config/alpha";

interface Props {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
  onClose: () => void;
  onProvidersChange?: (providers: AIProviderConfig[]) => void;
  onMcpServersChange?: (servers: MCPServerConfig[]) => void;
  inlineCompletionEnabled?: boolean;
  onInlineCompletionChange?: (enabled: boolean) => void;
  projectPath?: string;
}

type ProviderPreset = (typeof PROVIDER_PRESETS)[number];

function createProviderFromPreset(preset: ProviderPreset): AIProviderConfig {
  return {
    id: `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: preset.type,
    name: preset.name,
    apiKey: "",
    baseUrl: preset.baseUrl,
    models: [{ id: preset.defaultModel, name: preset.defaultModel, enabled: true }],
  };
}

export default function Settings({ config, onConfigChange, onClose, onProvidersChange, onMcpServersChange, inlineCompletionEnabled = true, onInlineCompletionChange, projectPath }: Props) {
  const [local, setLocal] = useState<AppConfig>({ ...config });
  const [providers, setProviders] = useState<AIProviderConfig[]>([]);
  const [mcpServers, setMcpServers] = useState<MCPServerConfig[]>([]);
  const [saved, setSaved] = useState(false);
  const [activeSection, setActiveSection] = useState<"theme" | "providers" | "mcp" | "architecture" | "about">("providers");
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; error?: string } | null>(null);

  // Theme state
  const [customThemes, setCustomThemes] = useState<ThemeDefinition[]>([]);
  const [activeThemeId, setActiveThemeId] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);

  // Load providers on mount
  useEffect(() => {
    loadAIProviders().then((loaded) => {
      if (loaded.length > 0) {
        setProviders(loaded);
        setExpandedProviderId((prev) => prev ?? loaded[0]?.id ?? null);
      } else {
        // Migrate from old single-provider config
        if (config.api_key) {
          const migrated: AIProviderConfig = {
            id: "migrated-" + Date.now(),
            type: config.provider === "gemini" ? "gemini" : "openai-compatible",
            name: config.provider === "gemini" ? "Google Gemini" : config.provider === "openai" ? "OpenAI" : "Groq",
            apiKey: config.api_key,
            baseUrl: config.provider === "groq" ? "https://api.groq.com/openai/v1" : config.provider === "openai" ? "https://api.openai.com/v1" : undefined,
            models: [{ id: config.model, name: config.model, enabled: true }],
          };
          setProviders([migrated]);
          setExpandedProviderId(migrated.id);
        }
      }
    });
    // Load themes
    loadCustomThemes().then(setCustomThemes);
    loadActiveThemeId().then((id) => {
      if (id) setActiveThemeId(id);
      else setActiveThemeId(getDefaultTheme(config.theme === "light" ? "light" : "dark").id);
    });
    // Load MCP servers
    loadMcpServers().then(setMcpServers);
  }, [config]);

  const handleSave = async () => {
    try {
      await saveConfigToStore(local);
      await saveAIProviders(providers);
      await saveMcpServers(mcpServers);
      onConfigChange(local);
      onProvidersChange?.(providers);
      onMcpServersChange?.(mcpServers);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      showToast(`Failed to save settings: ${err}`, "error");
    }
  };

  const addProvider = (presetIndex: number) => {
    const preset = PROVIDER_PRESETS[presetIndex];
    const newProvider = createProviderFromPreset(preset);
    setProviders((prev) => [...prev, newProvider]);
    setExpandedProviderId(newProvider.id);
    setShowAddProvider(false);
  };

  const addMissingBuiltInProviders = () => {
    const missingProviders = providerPresetChoices.map(({ preset }) => createProviderFromPreset(preset));
    if (missingProviders.length === 0) return;
    setProviders((prev) => [...prev, ...missingProviders]);
    setExpandedProviderId(missingProviders[0].id);
    setShowAddProvider(false);
    showToast(`Added ${missingProviders.length} built-in provider${missingProviders.length === 1 ? "" : "s"}.`, "success");
  };

  const removeProvider = (id: string) => {
    setProviders((prev) => prev.filter((p) => p.id !== id));
    setExpandedProviderId((prev) => prev === id ? null : prev);
  };

  const updateProvider = (id: string, updates: Partial<AIProviderConfig>) => {
    setProviders((prev) => prev.map((p) => p.id === id ? { ...p, ...updates } : p));
  };

  const addModel = (providerId: string) => {
    setExpandedProviderId(providerId);
    setProviders((prev) => prev.map((p) => {
      if (p.id !== providerId) return p;
      const newModel: ModelConfig = { id: "", name: "", enabled: true };
      return { ...p, models: [...p.models, newModel] };
    }));
  };

  const updateModel = (providerId: string, modelIdx: number, updates: Partial<ModelConfig>) => {
    setProviders((prev) => prev.map((p) => {
      if (p.id !== providerId) return p;
      const models = [...p.models];
      models[modelIdx] = { ...models[modelIdx], ...updates };
      // Sync id and name
      if (updates.name !== undefined) models[modelIdx].id = updates.name;
      return { ...p, models };
    }));
  };

  const removeModel = (providerId: string, modelIdx: number) => {
    setProviders((prev) => prev.map((p) => {
      if (p.id !== providerId) return p;
      return { ...p, models: p.models.filter((_, i) => i !== modelIdx) };
    }));
  };

  const handleTest = async (provider: AIProviderConfig) => {
    const model = provider.models[0]?.id;
    if (!model || !provider.apiKey) {
      setTestResult({ id: provider.id, success: false, error: "Add API key and model first" });
      return;
    }
    setTestingId(provider.id);
    setTestResult(null);
    const result = await testConnection(provider, model);
    setTestingId(null);
    setTestResult({ id: provider.id, ...result });
    setTimeout(() => setTestResult(null), 5000);
  };

  // --- Theme Handlers ---
  const handleSelectTheme = async (theme: ThemeDefinition) => {
    const nextConfig = { ...local, theme: theme.type };
    setActiveThemeId(theme.id);
    applyTheme(theme);
    setLocal(nextConfig);
    onConfigChange(nextConfig);
    await saveActiveThemeId(theme.id);
    await saveConfigToStore(nextConfig);
  };

  const handleImportTheme = () => {
    const theme = importTheme(importText);
    if (!theme) {
      showToast("Invalid theme JSON. Check the format and try again.", "error");
      return;
    }
    // Ensure unique ID
    if (BUILTIN_THEMES.some((t) => t.id === theme.id) || customThemes.some((t) => t.id === theme.id)) {
      theme.id = `custom-${Date.now()}`;
    }
    const updated = [...customThemes, theme];
    setCustomThemes(updated);
    saveCustomThemes(updated);
    setImportText("");
    setShowImport(false);
    showToast(`Theme "${theme.name}" imported!`, "success");
  };

  const handleExportTheme = (theme: ThemeDefinition) => {
    const json = exportTheme(theme);
    navigator.clipboard.writeText(json).then(() => {
      showToast(`Theme "${theme.name}" copied to clipboard`, "success");
    }).catch(() => {
      showToast("Failed to copy theme", "error");
    });
  };

  const handleDeleteCustomTheme = (themeId: string) => {
    const updated = customThemes.filter((t) => t.id !== themeId);
    setCustomThemes(updated);
    saveCustomThemes(updated);
    if (activeThemeId === themeId) {
      // Reset to default
      const defaultTheme = getDefaultTheme("dark", updated);
      handleSelectTheme(defaultTheme);
    }
  };

  const allThemes = [...BUILTIN_THEMES, ...customThemes];
  const providerPresetChoices = PROVIDER_PRESETS
    .map((preset, idx) => ({ preset, idx }))
    .filter(({ preset }) => !providers.some((provider) => {
      const sameBaseUrl = preset.baseUrl && provider.baseUrl && preset.baseUrl.replace(/\/+$/, "") === provider.baseUrl.replace(/\/+$/, "");
      const sameName = provider.name.trim().toLowerCase() === preset.name.trim().toLowerCase();
      return sameBaseUrl || sameName;
    }));

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel settings-panel-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        {/* Section tabs */}
        <div className="settings-tabs">
          <button
            className={`settings-tab ${activeSection === "providers" ? "active" : ""}`}
            onClick={() => setActiveSection("providers")}
          >
            AI Providers
          </button>
          <button
            className={`settings-tab ${activeSection === "mcp" ? "active" : ""}`}
            onClick={() => setActiveSection("mcp")}
          >
            MCP Tools
          </button>
          <button
            className={`settings-tab ${activeSection === "architecture" ? "active" : ""}`}
            onClick={() => setActiveSection("architecture")}
          >
            Architecture Rules
          </button>
          <button
            className={`settings-tab ${activeSection === "theme" ? "active" : ""}`}
            onClick={() => setActiveSection("theme")}
          >
            Themes & Editor
          </button>
          <button
            className={`settings-tab ${activeSection === "about" ? "active" : ""}`}
            onClick={() => setActiveSection("about")}
          >
            About
          </button>
        </div>

        {/* AI Providers Section */}
        {activeSection === "providers" && (
          <div className="settings-providers-section">
            <AdaptiveModeSettings
              enabled={Boolean(local.adaptiveMode)}
              strategy={(local.adaptiveStrategy || "coding_optimized") as AdaptiveStrategy}
              onEnabledChange={(adaptiveMode) => setLocal((prev) => ({ ...prev, adaptiveMode }))}
              onStrategyChange={(adaptiveStrategy) => setLocal((prev) => ({ ...prev, adaptiveStrategy }))}
            />

            {providers.length === 0 && (
              <div className="settings-empty">
                No AI providers configured. Add one to start chatting.
              </div>
            )}

            {providers.map((provider) => {
              const isExpanded = expandedProviderId === provider.id;
              const enabledModelCount = provider.models.filter((model) => model.enabled && model.id).length;
              const primaryModel = provider.models.find((model) => model.enabled && model.id)?.id || provider.models[0]?.id || "No model";
              const keyStatus = provider.name === "Ollama (Local)" || provider.apiKey ? "Ready" : "Needs key";

              return (
              <div key={provider.id} className={`provider-card ${isExpanded ? "expanded" : ""}`}>
                <div className="provider-card-header">
                  <button
                    className="provider-expand-btn"
                    onClick={() => setExpandedProviderId(isExpanded ? null : provider.id)}
                    title={isExpanded ? "Collapse provider" : "Edit provider"}
                    aria-label={isExpanded ? "Collapse provider" : "Edit provider"}
                  >
                    <ChevronDown size={14} />
                  </button>
                  <span className="provider-card-type">{provider.type === "gemini" ? "Gemini" : "OpenAI-Compatible"}</span>
                  <input
                    type="text"
                    className="provider-name-input"
                    value={provider.name}
                    onChange={(e) => updateProvider(provider.id, { name: e.target.value })}
                    onFocus={() => setExpandedProviderId(provider.id)}
                    placeholder="Provider name"
                  />
                  <div className="provider-card-summary">
                    <span>{enabledModelCount} model{enabledModelCount === 1 ? "" : "s"}</span>
                    <span>{primaryModel}</span>
                    <span className={keyStatus === "Ready" ? "provider-status-ready" : "provider-status-warning"}>{keyStatus}</span>
                  </div>
                  <button className="icon-btn danger" onClick={() => removeProvider(provider.id)} title="Remove provider">
                    <Trash2 size={14} />
                  </button>
                </div>

                {isExpanded && (
                <div className="provider-card-body">
                  {/* API Key */}
                  <div className="provider-field">
                    <label>API Key</label>
                    <div className="api-key-input">
                      <input
                        type="password"
                        value={provider.apiKey}
                        onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                        placeholder={provider.name === "Ollama (Local)" ? "Not required" : "Paste API key"}
                      />
                    </div>
                  </div>

                  {/* Base URL (OpenAI-compatible only) */}
                  {provider.type === "openai-compatible" && (
                    <div className="provider-field">
                      <label>Base URL</label>
                      <input
                        type="text"
                        className="settings-input"
                        value={provider.baseUrl || ""}
                        onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                  )}

                  {/* Models */}
                  <div className="provider-field">
                    <label>Models</label>
                    {provider.models.map((model, idx) => (
                      <div key={idx} className="model-row">
                        <input
                          type="checkbox"
                          checked={model.enabled}
                          onChange={(e) => updateModel(provider.id, idx, { enabled: e.target.checked })}
                        />
                        <input
                          type="text"
                          className="model-name-input"
                          value={model.name}
                          onChange={(e) => updateModel(provider.id, idx, { name: e.target.value, id: e.target.value })}
                          placeholder="Model name (e.g. gpt-4o-mini)"
                        />
                        {provider.models.length > 1 && (
                          <button className="icon-btn small" onClick={() => removeModel(provider.id, idx)}>
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                    <button className="add-model-btn" onClick={() => addModel(provider.id)}>
                      <Plus size={12} /> Add Model
                    </button>
                  </div>

                  {/* Test Connection */}
                  <div className="provider-test">
                    <button
                      className="btn-secondary compact"
                      onClick={() => handleTest(provider)}
                      disabled={testingId === provider.id}
                    >
                      {testingId === provider.id ? (
                        <><Loader2 size={12} className="spin" /> Testing...</>
                      ) : (
                        "Test Connection"
                      )}
                    </button>
                    {testResult && testResult.id === provider.id && (
                      <span className={`test-result ${testResult.success ? "success" : "error"}`}>
                        {testResult.success ? <><CheckCircle size={12} /> Connected</> : <><XCircle size={12} /> {testResult.error}</>}
                      </span>
                    )}
                  </div>
                </div>
                )}
              </div>
              );
            })}

            {/* Add Provider */}
            {showAddProvider ? (
              <div className="add-provider-list">
                <span className="add-provider-title">Choose provider type:</span>
                {providerPresetChoices.length === 0 && (
                  <div className="settings-empty compact">All built-in providers are already added.</div>
                )}
                {providerPresetChoices.map(({ preset, idx }) => (
                  <button key={idx} className="add-provider-option" onClick={() => addProvider(idx)}>
                    <strong>{preset.name}</strong>
                    <span>{preset.type === "gemini" ? "Native Gemini API" : `OpenAI-compatible • ${preset.baseUrl || ""}`}</span>
                  </button>
                ))}
                <button className="btn-secondary compact" onClick={() => setShowAddProvider(false)}>Cancel</button>
              </div>
            ) : (
              <div className="settings-provider-actions">
                <button className="btn-primary compact" onClick={() => setShowAddProvider(true)}>
                  <Plus size={14} /> Add Provider
                </button>
                <button
                  className="btn-secondary compact"
                  onClick={addMissingBuiltInProviders}
                  disabled={providerPresetChoices.length === 0}
                  title="Add every built-in provider that is not in this list yet"
                >
                  Add Missing Built-ins
                </button>
              </div>
            )}
          </div>
        )}

        {/* MCP Tools Section */}
        {activeSection === "mcp" && (
          <McpSettings
            servers={mcpServers}
            onChange={setMcpServers}
            projectPath={projectPath}
          />
        )}

        {/* Architecture Rules Section */}
        {activeSection === "architecture" && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 400 }}>
            <ArchitectureRulesEditor />
          </div>
        )}

        {/* Theme Section */}
        {activeSection === "theme" && (
          <div className="settings-section">
            <h3>Themes</h3>
            <div className="theme-gallery">
              {allThemes.map((theme) => (
                <button
                  key={theme.id}
                  className={`theme-card ${activeThemeId === theme.id ? "active" : ""}`}
                  onClick={() => handleSelectTheme(theme)}
                  title={`${theme.name}${theme.author ? ` by ${theme.author}` : ""}`}
                >
                  <div className="theme-card-preview" style={{
                    background: theme.colors.bgPrimary,
                    borderColor: activeThemeId === theme.id ? theme.colors.accent : theme.colors.border,
                  }}>
                    <div className="theme-card-sidebar" style={{ background: theme.colors.bgSecondary }} />
                    <div className="theme-card-editor">
                      <div className="theme-card-line" style={{ background: theme.colors.accent, width: "60%" }} />
                      <div className="theme-card-line" style={{ background: theme.colors.textMuted, width: "80%" }} />
                      <div className="theme-card-line" style={{ background: theme.colors.green, width: "45%" }} />
                      <div className="theme-card-line" style={{ background: theme.colors.purple, width: "70%" }} />
                    </div>
                  </div>
                  <div className="theme-card-info">
                    <span className="theme-card-name">{theme.name}</span>
                    <span className="theme-card-type">{theme.type}</span>
                  </div>
                  {!BUILTIN_THEMES.some((t) => t.id === theme.id) && (
                    <div className="theme-card-actions">
                      <button
                        className="icon-btn small"
                        onClick={(e) => { e.stopPropagation(); handleExportTheme(theme); }}
                        title="Export theme"
                      >
                        <Download size={10} />
                      </button>
                      <button
                        className="icon-btn small danger"
                        onClick={(e) => { e.stopPropagation(); handleDeleteCustomTheme(theme.id); }}
                        title="Delete theme"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  )}
                </button>
              ))}
            </div>

            {/* Import Theme */}
            <div className="theme-import-section">
              {showImport ? (
                <div className="theme-import-form">
                  <textarea
                    className="theme-import-textarea"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder='Paste theme JSON here...'
                    rows={6}
                  />
                  <div className="theme-import-actions">
                    <button className="btn-primary compact" onClick={handleImportTheme} disabled={!importText.trim()}>
                      <Upload size={12} /> Import
                    </button>
                    <button className="btn-secondary compact" onClick={() => { setShowImport(false); setImportText(""); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="theme-import-buttons">
                  <button className="btn-secondary compact" onClick={() => setShowImport(true)}>
                    <Upload size={12} /> Import Custom Theme
                  </button>
                  {activeThemeId && (
                    <button
                      className="btn-secondary compact"
                      onClick={() => {
                        const theme = getThemeById(activeThemeId, customThemes);
                        if (theme) handleExportTheme(theme);
                      }}
                    >
                      <Download size={12} /> Export Current
                    </button>
                  )}
                </div>
              )}
            </div>

            <h3 style={{ marginTop: 20 }}>Editor</h3>
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Inline Code Completion</span>
                <span className="settings-toggle-desc">Copilot-style suggestions as you type (uses AI tokens)</span>
              </div>
              <button
                className={`settings-toggle-switch ${inlineCompletionEnabled ? "on" : "off"}`}
                onClick={() => onInlineCompletionChange?.(!inlineCompletionEnabled)}
                role="switch"
                aria-checked={inlineCompletionEnabled}
                aria-label="Toggle inline code completion"
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            <h3 style={{ marginTop: 20 }}>Inline Autocomplete</h3>

            {/* Enable/disable toggle */}
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Enable Autocomplete</span>
                <span className="settings-toggle-desc">Master switch for the inline autocomplete engine</span>
              </div>
              <button
                className={`settings-toggle-switch ${local.autocompleteEnabled ? "on" : "off"}`}
                onClick={() => setLocal((prev) => ({ ...prev, autocompleteEnabled: !prev.autocompleteEnabled }))}
                role="switch"
                aria-checked={local.autocompleteEnabled}
                aria-label="Toggle autocomplete"
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            {/* Mode selector */}
            <div className="provider-field" style={{ marginTop: 12 }}>
              <label>Completion Mode</label>
              <select
                className="settings-input"
                value={local.autocompleteMode}
                onChange={(e) => setLocal((prev) => ({ ...prev, autocompleteMode: e.target.value as AppConfig["autocompleteMode"] }))}
              >
                <option value="auto">Auto (detect from model)</option>
                <option value="fim">Force FIM</option>
                <option value="chat">Force Chat Fallback</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>

            {/* Trigger delay */}
            <div className="provider-field" style={{ marginTop: 12 }}>
              <label>Trigger Delay: {local.autocompleteDebounceMs}ms</label>
              <input
                type="range"
                min={150}
                max={800}
                step={50}
                value={local.autocompleteDebounceMs}
                onChange={(e) => setLocal((prev) => ({ ...prev, autocompleteDebounceMs: Math.max(150, Number(e.target.value)) }))}
                className="settings-range"
              />
              <span className="settings-toggle-desc">Delay before triggering completion (150–800ms)</span>
            </div>

            {/* Max tokens */}
            <div className="provider-field" style={{ marginTop: 12 }}>
              <label>Max Tokens: {local.autocompleteMaxTokens}</label>
              <input
                type="number"
                min={16}
                max={512}
                value={local.autocompleteMaxTokens}
                onChange={(e) => {
                  const val = Math.min(512, Math.max(16, Number(e.target.value)));
                  setLocal((prev) => ({ ...prev, autocompleteMaxTokens: val }));
                }}
                className="settings-input"
              />
              <span className="settings-toggle-desc">Max tokens per completion response (16–512)</span>
            </div>
          </div>
        )}

        {activeSection === "about" && (
          <div className="settings-section">
            {/* Identity */}
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <img src="/logo_transparent.png" alt="PunamIDE" style={{ width: 48, height: 48, marginBottom: 8 }} />
              <h3 style={{ margin: "4px 0" }}>PunamIDE</h3>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "2px 0" }}>AI-native development environment</p>
              <p style={{ fontSize: 13, fontWeight: 600, margin: "8px 0 4px" }}>Version {PUNAM_VERSION}</p>
              <p style={{ fontSize: 11, color: "#34d399", margin: 0 }}>✓ You're up to date</p>
            </div>

            {/* About This Installation */}
            <h4 style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "var(--text-secondary)", marginBottom: 8 }}>About This Installation</h4>
            <div className="settings-about-grid">
              <div><span>Version</span><strong>{PUNAM_VERSION}</strong></div>
              <div><span>Build</span><strong>{PUNAM_BUILD_NUMBER}</strong></div>
              <div><span>Update Channel</span><strong>{PUNAM_RELEASE_CHANNEL}</strong></div>
              <div><span>Architecture</span><strong>{PUNAM_ARCHITECTURE}</strong></div>
            </div>
            <div style={{ marginTop: 8 }}>
              <button
                className="btn-secondary compact"
                onClick={() => {
                  const info = `PunamIDE ${PUNAM_VERSION}\nBuild: ${PUNAM_BUILD_NUMBER}\nChannel: ${PUNAM_RELEASE_CHANNEL}\nArch: ${PUNAM_ARCHITECTURE}\nOS: ${navigator.platform}\nDate: ${PUNAM_RELEASE_DATE}`;
                  navigator.clipboard.writeText(info);
                  showToast("System information copied", "success");
                }}
              >
                Copy System Information
              </button>
            </div>

            {/* Resources */}
            <h4 style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "var(--text-secondary)", marginTop: 20, marginBottom: 8 }}>Resources</h4>
            <div className="settings-provider-actions" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
              <button className="btn-secondary compact" style={{ justifyContent: "space-between" }} onClick={() => openExternal(PUNAM_WEBSITE_URL).catch((err) => showToast(`Failed: ${err}`, "error"))}>
                <span>Website</span><span style={{ opacity: 0.5 }}>↗</span>
              </button>
              <button className="btn-secondary compact" style={{ justifyContent: "space-between" }} onClick={() => openExternal(PUNAM_DOCS_URL).catch((err) => showToast(`Failed: ${err}`, "error"))}>
                <span>Documentation</span><span style={{ opacity: 0.5 }}>↗</span>
              </button>
              <button className="btn-secondary compact" style={{ justifyContent: "space-between" }} onClick={() => openExternal(PUNAM_RELEASE_NOTES_URL).catch((err) => showToast(`Failed: ${err}`, "error"))}>
                <span>Release Notes</span><span style={{ opacity: 0.5 }}>↗</span>
              </button>
              <button className="btn-secondary compact" style={{ justifyContent: "space-between" }} onClick={() => openExternal(PUNAM_ISSUES_URL).catch((err) => showToast(`Failed: ${err}`, "error"))}>
                <span>Report an Issue</span><span style={{ opacity: 0.5 }}>↗</span>
              </button>
            </div>

            {/* Legal */}
            <h4 style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "var(--text-secondary)", marginTop: 20, marginBottom: 8 }}>Legal</h4>
            <div className="settings-provider-actions" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
              <button className="btn-secondary compact" style={{ justifyContent: "space-between" }} onClick={() => openExternal(PUNAM_LICENSE_URL).catch((err) => showToast(`Failed: ${err}`, "error"))}>
                <span>Open-Source Licenses ({PUNAM_LICENSE})</span><span style={{ opacity: 0.5 }}>↗</span>
              </button>
            </div>

            {/* Footer */}
            <p style={{ textAlign: "center", fontSize: 11, color: "var(--text-secondary)", marginTop: 24, marginBottom: 0 }}>
              © 2026 PunamIDE. All rights reserved.
            </p>
          </div>
        )}

        <div className="settings-actions">
          <div className="settings-actions-left">
            <button
              className="btn-secondary compact"
              title="Export all settings to a JSON file"
              onClick={async () => {
                try {
                  const json = await exportAllSettings();
                  const blob = new Blob([json], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "punamide-settings.json";
                  a.click();
                  URL.revokeObjectURL(url);
                  showToast("Settings exported", "success");
                } catch (err) {
                  showToast(`Export failed: ${err}`, "error");
                }
              }}
            >
              <FileDown size={13} /> Export
            </button>
            <button
              className="btn-secondary compact"
              title="Import settings from a JSON file"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".json";
                input.onchange = async (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    await importAllSettings(text);
                    showToast("Settings imported — restart to apply all changes", "success");
                  } catch (err) {
                    showToast(`Import failed: ${err}`, "error");
                  }
                };
                input.click();
              }}
            >
              <FileUp size={13} /> Import
            </button>
          </div>
          <div className="settings-actions-right">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={handleSave}>
              <Save size={14} />
              {saved ? "Saved!" : "Save Settings"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
