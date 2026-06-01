/**
 * AgentKanban — Visual task board for AI agent operations.
 * Shows tasks in columns: Planning → In Progress → Review → Done
 */

import { useState, useCallback } from "react";
import { Plus, Play, CheckCircle2, Clock, AlertCircle, Trash2, GripVertical } from "lucide-react";

export type TaskStatus = "planning" | "in_progress" | "review" | "done" | "failed";

export interface AgentTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  steps: string[];
  currentStep: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
}

interface Props {
  onRunTask?: (task: AgentTask) => void;
}

const COLUMNS: { id: TaskStatus; label: string; icon: typeof Clock; color: string }[] = [
  { id: "planning", label: "Planning", icon: Clock, color: "#89b4fa" },
  { id: "in_progress", label: "In Progress", icon: Play, color: "#fab387" },
  { id: "review", label: "Review", icon: AlertCircle, color: "#f9e2af" },
  { id: "done", label: "Done", icon: CheckCircle2, color: "#a6e3a1" },
];

const STORAGE_KEY = "punam-agent-tasks";

function loadTasks(): AgentTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveTasks(tasks: AgentTask[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

export default function AgentKanban({ onRunTask }: Props) {
  const [tasks, setTasks] = useState<AgentTask[]>(loadTasks);
  const [newTaskTitle, setNewTaskTitle] = useState("");

  const updateTasks = useCallback((updater: (prev: AgentTask[]) => AgentTask[]) => {
    setTasks((prev) => {
      const next = updater(prev);
      saveTasks(next);
      return next;
    });
  }, []);

  const addTask = () => {
    if (!newTaskTitle.trim()) return;
    const task: AgentTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: newTaskTitle.trim(),
      description: "",
      status: "planning",
      steps: [],
      currentStep: 0,
      createdAt: Date.now(),
    };
    updateTasks((prev) => [...prev, task]);
    setNewTaskTitle("");
  };

  const moveTask = (taskId: string, newStatus: TaskStatus) => {
    updateTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, status: newStatus, completedAt: newStatus === "done" ? Date.now() : undefined }
          : t
      )
    );
  };

  const deleteTask = (taskId: string) => {
    updateTasks((prev) => prev.filter((t) => t.id !== taskId));
  };

  const getTasksForColumn = (status: TaskStatus) => tasks.filter((t) => t.status === status);

  return (
    <div className="kanban-board">
      <div className="kanban-header">
        <h3>Agent Tasks</h3>
        <div className="kanban-add">
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTask()}
            placeholder="New task..."
            className="kanban-input"
          />
          <button className="kanban-add-btn" onClick={addTask} disabled={!newTaskTitle.trim()}>
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="kanban-columns">
        {COLUMNS.map((col) => (
          <div key={col.id} className="kanban-column">
            <div className="kanban-column-header" style={{ borderTopColor: col.color }}>
              <col.icon size={13} style={{ color: col.color }} />
              <span>{col.label}</span>
              <span className="kanban-count">{getTasksForColumn(col.id).length}</span>
            </div>
            <div className="kanban-column-body">
              {getTasksForColumn(col.id).map((task) => (
                <div key={task.id} className="kanban-card">
                  <div className="kanban-card-header">
                    <GripVertical size={12} className="kanban-grip" />
                    <span className="kanban-card-title">{task.title}</span>
                  </div>
                  {task.steps.length > 0 && (
                    <div className="kanban-card-progress">
                      {task.currentStep}/{task.steps.length} steps
                    </div>
                  )}
                  {task.error && (
                    <div className="kanban-card-error">{task.error}</div>
                  )}
                  <div className="kanban-card-actions">
                    {col.id === "planning" && (
                      <button onClick={() => { moveTask(task.id, "in_progress"); onRunTask?.(task); }} title="Start">
                        <Play size={12} />
                      </button>
                    )}
                    {col.id === "in_progress" && (
                      <button onClick={() => moveTask(task.id, "review")} title="Move to Review">
                        <AlertCircle size={12} />
                      </button>
                    )}
                    {col.id === "review" && (
                      <button onClick={() => moveTask(task.id, "done")} title="Mark Done">
                        <CheckCircle2 size={12} />
                      </button>
                    )}
                    <button onClick={() => deleteTask(task.id)} title="Delete" className="kanban-delete">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
              {getTasksForColumn(col.id).length === 0 && (
                <div className="kanban-empty">No tasks</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
