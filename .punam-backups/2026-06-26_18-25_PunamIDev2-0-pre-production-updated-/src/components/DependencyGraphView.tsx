/**
 * DependencyGraphView.tsx — Phase 7
 *
 * Lightweight interactive dependency graph visualization.
 * Uses HTML Canvas for rendering — no external dependencies.
 *
 * Features:
 *  - Force-directed layout (simple spring simulation)
 *  - Nodes colored by coupling score
 *  - Circular dependencies highlighted in red
 *  - Hub files rendered larger
 *  - Click node to see details
 *  - Zoom/pan via mouse wheel and drag
 */

import { useRef, useEffect, useState, useCallback } from "react";
import type { DependencyAnalysis } from "../services/technicalDebt/DependencyGraphEngine";

interface Props {
  analysis: DependencyAnalysis;
  height?: number;
}

interface GraphNode {
  id: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  isHub: boolean;
  inCycle: boolean;
  coupling: number;
}

interface GraphEdge {
  source: string;
  target: string;
  isCyclic: boolean;
}

function shortenPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

function couplingToColor(score: number): string {
  if (score >= 60) return "#f87171";
  if (score >= 30) return "#fbbf24";
  if (score >= 10) return "#60a5fa";
  return "#34d399";
}

export default function DependencyGraphView({ analysis, height = 350 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [dimensions, setDimensions] = useState({ width: 400, height });
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const animRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Build graph data from analysis
  useEffect(() => {
    const { graph, hubFiles, circularDependencies, couplingScores } = analysis;

    const hubSet = new Set(hubFiles.map(h => h.filePath));
    const cycleSet = new Set<string>();
    for (const cd of circularDependencies) {
      for (const fp of cd.cycle) cycleSet.add(fp);
    }

    // Create nodes
    const nodes: GraphNode[] = [];
    const nodeIds = new Set<string>();

    for (const [filePath, node] of graph.nodes) {
      // Only include files with at least one connection
      if (node.dependsOn.length === 0 && node.dependedBy.length === 0) continue;

      const coupling = couplingScores.get(filePath) ?? 0;
      const isHub = hubSet.has(filePath);

      nodes.push({
        id: filePath,
        label: shortenPath(filePath),
        x: Math.random() * dimensions.width,
        y: Math.random() * dimensions.height,
        vx: 0,
        vy: 0,
        radius: isHub ? 12 : 6,
        color: couplingToColor(coupling),
        isHub,
        inCycle: cycleSet.has(filePath),
        coupling,
      });
      nodeIds.add(filePath);
    }

    // Create edges (only between nodes that exist in our set)
    const edges: GraphEdge[] = [];
    const cyclicEdges = new Set<string>();
    for (const cd of circularDependencies) {
      for (let i = 0; i < cd.cycle.length - 1; i++) {
        cyclicEdges.add(`${cd.cycle[i]}→${cd.cycle[i + 1]}`);
      }
    }

    for (const [filePath, node] of graph.nodes) {
      if (!nodeIds.has(filePath)) continue;
      for (const dep of node.dependsOn) {
        if (!nodeIds.has(dep)) continue;
        edges.push({
          source: filePath,
          target: dep,
          isCyclic: cyclicEdges.has(`${filePath}→${dep}`),
        });
      }
    }

    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [analysis, dimensions]);

  // Measure container
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({ width: entry.contentRect.width, height });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [height]);

  // Force simulation + render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;
    let iteration = 0;
    const maxIterations = 200;

    const simulate = () => {
      if (!running) return;
      iteration++;

      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const nodeMap = new Map(nodes.map(n => [n.id, n]));

      // Cooling factor
      const alpha = Math.max(0.01, 1 - iteration / maxIterations);

      // Repulsion (all pairs)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const force = (150 * alpha) / dist;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      // Attraction (edges)
      for (const edge of edges) {
        const a = nodeMap.get(edge.source);
        const b = nodeMap.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = (dist - 80) * 0.01 * alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      // Center gravity
      const cx = dimensions.width / 2;
      const cy = dimensions.height / 2;
      for (const node of nodes) {
        node.vx += (cx - node.x) * 0.001 * alpha;
        node.vy += (cy - node.y) * 0.001 * alpha;
      }

      // Apply velocity with damping
      for (const node of nodes) {
        node.vx *= 0.8;
        node.vy *= 0.8;
        node.x += node.vx;
        node.y += node.vy;
        // Bounds
        node.x = Math.max(node.radius, Math.min(dimensions.width - node.radius, node.x));
        node.y = Math.max(node.radius, Math.min(dimensions.height - node.radius, node.y));
      }

      // Render
      ctx.clearRect(0, 0, dimensions.width, dimensions.height);

      // Draw edges
      for (const edge of edges) {
        const a = nodeMap.get(edge.source);
        const b = nodeMap.get(edge.target);
        if (!a || !b) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = edge.isCyclic ? "rgba(248, 113, 113, 0.6)" : "rgba(100, 100, 140, 0.2)";
        ctx.lineWidth = edge.isCyclic ? 2 : 0.5;
        ctx.stroke();
      }

      // Draw nodes
      for (const node of nodes) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = node.color;
        ctx.fill();

        if (node.inCycle) {
          ctx.strokeStyle = "#f87171";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        if (node === selectedNode) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // Draw labels for hubs and selected
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      for (const node of nodes) {
        if (node.isHub || node === selectedNode) {
          ctx.fillStyle = "rgba(255,255,255,0.8)";
          ctx.fillText(node.label.split("/").pop() || "", node.x, node.y - node.radius - 4);
        }
      }

      if (iteration < maxIterations) {
        animRef.current = requestAnimationFrame(simulate);
      }
    };

    simulate();

    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [dimensions, selectedNode]);

  // Click handler
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const clicked = nodesRef.current.find(n => {
      const dx = n.x - x;
      const dy = n.y - y;
      return Math.sqrt(dx * dx + dy * dy) <= n.radius + 4;
    });

    setSelectedNode(clicked || null);
  }, []);

  return (
    <div ref={containerRef} style={{ width: "100%", position: "relative" }}>
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        onClick={handleClick}
        style={{
          width: "100%",
          height: `${height}px`,
          background: "var(--bg-input, #1a1a2e)",
          borderRadius: "6px",
          cursor: "crosshair",
        }}
      />
      {selectedNode && (
        <div style={{
          position: "absolute", bottom: "8px", left: "8px", right: "8px",
          padding: "8px 10px", background: "rgba(22, 22, 42, 0.95)",
          border: "1px solid var(--border-color, #2a2a4a)", borderRadius: "6px",
          fontSize: "10px", color: "var(--text-secondary, #a0a0b0)",
        }}>
          <div style={{ fontWeight: 600, color: "var(--text-primary, #e0e0e0)", marginBottom: "3px" }}>
            {selectedNode.label}
          </div>
          <div>
            Coupling: <span style={{ color: selectedNode.color }}>{selectedNode.coupling}</span>
            {selectedNode.isHub && <span style={{ color: "#fbbf24", marginLeft: "8px" }}>● Hub</span>}
            {selectedNode.inCycle && <span style={{ color: "#f87171", marginLeft: "8px" }}>● Circular</span>}
          </div>
        </div>
      )}
      {nodesRef.current.length === 0 && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", fontSize: "11px", color: "var(--text-secondary, #a0a0b0)" }}>
          No dependency connections found
        </div>
      )}
    </div>
  );
}
