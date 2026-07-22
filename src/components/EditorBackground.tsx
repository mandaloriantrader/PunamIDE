import { useRef, useEffect, useCallback } from "react";

/**
 * EditorBackground — renders an animated "connected nodes" network pattern
 * behind the active code editor. Uses HTML5 Canvas for performance.
 * Deliberately ultra-subtle to avoid interfering with code readability.
 */

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface EditorBackgroundProps {
  /** Base opacity for the entire canvas (0–1). Default: 0.04 */
  opacity?: number;
  /** Node color. Default uses accent color */
  nodeColor?: string;
  /** Line/connection color. Default uses accent color */
  lineColor?: string;
  /** Max number of nodes. Default: 40 */
  nodeCount?: number;
  /** Max distance for drawing connections between nodes. Default: 120 */
  connectionDistance?: number;
  /** Whether the animation is active. Default: true */
  active?: boolean;
}

export default function EditorBackground({
  opacity = 0.04,
  nodeColor,
  lineColor,
  nodeCount = 40,
  connectionDistance = 120,
  active = true,
}: EditorBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const animFrameRef = useRef<number>(0);
  const sizeRef = useRef({ w: 0, h: 0 });

  // Resolve colors from CSS variables
  const getColor = useCallback(
    (override: string | undefined, fallback: string) => {
      if (override) return override;
      const accent = getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim();
      return accent || fallback;
    },
    []
  );

  // Initialize nodes
  const initNodes = useCallback(
    (w: number, h: number) => {
      const nodes: Node[] = [];
      for (let i = 0; i < nodeCount; i++) {
        nodes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.25,
          vy: (Math.random() - 0.5) * 0.25,
          radius: Math.random() * 2 + 1.2,
        });
      }
      nodesRef.current = nodes;
    },
    [nodeCount]
  );

  // Animation loop
  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { w, h } = sizeRef.current;
    const nodes = nodesRef.current;
    const nColor = getColor(nodeColor, "#89b4fa");
    const lColor = getColor(lineColor, "#89b4fa");

    ctx.clearRect(0, 0, w, h);

    // Update positions
    for (const node of nodes) {
      node.x += node.vx;
      node.y += node.vy;

      // Bounce off edges
      if (node.x < 0 || node.x > w) node.vx *= -1;
      if (node.y < 0 || node.y > h) node.vy *= -1;

      // Clamp
      node.x = Math.max(0, Math.min(w, node.x));
      node.y = Math.max(0, Math.min(h, node.y));
    }

    // Draw connections
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < connectionDistance) {
          const lineOpacity = 1 - dist / connectionDistance;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.strokeStyle = `${lColor}${Math.round(lineOpacity * 180)
            .toString(16)
            .padStart(2, "0")}`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }

    // Draw nodes
    for (const node of nodes) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = `${nColor}cc`;
      ctx.fill();
    }

    animFrameRef.current = requestAnimationFrame(animate);
  }, [getColor, nodeColor, lineColor, connectionDistance]);

  // Handle resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.scale(dpr, dpr);
        sizeRef.current = { w: width, h: height };

        // Reinitialize nodes if canvas size changes significantly
        if (nodesRef.current.length === 0) {
          initNodes(width, height);
        }
      }
    });

    observer.observe(canvas.parentElement || canvas);
    return () => observer.disconnect();
  }, [initNodes]);

  // Start/stop animation
  useEffect(() => {
    if (active) {
      const canvas = canvasRef.current;
      if (canvas && nodesRef.current.length === 0) {
        const rect = canvas.getBoundingClientRect();
        initNodes(rect.width, rect.height);
      }
      animFrameRef.current = requestAnimationFrame(animate);
    }
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [active, animate, initNodes]);

  // Respect prefers-reduced-motion
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => {
      if (mq.matches && animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
    mq.addEventListener("change", handler);
    handler();
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="editor-bg-canvas"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        pointerEvents: "none",
        opacity,
      }}
    />
  );
}
