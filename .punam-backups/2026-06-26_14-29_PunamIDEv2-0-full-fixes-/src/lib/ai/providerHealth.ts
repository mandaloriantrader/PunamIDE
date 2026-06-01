import type { ProviderHealthStatus } from "./providerCapabilities";

export interface ProviderHealthState {
  status: ProviderHealthStatus;
  reason?: string;
  updatedAt: number;
}

const providerHealth = new Map<string, ProviderHealthState>();
const TEMPORARY_HEALTH_TTL_MS = 5 * 60 * 1000;

export function getProviderHealth(providerId: string): ProviderHealthState {
  const state = providerHealth.get(providerId);
  if (!state) return { status: "healthy", updatedAt: 0 };
  if (state.status !== "invalid_key" && Date.now() - state.updatedAt > TEMPORARY_HEALTH_TTL_MS) {
    providerHealth.delete(providerId);
    return { status: "healthy", updatedAt: 0 };
  }
  return state;
}

export function setProviderHealth(providerId: string, status: ProviderHealthStatus, reason?: string): void {
  providerHealth.set(providerId, { status, reason, updatedAt: Date.now() });
}

export function markProviderHealthy(providerId: string): void {
  providerHealth.delete(providerId);
}

export function classifyProviderError(error: string | undefined): ProviderHealthStatus {
  const message = (error || "").toLowerCase();
  if (message.includes("401") || message.includes("403") || message.includes("invalid api key") || message.includes("unauthorized")) {
    return "invalid_key";
  }
  if (message.includes("429") || message.includes("rate limit") || message.includes("quota")) {
    return "rate_limited";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("404") || message.includes("not found") || message.includes("unavailable") || message.includes("model unavailable")) {
    return "unavailable";
  }
  return "unavailable";
}

export function describeHealthStatus(status: ProviderHealthStatus): string {
  switch (status) {
    case "invalid_key":
      return "invalid key";
    case "rate_limited":
      return "quota/rate limit hit";
    case "timeout":
      return "request timed out";
    case "unavailable":
      return "model/provider unavailable";
    default:
      return "healthy";
  }
}
