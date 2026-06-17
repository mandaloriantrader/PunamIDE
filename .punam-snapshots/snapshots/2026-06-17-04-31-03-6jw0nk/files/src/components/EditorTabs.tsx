import { useRef } from "react";
import { X, Circle } from "lucide-react";
import { FileIcon } from "./FileIcon";

export interface Tab {
  id: string;
  path: string;
  name: string;
  content: string;
  modified: boolean;
}

interface Props {
  tabs: Tab[];
  activeTab: string;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
}

export default function EditorTabs({ tabs, activeTab, onTabSelect, onTabClose }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Horizontal scroll with mouse wheel
  const onWheel = (e: React.WheelEvent) => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft += e.deltaY;
    }
  };

  return (
    <div className="editor-tabs-wrap">
      <div
        className="editor-tabs"
        ref={scrollRef}
        onWheel={onWheel}
        role="tablist"
        aria-label="Open files"
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <div
              key={tab.id}
              className={`editor-tab ${isActive ? "active" : ""}`}
              role="tab"
              aria-selected={isActive}
              onClick={() => onTabSelect(tab.id)}
              title={tab.path}
            >
              <span className="tab-file-icon">
                <FileIcon name={tab.name} size={14} />
              </span>
              <span className="tab-name">{tab.name}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                aria-label={`Close ${tab.name}`}
                title={tab.modified ? "Unsaved changes" : `Close ${tab.name}`}
              >
                {tab.modified
                  ? <Circle size={8} className="tab-modified-dot" fill="currentColor" />
                  : <X size={12} />
                }
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
