/**
 * SplitEditor — side-by-side dual pane editor layout.
 * Wraps two CodeEditor instances with a draggable gutter via react-split.
 */

import Split from "react-split";
import CodeEditor, { getLanguage } from "./CodeEditor";
import EditorTabs from "./EditorTabs";
import type { Tab } from "./EditorTabs";
import type { AIProviderConfig } from "../utils/providers";
import type { Problem } from "../utils/problems";
import { ChevronRight } from "lucide-react";

interface PaneState {
  activeTab: string;
}

interface Props {
  // Left pane
  leftTabs: Tab[];
  leftPane: PaneState;
  onLeftTabSelect: (id: string) => void;
  onLeftTabClose: (id: string) => void;
  onLeftChange: (value: string) => void;
  // Right pane
  rightTabs: Tab[];
  rightPane: PaneState;
  onRightTabSelect: (id: string) => void;
  onRightTabClose: (id: string) => void;
  onRightChange: (value: string) => void;
  // Shared
  problems?: Problem[];
  theme?: string;
  aiProviders?: AIProviderConfig[];
  inlineCompletionEnabled?: boolean;
  onSelectionChange?: (text: string) => void;
  onAskPunam?: (text: string, mode: string) => void;
  onCursorChange?: (pos: { line: number; column: number }) => void;
  onLeftSave?: () => void | Promise<void>;
  onRightSave?: () => void | Promise<void>;
}

function Breadcrumb({ path }: { path: string }) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return (
    <div className="breadcrumb-bar">
      {parts.map((seg, i, arr) => (
        <span key={i} className="breadcrumb-item">
          {i > 0 && <ChevronRight size={12} className="breadcrumb-sep" />}
          <span className={i === arr.length - 1 ? "breadcrumb-active" : ""}>{seg}</span>
        </span>
      ))}
    </div>
  );
}

export default function SplitEditor({
  leftTabs, leftPane, onLeftTabSelect, onLeftTabClose, onLeftChange,
  rightTabs, rightPane, onRightTabSelect, onRightTabClose, onRightChange,
  problems, theme, aiProviders, inlineCompletionEnabled,
  onSelectionChange, onAskPunam, onCursorChange, onLeftSave, onRightSave,
}: Props) {
  const leftTab = leftTabs.find((t) => t.id === leftPane.activeTab);
  const rightTab = rightTabs.find((t) => t.id === rightPane.activeTab);

  return (
    <Split
      className="split-editor-layout"
      sizes={[50, 50]}
      minSize={280}
      gutterSize={6}
      direction="horizontal"
      style={{ display: "flex", height: "100%", overflow: "hidden" }}
    >
      {/* Left pane */}
      <div className="split-editor-pane">
        {leftTabs.length > 0 ? (
          <>
            <EditorTabs
              tabs={leftTabs}
              activeTab={leftPane.activeTab}
              onTabSelect={onLeftTabSelect}
              onTabClose={onLeftTabClose}
            />
            {leftTab && (
              <>
                <Breadcrumb path={leftTab.path} />
                <CodeEditor
                  content={leftTab.content}
                  language={getLanguage(leftTab.name)}
                  path={leftTab.path}
                  problems={problems}
                  onChange={onLeftChange}
                  onSelectionChange={onSelectionChange}
                  onCursorChange={onCursorChange}
                  onSave={onLeftSave}
                  onAskPunam={onAskPunam}
                  theme={theme}
                  aiProviders={aiProviders}
                  inlineCompletionEnabled={inlineCompletionEnabled}
                />
              </>
            )}
          </>
        ) : (
          <div className="split-editor-empty">Open a file to the left pane</div>
        )}
      </div>

      {/* Right pane */}
      <div className="split-editor-pane">
        {rightTabs.length > 0 ? (
          <>
            <EditorTabs
              tabs={rightTabs}
              activeTab={rightPane.activeTab}
              onTabSelect={onRightTabSelect}
              onTabClose={onRightTabClose}
            />
            {rightTab && (
              <>
                <Breadcrumb path={rightTab.path} />
                <CodeEditor
                  content={rightTab.content}
                  language={getLanguage(rightTab.name)}
                  path={rightTab.path}
                  problems={problems}
                  onChange={onRightChange}
                  onSelectionChange={onSelectionChange}
                  onCursorChange={onCursorChange}
                  onSave={onRightSave}
                  onAskPunam={onAskPunam}
                  theme={theme}
                  aiProviders={aiProviders}
                  inlineCompletionEnabled={inlineCompletionEnabled}
                />
              </>
            )}
          </>
        ) : (
          <div className="split-editor-empty">
            Drag a tab here or open a file
          </div>
        )}
      </div>
    </Split>
  );
}
