# GPU-Accelerated Embeddings Research — Phase 10.11

**Date:** 2026-05-30
**Project:** Punam IDE v2.0
**Context:** Offload expensive embedding computations (similarity heatmaps, PCA projection, retrieval testing) to GPU via WebGPU/ONNX.

---

## 1. Problem Statement

The `EmbeddingAnalyzer` performs O(n²) operations:
- **generateHeatmap:** n² cosine similarity calculations
- **projectTo2D:** PCA-style mean + centering across all vectors
- **testRetrieval:** embedding + sorting for precision@k

For 10,000+ chunks (realistic for large codebases), this means 100 million cosine similarity computations — which blocks the main thread. Phase 10.7 already offloads this to Web Workers, but the computation itself remains CPU-bound.

---

## 2. Candidate Solutions

### 2.1 ONNX Runtime Web (WebGPU backend)

| Property | Value |
|----------|-------|
| **Package** | `onnxruntime-web` |
| **Backend** | `webgpu` (falls back to `wasm` then `webgl`) |
| **Model** | all-MiniLM-L6-v2 (384 dimensions, ~23MB) |
| **Integration** | Convert PyTorch model → ONNX → load via `ort.InferenceSession` |
| **Pros** | Mature, runs actual transformer models, 10-50x speedup on GPU |
| **Cons** | Large model download (~23MB), requires ONNX model conversion pipeline |
| **Status** | Production-ready, used by Hugging Face Transformers.js |

**Code sketch:**
```typescript
import * as ort from "onnxruntime-web";
const session = await ort.InferenceSession.create("./all-MiniLM-L6-v2.onnx", {
  executionProviders: ["webgpu", "wasm"],
});
const embeddings = await session.run({ input_ids, attention_mask });
```

### 2.2 Transformers.js (Hugging Face)

| Property | Value |
|----------|-------|
| **Package** | `@xenova/transformers` |
| **Model** | `Xenova/all-MiniLM-L6-v2` (384d, quantized ~23MB) |
| **Integration** | `pipeline("feature-extraction", model)` |
| **Pros** | Drop-in API, handles tokenization + ONNX under the hood, WebGPU support |
| **Cons** | Larger bundle, model download on first use, ~23MB payload |
| **Status** | Production-ready, active maintenance |

**Code sketch:**
```typescript
import { pipeline } from "@xenova/transformers";
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const embedding = await extractor("function hello() {}", { pooling: "mean" });
```

### 2.3 Raw WebGPU Compute Shaders

| Property | Value |
|----------|-------|
| **Integration** | Write WGSL compute shaders for batched cosine similarity |
| **Dependency** | None (browser API) |
| **Pros** | No model download, fastest for pure matrix math, zero-dependency |
| **Cons** | Complex to implement, no semantic embeddings (just math), requires WGSL expertise |
| **Status** | Experimental |

**Use case:** Accelerating the `generateHeatmap` matrix computation. Each workgroup computes one element of the n×n matrix:
```wgsl
@group(0) @binding(0) var<storage, read> vectors: array<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  // Compute cosine similarity for cell (id.x, id.y)
}
```

### 2.4 WebGL 2.0 Compute (via GPU.js)

| Property | Value |
|----------|-------|
| **Package** | `gpu.js` |
| **Pros** | Simple API, kernel-based, compiles JS → GLSL |
| **Cons** | No WebGPU, limited to WebGL, not maintained as actively |

Verdict: Skip — WebGPU is the future, WebGL is legacy.

---

## 3. Recommendation

### Phase 1: Hybrid Approach (Recommended)

Use two complementary strategies:

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **generateHeatmap** (O(n²) matrix math) | Raw WebGPU compute shader | No model overhead, max throughput for pure math |
| **projectTo2D** (PCA projection) | Raw WebGPU compute shader | Same as above |
| **testRetrieval** / **compareModels** | Transformers.js or ONNX Runtime Web | Actual semantic embeddings needed for quality |
| **simpleHash** (current local fallback) | Keep as CPU-only fallback | No GPU dependency required |

### Phase 2: Full ONNX Pipeline (Future)

If codebase grows beyond 100K files:
- Ship all-MiniLM-L6-v2 model as `.onnx` in the Tauri bundle (loaded from `tauri://localhost` asset protocol)
- All embedding operations run through ONNX Runtime Web with WebGPU backend
- Fallback to Transformers.js if ONNX fails

---

## 4. Implementation Plan (If Approved)

### Sub-task 4.1: GPU Cosine Similarity (WebGPU) — ~3h

**File:** `src/workers/gpu-embedding.worker.ts`

- Detect WebGPU support: `navigator.gpu.requestAdapter()`
- Write WGSL kernel for batched dot-product + normalization
- Benchmark: 10K chunks × 10K matrix = 100M computations vs CPU

### Sub-task 4.2: Transformers.js Integration — ~2h

**Files to modify:** `src/services/embeddings/EmbeddingAnalyzer.ts`

- Add `npm install @xenova/transformers` to package.json
- Add `generateEmbeddingAsync()` method using pipeline
- Feature flag: enable/disable GPU via `.env`/settings

### Sub-task 4.3: Fallback Chain — ~1h

Order of operations:
1. Try WebGPU compute shader (fastest)
2. Try Transformers.js (WebGPU under the hood)
3. Fall back to simpleHash CPU (current behavior)
4. All wrapped in `EmbeddingAnalyzer.generateEmbeddingAsync()`

---

## 5. Performance Estimates

| Operation | Current (CPU simpleHash) | WebGPU Compute Shader | Transformers.js (WebGPU) |
|-----------|--------------------------|----------------------|--------------------------|
| Heatmap (1K chunks) | ~50ms | ~2ms (25x) | ~15ms (3x) |
| Heatmap (10K chunks) | ~5s | ~150ms (33x) | ~1.5s (3x) |
| Heatmap (50K chunks) | ~120s+ (blocking) | ~3.5s (34x) | ~35s (3x) |
| Single embedding | ~0.1ms | N/A | ~5ms |
| Batch embeddings (1K) | ~100ms | N/A | ~500ms |

**Key insight:** WebGPU compute shaders are ideal for the pure math (heatmap matrix), while Transformers.js/ONNX is needed for actual semantic embedding quality. The two approaches are complementary, not competing.

---

## 6. Decision

**Status:** RESEARCH COMPLETE — Awaiting approval to proceed with Sub-task 4.1 (GPU compute shader for heatmap).

**Estimated total effort if approved:** ~6 hours across 3 sub-tasks.
**Risk:** Low — all technologies are production-ready. WebGPU is supported in Chrome 113+, Edge 113+, Firefox Nightly.
**Fallback:** If WebGPU unavailable, the existing Web Worker CPU path (Task 10.7) handles the computation without blocking the UI.