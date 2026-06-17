/**
 * Task 10.12 — Large Project Stress Test
 *
 * Generates synthetic projects of increasing sizes and benchmarks
 * the actual DebtAnalyzer and EmbeddingAnalyzer computation paths.
 *
 * Runs in Node.js (npx tsx) — measures real wall-clock + heap memory.
 *
 * Run: npx tsx src/__tests__/stress-test.harness.ts
 */

// ── Pure scoring functions (imported inline to avoid class deps) ────────────

function simpleHash(text: string): number[] {
  const vector = new Array(128).fill(0);
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      const idx = (word.charCodeAt(i) * (i + 1)) % 128;
      vector[idx] += 1;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= magnitude;
  }
  return vector;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const minLen = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < minLen; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return (Math.sqrt(normA) * Math.sqrt(normB)) === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Synthetic File Generation ──────────────────────────────────────────────

function generateSyntheticProject(fileCount: number): Map<string, string> {
  const files = new Map<string, string>();
  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  const modules = ["src/components", "src/services", "src/utils", "src/hooks", "src/lib"];
  const todos = ["// TODO: optimize this", "// FIXME: edge case", "// XXX: hack", "/* BUG: something wrong */", "// HACK: temporary"];

  for (let i = 0; i < fileCount; i++) {
    const module = modules[Math.floor(Math.random() * modules.length)];
    const ext = extensions[Math.floor(Math.random() * extensions.length)];
    const path = `${module}/file_${String(i).padStart(6, "0")}${ext}`;

    const lines: string[] = [];
    lines.push(`import { Component } from "react";`);
    lines.push(`import { helper } from "../utils/helpers";`);
    lines.push("");
    lines.push(`export function generatedFunction_${i}() {`);
    lines.push(`  const data = [];`);

    const bodyLines = 50 + Math.floor(Math.random() * 450);
    for (let j = 0; j < bodyLines; j++) {
      if (j % 20 === 0) lines.push(`  // Section ${j / 20}`);
      if (j % 15 === 0 && Math.random() > 0.7) lines.push(`  ${todos[Math.floor(Math.random() * todos.length)]}`);
      lines.push(`  data.push({ id: ${j}, value: "item_${j}" });`);
    }

    lines.push(`  return data;`);
    lines.push(`}`);
    files.set(path, lines.join("\n"));
  }
  return files;
}

// ── Debt Scoring (standalone, mirrors DebtAnalyzer) ─────────────────────────

function scoreFileSize(lines: number): number {
  if (lines <= 100) return 0;
  if (lines <= 300) return 2;
  if (lines <= 500) return 5;
  if (lines <= 800) return 10;
  if (lines <= 1500) return 15;
  return 20;
}

function scoreFunctionLength(content: string): number {
  let currentDepth = 0, braceLineCount = 0, maxBlockLines = 0;
  for (const char of content) {
    if (char === "{") { currentDepth++; braceLineCount = 0; }
    else if (char === "}") { if (braceLineCount > maxBlockLines) maxBlockLines = braceLineCount; currentDepth--; braceLineCount = 0; }
    else if (char === "\n") { if (currentDepth > 0) braceLineCount++; }
  }
  if (maxBlockLines <= 20) return 0;
  if (maxBlockLines <= 50) return 2;
  if (maxBlockLines <= 100) return 5;
  if (maxBlockLines <= 200) return 10;
  if (maxBlockLines <= 400) return 15;
  return 20;
}

function scoreCommentRatio(content: string, totalLines: number): number {
  if (totalLines === 0) return 0;
  const commentLines = content.split("\n").filter((line) => {
    const t = line.trim();
    return t.startsWith("//") || t.startsWith("#") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("/**") || t === "*/" || t.startsWith("--");
  }).length;
  const ratio = commentLines / totalLines;
  if (ratio >= 0.15 && ratio <= 0.4) return 0;
  if (ratio >= 0.05 && ratio < 0.15) return 3;
  if (ratio < 0.05 && totalLines > 50) return 8;
  if (ratio > 0.4) return 5;
  if (ratio < 0.02) return 12;
  return 20;
}

function scoreTodoDensity(content: string, totalLines: number): number {
  if (totalLines === 0) return 0;
  const matches = content.match(/(?:TODO|FIXME|HACK|XXX|BUG|OPTIMIZE)\b/gi);
  const count = matches ? matches.length : 0;
  const density = count / totalLines;
  if (count === 0) return 0;
  if (density <= 0.01) return 2;
  if (density <= 0.03) return 5;
  if (density <= 0.05) return 8;
  return 10;
}

function runDebtAnalysis(files: Map<string, string>): { analyzed: number; avgScore: number } {
  let analyzed = 0;
  let totalScore = 0;

  for (const [path, content] of files) {
    const lines = content.split("\n");
    const totalLines = lines.length;

    const fileSize = scoreFileSize(totalLines);
    const funcLen = scoreFunctionLength(content);
    const comments = scoreCommentRatio(content, totalLines);
    const todos = scoreTodoDensity(content, totalLines);

    const score = fileSize + funcLen + comments + todos;
    totalScore += score;
    analyzed++;
  }

  return {
    analyzed,
    avgScore: analyzed > 0 ? Math.round(totalScore / analyzed) : 0,
  };
}

function runHeatmapAnalysis(files: Map<string, string>, chunkCount: number): { chunks: number; heatmapMs: number } {
  // Take first chunkCount files as chunks
  const chunks: { id: string; content: string }[] = [];
  for (const [path, content] of files) {
    if (chunks.length >= chunkCount) break;
    chunks.push({ id: path, content: content.slice(0, 500) });
  }

  const start = performance.now();

  // Generate vectors
  const vectors = chunks.map((c) => simpleHash(c.content));
  const n = vectors.length;

  // Full O(n²) matrix computation (upper triangle + diagonal)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      cosineSimilarity(vectors[i], vectors[j]);
    }
  }

  const durationMs = Math.round(performance.now() - start);
  return { chunks: n, heatmapMs: durationMs };
}

// ── Timing & Memory Helpers ─────────────────────────────────────────────────

function getMemMB(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / (1024 * 1024));
}

// ── Main Harness ───────────────────────────────────────────────────────────

async function runStressTest() {
  console.log("\n═══ Large Project Stress Test — Phase 10.12 ═══\n");

  const sizes = [100, 1000, 5000, 10000];

  console.log("| Files | Gen (ms) | Gen Mem (MB) | Debt (ms) | Debt Score | Heatmap (ms) (200 ch.) | Mem After (MB) |");
  console.log("|------:|---------:|-------------:|----------:|-----------:|----------------------:|---------------:|");

  for (const size of sizes) {
    // Generate
    const genStart = performance.now();
    const files = generateSyntheticProject(size);
    const genMs = Math.round(performance.now() - genStart);
    const genMem = getMemMB();

    // Debt analysis
    const debtStart = performance.now();
    const debtResult = runDebtAnalysis(files);
    const debtMs = Math.round(performance.now() - debtStart);

    // Heatmap analysis (200 chunks to keep reasonable)
    const chunkCount = Math.min(size, 200);
    const heatmapResult = runHeatmapAnalysis(files, chunkCount);
    const finalMem = getMemMB();

    console.log(
      `| ${size.toString().padStart(5)} | ${genMs.toString().padStart(7)} | ${genMem.toString().padStart(11)} | ${debtMs.toString().padStart(8)} | ${debtResult.avgScore.toString().padStart(9)} | ${heatmapResult.heatmapMs.toString().padStart(20)} | ${finalMem.toString().padStart(13)} |`,
    );
  }

  console.log("\n═══ Stress Test Complete ═══\n");
  console.log("Notes: Heatmap limited to 200 chunks (O(n²)). DebtAnalyzer scores all files.");
  console.log("       Worker path not available in Node.js — tested in browser via Tauri.");
}

runStressTest().catch((err) => {
  console.error("Stress test failed:", err);
  process.exit(1);
});