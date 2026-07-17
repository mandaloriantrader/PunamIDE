/**
 * @phase P4
 * @purpose Manages individual semantic analysis rules. Each rule is
 *          a separate class implementing SemanticRule. Rules are
 *          registered and can be enabled/disabled via config.
 *          This separates rule logic from the analyzer orchestration.
 *
 * Compatibility note: written against ts-morph v24 API
 * (SyntaxKind numeric literals updated, getText() takes no sourceFile
 * argument, instanceof is a BinaryExpression, parameter lists are
 * accessed via getParameters()).
 */

import type { Finding, Severity } from './types';
import type { SourceFile } from 'ts-morph';
import { SyntaxKind, Node } from 'ts-morph';

/** A semantic analysis rule. */
export interface SemanticRule {
  id: string;
  name: string;
  severity: Severity;
  defaultEnabled: boolean;
  cwe?: string;
  run(sourceFile: SourceFile): Finding[];
}

// ts-morph v24 SyntaxKind values
const KIND = {
  CallExpression: 213,
  IfStatement: 245,
  AwaitExpression: 223,
  ReturnStatement: 253,
  ThrowStatement: 257,
  AsExpression: 234,
  NonNullExpression: 235,
  TypeOfExpression: 221,
  BinaryExpression: 226,
  ArrowFunction: 219,
  FunctionExpression: 218,
  Parameter: 169,
} as const;

// ═══════════════════════════════════════════════════════════════════
// Rule 1: Null/Undefined Mismatches
// ═══════════════════════════════════════════════════════════════════

/** Detects null/undefined mismatches across function boundaries. */
export class NullMismatchRule implements SemanticRule {
  id = 'null-mismatch';
  name = 'Null/Undefined Mismatch Detection';
  severity: Severity = 'high';
  defaultEnabled = true;
  cwe = 'CWE-476';

  run(sourceFile: SourceFile): Finding[] {
    const findings: Finding[] = [];
    const filePath = sourceFile.getFilePath();

    sourceFile.getFunctions().forEach(func => {
      const returnType = func.getReturnType();
      const returnText = returnType.getText();

      if (returnText.includes('null') || returnText.includes('undefined')) {
        const funcName = func.getName();
        if (!funcName) return;

        sourceFile.getDescendantsOfKind(KIND.CallExpression).forEach(call => {
          const callText = call.getText();
          const parent = call.getParent();
          if (parent) {
            const parentKind = parent.getKind();
            const parentText = parent.getText();

            const hasNullCheck =
              parentText.includes('!== null') ||
              parentText.includes('!= null') ||
              parentText.includes('!== undefined') ||
              parentText.includes('!= undefined') ||
              parentText.includes('?.') ||
              parentKind === KIND.IfStatement;

            if (!hasNullCheck && callText.includes(funcName)) {
              const line = call.getStartLineNumber();
              findings.push({
                id: `type:${filePath}:${line}:null-mismatch:${funcName}`,
                file: filePath,
                line,
                source: 'type',
                severity: this.severity,
                confidence: 'direct',
                title: `Possible null/undefined mismatch: ${funcName}() can return null`,
                description: `Function ${funcName}() can return null or undefined, but the return value is used without a null check at line ${line}.`,
                whyFlagged: `Return type "${returnText}" includes null/undefined, but no null guard found at call site.`,
                cwe: this.cwe,
                fix: `Add a null check: if (result !== null) { ... } or use optional chaining: result?.property`,
              });
            }
          }
        });
      }
    });

    return findings;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Rule 2: Unhandled Promise Rejections
// ═══════════════════════════════════════════════════════════════════

/** Detects unhandled promise rejections and floating promises. */
export class UnhandledPromiseRule implements SemanticRule {
  id = 'unhandled-promise';
  name = 'Unhandled Promise Rejection Detection';
  severity: Severity = 'high';
  defaultEnabled = true;
  cwe = 'CWE-754';

  run(sourceFile: SourceFile): Finding[] {
    const findings: Finding[] = [];
    const filePath = sourceFile.getFilePath();

    sourceFile.getDescendantsOfKind(KIND.CallExpression).forEach(call => {
      const callText = call.getText();
      const parent = call.getParent();
      if (!parent) return;

      const parentKind = parent.getKind();
      const parentText = parent.getText();

      const isAwaited = parentKind === KIND.AwaitExpression;
      const hasThen = parentText.includes('.then(');
      const hasCatch = parentText.includes('.catch(');
      const hasFinally = parentText.includes('.finally(');

      try {
        const returnType = call.getReturnType();
        const returnText = returnType.getText();

        if (returnText.includes('Promise<') && !isAwaited && !hasThen && !hasCatch && !hasFinally) {
          const line = call.getStartLineNumber();
          findings.push({
            id: `type:${filePath}:${line}:unhandled-promise`,
            file: filePath,
            line,
            source: 'type',
            severity: this.severity,
            confidence: 'direct',
            title: 'Unhandled promise rejection (floating promise)',
            description: `A promise-returning call at line ${line} is not awaited and has no .catch() handler. Rejections will be silently swallowed.`,
            whyFlagged: `Return type "${returnText}" is a Promise, but the call is not awaited and has no error handler.`,
            cwe: this.cwe,
            fix: 'Add `await` and wrap in try/catch, or chain `.catch(err => ...)` to handle rejections.',
          });
        }
      } catch {
        // Type resolution may fail for some expressions — skip gracefully
      }
    });

    sourceFile.getDescendantsOfKind(KIND.CallExpression).forEach(call => {
      const callText = call.getText();
      if (callText.includes('.then(') && !callText.includes('.catch(') && !callText.includes('.finally(')) {
        const line = call.getStartLineNumber();
        const existing = findings.find(f => f.line === line && f.id.includes('unhandled-promise'));
        if (!existing) {
          findings.push({
            id: `type:${filePath}:${line}:then-no-catch`,
            file: filePath,
            line,
            source: 'type',
            severity: 'medium',
            confidence: 'direct',
            title: 'Promise .then() without .catch()',
            description: `A promise chain at line ${line} has .then() but no .catch(). Rejections will be unhandled.`,
            whyFlagged: '.then() found without corresponding .catch() or .finally()',
            cwe: this.cwe,
            fix: 'Add .catch(err => { ... }) to handle potential rejections.',
          });
        }
      }
    });

    return findings;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Rule 3: Unsafe Type Assertions
// ═══════════════════════════════════════════════════════════════════

/** Detects `as any`, non-null assertion overuse, and double assertions. */
export class UnsafeAssertionRule implements SemanticRule {
  id = 'unsafe-assertion';
  name = 'Unsafe Type Assertion Detection';
  severity: Severity = 'medium';
  defaultEnabled = true;

  run(sourceFile: SourceFile): Finding[] {
    const findings: Finding[] = [];
    const filePath = sourceFile.getFilePath();

    const asAnyCount = (sourceFile.getFullText().match(/\bas\s+any\b/g) || []).length;
    if (asAnyCount > 0) {
      sourceFile.getDescendantsOfKind(KIND.AsExpression).forEach(asExpr => {
        const text = asExpr.getText();
        if (text.includes('as any')) {
          const line = asExpr.getStartLineNumber();
          findings.push({
            id: `type:${filePath}:${line}:as-any`,
            file: filePath,
            line,
            source: 'type',
            severity: 'medium',
            confidence: 'direct',
            title: '`as any` type assertion bypasses type checking',
            description: `Using 'as any' at line ${line} disables type checking for this expression. This can hide real type errors.`,
            whyFlagged: '`as any` assertion found — this silences the type checker entirely.',
            fix: 'Use a proper type assertion or type guard. If the type is truly unknown, use `unknown` and narrow it.',
          });
        }
      });
    }

    const nonNullAssertions = sourceFile.getDescendantsOfKind(KIND.NonNullExpression);
    if (nonNullAssertions.length > 3) {
      findings.push({
        id: `type:${filePath}:0:nonnull-overuse:${nonNullAssertions.length}`,
        file: filePath,
        source: 'type',
        severity: 'medium',
        confidence: 'direct',
        title: `Excessive non-null assertions (${nonNullAssertions.length})`,
        description: `This file has ${nonNullAssertions.length} non-null assertions (!). More than 3 suggests the types are not accurately representing nullability.`,
        whyFlagged: `nonNullAssertionCount = ${nonNullAssertions.length} (threshold: 3)`,
        fix: 'Fix the type definitions to accurately reflect nullability instead of using ! to suppress errors.',
      });
    }

    const doubleAssertionPattern = /as\s+unknown\s+as\s+/g;
    const fullText = sourceFile.getFullText();
    let match;
    while ((match = doubleAssertionPattern.exec(fullText)) !== null) {
      const line = fullText.substring(0, match.index).split('\n').length;
      findings.push({
        id: `type:${filePath}:${line}:double-assertion`,
        file: filePath,
        line,
        source: 'type',
        severity: 'high',
        confidence: 'direct',
        title: 'Double type assertion (as unknown as X)',
        description: `Double assertion at line ${line} bypasses TypeScript's type safety checks. This is almost always a type error being suppressed.`,
        whyFlagged: 'as unknown as X pattern detected — this circumvents the type system entirely.',
        fix: 'Fix the underlying type mismatch. If the types are genuinely incompatible, reconsider the data model.',
      });
    }

    return findings;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Rule 4: Unreachable Code
// ═══════════════════════════════════════════════════════════════════

/** Detects unreachable code after return/throw and in dead branches. */
export class UnreachableCodeRule implements SemanticRule {
  id = 'unreachable-code';
  name = 'Unreachable Code Detection';
  severity: Severity = 'low';
  defaultEnabled = true;

  run(sourceFile: SourceFile): Finding[] {
    const findings: Finding[] = [];
    const filePath = sourceFile.getFilePath();

    sourceFile.getFunctions().forEach(func => {
      const body = func.getBody();
      if (!body || !Node.isBlock(body)) return;

      const statements = body.getStatements();
      let foundTerminal = false;

      for (const stmt of statements) {
        const kind = stmt.getKind();
        if (kind === KIND.ReturnStatement || kind === KIND.ThrowStatement) {
          foundTerminal = true;
          continue;
        }
        if (foundTerminal) {
          const line = stmt.getStartLineNumber();
          findings.push({
            id: `type:${filePath}:${line}:unreachable`,
            file: filePath,
            line,
            source: 'type',
            severity: this.severity,
            confidence: 'direct',
            title: 'Unreachable code after return/throw',
            description: `Code at line ${line} is unreachable because it follows a return or throw statement.`,
            whyFlagged: 'Statement follows a terminal (return/throw) statement in the same block.',
            fix: 'Remove the unreachable code or move the return/throw to the correct position.',
          });
          break;
        }
      }
    });

    return findings;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Rule 5: Implicit Any Leakage
// ═══════════════════════════════════════════════════════════════════

/** Detects implicit any in exported functions and noImplicitAny violations. */
export class ImplicitAnyRule implements SemanticRule {
  id = 'implicit-any';
  name = 'Implicit Any Leakage Detection';
  severity: Severity = 'medium';
  defaultEnabled = true;

  run(sourceFile: SourceFile): Finding[] {
    const findings: Finding[] = [];
    const filePath = sourceFile.getFilePath();

    sourceFile.getFunctions().forEach(func => {
      if (!func.isExported()) return;

      func.getParameters().forEach(param => {
        const paramText = param.getText();
        if (!paramText.includes(':') && !paramText.includes('...')) {
          const line = param.getStartLineNumber();
          findings.push({
            id: `type:${filePath}:${line}:implicit-any:${param.getName()}`,
            file: filePath,
            line,
            source: 'type',
            severity: this.severity,
            confidence: 'direct',
            title: `Implicit any in exported function parameter: ${param.getName()}`,
            description: `Parameter "${param.getName()}" in exported function "${func.getName() ?? 'anonymous'}" has no type annotation. This leaks 'any' into the public API.`,
            whyFlagged: 'Exported function parameter without type annotation — implicit any.',
            fix: `Add an explicit type annotation: ${param.getName()}: <expectedType>`,
          });
        }
      });
    });

    sourceFile.getVariableStatements().forEach(varStmt => {
      if (!varStmt.isExported()) return;

      varStmt.getDeclarations().forEach(decl => {
        const initializer = decl.getInitializer();
        if (!initializer) return;

        if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
          initializer.getParameters().forEach(param => {
            const paramText = param.getText();
            if (!paramText.includes(':')) {
              const line = param.getStartLineNumber();
              findings.push({
                id: `type:${filePath}:${line}:implicit-any-arrow:${param.getText()}`,
                file: filePath,
                line,
                source: 'type',
                severity: this.severity,
                confidence: 'direct',
                title: `Implicit any in exported arrow function parameter`,
                description: `Parameter "${paramText}" in an exported arrow function has no type annotation.`,
                whyFlagged: 'Exported arrow function parameter without type annotation — implicit any.',
                fix: 'Add an explicit type annotation to the parameter.',
              });
            }
          });
        }
      });
    });

    return findings;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Rule 6: Type Narrowing Errors
// ═══════════════════════════════════════════════════════════════════

/** Detects typeof checks on wrong types and instanceof on non-class values. */
export class TypeNarrowingRule implements SemanticRule {
  id = 'type-narrowing';
  name = 'Type Narrowing Error Detection';
  severity: Severity = 'low';
  defaultEnabled = true;

  run(sourceFile: SourceFile): Finding[] {
    const findings: Finding[] = [];
    const filePath = sourceFile.getFilePath();

    sourceFile.getDescendantsOfKind(KIND.TypeOfExpression).forEach(typeofExpr => {
      const parent = typeofExpr.getParent();
      if (!parent) return;

      const parentText = parent.getText();
      const invalidTypeStrings = ['null', 'array', 'list', 'int', 'float', 'double', 'boolean'];
      for (const invalid of invalidTypeStrings) {
        if (parentText.includes(`'${invalid}'`) || parentText.includes(`"${invalid}"`)) {
          const line = typeofExpr.getStartLineNumber();
          findings.push({
            id: `type:${filePath}:${line}:typeof-invalid:${invalid}`,
            file: filePath,
            line,
            source: 'type',
            severity: this.severity,
            confidence: 'direct',
            title: `Invalid typeof comparison: typeof x === '${invalid}'`,
            description: `typeof never returns "${invalid}". This comparison will always be false.`,
            whyFlagged: `typeof comparison against invalid string "${invalid}"`,
            fix: invalid === 'null'
              ? 'Use `x === null` instead of `typeof x === "null"`.'
              : `Use the correct typeof return value or use instanceof.`,
          });
        }
      }
    });

    // instanceof is a BinaryExpression with operator token `instanceof`
    sourceFile.getDescendantsOfKind(KIND.BinaryExpression).forEach(binExpr => {
      const operatorToken = binExpr.getOperatorToken();
      if (operatorToken.getKind() !== SyntaxKind.InstanceOfKeyword) return;
      try {
        const rightSide = binExpr.getRight();
        const rightType = rightSide.getType();
        const rightText = rightSide.getText();

        if (!rightType.isClass() && !rightType.isClassOrInterface()) {
          const line = binExpr.getStartLineNumber();
          findings.push({
            id: `type:${filePath}:${line}:instanceof-nonclass`,
            file: filePath,
            line,
            source: 'type',
            severity: this.severity,
            confidence: 'direct',
            title: `instanceof used with non-class type: ${rightText}`,
            description: `The right-hand side of instanceof at line ${line} is not a class. instanceof only works with class constructors.`,
            whyFlagged: `instanceof right side "${rightText}" is not a class type.`,
            fix: 'Use typeof or a type guard function instead of instanceof for non-class types.',
          });
        }
      } catch {
        // Type resolution may fail — skip gracefully
      }
    });

    return findings;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Rule Engine
// ═══════════════════════════════════════════════════════════════════

/**
 * Manages semantic analysis rules. Rules are registered and can be
 * enabled/disabled via config. This separates rule logic from the
 * analyzer orchestration.
 */
export class SemanticRuleEngine {
  private rules: Map<string, SemanticRule> = new Map();

  constructor() {
    this.register(new NullMismatchRule());
    this.register(new UnhandledPromiseRule());
    this.register(new UnsafeAssertionRule());
    this.register(new UnreachableCodeRule());
    this.register(new ImplicitAnyRule());
    this.register(new TypeNarrowingRule());
  }

  register(rule: SemanticRule): void {
    this.rules.set(rule.id, rule);
  }

  unregister(id: string): void {
    this.rules.delete(id);
  }

  getRule(id: string): SemanticRule | undefined {
    return this.rules.get(id);
  }

  getAllRules(): SemanticRule[] {
    return Array.from(this.rules.values());
  }

  runAll(
    sourceFile: SourceFile,
    enabledRuleIds?: string[],
    maxPerRule: number = 50,
  ): Finding[] {
    const allFindings: Finding[] = [];

    for (const rule of this.rules.values()) {
      const isEnabled = enabledRuleIds
        ? enabledRuleIds.includes(rule.id)
        : rule.defaultEnabled;

      if (!isEnabled) continue;

      try {
        const ruleFindings = rule.run(sourceFile);
        allFindings.push(...ruleFindings.slice(0, maxPerRule));
      } catch (err) {
        console.error(`Semantic rule ${rule.id} failed:`, err);
      }
    }

    return allFindings;
  }
}

// ── Singleton pattern (follows existing codebase convention) ───────
let instance: SemanticRuleEngine | null = null;

export function getSemanticRuleEngine(): SemanticRuleEngine {
  if (!instance) instance = new SemanticRuleEngine();
  return instance;
}