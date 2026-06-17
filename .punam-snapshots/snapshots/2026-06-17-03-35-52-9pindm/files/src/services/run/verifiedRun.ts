export interface RunObservation {
  id: string;
  command: string;
  status: "running" | "failed" | "ready" | "completed";
  output: string;
  url?: string;
  reason?: string;
}

const DEV_SERVER_URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)[^\s<>"')\]},;]*)/i;
const PROBLEM_RE =
  /\b(error|failed|exception|traceback|cannot find|module not found|failed to resolve|pre-transform error|syntaxerror|typeerror|referenceerror|port .*in use)\b/i;

export function detectDevServerUrl(output: string): string | null {
  const match = output.match(DEV_SERVER_URL_RE);
  if (!match) return null;
  return match[1].replace(/\.$/, "");
}

export function detectRunProblem(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const finalLines = lines.slice(-12);
  const hit = [...finalLines].reverse().find((line) => PROBLEM_RE.test(line));
  return hit || null;
}

export function createRunObservation(
  command: string,
  output: string,
  explicitStatus?: RunObservation["status"]
): RunObservation | null {
  const url = detectDevServerUrl(output);
  const reason = detectRunProblem(output);
  const status = explicitStatus || (reason ? "failed" : url ? "ready" : "running");

  if (status === "running") return null;

  return {
    id: `${command}|${status}|${url || ""}|${reason || ""}|${Date.now()}`,
    command,
    status,
    output,
    url: url || undefined,
    reason: reason || undefined,
  };
}
