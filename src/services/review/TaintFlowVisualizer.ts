/**
 * @phase P5
 * @purpose Produces human-readable taint flow descriptions for the UI.
 *          Given a TaintFlow, produces a step-by-step trace string
 *          that feeds into Finding.description and Finding.whyFlagged.
 */

import { type TaintFlow } from './TaintTracker';

/**
 * Visualizes taint flows as human-readable step-by-step traces.
 */
export class TaintFlowVisualizer {
  /**
   * Produces a step-by-step trace string for a taint flow.
   *
   * Example output:
   *   Source: req.body at server.ts:12 → passed to sanitizeInput() at utils.ts:45
   *   → reaches eval() at engine.ts:89
   *
   * @param flow - The taint flow to visualize
   * @returns Human-readable trace string
   */
  visualize(flow: TaintFlow): string {
    const steps: string[] = [];

    for (let i = 0; i < flow.path.length; i++) {
      const node = flow.path[i];

      if (i === 0) {
        // Source node
        steps.push(`Source: ${node.variable} at ${this.formatLocation(node.file, node.line)}`);
      } else if (i === flow.path.length - 1 && node.operation === 'sink') {
        // Sink node
        steps.push(`reaches ${flow.sink.name} at ${this.formatLocation(node.file, node.line)}`);
      } else if (node.operation === 'import') {
        // Intermediate import hop
        steps.push(`imported into ${this.formatLocation(node.file, node.line)}`);
      } else {
        // Generic intermediate step
        steps.push(`${node.operation}: ${node.variable} at ${this.formatLocation(node.file, node.line)}`);
      }
    }

    const trace = steps.join(' → ');
    const confidence = ` [confidence: ${flow.confidence}]`;
    const cwe = flow.cwe ? ` [${flow.cwe}]` : '';

    return `${trace}${confidence}${cwe}`;
  }

  /**
   * Produces a compact one-line summary for list views.
   */
  summarize(flow: TaintFlow): string {
    const source = flow.path[0];
    const sink = flow.path[flow.path.length - 1];
    const hops = flow.path.length - 1;
    return `${flow.source.name} → ${flow.sink.name} (${hops} hop${hops !== 1 ? 's' : ''}, ${flow.confidence})`;
  }

  /**
   * Produces a detailed multi-line report for detail views.
   */
  detail(flow: TaintFlow): string {
    const lines: string[] = [
      `Taint Flow Report`,
      `══════════════════════════════════════════════════`,
      ``,
      `Source: ${flow.source.name} (${flow.source.cwe})`,
      `Sink:   ${flow.sink.name} (${flow.sink.cwe})`,
      `Confidence: ${flow.confidence}`,
      ``,
      `Trace:`,
    ];

    for (let i = 0; i < flow.path.length; i++) {
      const node = flow.path[i];
      const prefix = i === 0 ? '  →' : '  →';
      lines.push(`${prefix} [${i}] ${node.operation}: ${node.variable} at ${node.file}:${node.line}`);
    }

    lines.push(``, `OWASP: ${flow.source.owaspCategory}`, `CWE: ${flow.cwe}`);

    return lines.join('\n');
  }

  /**
   * Formats a file:line location, handling missing line numbers.
   */
  private formatLocation(file: string, line: number): string {
    return line > 0 ? `${file}:${line}` : file;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: TaintFlowVisualizer | null = null;

/**
 * Gets the singleton TaintFlowVisualizer instance.
 * Every service uses this pattern: `let instance: T | null = null`
 * with an exported `getXxx(): T` getter.
 */
export function getTaintFlowVisualizer(): TaintFlowVisualizer {
  if (!instance) instance = new TaintFlowVisualizer();
  return instance;
}
