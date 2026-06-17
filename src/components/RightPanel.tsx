/**
 * RightPanel — Tabbed right panel with Chat, Composer, Notepads, and Usage tabs.
 * Replaces the single AiChat panel with a multi-tab layout.
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Layers, StickyNote, BarChart3, FileCode, ShieldCheck, Monitor, Bot, TrendingUp, Activity, MoreHorizontal, Brain, Search } from "lucide-react";
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
const IntelligencePanel = lazy(() => import("./IntelligencePanel"));

export type RightPanelTab = "chat" | "composer" | "notepads" | "usage" | "impact" | "security" | "environment" | "agents" | "debt" | "cicd" | "rag" | "intelligence";

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
  { id: "intelligence", label: "Intel", icon: Search },
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
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const tabWidthsRef = useRef<number[]>([]);
  const rafRef = useRef<number>(0);

  // Measure how many tabs fit in the available width
  const measureTabs = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const container = tabBarRef.current;
      if (!container) return;

      const containerWidth = container.offsetWidth;
      if (containerWidth <= 0) return;

      // Cache tab widths on first render when all tabs are in the DOM
      if (tabWidthsRef.current.length === 0) {
        const buttons = container.querySelectorAll<HTMLElement>(".right-panel-tab:not(.right-panel-tab-more)");
        if (buttons.length < TABS.length) return; // Not all rendered yet, wait
        tabWidthsRef.current = Array.from(buttons).map(btn => btn.offsetWidth);
      }

      // Measure the real overflow button width if available, else estimate
      const moreBtn = container.querySelector<HTMLElement>(".right-panel-tab-more");
      const moreButtonWidth = moreBtn ? moreBtn.offsetWidth + 8 : 44;

      const widths = tabWidthsRef.current;
      const allTabsWidth = widths.reduce((sum, w) => sum + w, 0);

      // If all tabs fit without overflow button, show them all
      if (allTabsWidth <= containerWidth) {
        setVisibleCount(TABS.length);
        return;
      }

      // Otherwise calculate how many fit alongside the overflow button
      let totalWidth = 0;
      let fitCount = 0;
      for (let i = 0; i < widths.length; i++) {
        if (totalWidth + widths[i] + moreButtonWidth > containerWidth) break;
        totalWidth += widths[i];
        fitCount++;
      }

      setVisibleCount(Math.max(1, fitCount));
    });
  }, []);

  // Use useLayoutEffect for initial measurement (before paint)
  useLayoutEffect(() => {
    measureTabs();
    return () => cancelAnimationFrame(rafRef.current);
  }, [measureTabs]);

  // ResizeObserver for ongoing resize tracking
  useEffect(() => {
    const observer = new ResizeObserver(measureTabs);
    if (tabBarRef.current) observer.observe(tabBarRef.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [measureTabs]);

  // Position dropdown relative to the more button (for portal rendering)
  useEffect(() => {
    if (showOverflow && moreButtonRef.current) {
      const rect = moreButtonRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 2,
        right: window.innerWidth - rect.right,
      });
    }
  }, [showOverflow]);

  // Close overflow dropdown when clicking outside
  useEffect(() => {
    if (!showOverflow) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (overflowRef.current && overflowRef.current.contains(target)) return;
      if (moreButtonRef.current && moreButtonRef.current.contains(target)) return;
      setShowOverflow(false);
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
          <div className="right-panel-tab-overflow">
            <button
              ref={moreButtonRef}
              className={`right-panel-tab right-panel-tab-more ${overflowTabs.some(t => t.id === activeTab) ? "active" : ""}`}
              onClick={() => setShowOverflow(!showOverflow)}
              title="More tabs"
            >
              <MoreHorizontal size={14} />
            </button>
            {showOverflow && dropdownPos && createPortal(
              <div
                ref={overflowRef}
                className="right-panel-overflow-dropdown"
                style={{ position: "fixed", top: dropdownPos.top, right: dropdownPos.right, zIndex: 9999 }}
              >
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
              </div>,
              document.body
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
              <TechnicalDebtDashboard projectPath={props.projectPath} files={props.files} />
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

        {activeTab === "intelligence" && (
          <PanelErrorBoundary fallbackLabel="Intelligence">
            <Suspense fallback={null}>
              <IntelligencePanel />
            </Suspense>
          </PanelErrorBoundary>
        )}

      </div>
    </div>
  );
}
