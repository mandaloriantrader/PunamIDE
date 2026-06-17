/**
 * useKeyboardShortcuts — Global keyboard shortcut system with customizable bindings.
 * Ported from Zenith IDE for Punam IDE.
 */

import { useEffect } from "react";

export interface Keybinding {
  id: string;
  label: string;
  keys: string;
  command: string;
  category: string;
}

export interface ShortcutHandler {
  command: string;
  handler: () => void;
}

function parseKeybinding(keys: string): {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
} {
  const parts = keys.toLowerCase().split("+").map((p) => p.trim());
  return {
    ctrlKey: parts.includes("ctrl") || parts.includes("cmd"),
    shiftKey: parts.includes("shift"),
    altKey: parts.includes("alt"),
    key: parts.filter((p) => !["ctrl", "cmd", "shift", "alt"].includes(p))[0] || "",
  };
}

function matchesKeybinding(
  event: KeyboardEvent,
  binding: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string }
): boolean {
  const eventKey = event.key.toLowerCase() === " " ? "space" : event.key.toLowerCase();
  return (
    event.ctrlKey === binding.ctrlKey &&
    event.shiftKey === binding.shiftKey &&
    event.altKey === binding.altKey &&
    eventKey === binding.key
  );
}

/**
 * Hook that registers global keyboard shortcuts.
 * @param keybindings - Array of keybinding definitions
 * @param handlers - Array of command handlers to register
 */
export function useKeyboardShortcuts(
  keybindings: Keybinding[],
  handlers: ShortcutHandler[]
): void {
  useEffect(() => {
    const handlerMap: Record<string, () => void> = {};
    for (const h of handlers) {
      handlerMap[h.command] = h.handler;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      for (const kb of keybindings) {
        const binding = parseKeybinding(kb.keys);
        if (matchesKeybinding(e, binding)) {
          const handler = handlerMap[kb.command];
          if (handler) {
            e.preventDefault();
            e.stopPropagation();
            handler();
            return;
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keybindings, handlers]);
}
