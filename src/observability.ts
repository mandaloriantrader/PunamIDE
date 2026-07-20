import * as Sentry from "@sentry/react";
import { error, info } from "@tauri-apps/plugin-log";
import { SENTRY_DSN } from "./config/alpha";

export function initObservability() {
  info("PunamIDE observability initialized").catch(() => {});

  window.addEventListener("error", (event) => {
    error(`UI error: ${event.message}`).catch(() => {});
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    error(`Unhandled promise rejection: ${reason}`).catch(() => {});
  });

  if (SENTRY_DSN) {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: import.meta.env.MODE,
      release: "punamide@2.1.4",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
  }
}
