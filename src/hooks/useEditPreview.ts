/**
 * useEditPreview.ts — Cursor-like per-change diff preview before applying edits.
 *
 * Integrates with resolveEditOperations to show each EDIT block's changes
 * as a side-by-side diff before committing via apply_multi_patch.
 */
import { useState, useCallback } from "react";
import type { EditOperation } from "../utils/prompts";

export interface EditPreviewItem {
  filePath: string;
  searchText: string;
  replaceText: string;
  accepted: boolean;
}

export interface EditPreviewState {
  items: EditPreviewItem[];
  allAccepted: boolean;
}

/**
 * Hook: converts editOperations into a previewable list with accept/reject per item.
 * Call acceptItem()/rejectItem() to toggle, then applyAccepted() to send only accepted changes.
 */
export function useEditPreview() {
  const [preview, setPreview] = useState<EditPreviewState>({ items: [], allAccepted: false });

  /** Initialize preview from parsed edit operations */
  const buildPreview = useCallback((editOperations: EditOperation[]) => {
    const items: EditPreviewItem[] = [];
    for (const op of editOperations) {
      for (const pair of op.searchReplace) {
        items.push({
          filePath: op.path,
          searchText: pair.search,
          replaceText: pair.replace,
          accepted: true, // default: accept all, user can reject
        });
      }
    }
    setPreview({ items, allAccepted: items.every(i => i.accepted) });
  }, []);

  /** Toggle a specific item's accept status */
  const toggleItem = useCallback((index: number) => {
    setPreview(prev => {
      const items = [...prev.items];
      if (index >= 0 && index < items.length) {
        items[index] = { ...items[index], accepted: !items[index].accepted };
      }
      return { items, allAccepted: items.every(i => i.accepted) };
    });
  }, []);

  /** Accept all items */
  const acceptAll = useCallback(() => {
    setPreview(prev => ({
      items: prev.items.map(i => ({ ...i, accepted: true })),
      allAccepted: true,
    }));
  }, []);

  /** Reject all items */
  const rejectAll = useCallback(() => {
    setPreview(prev => ({
      items: prev.items.map(i => ({ ...i, accepted: false })),
      allAccepted: false,
    }));
  }, []);

  /** Get only the accepted edit operations for apply_multi_patch */
  const getAcceptedEdits = useCallback((): Array<{ path: string; searchReplace: Array<{ search: string; replace: string }> }> => {
    const byFile = new Map<string, Array<{ search: string; replace: string }>>();
    for (const item of preview.items) {
      if (!item.accepted) continue;
      const pairs = byFile.get(item.filePath) || [];
      pairs.push({ search: item.searchText, replace: item.replaceText });
      byFile.set(item.filePath, pairs);
    }
    return Array.from(byFile.entries()).map(([path, searchReplace]) => ({ path, searchReplace }));
  }, [preview.items]);

  /** Reset preview state */
  const reset = useCallback(() => {
    setPreview({ items: [], allAccepted: false });
  }, []);

  return {
    preview,
    buildPreview,
    toggleItem,
    acceptAll,
    rejectAll,
    getAcceptedEdits,
    reset,
  };
}