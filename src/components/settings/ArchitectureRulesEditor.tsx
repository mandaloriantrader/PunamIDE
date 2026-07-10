/**
 * ArchitectureRulesEditor.tsx
 *
 * Visual canvas for editing Architecture Guardrails Engine rules.
 * Users define layers (boxes) and draw dependency rules (arrows) between them.
 * The canvas auto-saves to punamide-settings.json on every change.
 *
 * Toggle between Visual (React Flow canvas) and JSON (Monaco editor) modes.
 * Import/Export standalone architecture-rules.json files.
 * Uses @xyflow/react for the interactive graph editor.
 */

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  Handle,
  Position,
  type NodeProps,
  type EdgeProps,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  Plus,
  Trash2,
  Save,
  RefreshCw,
  Play,
  Code,
  GitBranch,
  Download,
  Upload,
} from "lucide-react";
import type {
  ArchitectureRules,
  ArchitectureRule,
} from "../../services/architecture/ArchitectureEngine";
import {
  loadArchitectureRules,
  saveArchitectureRules,
  resetArchitectureRules,
  validateArchitecture,
  invalidateCache,
} from "../../services/architecture/ArchitectureEngine";
import { showToast } from "../../utils/toast";

// ── Data Types ──────────────────────────────────────────────────────────────────

interface LayerNodeData extends Record<string, unknown> {
  label: string;
  patterns: string[];
  color: string;
}

interface RuleEdgeData extends Record<string, unknown> {
  allowed: boolean;
  severity: "error" | "warning";
  description: string;
}

type LayerNodeType = Node<LayerNodeData, "layer">;
type RuleEdgeType = Edge<RuleEdgeData, "rule">;

const LAYER_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#84cc16", "#14b8a6",
];

// ── Custom Node Component ───────────────────────────────────────────────────────

function LayerNodeComponent({ data, selected }: NodeProps<LayerNodeType>) {
  const layerData = data as LayerNodeData;
  return (
    <div
      style={{
        background: layerData.color + "18",
        border: `2px solid ${selected ? "#fff" : layerData.color}`,
        borderRadius: "10px",
        padding: "10px 14px",
        minWidth: "140px",
        maxWidth: "220px",
        fontSize: "12px",
        color: "var(--text-primary, #e0e0e0)",
        boxShadow: selected
          ? `0 0 12px ${layerData.color}40`
          : "0 2px 6px rgba(0,0,0,0.3)",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: layerData.color }} />
      <div style={{ fontWeight: 700, fontSize: "13px", marginBottom: "4px" }}>
        {layerData.label}
      </div>
      <div style={{ fontSize: "10px", color: "var(--text-secondary, #a0a0b0)", lineHeight: "1.4" }}>
        {layerData.patterns.map((p: string, i: number) => (
          <div key={i} style={{ wordBreak: "break-all" }}>{p}</div>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: layerData.color }} />
    </div>
  );
}

// ── Custom Edge Component ───────────────────────────────────────────────────────

function RuleEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<RuleEdgeType>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const edgeData = data as RuleEdgeData | undefined;
  const isAllowed = edgeData?.allowed ?? true;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: isAllowed ? "#22c55e" : "#ef4444",
          strokeWidth: selected ? 3 : 2,
          strokeDasharray: isAllowed ? undefined : "8 4",
          opacity: selected ? 1 : 0.7,
        }}
        markerEnd={
          isAllowed
            ? `url(#arrow-green-${selected ? "sel" : "def"})`
            : undefined
        }
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            left: labelX,
            top: labelY,
            transform: "translate(-50%, -50%)",
            background: "var(--bg-secondary, #1a1a2e)",
            border: `1px solid ${isAllowed ? "#22c55e" : "#ef4444"}`,
            borderRadius: "4px",
            padding: "1px 6px",
            fontSize: "9px",
            fontWeight: 700,
            color: isAllowed ? "#22c55e" : "#ef4444",
            pointerEvents: "none",
          }}
        >
          {isAllowed ? "CAN" : "CANNOT"}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// ── Bidirectional Mapping ───────────────────────────────────────────────────────

function rulesToCanvas(rules: ArchitectureRules): { nodes: LayerNodeType[]; edges: RuleEdgeType[] } {
  const nodes: LayerNodeType[] = [];
  const edges: RuleEdgeType[] = [];
  let colorIdx = 0;

  for (const [layerName, layerDef] of Object.entries(rules.layers)) {
    const patterns: string[] = Array.isArray(layerDef) ? layerDef : (layerDef as Record<string, unknown>).patterns as string[] || [];
    const color = LAYER_COLORS[colorIdx % LAYER_COLORS.length];
    colorIdx++;

    nodes.push({
      id: layerName,
      type: "layer",
      position: {
        x: 100 + (colorIdx % 3) * 250,
        y: 50 + Math.floor(colorIdx / 3) * 200,
      },
      data: {
        label: layerName,
        patterns,
        color,
      } as LayerNodeData,
      draggable: true,
    });
  }

  for (const rule of rules.rules) {
    const parsed = parseRuleId(rule.id);
    if (parsed && nodes.some(n => n.id === parsed.from) && nodes.some(n => n.id === parsed.to)) {
      edges.push({
        id: rule.id,
        source: parsed.from,
        target: parsed.to,
        type: "rule",
        animated: rule.severity === "error",
        data: {
          allowed: parsed.allowed,
          severity: rule.severity,
          description: rule.description,
        } as RuleEdgeData,
      });
    }
  }

  return { nodes, edges };
}

function canvasToRules(nodes: LayerNodeType[], edges: RuleEdgeType[]): ArchitectureRules {
  const layers: Record<string, string[]> = {};
  for (const node of nodes) {
    const nd = node.data as LayerNodeData;
    layers[node.id] = nd.patterns;
  }

  const rulesList: ArchitectureRule[] = [];
  for (const edge of edges) {
    const ed = edge.data as RuleEdgeData | undefined;
    const allowed = ed?.allowed ?? false;
    const ruleId = buildRuleId(edge.source, edge.target, allowed);
    rulesList.push({
      id: ruleId,
      description: ed?.description || `${edge.source} ${allowed ? "can" : "cannot"} import ${edge.target}`,
      severity: ed?.severity || "error",
    });
  }

  return { rules: rulesList, layers };
}

function parseRuleId(ruleId: string): { from: string; to: string; allowed: boolean } | null {
  const cannotMatch = ruleId.match(/^(.+)_cannot_import_(.+)$/);
  if (cannotMatch) {
    return { from: cannotMatch[1], to: cannotMatch[2], allowed: false };
  }
  const canMatch = ruleId.match(/^(.+)_can_import_(.+)$/);
  if (canMatch) {
    return { from: canMatch[1], to: canMatch[2], allowed: true };
  }
  return null;
}

function buildRuleId(from: string, to: string, allowed: boolean): string {
  return allowed ? `${from}_can_import_${to}` : `${from}_cannot_import_${to}`;
}

// ── Layer Editor Modal ──────────────────────────────────────────────────────────

function LayerEditorModal({
  layer,
  onSave,
  onClose,
}: {
  layer: LayerNodeType | null;
  onSave: (data: LayerNodeData, oldId?: string) => void;
  onClose: () => void;
}) {
  const layerData = layer?.data as LayerNodeData | undefined;
  const [name, setName] = useState(layer?.id ?? "");
  const [patternsStr, setPatternsStr] = useState(
    layerData ? layerData.patterns.join("\n") : ""
  );
  const [color, setColor] = useState(
    layerData?.color ?? LAYER_COLORS[0]
  );

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const patterns = patternsStr
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    if (patterns.length === 0) return;

    onSave(
      { label: trimmed, patterns, color },
      layer?.id
    );
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-panel"
        style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{layer ? "Edit Layer" : "New Layer"}</h3>

        <div className="provider-field">
          <label>Layer Name</label>
          <input
            type="text"
            className="settings-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. ui, services, database"
            autoFocus
          />
        </div>

        <div className="provider-field">
          <label>Path Patterns (one per line)</label>
          <textarea
            className="settings-input"
            style={{ minHeight: 80, fontFamily: "monospace", fontSize: 11 }}
            value={patternsStr}
            onChange={(e) => setPatternsStr(e.target.value)}
            placeholder="src/components/\nsrc/pages/"
          />
          <span style={{ fontSize: 10, color: "var(--text-secondary, #a0a0b0)" }}>
            Use glob-style prefixes (e.g., src/services/). ** and * supported.
          </span>
        </div>

        <div className="provider-field">
          <label>Node Color</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
            {LAYER_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: c,
                  border: color === c ? "3px solid #fff" : "2px solid transparent",
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        </div>

        <div className="settings-actions" style={{ marginTop: 16 }}>
          <button className="btn-secondary compact" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary compact"
            onClick={handleSave}
            disabled={!name.trim() || !patternsStr.trim()}
          >
            <Save size={12} /> {layer ? "Update" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Rule Inspector (sidebar) ────────────────────────────────────────────────────

function RuleInspector({
  edge,
  nodes,
  onUpdate,
  onDelete,
}: {
  edge: RuleEdgeType | null;
  nodes: LayerNodeType[];
  onUpdate: (updates: Partial<RuleEdgeData>) => void;
  onDelete: () => void;
}) {
  if (!edge) {
    return (
      <div
        style={{
          padding: 12,
          fontSize: 12,
          color: "var(--text-secondary, #a0a0b0)",
        }}
      >
        Click a connection arrow to edit it.
      </div>
    );
  }

  const edgeData = edge.data as RuleEdgeData;
  const fromNode = nodes.find(n => n.id === edge.source);
  const toNode = nodes.find(n => n.id === edge.target);
  const fromLabel = (fromNode?.data as LayerNodeData)?.label ?? edge.source;
  const toLabel = (toNode?.data as LayerNodeData)?.label ?? edge.target;

  return (
    <div style={{ padding: 10, fontSize: 12 }}>
      <h4 style={{ margin: "0 0 8px", fontSize: 13 }}>Rule Inspector</h4>

      <div style={{ marginBottom: 10 }}>
        <div style={{ color: "var(--text-secondary, #a0a0b0)", fontSize: 10 }}>
          {fromLabel} → {toLabel}
        </div>
      </div>

      <div className="provider-field">
        <label>Import Rule</label>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            className={`btn-${edgeData.allowed ? "primary" : "secondary"} compact`}
            style={{
              flex: 1,
              background: edgeData.allowed ? "#22c55e" : undefined,
              borderColor: edgeData.allowed ? "#22c55e" : undefined,
            }}
            onClick={() => onUpdate({ allowed: true })}
          >
            Can Import
          </button>
          <button
            className={`btn-${!edgeData.allowed ? "primary" : "secondary"} compact`}
            style={{
              flex: 1,
              background: !edgeData.allowed ? "#ef4444" : undefined,
              borderColor: !edgeData.allowed ? "#ef4444" : undefined,
            }}
            onClick={() => onUpdate({ allowed: false })}
          >
            Cannot Import
          </button>
        </div>
      </div>

      <div className="provider-field">
        <label>Severity</label>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          {(["error", "warning"] as const).map((sev) => (
            <button
              key={sev}
              className={`btn-${edgeData.severity === sev ? "primary" : "secondary"} compact`}
              style={{ flex: 1 }}
              onClick={() => onUpdate({ severity: sev })}
            >
              {sev === "error" ? "Error (block)" : "Warning (advise)"}
            </button>
          ))}
        </div>
      </div>

      <div className="provider-field">
        <label>Description</label>
        <input
          type="text"
          className="settings-input"
          value={edgeData.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="Why this rule exists..."
        />
      </div>

      <button
        className="btn-secondary compact"
        style={{ marginTop: 10, color: "#ef4444", width: "100%" }}
        onClick={onDelete}
      >
        <Trash2 size={12} /> Delete Rule
      </button>
    </div>
  );
}

// ── Monaco JSON Editor ──────────────────────────────────────────────────────────

function JsonEditorPanel({
  rules,
  onApply,
}: {
  rules: ArchitectureRules;
  onApply: (parsed: ArchitectureRules) => void;
}) {
  const [jsonText, setJsonText] = useState(() => JSON.stringify(rules, null, 2));
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => {
    const newJson = JSON.stringify(rules, null, 2);
    if (newJson !== jsonText) {
      setJsonText(newJson);
      setError(null);
    }
  }, [rules]);

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.updateOptions({
      theme: "vs-dark",
      fontSize: 12,
      lineNumbers: "on",
      minimap: { enabled: false },
      wordWrap: "on",
      scrollBeyondLastLine: false,
      tabSize: 2,
    });
  };

  const handleApply = () => {
    try {
      const parsed = JSON.parse(jsonText) as ArchitectureRules;
      if (!parsed.rules || !Array.isArray(parsed.rules)) {
        setError('Invalid format: "rules" must be an array');
        return;
      }
      if (!parsed.layers || typeof parsed.layers !== "object") {
        setError('Invalid format: "layers" must be an object');
        return;
      }
      setError(null);
      onApply(parsed);
      showToast("JSON applied to canvas", "success");
    } catch (err) {
      setError(`JSON Parse Error: ${(err as Error).message}`);
    }
  };

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (err) {
      setError(`Cannot format: ${(err as Error).message}`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--border-color, #2a2a4a)",
          background: "var(--bg-secondary, #1a1a2e)",
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-secondary, #a0a0b0)", flex: 1 }}>
          Edit raw ArchitectureRules JSON — changes apply to canvas on save
        </span>
        <button
          className="btn-secondary compact"
          onClick={handleFormat}
          style={{
            background: "var(--bg-secondary, #1a1a2e)",
            borderColor: "var(--border-color, #2a2a4a)",
            color: "var(--text-primary, #e0e0e0)",
          }}
        >
          Format
        </button>
        <button
          className="btn-primary compact"
          onClick={handleApply}
        >
          <Save size={12} /> Apply to Canvas
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 11,
            background: "rgba(239, 68, 68, 0.1)",
            borderBottom: "1px solid #ef444440",
            color: "#ef4444",
            fontFamily: "monospace",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          defaultLanguage="json"
          value={jsonText}
          onChange={(val) => {
            setJsonText(val ?? "");
            setError(null);
          }}
          onMount={handleEditorMount}
          loading={
            <div style={{ padding: 20, fontSize: 12, color: "var(--text-secondary, #a0a0b0)" }}>
              Loading editor...
            </div>
          }
          options={{
            readOnly: false,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────────

export default function ArchitectureRulesEditor() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<Record<string, unknown>>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<Record<string, unknown>>>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [viewMode, setViewMode] = useState<"visual" | "json">("visual");
  const [validationResult, setValidationResult] = useState<{
    allowed: boolean;
    errorCount: number;
    warningCount: number;
    violations: string[];
  } | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<RuleEdgeType | null>(null);
  const [showLayerEditor, setShowLayerEditor] = useState(false);
  const [editingLayer, setEditingLayer] = useState<LayerNodeType | null>(null);
  // Live violation count from debounced auto-validate
  const [liveViolationCount, setLiveViolationCount] = useState<{ errors: number; warnings: number } | null>(null);

  const typedNodes = nodes as unknown as LayerNodeType[];
  const typedEdges = edges as unknown as RuleEdgeType[];

  const nodeTypes = useMemo(() => ({ layer: LayerNodeComponent }), []);
  const edgeTypes = useMemo(() => ({ rule: RuleEdgeComponent }), []);

  const currentRules = useMemo(
    () => canvasToRules(typedNodes, typedEdges),
    // Only recompute when node data (labels/patterns) or edges change,
    // NOT on position changes (which happen during drag)
    [typedNodes.map(n => `${n.id}:${(n.data as LayerNodeData).patterns.join(',')}`).join('|'), 
     typedEdges.map(e => `${e.id}:${(e.data as RuleEdgeData)?.allowed}:${(e.data as RuleEdgeData)?.severity}`).join('|')]
  );

  useEffect(() => {
    loadArchitectureRules().then((rules) => {
      const { nodes: initialNodes, edges: initialEdges } = rulesToCanvas(rules);
      setNodes(initialNodes as unknown as Node<Record<string, unknown>>[]);
      setEdges(initialEdges as unknown as Edge<Record<string, unknown>>[]);
      setLoaded(true);
    });
  }, [setNodes, setEdges]);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await saveArchitectureRules(currentRules);
        invalidateCache();
      } catch (err) {
        console.error("[ArchEditor] Auto-save failed:", err);
      }
    }, 500);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [currentRules, loaded]);

  // ── Debounced auto-validate: re-runs architecture validation 2s after
  // the last rule change, showing a live violation count on the toolbar.
  const validateTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;

    if (validateTimeoutRef.current) clearTimeout(validateTimeoutRef.current);
    validateTimeoutRef.current = setTimeout(async () => {
      try {
        const result = await validateArchitecture(currentRules);
        setLiveViolationCount({
          errors: result.error_count,
          warnings: result.warning_count,
        });
      } catch {
        // Validation unavailable — clear the count
        setLiveViolationCount(null);
      }
    }, 2000);

    return () => {
      if (validateTimeoutRef.current) clearTimeout(validateTimeoutRef.current);
    };
  }, [currentRules, loaded]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const onConnectFn = useCallback(
    (connection: Connection) => {
      if (connection.source === connection.target) return;

      const exists = typedEdges.some(
        (e) => e.source === connection.source && e.target === connection.target
      );
      if (exists) return;

      const newEdge: RuleEdgeType = {
        id: buildRuleId(connection.source!, connection.target!, false),
        source: connection.source!,
        target: connection.target!,
        type: "rule",
        animated: true,
        data: {
          allowed: false,
          severity: "error",
          description: `${connection.source} cannot import ${connection.target}`,
        } as RuleEdgeData,
      };

      setEdges((eds) => addEdge(newEdge, eds as Edge<Record<string, unknown>>[]) as Edge<Record<string, unknown>>[]);
    },
    [typedEdges, setEdges]
  );

  const onEdgeClickFn = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      setSelectedEdge(edge as unknown as RuleEdgeType);
    },
    []
  );

  const updateSelectedEdge = useCallback(
    (updates: Partial<RuleEdgeData>) => {
      if (!selectedEdge) return;
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id === selectedEdge.id) {
            const currentData = (e.data as RuleEdgeData | undefined) ?? { allowed: false, severity: "error" as const, description: "" };
            const newData: RuleEdgeData = { ...currentData, ...updates };
            return {
              ...e,
              data: newData as Record<string, unknown>,
              animated: (updates.severity ?? currentData.severity) === "error",
            };
          }
          return e;
        })
      );
      setSelectedEdge((prev) => {
        if (!prev) return null;
        const prevData = prev.data as RuleEdgeData;
        return { ...prev, data: { ...prevData, ...updates } as RuleEdgeData };
      });
    },
    [selectedEdge, setEdges]
  );

  const deleteSelectedEdge = useCallback(() => {
    if (!selectedEdge) return;
    setEdges((eds) => eds.filter((e) => e.id !== selectedEdge.id));
    setSelectedEdge(null);
  }, [selectedEdge, setEdges]);

  const addLayer = () => {
    setEditingLayer(null);
    setShowLayerEditor(true);
  };

  const handleLayerSave = (data: LayerNodeData, oldId?: string) => {
    if (oldId) {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === oldId) {
            return { ...n, id: data.label, data: data as Record<string, unknown> };
          }
          return n;
        })
      );
      setEdges((eds) =>
        eds.map((e) => {
          if (e.source === oldId) {
            const ed = e.data as Record<string, unknown>;
            return { ...e, source: data.label, id: buildRuleId(data.label, e.target, (ed.allowed as boolean) ?? false) };
          }
          if (e.target === oldId) {
            const ed = e.data as Record<string, unknown>;
            return { ...e, target: data.label, id: buildRuleId(e.source, data.label, (ed.allowed as boolean) ?? false) };
          }
          return e;
        })
      );
    } else {
      const colorIdx = nodes.length;
      const newNode: LayerNodeType = {
        id: data.label,
        type: "layer",
        position: {
          x: 100 + (colorIdx % 3) * 250,
          y: 50 + Math.floor(colorIdx / 3) * 200,
        },
        data: data as LayerNodeData,
        draggable: true,
      };
      setNodes((nds) => [...nds, newNode as unknown as Node<Record<string, unknown>>]);
    }
    setShowLayerEditor(false);
  };

  const deleteLayer = (nodeId: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    if (selectedEdge && (selectedEdge.source === nodeId || selectedEdge.target === nodeId)) {
      setSelectedEdge(null);
    }
  };

  const handleDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setEditingLayer(node as unknown as LayerNodeType);
      setShowLayerEditor(true);
    },
    []
  );

  const handleReset = async () => {
    const defaults = await resetArchitectureRules();
    const { nodes: defaultNodes, edges: defaultEdges } = rulesToCanvas(defaults);
    setNodes(defaultNodes as unknown as Node<Record<string, unknown>>[]);
    setEdges(defaultEdges as unknown as Edge<Record<string, unknown>>[]);
    setSelectedEdge(null);
    showToast("Architecture rules reset to defaults", "success");
  };

  const handleValidate = async () => {
    setValidating(true);
    setValidationResult(null);
    try {
      const result = await validateArchitecture(currentRules);
      setValidationResult({
        allowed: result.allowed,
        errorCount: result.error_count,
        warningCount: result.warning_count,
        violations: result.violations.map((v) => v.description),
      });
    } catch (err) {
      showToast(`Validation failed: ${err}`, "error");
    } finally {
      setValidating(false);
    }
  };

  const handleSaveNow = async () => {
    setSaving(true);
    try {
      await saveArchitectureRules(currentRules);
      invalidateCache();
      showToast("Architecture rules saved", "success");
    } catch (err) {
      showToast(`Save failed: ${err}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleJsonApply = (parsed: ArchitectureRules) => {
    const { nodes: newNodes, edges: newEdges } = rulesToCanvas(parsed);
    setNodes(newNodes as unknown as Node<Record<string, unknown>>[]);
    setEdges(newEdges as unknown as Edge<Record<string, unknown>>[]);
    setSelectedEdge(null);
  };

  const toggleViewMode = () => {
    setViewMode((prev) => (prev === "visual" ? "json" : "visual"));
  };

  // ── Import/Export ────────────────────────────────────────────────────────

  const handleExportRules = () => {
    try {
      const json = JSON.stringify(currentRules, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "architecture-rules.json";
      a.click();
      URL.revokeObjectURL(url);
      showToast("Architecture rules exported to architecture-rules.json", "success");
    } catch (err) {
      showToast(`Export failed: ${err}`, "error");
    }
  };

  const handleImportRules = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as ArchitectureRules;
        if (!parsed.rules || !Array.isArray(parsed.rules)) {
          showToast('Import failed: "rules" must be an array', "error");
          return;
        }
        if (!parsed.layers || typeof parsed.layers !== "object") {
          showToast('Import failed: "layers" must be an object', "error");
          return;
        }
        const { nodes: newNodes, edges: newEdges } = rulesToCanvas(parsed);
        setNodes(newNodes as unknown as Node<Record<string, unknown>>[]);
        setEdges(newEdges as unknown as Edge<Record<string, unknown>>[]);
        setSelectedEdge(null);
        showToast(`Imported ${parsed.rules.length} rules and ${Object.keys(parsed.layers).length} layers`, "success");
      } catch (err) {
        showToast(`Import failed: ${(err as Error).message}`, "error");
      }
    };
    input.click();
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--border-color, #2a2a4a)",
          flexWrap: "wrap",
        }}
      >
        {viewMode === "visual" ? (
          <>
            <button
              className="btn-primary compact"
              onClick={addLayer}
            >
              <Plus size={14} /> Add Layer
            </button>
            <span style={{ fontSize: 11, color: "var(--text-secondary, #a0a0b0)" }}>
              |
            </span>
            <span style={{ fontSize: 11, color: "var(--text-secondary, #a0a0b0)" }}>
              Drag between layer handles to add rules · Double-click layer to edit · Delete key removes edges
            </span>
          </>
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-secondary, #a0a0b0)", flex: 1 }}>
            JSON mode — edit rules directly. Click "Apply to Canvas" to sync with visual editor.
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="btn-secondary compact"
          onClick={handleExportRules}
          style={{
            background: "var(--bg-secondary, #1a1a2e)",
            borderColor: "var(--border-color, #2a2a4a)",
            color: "var(--text-primary, #e0e0e0)",
          }}
          title="Export rules as architecture-rules.json"
        >
          <Download size={12} /> Export
        </button>
        <button
          className="btn-secondary compact"
          onClick={handleImportRules}
          style={{
            background: "var(--bg-secondary, #1a1a2e)",
            borderColor: "var(--border-color, #2a2a4a)",
            color: "var(--text-primary, #e0e0e0)",
          }}
          title="Import rules from a .json file"
        >
          <Upload size={12} /> Import
        </button>
        <button
          className="btn-secondary compact"
          onClick={handleValidate}
          disabled={validating}
          style={{
            background: "var(--bg-secondary, #1a1a2e)",
            borderColor: "var(--border-color, #2a2a4a)",
            color: "var(--text-primary, #e0e0e0)",
          }}
        >
          <Play size={12} />{" "}
          {validating
            ? "Validating..."
            : liveViolationCount
              ? liveViolationCount.errors > 0
                ? `🔴 ${liveViolationCount.errors} errors, ${liveViolationCount.warnings} warnings`
                : liveViolationCount.warnings > 0
                  ? `🟡 ${liveViolationCount.warnings} warnings`
                  : "🟢 All rules pass"
              : "Test Rules"}
        </button>
        <button
          className="btn-secondary compact"
          onClick={handleReset}
          style={{
            background: "var(--bg-secondary, #1a1a2e)",
            borderColor: "var(--border-color, #2a2a4a)",
            color: "var(--text-primary, #e0e0e0)",
          }}
        >
          <RefreshCw size={12} /> Reset Defaults
        </button>
        <button
          className="btn-secondary compact"
          onClick={toggleViewMode}
          style={{
            background: viewMode === "json" ? "#059669" : "var(--bg-secondary, #1a1a2e)",
            borderColor: viewMode === "json" ? "#059669" : "var(--border-color, #2a2a4a)",
            color: viewMode === "json" ? "#fff" : "var(--text-primary, #e0e0e0)",
          }}
          title={viewMode === "visual" ? "Switch to JSON editor" : "Switch to visual canvas"}
        >
          {viewMode === "visual" ? <Code size={12} /> : <GitBranch size={12} />}
          {" "}{viewMode === "visual" ? "JSON" : "Canvas"}
        </button>
        <button
          className="btn-primary compact"
          onClick={handleSaveNow}
          disabled={saving}
        >
          <Save size={12} /> {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {validationResult && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 11,
            background: validationResult.allowed
              ? "rgba(34, 197, 94, 0.1)"
              : "rgba(239, 68, 68, 0.1)",
            borderBottom: `1px solid ${
              validationResult.allowed ? "#22c55e40" : "#ef444440"
            }`,
            color: validationResult.allowed ? "#22c55e" : "#ef4444",
          }}
        >
          {validationResult.allowed ? "✓ All rules pass" : `✗ ${validationResult.errorCount} error(s), ${validationResult.warningCount} warning(s)`}
          {validationResult.violations.length > 0 && (
            <span style={{ marginLeft: 8, color: "var(--text-secondary, #a0a0b0)" }}>
              ({validationResult.violations.slice(0, 3).join("; ")}
              {validationResult.violations.length > 3 ? "..." : ""})
            </span>
          )}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, position: "relative" }}>
          {viewMode === "visual" ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnectFn}
              onEdgeClick={onEdgeClickFn}
              onNodeDoubleClick={handleDoubleClick}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              snapToGrid={true}
              snapGrid={[16, 16]}
              deleteKeyCode={["Delete", "Backspace"]}
              onNodesDelete={(deleted) => {
                for (const node of deleted) {
                  setEdges((eds) =>
                    eds.filter((e) => e.source !== node.id && e.target !== node.id)
                  );
                }
              }}
              onEdgesDelete={(deleted) => {
                if (selectedEdge && deleted.some((e) => e.id === selectedEdge.id)) {
                  setSelectedEdge(null);
                }
              }}
              multiSelectionKeyCode="Shift"
              style={{ background: "var(--bg-input, #13132b)" }}
            >
              <Background color="var(--border-color, #2a2a4a)" gap={20} />
              <Controls
                style={{
                  background: "var(--bg-card, #16162a)",
                  border: "1px solid var(--border-color, #2a2a4a)",
                  borderRadius: 6,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                }}
              />

              <svg>
                <defs>
                  <marker
                    id="arrow-green-def"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#22c55e" />
                  </marker>
                  <marker
                    id="arrow-green-sel"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#22c55e" />
                  </marker>
                </defs>
              </svg>
            </ReactFlow>
          ) : (
            <JsonEditorPanel
              rules={currentRules}
              onApply={handleJsonApply}
            />
          )}
        </div>

        {viewMode === "visual" && (
          <div
            style={{
              width: 240,
              borderLeft: "1px solid var(--border-color, #2a2a4a)",
              background: "var(--bg-secondary, #16162a)",
              overflowY: "auto",
            }}
          >
            <RuleInspector
              edge={selectedEdge}
              nodes={typedNodes}
              onUpdate={updateSelectedEdge}
              onDelete={deleteSelectedEdge}
            />
          </div>
        )}
      </div>

      {viewMode === "visual" && (
        <div
          style={{
            borderTop: "1px solid var(--border-color, #2a2a4a)",
            padding: "8px 12px",
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 10, color: "var(--text-secondary, #a0a0b0)", marginRight: 4 }}>
            Layers:
          </span>
          {typedNodes.map((node) => {
            const nd = node.data as LayerNodeData;
            return (
              <span
                key={node.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: nd.color + "20",
                  border: `1px solid ${nd.color}`,
                  fontSize: 10,
                  color: "var(--text-primary, #e0e0e0)",
                }}
              >
                {nd.label}
                <button
                  onClick={() => deleteLayer(node.id)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--text-secondary, #a0a0b0)",
                    padding: 0,
                    display: "flex",
                  }}
                  title="Delete layer"
                >
                  <Trash2 size={10} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {showLayerEditor && (
        <LayerEditorModal
          layer={editingLayer}
          onSave={handleLayerSave}
          onClose={() => {
            setShowLayerEditor(false);
            setEditingLayer(null);
          }}
        />
      )}
    </div>
  );
}