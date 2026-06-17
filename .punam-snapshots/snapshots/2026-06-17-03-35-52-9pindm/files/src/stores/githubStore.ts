/**
 * GitHub Store — Centralized state management for GitHub integration.
 */

import { create } from "zustand";
import type { GitCoreStatus, GitHubUser, BranchInfo } from "../services/githubService";

interface GitHubState {
  // Phase 0: Git Core
  coreStatus: GitCoreStatus | null;
  branches: BranchInfo[];
  coreLoading: boolean;
  coreError: string | null;

  // Phase 1: Auth
  user: GitHubUser | null;
  isAuthenticated: boolean;
  authLoading: boolean;

  // UI state
  showGitHubPanel: boolean;
  activeTab: "overview" | "repos" | "prs" | "issues" | "actions" | "settings";

  // Actions
  setCoreStatus: (status: GitCoreStatus | null) => void;
  setBranches: (branches: BranchInfo[]) => void;
  setCoreLoading: (loading: boolean) => void;
  setCoreError: (error: string | null) => void;
  setUser: (user: GitHubUser | null) => void;
  setIsAuthenticated: (auth: boolean) => void;
  setAuthLoading: (loading: boolean) => void;
  setShowGitHubPanel: (show: boolean) => void;
  toggleGitHubPanel: () => void;
  setActiveTab: (tab: GitHubState["activeTab"]) => void;
}

export const useGitHubStore = create<GitHubState>((set) => ({
  // Phase 0
  coreStatus: null,
  branches: [],
  coreLoading: false,
  coreError: null,

  // Phase 1
  user: null,
  isAuthenticated: false,
  authLoading: false,

  // UI
  showGitHubPanel: false,
  activeTab: "overview",

  // Actions
  setCoreStatus: (status) => set({ coreStatus: status }),
  setBranches: (branches) => set({ branches }),
  setCoreLoading: (loading) => set({ coreLoading: loading }),
  setCoreError: (error) => set({ coreError: error }),
  setUser: (user) => set({ user, isAuthenticated: !!user }),
  setIsAuthenticated: (auth) => set({ isAuthenticated: auth }),
  setAuthLoading: (loading) => set({ authLoading: loading }),
  setShowGitHubPanel: (show) => set({ showGitHubPanel: show }),
  toggleGitHubPanel: () => set((s) => ({ showGitHubPanel: !s.showGitHubPanel })),
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
