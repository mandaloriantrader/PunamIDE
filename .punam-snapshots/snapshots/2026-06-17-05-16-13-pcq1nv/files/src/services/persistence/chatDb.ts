/**
 * Chat persistence via SQLite (Rust backend).
 * Saves and loads chat sessions to/from a local database.
 */

import { invoke } from "@tauri-apps/api/core";

export interface ChatSessionRecord {
  id: string;
  project_path: string;
  title: string;
  provider: string;
  model: string;
  messages: string; // JSON stringified
  token_count: number;
  cost: number;
  created_at: number;
  updated_at: number;
}

let initialized = false;
let initPromise: Promise<void> | null = null;
let maintenancePromise: Promise<void> | null = null;
let writesSinceMaintenance = 0;

function runMaintenance(): Promise<void> {
  if (maintenancePromise) return maintenancePromise;
  maintenancePromise = invoke<string>("db_maintenance")
    .then((summary) => {
      if (summary) console.info("[ChatDB] Maintenance complete:", summary);
      writesSinceMaintenance = 0;
    })
    .catch((err) => {
      console.warn("[ChatDB] Maintenance failed:", err);
    })
    .finally(() => {
      maintenancePromise = null;
    });
  return maintenancePromise;
}

export async function initChatDb(): Promise<void> {
  if (initialized) return;
  if (!initPromise) {
    initPromise = invoke("db_init")
      .then(() => {
        initialized = true;
        void runMaintenance();
      })
      .catch((err) => {
        console.warn("Chat DB init failed (running in browser?):", err);
      })
      .finally(() => {
        initPromise = null;
      });
  }
  await initPromise;
}

export async function saveChatSession(session: ChatSessionRecord): Promise<void> {
  await initChatDb();
  try {
    await invoke("db_save_chat_session", { session });
    writesSinceMaintenance += 1;
    if (writesSinceMaintenance >= 100) void runMaintenance();
  } catch (err) {
    console.error("Failed to save chat session:", err);
  }
}

export async function loadChatSessions(projectPath: string, limit = 50): Promise<ChatSessionRecord[]> {
  await initChatDb();
  try {
    return await invoke("db_load_chat_sessions", { projectPath, limit });
  } catch (err) {
    console.warn("Failed to load chat sessions:", err);
    return [];
  }
}

export async function loadChatSession(id: string, projectPath: string): Promise<ChatSessionRecord | null> {
  await initChatDb();
  try {
    return await invoke("db_load_chat_session", { id, projectPath });
  } catch (err) {
    console.warn("Failed to load chat session:", err);
    return null;
  }
}

export async function deleteChatSession(id: string, projectPath: string): Promise<void> {
  await initChatDb();
  try {
    await invoke("db_delete_chat_session", { id, projectPath });
  } catch (err) {
    console.error("Failed to delete chat session:", err);
  }
}
