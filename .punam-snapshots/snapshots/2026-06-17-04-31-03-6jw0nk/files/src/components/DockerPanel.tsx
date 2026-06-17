/**
 * DockerPanel — List, start, stop, and remove Docker containers.
 * Detects devcontainer configurations.
 * Ported from Zenith IDE, adapted for Punam IDE.
 */

import { useState, useCallback } from "react";
import { Box, Play, Square, RefreshCw, Trash2, Terminal } from "lucide-react";
import { runTerminalCommand } from "../utils/tauri";

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  created: string;
}

interface Props {
  projectPath: string;
}

export default function DockerPanel({ projectPath }: Props) {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasDocker, setHasDocker] = useState<boolean | null>(null);
  const [devcontainerExists, setDevcontainerExists] = useState(false);

  const refreshContainers = useCallback(async () => {
    if (!projectPath) return;
    try {
      const result = await runTerminalCommand(
        'docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.CreatedAt}}"',
        projectPath
      );
      if (result.exit_code === 0) {
        const parsed = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const parts = line.split("|");
            return {
              id: parts[0] || "",
              name: parts[1] || "",
              image: parts[2] || "",
              status: parts[3] || "",
              ports: parts[4] || "",
              created: parts[5] || "",
            };
          });
        setContainers(parsed);
      }
    } catch {
      // Docker not available
    }
  }, [projectPath]);

  const checkDocker = useCallback(async () => {
    if (!projectPath) return;
    setIsLoading(true);
    try {
      const result = await runTerminalCommand(
        "docker version --format \"{{.Server.Version}}\"",
        projectPath
      );
      setHasDocker(result.exit_code === 0);

      // Check for devcontainer
      const dcCheck = await runTerminalCommand(
        "if exist .devcontainer\\devcontainer.json (echo yes) else (echo no)",
        projectPath
      );
      setDevcontainerExists(dcCheck.stdout.trim() === "yes");

      if (result.exit_code === 0) {
        await refreshContainers();
      }
    } catch {
      setHasDocker(false);
    }
    setIsLoading(false);
  }, [projectPath, refreshContainers]);

  const startContainer = async (containerId: string) => {
    if (!projectPath) return;
    await runTerminalCommand(`docker start ${containerId}`, projectPath);
    await refreshContainers();
  };

  const stopContainer = async (containerId: string) => {
    if (!projectPath) return;
    await runTerminalCommand(`docker stop ${containerId}`, projectPath);
    await refreshContainers();
  };

  const removeContainer = async (containerId: string) => {
    if (!projectPath) return;
    await runTerminalCommand(`docker rm -f ${containerId}`, projectPath);
    await refreshContainers();
  };

  const openDevcontainer = async () => {
    if (!projectPath) return;
    await runTerminalCommand(
      "docker compose -f .devcontainer/docker-compose.yml up -d 2>nul || docker build -t devcontainer .devcontainer/",
      projectPath
    );
    await refreshContainers();
  };

  if (hasDocker === null) {
    return (
      <div className="docker-panel">
        <div className="docker-check">
          <Box size={24} />
          <p>Docker Integration</p>
          <button className="docker-check-btn" onClick={checkDocker} disabled={isLoading}>
            {isLoading ? "Checking..." : "Check Docker Status"}
          </button>
        </div>
      </div>
    );
  }

  if (!hasDocker) {
    return (
      <div className="docker-panel">
        <div className="docker-not-found">
          <Box size={24} />
          <p>Docker not found</p>
          <span>Install Docker Desktop to use container features</span>
          <a
            href="https://www.docker.com/products/docker-desktop/"
            target="_blank"
            rel="noopener noreferrer"
            className="docker-install-link"
          >
            Get Docker Desktop →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="docker-panel">
      <div className="docker-header">
        <h4>
          <Box size={14} /> Containers
        </h4>
        <div className="docker-actions">
          <button onClick={refreshContainers} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {devcontainerExists && (
        <div className="devcontainer-banner">
          <Terminal size={14} />
          <span>Dev Container detected</span>
          <button onClick={openDevcontainer}>Open</button>
        </div>
      )}

      <div className="docker-container-list">
        {containers.length === 0 ? (
          <div className="docker-empty">No containers running</div>
        ) : (
          containers.map((c) => (
            <div key={c.id} className="docker-container-item">
              <div className="docker-container-info">
                <span
                  className={`docker-status-dot ${c.status.includes("Up") ? "running" : "stopped"}`}
                />
                <div>
                  <div className="docker-container-name">{c.name}</div>
                  <div className="docker-container-image">{c.image}</div>
                  <div className="docker-container-status">{c.status}</div>
                  {c.ports && <div className="docker-container-ports">{c.ports}</div>}
                </div>
              </div>
              <div className="docker-container-actions">
                {c.status.includes("Up") ? (
                  <button onClick={() => stopContainer(c.id)} title="Stop">
                    <Square size={12} />
                  </button>
                ) : (
                  <button onClick={() => startContainer(c.id)} title="Start">
                    <Play size={12} />
                  </button>
                )}
                <button onClick={() => removeContainer(c.id)} title="Remove">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
