/**
 * GitHub Service — invoke() wrappers for all Rust GitHub commands.
 * PAT never touches this layer. All auth is handled in Rust.
 */

import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";

const STORE_NAME = "punamide-settings.json";
const GITHUB_TOKEN_KEY = "github_token";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitCoreStatus {
  is_git_repo: boolean;
  branch: string | null;
  detached: boolean;
  dirty_count: number;
  dirty_files: string[];
  remote_origin: string | null;
  ahead: number;
  behind: number;
  has_upstream: boolean;
  git_available: boolean;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  name: string | null;
  email: string | null;
  html_url: string;
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  upstream: string | null;
}

export interface RepoInfo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  created_at: string;
  updated_at: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  head_ref: string;
  base_ref: string;
  user_login: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  mergeable: boolean | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user_login: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_branch: string;
  created_at: string;
}

export interface PrePushStatus {
  dirty_files: string[];
  ahead: number;
  behind: number;
  has_remote: boolean;
  has_upstream: boolean;
  current_branch: string | null;
  safe_to_push: boolean;
  warnings: string[];
}

// ─── Phase 0: Git Core Check ─────────────────────────────────────────────────

/** Full git status check — repo state, branch, dirty files, remote, ahead/behind. */
export const githubCheckRepo = () =>
  invoke<GitCoreStatus>("github_check_repo");

/** Quick check: is the current folder a git repo? */
export const githubIsGitRepo = () =>
  invoke<boolean>("github_is_git_repo");

/** Get current branch name. */
export const githubGetBranch = () =>
  invoke<string | null>("github_get_branch");

/** Get list of dirty (uncommitted) files. */
export const githubGetDirtyFiles = () =>
  invoke<string[]>("github_get_dirty_files");

/** Get remote origin URL. */
export const githubGetRemoteOrigin = () =>
  invoke<string | null>("github_get_remote_origin");

/** Get ahead/behind counts relative to upstream. Returns [ahead, behind]. */
export const githubGetAheadBehind = () =>
  invoke<[number, number]>("github_get_ahead_behind");

/** List all branches (local + optionally remote). */
export const githubListBranches = (includeRemote: boolean = false) =>
  invoke<BranchInfo[]>("github_list_branches", { includeRemote });

// ─── Phase 1: Authentication ─────────────────────────────────────────────────

/** Store PAT and validate it. Returns the authenticated user on success. */
export const githubSetToken = (token: string) =>
  invoke<GitHubUser>("github_set_token", { token });

/** Get the currently authenticated user (cached). */
export const githubGetUser = () =>
  invoke<GitHubUser | null>("github_get_user");

/** Check if authenticated. */
export const githubCheckAuth = () =>
  invoke<boolean>("github_check_auth");

/** Clear stored token and logout. */
export const githubLogout = () =>
  invoke<void>("github_logout");

// ─── Token Persistence (encrypted at rest via tauri-plugin-store) ────────────

/** Save token to encrypted store. Called after successful github_set_token. */
export async function persistGitHubToken(token: string): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.set(GITHUB_TOKEN_KEY, token);
  await store.save();
}

/** Load persisted token and re-authenticate with Rust backend on app startup. */
export async function restoreGitHubAuth(): Promise<GitHubUser | null> {
  try {
    const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
    const token = (await store.get(GITHUB_TOKEN_KEY)) as string | null;
    if (!token) return null;

    // Pass token to Rust to validate and cache
    const user = await githubSetToken(token);
    return user;
  } catch {
    // Token expired or invalid — clear it
    await clearPersistedGitHubToken();
    return null;
  }
}

/** Clear persisted token from store. */
export async function clearPersistedGitHubToken(): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} });
  await store.delete(GITHUB_TOKEN_KEY);
  await store.save();
}

// ─── Phase 2: Repository Management ──────────────────────────────────────────

/** Create a new GitHub repository. */
export const githubCreateRepo = (name: string, isPrivate: boolean, description?: string, autoInit: boolean = false) =>
  invoke<RepoInfo>("github_create_repo", { name, private: isPrivate, description: description || null, autoInit });

/** List authenticated user's repositories. */
export const githubListRepos = (page: number = 1, perPage: number = 30, sort?: string) =>
  invoke<RepoInfo[]>("github_list_repos", { page, perPage, sort: sort || null });

/** Get info about a specific repository. */
export const githubGetRepoInfo = (owner: string, repo: string) =>
  invoke<RepoInfo>("github_get_repo_info", { owner, repo });

/** Add or update a remote on the current git repo. */
export const githubLinkRemote = (repoUrl: string, remoteName?: string) =>
  invoke<void>("github_link_remote", { repoUrl, remoteName: remoteName || null });

/** Remove a remote from the current git repo. */
export const githubRemoveRemote = (remoteName: string) =>
  invoke<void>("github_remove_remote", { remoteName });

/** Initialize a new git repository in the current project. */
export const githubInitRepo = () =>
  invoke<void>("github_init_repo");

/** Get the owner/repo slug from the current remote origin. */
export const githubGetRepoSlug = () =>
  invoke<[string, string]>("github_get_repo_slug");
