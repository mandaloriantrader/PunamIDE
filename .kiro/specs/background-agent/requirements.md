# Requirements Document

## Introduction

PunamIDE currently blocks the chat panel while the AI agent (Punam) executes tasks such as editing files, running terminal commands, and iterating on errors. The Background Agent feature allows users to continue coding while Punam works on a task in the background. A progress indicator appears in the status bar, and the user can check progress, pause, or cancel the background task at any time. When the agent finishes, results appear via a notification or dedicated panel.

## Glossary

- **Background_Agent**: The subsystem that manages agent task execution in a separate logical context, decoupled from the main chat panel UI
- **Status_Bar_Indicator**: A compact progress widget rendered in the existing StatusBar component showing the state of a background task
- **Task_Queue**: An ordered list of pending background agent tasks awaiting execution
- **Conflict_Detector**: The subsystem that identifies when a background agent file change targets a file the user is currently editing
- **Shadow_Buffer**: A temporary in-memory copy of file content used by the Background_Agent to stage changes before applying them to disk
- **Notification_Panel**: A UI element that displays completion results, conflict warnings, and action prompts to the user
- **Agent_Session**: A single background execution context containing the task description, subtasks, history, and produced file changes

## Requirements

### Requirement 1: Launch Task in Background

**User Story:** As a developer, I want to send a task to Punam and immediately return to coding, so that I do not lose focus waiting for the agent to finish.

#### Acceptance Criteria

1. WHEN the user submits a task in Agent mode and selects "Run in Background", THE Background_Agent SHALL create a new Agent_Session and begin execution without blocking the chat panel
2. WHEN a background task is launched, THE Background_Agent SHALL transfer the current project context (open tabs, active file, project path, file tree) to the Agent_Session at the moment of launch
3. WHEN a background task is launched, THE Chat_Panel SHALL return to an idle state where the user can send new chat messages or start a new foreground task
4. THE Background_Agent SHALL support at most one active Agent_Session at a time to prevent resource contention

### Requirement 2: Status Bar Progress Indicator

**User Story:** As a developer, I want to see a small progress indicator in the status bar while Punam works in the background, so that I know the task is still running without switching context.

#### Acceptance Criteria

1. WHILE an Agent_Session is active, THE Status_Bar_Indicator SHALL display a spinning animation and the current subtask label in the status bar
2. WHEN the Agent_Session transitions between steps (planning, proposing fix, running command, verifying), THE Status_Bar_Indicator SHALL update the displayed step label within 500ms
3. WHEN no Agent_Session is active, THE Status_Bar_Indicator SHALL not be visible in the status bar
4. WHEN the user hovers over the Status_Bar_Indicator, THE Status_Bar_Indicator SHALL display a tooltip showing the full task description and elapsed time

### Requirement 3: Progress Inspection

**User Story:** As a developer, I want to check the detailed progress of the background task at any time, so that I can understand what Punam is doing without interrupting the work.

#### Acceptance Criteria

1. WHEN the user clicks the Status_Bar_Indicator, THE Notification_Panel SHALL open and display the Agent_Session history including completed steps, current step, and pending subtasks
2. WHILE the Agent_Session is active, THE Notification_Panel SHALL update in real-time as new steps complete or new output is produced
3. WHEN the Agent_Session has produced file changes, THE Notification_Panel SHALL list each changed file path with a summary of the modification

### Requirement 4: Pause and Resume

**User Story:** As a developer, I want to pause the background agent so that I can review intermediate results or free up system resources, and resume later.

#### Acceptance Criteria

1. WHEN the user clicks "Pause" in the Notification_Panel or Status_Bar_Indicator context menu, THE Background_Agent SHALL suspend execution after completing the current atomic step
2. WHILE the Agent_Session is paused, THE Status_Bar_Indicator SHALL display a paused icon and the label "Paused"
3. WHEN the user clicks "Resume", THE Background_Agent SHALL continue execution from the next pending step in the Agent_Session
4. WHILE the Agent_Session is paused, THE Background_Agent SHALL retain all session state including history, pending subtasks, and staged file changes

### Requirement 5: Cancel Background Task

**User Story:** As a developer, I want to cancel a background task that is no longer needed, so that I can reclaim resources and start a different task.

#### Acceptance Criteria

1. WHEN the user clicks "Cancel" in the Notification_Panel or Status_Bar_Indicator context menu, THE Background_Agent SHALL stop execution and discard all unapplied file changes from the Agent_Session
2. WHEN a task is cancelled, THE Background_Agent SHALL terminate any running terminal command associated with the Agent_Session within 2 seconds
3. WHEN a task is cancelled, THE Notification_Panel SHALL display a summary of work completed before cancellation
4. IF the Agent_Session has already applied some file changes to disk before cancellation, THEN THE Background_Agent SHALL offer a "Revert Changes" action to undo applied modifications

### Requirement 6: Completion Notification

**User Story:** As a developer, I want to be notified when the background task finishes, so that I can review the results at my convenience.

#### Acceptance Criteria

1. WHEN the Agent_Session completes all subtasks successfully, THE Notification_Panel SHALL display a success notification with a summary of all changes made
2. WHEN the Agent_Session completes, THE Status_Bar_Indicator SHALL transition to a checkmark icon for 10 seconds, then hide
3. WHEN the user clicks the completion notification, THE Notification_Panel SHALL open showing the full result including file diffs and terminal output
4. IF the Agent_Session fails after exhausting retry attempts, THEN THE Notification_Panel SHALL display an error notification with the failure reason and last attempted step

### Requirement 7: File Conflict Detection and Resolution

**User Story:** As a developer, I want the background agent to detect when it tries to modify a file I am currently editing, so that my work is not overwritten.

#### Acceptance Criteria

1. WHEN the Background_Agent produces a file change targeting a file that has unsaved modifications in the editor, THE Conflict_Detector SHALL flag the change as conflicting and pause application of that specific file
2. WHEN a conflict is detected, THE Notification_Panel SHALL prompt the user with options: "Apply Anyway", "View Diff", or "Skip This File"
3. WHEN the user selects "View Diff", THE Notification_Panel SHALL open a diff view comparing the user's current editor content against the agent's proposed change
4. WHEN the Background_Agent targets a file that is not open or has no unsaved changes, THE Background_Agent SHALL apply the change directly without prompting
5. THE Conflict_Detector SHALL compare file content at the moment of application against the content snapshot taken at task launch to detect external modifications

### Requirement 8: Background Terminal Isolation

**User Story:** As a developer, I want background agent terminal commands to run in a separate session, so that they do not interfere with my active terminal work.

#### Acceptance Criteria

1. WHEN the Background_Agent needs to execute a terminal command, THE Background_Agent SHALL create or reuse a dedicated terminal session named "Punam Background"
2. THE Background_Agent SHALL not write to or read from terminal sessions owned by the user
3. WHEN the Agent_Session completes or is cancelled, THE Background_Agent SHALL preserve the "Punam Background" terminal session output for user review
4. WHILE the Background_Agent is executing a terminal command, THE Status_Bar_Indicator SHALL display the command being run

### Requirement 9: State Persistence Across Restarts

**User Story:** As a developer, I want the background task state to survive an IDE restart, so that I do not lose progress if I close and reopen PunamIDE.

#### Acceptance Criteria

1. WHILE an Agent_Session is active or paused, THE Background_Agent SHALL persist the session state (task, step, history, staged changes) to the Zustand persisted store
2. WHEN PunamIDE starts and a persisted Agent_Session exists, THE Background_Agent SHALL restore the session in a paused state and notify the user via the Notification_Panel
3. IF the persisted session state is corrupted or incompatible with the current project state, THEN THE Background_Agent SHALL discard the session and notify the user that the background task could not be recovered

### Requirement 10: Resource Management

**User Story:** As a developer, I want the background agent to use resources responsibly, so that my IDE remains responsive while the agent works.

#### Acceptance Criteria

1. THE Background_Agent SHALL limit concurrent LLM API calls to one at a time per Agent_Session
2. WHILE the user is actively typing in the editor, THE Background_Agent SHALL deprioritize non-critical operations (delay next LLM call by 2 seconds) to preserve UI responsiveness
3. WHEN the Background_Agent encounters a rate-limit response from the LLM provider, THE Background_Agent SHALL wait for the retry-after duration and resume automatically without user intervention
4. THE Background_Agent SHALL track and report token usage for background tasks separately in the Usage Dashboard
