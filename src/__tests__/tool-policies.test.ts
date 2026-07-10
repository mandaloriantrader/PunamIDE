/**
 * Unit tests for ToolPolicies — the command approval policy system.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveCommandPolicy,
  ApprovalMemory,
} from "../services/agent/ToolPolicies";

describe("resolveCommandPolicy", () => {
  it("returns auto policy for safe commands", () => {
    const policy = resolveCommandPolicy("safe");
    expect(policy.policy).toBe("auto");
    expect(policy.risk).toBe("safe");
  });

  it("returns auto policy for low-risk commands", () => {
    const policy = resolveCommandPolicy("low");
    expect(policy.policy).toBe("auto");
    expect(policy.risk).toBe("low");
  });

  it("returns once_session for medium-risk commands", () => {
    const policy = resolveCommandPolicy("medium");
    expect(policy.policy).toBe("once_session");
    expect(policy.risk).toBe("medium");
  });

  it("returns always for high-risk commands", () => {
    const policy = resolveCommandPolicy("high");
    expect(policy.policy).toBe("always");
    expect(policy.risk).toBe("high");
  });

  it("returns always for unknown risk levels", () => {
    const policy = resolveCommandPolicy("unknown_thing");
    expect(policy.policy).toBe("always");
  });
});

describe("ApprovalMemory", () => {
  let memory: ApprovalMemory;

  beforeEach(() => {
    memory = new ApprovalMemory();
  });

  it("auto-approves auto policy without any prior decisions", () => {
    const policy = resolveCommandPolicy("safe");
    expect(memory.isPreApproved("ls", policy)).toBe(true);
  });

  it("does not pre-approve high-risk commands without prior decision", () => {
    const policy = resolveCommandPolicy("high");
    expect(memory.isPreApproved("rm -rf /tmp/test", policy)).toBe(false);
  });

  it("remembers session-wide approval for once_session policy", () => {
    const policy = resolveCommandPolicy("medium");
    expect(memory.isPreApproved("npm install lodash", policy)).toBe(false);

    memory.recordApproval("npm install lodash", policy);

    // Now ANY medium-risk command is pre-approved for the session
    expect(memory.isPreApproved("npm install express", policy)).toBe(true);
  });

  it("remembers per-tool approval for always policy", () => {
    const policy = resolveCommandPolicy("high");
    memory.recordApproval("npm run build", policy);

    // Same pattern → approved
    expect(memory.isPreApproved("npm run build", policy)).toBe(true);
    // Different pattern → not approved
    expect(memory.isPreApproved("rm -rf dist", policy)).toBe(false);
  });

  it("tracks denials", () => {
    memory.recordDenial("dangerous-command");
    expect(memory.wasDenied("dangerous-command")).toBe(true);
    expect(memory.wasDenied("safe-command")).toBe(false);
  });

  it("groups npm subcommands as patterns", () => {
    const policy = resolveCommandPolicy("high");
    memory.recordApproval("npm install lodash", policy);

    // "npm install express" shares the "npm install" pattern
    expect(memory.isPreApproved("npm install express", policy)).toBe(true);
    // "npm run test" is a different pattern
    expect(memory.isPreApproved("npm run test", policy)).toBe(false);
  });

  it("resets all state", () => {
    const policy = resolveCommandPolicy("medium");
    memory.recordApproval("npm install x", policy);
    memory.recordDenial("bad-cmd");

    memory.reset();

    expect(memory.isPreApproved("npm install y", policy)).toBe(false);
    expect(memory.wasDenied("bad-cmd")).toBe(false);
  });
});
