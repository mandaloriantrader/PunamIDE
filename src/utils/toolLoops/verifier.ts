// src/utils/toolLoops/verifier.ts
//
// Phase 2: Auto-verification stage — runs typecheck/lint/test after patches, retries on failure.

import { executeAgentTool, type ToolCall } from "../agentTools";
import { type ToolLoopOptions, type VerifyResult } from "./shared";

// ── Verification command detection ───────────────────────────────────────────

/** Auto-detect what verification commands to run based on project structure */
export async function detectVerificationCommands(projectPath: string): Promise<string[]> {
  const commands: string[] = [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const pkgExists = await invoke<boolean>("path_exists", { path: "package.json" });
    if (pkgExists) {
      try {
        const pkgContent = await invoke<string>("read_file", { path: "package.json" });
        const pkg = JSON.parse(pkgContent);
        if (pkg.scripts?.typecheck) commands.push("npm run typecheck 2>&1");
        else if (pkg.scripts?.["type-check"]) commands.push("npm run type-check 2>&1");
        else if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
          const tsconfigExists = await invoke<boolean>("path_exists", { path: "tsconfig.json" });
          if (tsconfigExists) commands.push("npx tsc --noEmit 2>&1");
        }
        if (pkg.scripts?.lint) commands.push("npm run lint 2>&1");
        if (pkg.scripts?.test && !/no test/i.test(pkg.scripts.test)) {
          commands.push("npm test -- --run 2>&1");
        }
      } catch { /* package.json parse failed — skip */ }
    }
    const cargoExists = await invoke<boolean>("path_exists", { path: "Cargo.toml" });
    if (cargoExists) {
      commands.push("cargo check 2>&1");
    }
    const pyprojectExists = await invoke<boolean>("path_exists", { path: "pyproject.toml" });
    if (pyprojectExists) {
      commands.push("ruff check . 2>&1");
    }
  } catch { /* detection failed — skip */ }
  return commands;
}

// ── Verification runner ──────────────────────────────────────────────────────

/** Run verification commands and return results */
export async function runVerification(
  projectPath: string,
  opts: ToolLoopOptions,
  retryCount: number,
): Promise<VerifyResult> {
  const verifCommands = await detectVerificationCommands(projectPath);
  if (verifCommands.length === 0) {
    return { passed: true, checks: [], retryCount };
  }

  const checks: VerifyResult["checks"] = [];
  let allPassed = true;

  for (const cmd of verifCommands) {
    try {
      const result = await executeAgentTool(
        { name: "run_command", input: { command: cmd, cwd: projectPath }, id: `verify-${Date.now()}` } as unknown as ToolCall,
        projectPath
      );
      const output = result.content.slice(0, 2000);
      const failed = result.is_error ||
        (/\berror\b/i.test(output) && !/0 errors|no errors|error 0/i.test(output)) ||
        result.content.includes("FAIL") ||
        result.content.includes("failed");
      checks.push({ name: cmd, passed: !failed, output });
      if (failed) allPassed = false;
    } catch (err) {
      checks.push({ name: cmd, passed: false, output: String(err).slice(0, 500) });
      allPassed = false;
    }
  }

  const verifyResult: VerifyResult = { passed: allPassed, checks, retryCount };
  opts.onVerifyResult?.(verifyResult);
  return verifyResult;
}
