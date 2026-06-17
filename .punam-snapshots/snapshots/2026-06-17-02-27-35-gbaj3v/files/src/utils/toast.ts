/**
 * Global toast notification system.
 * Components can call showToast() without needing props from App.
 */

type ToastType = "info" | "success" | "error" | "warning";
type ToastListener = (message: string, type: ToastType) => void;

let listener: ToastListener | null = null;

/** Register the toast handler (called once from App.tsx) */
export function registerToastHandler(handler: ToastListener) {
  listener = handler;
}

/** Show a toast notification from anywhere in the app */
export function showToast(message: string, type: ToastType = "info") {
  if (listener) {
    listener(message, type);
  } else {
    // Fallback if handler not registered yet
    console.warn(`[Toast ${type}]: ${message}`);
  }
}
