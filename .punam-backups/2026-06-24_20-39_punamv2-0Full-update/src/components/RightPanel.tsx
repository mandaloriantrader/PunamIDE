/**
 * RightPanel — Tabbed right panel with Chat, Composer, Notepads, and Usage tabs.
 * Replaces the single AiChat panel with a multi-tab layout.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { MessageSquare, Layers, StickyNote, BarChart3, FileCode, ShieldCheck, Monitor, Bot, TrendingUp, Activity, MoreHorizontal, Brain } from "lucide-react";
import { PanelErrorBoundary } from "./ErrorBoundary";
import AiChat from "./AiChat";
import NotepadsPanel from "./NotepadsPanel";
import type { ParsedResponse } from "../utils/prompts";

// Lazy-loaded panels (Phase 3-9)
import { lazy, Suspense } from "react";
const ComposerPanel = lazy(() => import("./ComposerPanel"));
const UsageDashboard = lazy(() => import("./UsageDashboard"));
const ImpactAnalysisPanel = lazy(() => import("./ImpactAnalysisPanel"));
const SecurityPanel = lazy(() => import("./SecurityPanel"));
const EnvironmentDashboard = lazy(() => import("./EnvironmentDashboard"));
const MultiAgentDashboard = lazy(() => import("./MultiAgentDashboard"));
const TechnicalDebtDashboard = lazy(() => import("./TechnicalDebtDashboard"));
const CiDashboard = lazy(() => import("./CiDashboard"));
const RagWorkbenchPanel = lazy(() => import("./RagWorkbenchPanel"));

export type RightPanelTab = "chat" | "composer" | "notepads" | "usage" | "impact" | "security" | "environment" | "agents" | "debt" | "cicd" | "rag";

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
  forcePrompt?: { text: string; mode?: string } | null;
  onForcePromptConsumed?: () => void;
}

const TABS: { id: RightPanelTab; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "composer", label: "Composer", icon: Layers },
  { id: "notepads", label: "Notepads", icon: StickyNote },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "impact", label: "Impact", icon: FileCode },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "environment", label: "Env", icon: Monitor },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "debt", label: "Debt", icon: TrendingUp },
  { id: "cicd", label: "CI/CD", icon: Activity },
  { id: "rag", label: "RAG", icon: Brain },
];

export default function RightPanel(props: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>("chat");
  const [visibleCount, setVisibleCount] = useState(TABS.length);
  const [showOverflow, setShowOverflow] = useState(false);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Measure how many tabs fit in the available width
  const measureTabs = useCallback(() => {
    const container = tabBarRef.current;
    if (!container) return;

    const containerWidth = container.offsetWidth;
    const moreButtonWidth = 44; // width reserved for the "⋯" button
    let totalWidth = 0;
    let fitCount = 0;

    const buttons = container.querySelectorAll<HTMLElement>(".right-panel-tab:not(.right-panel-tab-more)");
    for (let i = 0; i < buttons.length; i++) {
      // Temporarily show all tabs to measure
      buttons[i].style.display = "flex";
      void buttons[i].offsetHeight; // Force synchronous layout reflow before measuring
    }

    for (let i = 0; i < buttons.length; i++) {
      totalWidth += buttons[i].offsetWidth;
      if (totalWidth + moreButtonWidth > containerWidth) break;
      fitCount++;
    }

    // If all tabs fit, show them all
    if (totalWidth <= containerWidth) {
      setVisibleCount(TABS.length);
    } else {
      setVisibleCount(Math.max(1, fitCount));
    }
  }, []);

  useEffect(() => {
    measureTabs();
    const observer = new ResizeObserver(measureTabs);
    if (tabBarRef.current) observer.observe(tabBarRef.current);
    return () => observer.disconnect();
  }, [measureTabs]);

  // Close overflow dropdown when clicking outside
  useEffect(() => {
    if (!showOverflow) return;
    const handleClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showOverflow]);

  const visibleTabs = TABS.slice(0, visibleCount);
  const overflowTabs = TABS.slice(visibleCount);

  return (
    <div className="right-panel-container">
      {/* Tab bar */}
      <div className="right-panel-tabs" ref={tabBarRef}>
        {visibleTabs.map((tab) => (
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
        {overflowTabs.length > 0 && (
          <div className="right-panel-tab-overflow" ref={overflowRef}>
            <button
              className={`right-panel-tab right-panel-tab-more ${overflowTabs.some(t => t.id === activeTab) ? "active" : ""}`}
              onClick={() => setShowOverflow(!showOverflow)}
              title="More tabs"
            >
              <MoreHorizontal size={14} />
            </button>
            {showOverflow && (
              <div className="right-panel-overflow-dropdown">
                {overflowTabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={`right-panel-overflow-item ${activeTab === tab.id ? "active" : ""}`}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setShowOverflow(false);
                    }}
                  >
                    <tab.icon size={13} />
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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
              forcePrompt={props.forcePrompt}
              onForcePromptConsumed={props.onForcePromptConsumed}
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

        {activeTab === "impact" && (
          <PanelErrorBoundary fallbackLabel="Impact Analysis">
            <Suspense fallback={null}>
              <ImpactAnalysisPanel />
            </Suspense>
          </PanelErrorBoundary>
        )}

        {activeTab === "security" && (
          <PanelErrorBoundary fallbackLabel="Security">
            <Suspense fallback={null}>
              <SecurityPanel projectPath={props.projectPath} />
            </Suspense>
          </PanelErrorBoundary>
        )}

        {activeTab === "environment" && (
          <PanelErrorBoundary fallbackLabel="Environment">
            <Suspense fallback={null}>
              <EnvironmentDashboard />
            </Suspense>
          </PanelErrorBoundary>
        )}

        {activeTab === "agents" && (
          <PanelErrorBoundary fallbackLabel="Multi-Agent">
            <Suspense fallback={null}>
              <MultiAgentDashboard />
            </Suspense>
          </PanelErrorBoundary>
        )}

        {activeTab === "debt" && (
          <PanelErrorBoundary fallbackLabel="Technical Debt">
            <Suspense fallback={null}>
              <TechnicalDebtDashboard projectPath={props.projectPath} />
            </Suspense>
          </PanelErrorBoundary>
        )}

        {activeTab === "cicd" && (
          <PanelErrorBoundary fallbackLabel="CI/CD">
            <Suspense fallback={null}>
              <CiDashboard projectPath={props.projectPath} />
            </Suspense>
          </PanelErrorBoundary>
        )}

        {activeTab === "rag" && (
          <PanelErrorBoundary fallbackLabel="RAG Workbench">
            <Suspense fallback={null}>
              <RagWorkbenchPanel />
            </Suspense>
          </PanelErrorBoundary>
        )}
      </div>
    </div>
  );
}
