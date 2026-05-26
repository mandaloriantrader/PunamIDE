/**
 * RightPanel — Tabbed right panel with Chat, Composer, Notepads, and Usage tabs.
 * Replaces the single AiChat panel with a multi-tab layout.
 */

import { useState } from "react";
import { MessageSquare, Layers, StickyNote, BarChart3 } from "lucide-react";
import { PanelErrorBoundary } from "./ErrorBoundary";
import AiChat from "./AiChat";
import NotepadsPanel from "./NotepadsPanel";
import type { ParsedResponse } from "../utils/prompts";

// Lazy-loaded panels
import { lazy, Suspense } from "react";
const ComposerPanel = lazy(() => import("./ComposerPanel"));
const UsageDashboard = lazy(() => import("./UsageDashboard"));

export type RightPanelTab = "chat" | "composer" | "notepads" | "usage";

interface RightPanelProps {
  // AiChat props (pass-through)
  config: any;
  projectPath: string;
  files: any[];
  openTabs: { path: string; name: string; content: string }[];
  activeFilePath?: string;
  selectedText: string;
  problems: any[];
  terminalOutput: string;
  aiProviders: any[];
  proactiveError: { command: string; output: string } | null;
  runObservation: any;
  onDismissProactiveError: () => void;
  onDismissRunObservation: () => void;
  checkResult: any;
  checkingProject: boolean;
  onRunProjectCheck: () => void;
  checkpointCount: number;
  mcpServers: any[];
  projectNotes: string;
  onApplyChanges: (parsed: ParsedResponse) => Promise<boolean>;
  onApplyDirect: (parsed: any) => Promise<void>;
  onRunCommand: (cmd: string) => void;
  onRevertLastApply: () => Promise<void>;
}

const TABS: { id: RightPanelTab; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "composer", label: "Composer", icon: Layers },
  { id: "notepads", label: "Notepads", icon: StickyNote },
  { id: "usage", label: "Usage", icon: BarChart3 },
];

export default function RightPanel(props: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>("chat");

  return (
    <div className="right-panel-container">
      {/* Tab bar */}
      <div className="right-panel-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`right-panel-tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.label}
          >
            <tab.icon size={14} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="right-panel-content">
        {activeTab === "chat" && (
          <PanelErrorBoundary fallbackLabel="AI Chat">
            <AiChat
              config={props.config}
              projectPath={props.projectPath}
              files={props.files}
              openTabs={props.openTabs}
              activeFilePath={props.activeFilePath}
              selectedText={props.selectedText}
              problems={props.problems}
              terminalOutput={props.terminalOutput}
              aiProviders={props.aiProviders}
              proactiveError={props.proactiveError}
              runObservation={props.runObservation}
              onDismissProactiveError={props.onDismissProactiveError}
              onDismissRunObservation={props.onDismissRunObservation}
              checkResult={props.checkResult}
              checkingProject={props.checkingProject}
              onRunProjectCheck={props.onRunProjectCheck}
              checkpointCount={props.checkpointCount}
              mcpServers={props.mcpServers}
              projectNotes={props.projectNotes}
              onApplyChanges={props.onApplyChanges}
              onApplyDirect={props.onApplyDirect}
              onRunCommand={props.onRunCommand}
              onRevertLastApply={props.onRevertLastApply}
            />
          </PanelErrorBoundary>
        )}

        {activeTab === "composer" && (
          <PanelErrorBoundary fallbackLabel="Composer">
            <Suspense fallback={null}>
              <ComposerPanel
                projectPath={props.projectPath}
                files={props.files}
                aiProviders={props.aiProviders}
                config={props.config}
                onApplyChanges={async (changes) => { await props.onApplyChanges(changes); }}
              />
            </Suspense>
          </PanelErrorBoundary>
        )}

        {activeTab === "notepads" && (
          <PanelErrorBoundary fallbackLabel="Notepads">
            <NotepadsPanel projectPath={props.projectPath} onClose={() => setActiveTab("chat")} />
          </PanelErrorBoundary>
        )}

        {activeTab === "usage" && (
          <PanelErrorBoundary fallbackLabel="Usage">
            <Suspense fallback={null}>
              <UsageDashboard />
            </Suspense>
          </PanelErrorBoundary>
        )}
      </div>
    </div>
  );
}
