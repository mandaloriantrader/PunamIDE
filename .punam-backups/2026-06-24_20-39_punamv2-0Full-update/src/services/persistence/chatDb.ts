/**
 * Chat persistence via SQLite (Rust backend).
 * Saves and loads chat sessions to/from a local database.
 */

import { invoke } from "@tauri-apps/api/core";

export interface ChatSessionRecord {
  id: string;
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

export async function initChatDb(): Promise<void> {
  if (initialized) return;
  try {
    await invoke("db_init");
    initialized = true;
  } catch (err) {
    console.warn("Chat DB init failed (running in browser?):", err);
  }
}

export async function saveChatSession(session: ChatSessionRecord): Promise<void> {
  await initChatDb();
  try {
    await invoke("db_save_chat_session", { session });
  } catch (err) {
    console.error("Failed to save chat session:", err);
  }
}

export async function loadChatSessions(limit = 50): Promise<ChatSessionRecord[]> {
  await initChatDb();
  try {
    return await invoke("db_load_chat_sessions", { limit });
  } catch (err) {
    console.warn("Failed to load chat sessions:", err);
    return [];
  }
}

export async function deleteChatSession(id: string): Promise<void> {
  await initChatDb();
  try {
    await invoke("db_delete_chat_session", { id });
  } catch (err) {
    console.error("Failed to delete chat session:", err);
  }
}
