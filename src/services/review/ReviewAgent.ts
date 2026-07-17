/**
 * @phase P6
 * @purpose The LLM Review Agent — the key market differentiator.
 *
 * Design principles (settled in prior discussion, restated as spec):
 * - New agent role, not a reused instance. A model reviewing its own
 *   freshly-generated output shares the same blind spots. The Review
 *   Agent is structurally independent: read-only, cannot write, runs
 *   after implementation, can flag/veto.
 * - Reuses existing 8-provider abstraction (including local Ollama
 *   for privacy-sensitive teams). Does NOT build a second routing system.
 * - Model selection is configurable and can differ from the coding
 *   agent's model — review runs once per patch, so spending more on
 *   a stronger model is justified.
 * - Prompt stance is adversarial: "find what's wrong with this patch."
 *   Grounded in dependency graph, coupling data, and architecture layer
 *   membership — codebase-aware, not diff-isolated.
 * - Input context per review call: diff + immediate file context +
 *     graph-derived context (callers, callees, layer, coupling, debt).
 *     NOT the whole repository, to keep cost and latency bounded.
 */

import { type Finding, type ReviewAgentConfig } from './types';
import { type LLMProvider, type LLMRequest, type LLMResponse } from './LLMProviderInterface';
import { type ReviewContext } from './ReviewContextAssembler';

/** Default system prompt for the Review Agent (adversarial stance). */
const DEFAULT_SYSTEM_PROMPT = `You are an adversarial code reviewer. Your job is to find what is WRONG with this patch, not what is good about it.

## Rules
1. Be adversarial — assume there IS a bug. Find it.
2. Ground your reasoning in the provided dependency graph, coupling data, and architecture context.
3. Do NOT flag style preferences as bugs. Distinguish "this is wrong" from "this could be better."
4. Provide concrete fixes, not just observations. Suggest specific code changes.
5. Acknowledge uncertainty — don't claim certainty where none exists. Use confidence levels.
6. Focus on: logic errors, missing error handling, race conditions, security issues, incorrect state management, missing backoff/retry logic, incorrect cache key scoping, off-by-one errors, null/undefined access without guards.
7. Do NOT repeat findings that are already listed in "Existing Findings" — those were caught by static analysis. Find what static analysis MISSED.
8. For each finding, output a JSON object with: title, severity (critical/high/medium/low), description, whyFlagged, fix, file, line (if known).

## Output Format
Output a JSON array of findings. Each finding must have:
{
  "title": "Short description",
  "severity": "critical" | "high" | "medium" | "low",
  "description": "Detailed explanation of the issue",
  "whyFlagged": "What specific pattern or risk triggered this finding",
  "fix": "Concrete suggested fix",
  "file": "File path (if known from the diff)",
  "line": <line number or null>
}

If you find no issues, output an empty array: []`;

/**
 * The LLM Review Agent. Structurally independent from the coding agent.
 * Read-only, cannot write, runs after implementation, can flag/veto.
 */
export class ReviewAgent {
  private config: ReviewAgentConfig;
  private provider: LLMProvider;

  constructor(provider: LLMProvider, config: ReviewAgentConfig) {
    this.provider = provider;
    this.config = config;
  }

  /**
   * Reviews a code patch with full codebase context.
   *
   * @param diff - The code diff being reviewed
   * @param context - Assembled context (graph, coupling, churn, existing findings)
   * @returns Findings with source='review-agent'
   */
  async reviewPatch(diff: string, context: ReviewContext): Promise<Finding[]> {
    // Build the user prompt from the context
    const userPrompt = this.buildUserPrompt(diff, context);

    // Build the system prompt (with optional custom additions)
    const systemPrompt = this.config.customPromptAdditions
      ? `${DEFAULT_SYSTEM_PROMPT}\n\n## Additional Instructions\n${this.config.customPromptAdditions}`
      : DEFAULT_SYSTEM_PROMPT;

    // Call the LLM
    const request: LLMRequest = {
      model: this.config.modelId,
      systemPrompt,
      userPrompt,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    };

    let response: LLMResponse;
    try {
      response = await this.provider.complete(request);
    } catch (err) {
      console.error('Review Agent LLM call failed:', err);
      return []; // Degrade gracefully
    }

    // Parse the LLM response into Findings
    return this.parseResponse(response.content, context);
  }

  /**
   * Builds the user prompt from the diff and context.
   */
  private buildUserPrompt(diff: string, context: ReviewContext): string {
    const sections: string[] = [];

    sections.push('## Code Diff Under Review');
    sections.push('```diff');
    sections.push(diff.substring(0, 8000)); // Bound diff size
    sections.push('```');

    sections.push('\n## Changed Files');
    for (const f of context.changedFiles) {
      sections.push(`- ${f.path} (+${f.addedLines} -${f.deletedLines} lines)`);
    }

    sections.push('\n## Dependency Graph Context (codebase-aware, not diff-isolated)');
    for (const g of context.graphContext) {
      sections.push(`### ${g.file}`);
      sections.push(`- Architecture layer: ${g.layer}`);
      sections.push(`- Instability: ${g.instability.toFixed(2)} (0=stable, 1=unstable)`);
      sections.push(`- Callers (who imports this): ${g.callers.join(', ') || 'none'}`);
      sections.push(`- Callees (what this imports): ${g.callees.join(', ') || 'none'}`);
    }

    sections.push('\n## Architecture Violations');
    if (context.architectureContext.violatedRules.length > 0) {
      for (const rule of context.architectureContext.violatedRules) {
        sections.push(`- ${rule}`);
      }
    } else {
      sections.push('No architecture violations detected by static analysis.');
    }

    sections.push('\n## Churn Data (change frequency)');
    for (const c of context.churnContext) {
      sections.push(`- ${c.file}: ${c.commitsLast30d} commits in last 30 days, last modified: ${c.lastModified}`);
    }

    sections.push('\n## Existing Findings (from static analysis — DO NOT repeat these)');
    if (context.existingFindings.length > 0) {
      for (const f of context.existingFindings) {
        sections.push(`- [${f.severity}] ${f.source}: ${f.title} at ${f.file}:${f.line ?? '?'}`);
      }
    } else {
      sections.push('No static analysis findings for these files.');
    }

    sections.push('\n## Your Task');
    sections.push('Find bugs and issues that static analysis CANNOT detect. Focus on:');
    sections.push('- Logic errors (syntactically and type-correct but behaviorally wrong)');
    sections.push('- Missing backoff/retry logic');
    sections.push('- Incorrect cache key scoping');
    sections.push('- Race conditions');
    sections.push('- Missing error handling for edge cases');
    sections.push('- Security issues that pattern matching would miss');
    sections.push('- State management bugs');
    sections.push('');
    sections.push('Output your findings as a JSON array. If no issues found, output [].');

    return sections.join('\n');
  }

  /**
   * Parses the LLM response into Finding[].
   */
  private parseResponse(content: string, context: ReviewContext): Finding[] {
    // Try to extract JSON from the response
    let jsonText = content.trim();

    // Handle markdown code blocks
    const jsonBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      jsonText = jsonBlockMatch[1].trim();
    }

    // Try to find a JSON array in the response
    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonText = arrayMatch[0];
    }

    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) return [];

      return parsed.map((item: {
        title?: string;
        severity?: string;
        description?: string;
        whyFlagged?: string;
        fix?: string;
        file?: string;
        line?: number | null;
      }, index: number): Finding => {
        const file = item.file || context.changedFiles[0]?.path || 'unknown';
        const line = item.line ?? undefined;

        return {
          id: `review-agent:${file}:${line ?? index}:${this.hashTitle(item.title ?? '')}`,
          file,
          line: line ?? undefined,
          source: 'review-agent',
          severity: this.validateSeverity(item.severity),
          confidence: 'heuristic', // LLM findings are inherently heuristic
          title: item.title || 'Untitled finding',
          description: item.description || '',
          whyFlagged: item.whyFlagged || '',
          fix: item.fix,
        };
      });
    } catch (err) {
      console.error('Failed to parse Review Agent response as JSON:', err);
      return [];
    }
  }

  /**
   * Validates and normalizes severity values from the LLM.
   */
  private validateSeverity(severity?: string): 'critical' | 'high' | 'medium' | 'low' | 'info' {
    const valid = ['critical', 'high', 'medium', 'low', 'info'];
    const lower = (severity ?? 'medium').toLowerCase();
    return (valid.includes(lower) ? lower : 'medium') as 'critical' | 'high' | 'medium' | 'low' | 'info';
  }

  /**
   * Creates a simple hash for generating unique finding IDs.
   */
  private hashTitle(title: string): string {
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
      const char = title.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Updates the agent's configuration.
   */
  updateConfig(config: Partial<ReviewAgentConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Gets the current configuration.
   */
  getConfig(): ReviewAgentConfig {
    return { ...this.config };
  }
}

// Re-export ReviewContext for convenience
export type { ReviewContext, ChangedFileInfo, GraphContext, ArchitectureContext, ChurnContext } from './ReviewContextAssembler';

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: ReviewAgent | null = null;

/**
 * Gets the singleton ReviewAgent instance.
 * Must be initialized first via initReviewAgent() with provider and config.
 */
export function getReviewAgent(): ReviewAgent {
  if (!instance) throw new Error('ReviewAgent not initialized. Call initReviewAgent() first.');
  return instance;
}

/**
 * Initializes the singleton ReviewAgent with provider and config.
 * @param provider - LLM provider
 * @param config - Review agent configuration
 */
export function initReviewAgent(provider: import('./LLMProviderInterface').LLMProvider, config: import('./types').ReviewAgentConfig): ReviewAgent {
  instance = new ReviewAgent(provider, config);
  return instance;
}
