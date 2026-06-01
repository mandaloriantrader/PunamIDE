import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { logger } from "./Logger";
import { APP_NAME, DEFAULT_PANEL_ERROR_MESSAGE, UNKNOWN_PANEL_ERROR_MESSAGE, FULL_APP_ERROR_MESSAGE, DEFAULT_ERROR_MESSAGE, DEFAULT_ERROR_DESCRIPTION, RELOAD_BUTTON_TEXT } from "../lib/constants";

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/** Panel-level error boundary — catches errors in a section without crashing the whole app */
export class PanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error(`[${APP_NAME} Panel Error] ${this.props.fallbackLabel || UNKNOWN_PANEL_ERROR_MESSAGE}:`, { error, componentStack: info.componentStack });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 12,
          color: "var(--text-muted)",
          fontSize: 13,
          textAlign: "center",
          height: "100%",
        }}>
          <span style={{ fontSize: 24 }}>⚠️</span>
          <p><strong>{this.props.fallbackLabel || DEFAULT_PANEL_ERROR_MESSAGE} crashed</strong></p>
          <p style={{ fontSize: 11, opacity: 0.7 }}>{this.state.error?.message?.slice(0, 100)}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: "6px 14px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

/** Full-app error boundary — shows reload screen */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error(FULL_APP_ERROR_MESSAGE, { error, componentStack: info.componentStack });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "#1e1e2e",
          color: "#cdd6f4",
          fontFamily: "system-ui, sans-serif",
          padding: 32,
          textAlign: "center",
        }}>
          <h1 style={{ fontSize: 24, marginBottom: 16, color: "#f38ba8" }}>
            {DEFAULT_ERROR_MESSAGE}
          </h1>
          <p style={{ fontSize: 14, color: "#a6adc8", maxWidth: 500, marginBottom: 24 }}>
            {DEFAULT_ERROR_DESCRIPTION}
          </p>
          <pre style={{
            fontSize: 12,
            color: "#f38ba8",
            background: "#181825",
            padding: 16,
            borderRadius: 8,
            maxWidth: 600,
            overflow: "auto",
            marginBottom: 24,
          }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "10px 24px",
              background: "#89b4fa",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {RELOAD_BUTTON_TEXT}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
