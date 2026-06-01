/**
 * useAutoSave — Automatically saves modified tabs after a configurable delay.
 * Ported from Zenith IDE for Punam IDE.
 */

import { useEffect, useRef } from "react";
import { writeFile } from "../utils/tauri";
import { showToast } from "../utils/toast";

interface Tab {
  id: string;
  path: string;
  content: string;
  modified: boolean;
}

interface AutoSaveOptions {
  enabled: boolean;
  delay: number;
  tabs: Tab[];
  onTabSaved: (id: string) => void;
}

export function useAutoSave({ enabled, delay, tabs, onTabSaved }: AutoSaveOptions): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    const modifiedTabs = tabs.filter((t) => t.modified);
    if (modifiedTabs.length === 0) return;

    timerRef.current = setTimeout(async () => {
      for (const tab of modifiedTabs) {
        try {
          await writeFile(tab.path, tab.content);
          onTabSaved(tab.id);
        } catch (err) {
          showToast(`Auto-save failed: ${tab.path.split(/[\\/]/).pop()}`, "error");
          console.error("Auto-save failed:", tab.path, err);
        }
      }
    }, delay);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [enabled, delay, tabs, onTabSaved]);
}
