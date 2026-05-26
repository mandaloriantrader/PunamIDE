# Multi-File Diff Board Implementation Plan

## Goal
Replace the current AiDiffPreview with a GitHub-PR-style multi-file diff review board where users can accept/reject **individual hunks** (not just whole files).

## Architecture

### New Component: `MultiFileDiffBoard.tsx`
- **Left sidebar**: File tree showing all changed files with +/- counts and status badges (Accepted/Rejected/Pending)
- **Main area**: 
  - Top: File tabs to switch between files
  - Bottom: Per-hunk diff display with Accept/Reject buttons on each hunk
- **Footer**: "Accept All", "Reject All", "Apply Selected", "Cancel"

### State Management
- Track per-hunk acceptance state: `Map<string, Map<number, "accepted" | "rejected" | "pending">`
  - Outer key: file path
  - Inner key: hunk index
- Auto-apply accepted hunks when "Apply Selected" is clicked

### Files to Create/Modify
1. `src/components/MultiFileDiffBoard.tsx` — New component (600+ lines)
2. `src/App.css` — Add CSS styles (~200 lines)
3. `src/App.tsx` — Replace AiDiffPreview usage with MultiFileDiffBoard

### Data Flow
1. AI proposes changes → `ReviewChanges` object created (same as now)
2. MultiFileDiffBoard parses each file's diff into hunks (using the existing diff logic)
3. User accepts/rejects hunks per file
4. On "Apply Selected", only accepted hunks are applied to each file