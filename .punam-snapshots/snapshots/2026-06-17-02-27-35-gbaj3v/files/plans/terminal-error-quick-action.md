# Terminal Error Quick Actions Plan

## Goal
Add a "Fix with AI" small button next to error lines in the terminal output. When clicked, it sends the error context (failed command + output) directly to the AI chat panel.

## Changes Needed

### 1. `src/components/Terminal.tsx`
- Add `onFixWithAi?: (errorText: string) => void` prop
- In the render loop for error lines, show a small "⚡ Fix" button next to the error text
- Collect the recent error context from the session

### 2. `src/components/TerminalPanel.tsx`
- Pass `onFixWithAi` through to `<Terminal>`

### 3. `src/App.tsx`
- Pass `onFixWithAi` to `<TerminalPanel>`
- The handler opens the AI panel and sends a pre-formatted prompt with the error

### 4. `src/App.css`
- Add styles for the "Fix with AI" button on terminal error lines

## UX Flow
1. User runs a failing command in terminal
2. Error lines appear with a small "⚡ Fix" button
3. User clicks "⚡ Fix"
4. AI panel opens with prompt: "Fix this error: [error text]"
5. AI analyzes and proposes a fix