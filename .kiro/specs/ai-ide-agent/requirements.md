# Requirements Document

## Introduction

This document defines the requirements for the AI IDE Agent feature in PunamIDE v2.0. The AI IDE Agent transforms PunamIDE from a code editor with AI chat assistance into a fully autonomous development partner capable of understanding entire projects, proactively detecting and fixing errors, performing multi-file refactoring, generating tests, and executing multi-step plans. The feature builds upon the existing AI Chat component, Terminal integration, Smart Context Engine architecture, and provider abstraction layer already present in PunamIDE.

## Glossary

- **Agent**: The autonomous AI system within PunamIDE that can plan, execute, and iterate on development tasks across multiple files and tools
- **Context_Engine**: The Smart Context Engine subsystem responsible for indexing, processing, and serving project-wide contextual information to the Agent
- **Project_Index**: A structured representation of the entire project including file contents, dependency graphs, type information, and architectural relationships
- **Task_Planner**: The component that decomposes high-level user goals into ordered, executable sub-tasks
- **Code_Analyzer**: The component that performs static analysis on project code to detect errors, anti-patterns, and improvement opportunities
- **Refactoring_Engine**: The component that executes multi-file code transformations while preserving program semantics
- **Test_Generator**: The component that analyzes code and produces unit and integration tests
- **Terminal_Bridge**: The interface between the Agent and the integrated terminal for executing commands and reading output
- **Healing_Loop**: The automated cycle of detecting build/test failures, diagnosing root causes, and applying corrective code changes
- **Persona**: A configurable set of coding standards, naming conventions, and architectural patterns that the Agent follows
- **Provider**: An external AI model service (Gemini, OpenAI, OpenRouter, Ollama) used by the Agent for inference

## Requirements

### Requirement 1: Whole-Program Project Indexing

**User Story:** As a developer, I want the Agent to understand my entire project structure and dependencies, so that it can make informed decisions that respect architectural boundaries and cross-file relationships.

#### Acceptance Criteria

1. WHEN a project folder is opened, THE Context_Engine SHALL build a Project_Index containing file paths, directory structure, and detected framework metadata (package manager config files, build tool configs, and language-specific manifest files) within 30 seconds for projects up to 10,000 files
2. WHEN a file is created, modified, or deleted in the project, THE Context_Engine SHALL incrementally update the Project_Index within 2 seconds of the file system event; WHEN multiple file system events occur within a 500-millisecond window, THE Context_Engine SHALL batch-process all changes and complete the update within 5 seconds
3. THE Context_Engine SHALL maintain a dependency graph that maps static import and export relationships between all source files in the project for languages with module systems supported by the configured language services
4. WHEN the Agent processes a user request referencing one or more target files, THE Context_Engine SHALL provide cross-file context limited to type definitions, function signatures, and architectural dependencies that are reachable within 2 levels of the import graph from the target files
5. THE Context_Engine SHALL exclude files matching patterns defined in .gitignore and a user-configurable ignore list stored in project settings from the Project_Index
6. IF the project exceeds 50,000 files, THEN THE Context_Engine SHALL index only directories containing source code files (as identified by file extension) and SHALL prioritize files accessed within the last 7 days and files belonging to the same module as currently open tabs
7. IF a file cannot be read during indexing due to permission errors or encoding failures, THEN THE Context_Engine SHALL skip the unreadable file, log the file path in the indexing report, and continue indexing the remaining files without interruption

### Requirement 2: Proactive Error Detection and Automated Fixing

**User Story:** As a developer, I want the Agent to actively detect errors beyond syntax issues and suggest automated fixes with explanations, so that I can resolve problems faster and understand root causes.

#### Acceptance Criteria

1. WHEN a file is saved, THE Code_Analyzer SHALL analyze the file and its direct dependents (up to 2 levels in the Project_Index dependency graph) for type errors, unused imports, unreachable code, and null/undefined reference patterns within 5 seconds
2. WHEN the Code_Analyzer detects an error, THE Agent SHALL generate a fix proposal containing the corrected code, affected file paths, and an explanation of the root cause in 3 sentences or fewer
3. THE Code_Analyzer SHALL detect errors across file boundaries by tracing type mismatches through import chains up to 3 levels deep using the Project_Index dependency graph
4. WHEN the user accepts a fix proposal, THE Agent SHALL apply the code changes to all affected files atomically and update the Project_Index
5. IF applying a fix proposal fails on any affected file, THEN THE Agent SHALL revert all changes from that proposal, preserve the original file contents, and display an error message indicating which file failed and why
6. IF the Code_Analyzer detects more than 20 issues in a single analysis pass, THEN THE Agent SHALL prioritize issues by severity (error, warning, info) and present the top 10 with an option to view all
7. WHEN terminal output contains stack traces, compiler error patterns, or test runner failure summaries, THE Code_Analyzer SHALL parse the output within 5 seconds, correlate errors to source file locations, and generate fix proposals
8. IF the Code_Analyzer detects an error but cannot generate a fix proposal, THEN THE Agent SHALL display the error with its location and root cause explanation without a fix action

### Requirement 3: Natural Language Multi-File Refactoring

**User Story:** As a developer, I want to describe refactoring operations in natural language and have the Agent execute them across multiple files, so that I can restructure code without manual find-and-replace across the project.

#### Acceptance Criteria

1. WHEN the user provides a natural language refactoring command, THE Refactoring_Engine SHALL identify all files containing references to the targeted symbol or structure using the Project_Index and generate a set of coordinated changes covering every affected reference, import, and type annotation within 30 seconds for projects of up to 10,000 indexed files
2. THE Refactoring_Engine SHALL preserve program semantics such that the project passes type-checking and compilation without new errors after the refactoring is applied, by updating all references, imports, and type annotations affected by the refactoring
3. WHEN the Refactoring_Engine generates changes spanning more than one file, THE Agent SHALL present a unified diff preview for each affected file and wait for explicit user confirmation (accept or reject) before applying any changes
4. THE Refactoring_Engine SHALL support extract-function, extract-component, rename-symbol, move-file, and inline-variable operations through natural language descriptions
5. IF a refactoring operation would break existing type contracts or introduce circular dependencies, THEN THE Refactoring_Engine SHALL reject the operation and display a message identifying the conflicting symbol, the affected file, and the nature of the conflict (type mismatch or circular dependency)
6. WHEN a refactoring is applied, THE Agent SHALL update the Project_Index dependency graph to reflect the new file structure and import relationships within 5 seconds of change application
7. IF the Refactoring_Engine cannot interpret the user's natural language command as one of the supported refactoring operations, THEN THE Refactoring_Engine SHALL display a message indicating the command was not recognized and list the supported operation types
8. IF a refactoring operation fails after partial application (one or more file writes succeed but a subsequent write fails), THEN THE Refactoring_Engine SHALL roll back all applied changes to restore the project to its pre-refactoring state and notify the user that the operation was aborted

### Requirement 4: End-to-End Test Generation

**User Story:** As a developer, I want the Agent to analyze my code and automatically generate unit and integration tests that adapt when implementation changes, so that I maintain test coverage without manual test writing.

#### Acceptance Criteria

1. WHEN the user requests test generation for a file or function, THE Test_Generator SHALL produce at least one test case for each reachable branch in the target code, including the success path, each error-throwing path, and boundary conditions (null inputs, empty collections, maximum-length inputs)
2. THE Test_Generator SHALL detect the project's existing test framework (Jest, Vitest, pytest, cargo test) by scanning package.json, pyproject.toml, Cargo.toml, or equivalent configuration files and generate tests using the matching framework syntax
3. IF no supported test framework is detected in the project configuration files, THEN THE Test_Generator SHALL notify the user that no framework was found, list the supported frameworks, and prompt the user to select one before generating tests
4. WHEN the signature, return type, or control-flow structure of a tested function changes, THE Test_Generator SHALL identify all tests that reference the changed function and suggest specific updates so that assertions match the new inputs, outputs, and branching behavior
5. THE Test_Generator SHALL generate integration tests that verify call chains between modules by traversing the dependency graph up to 3 levels from the target function
6. WHEN generating tests, THE Test_Generator SHALL include test names that state the function under test, the scenario, and the expected outcome (e.g., "functionName_whenCondition_thenExpectedResult"), use arrange-act-assert structure, and include an inline comment before each assertion explaining what it verifies
7. IF the target code has no exported interface or is a private implementation detail, THEN THE Test_Generator SHALL generate tests through the nearest public API that exercises the private code path and indicate in a comment which private path is being covered

### Requirement 5: Context-Aware Chat with Code Selection

**User Story:** As a developer, I want to highlight code blocks and ask the Agent questions about logic, edge cases, or documentation while it maintains awareness of the full project context, so that I get accurate answers grounded in my actual codebase.

#### Acceptance Criteria

1. WHEN the user selects code in the editor (up to 3000 characters) and sends a chat message, THE Agent SHALL treat the selected code as the primary context and produce a response that directly references or addresses the selected code within the project context
2. THE Agent SHALL maintain conversation history for all messages within the current session (defined as the period from when the chat panel is opened or cleared until it is explicitly cleared or the application is closed), and SHALL resolve anaphoric references (e.g., "that function", "the variable above") to previously discussed code, files, or concepts without requiring the user to re-state context
3. WHEN the user asks about edge cases for selected code, THE Agent SHALL identify at least the boundary conditions, null/empty inputs, and error paths relevant to the selected code's input domain, using type information and file context from the Project_Index
4. WHEN the user asks for documentation, THE Agent SHALL generate documentation in the format matching the file's language: JSDoc for TypeScript/JavaScript, docstrings for Python, doc comments for Rust, or the conventional format for other detected languages
5. THE Agent SHALL respond with explanation-only text (no FILE, DELETE, or CMD blocks) when the user's message is a question or uses explain/ask mode, and SHALL respond with diff previews containing FILE blocks when the user's message requests a code modification or uses edit/fix/refactor mode
6. WHEN the user references a file by name or path in the chat, THE Agent SHALL load that file's content (up to 6000 characters) from the Project_Index and include it in the response context
7. IF the user references a file by name or path that does not exist in the Project_Index, THEN THE Agent SHALL inform the user that the file was not found and list up to 5 similarly-named files from the project as suggestions
8. IF the selected code exceeds 3000 characters, THEN THE Agent SHALL truncate the selection to 3000 characters and indicate in the response context that the selection was truncated

### Requirement 6: Autonomous Multi-Step Task Planning and Execution

**User Story:** As a developer, I want to give the Agent a high-level goal and have it break the goal into tasks, execute them across multiple files, and report progress, so that I can delegate complex development work.

#### Acceptance Criteria

1. WHEN the user provides a high-level goal, THE Task_Planner SHALL decompose it into an ordered list of no more than 20 sub-tasks, each with an estimated scope expressed as a complexity rating (small, medium, large) and a list of target file paths, within 10 seconds
2. THE Task_Planner SHALL present the execution plan to the user for approval before beginning execution, displaying for each sub-task: the sub-task description, complexity rating, target files, and execution order
3. WHILE executing a multi-step plan, THE Agent SHALL report progress after each completed sub-task including files modified, tests run, and remaining steps
4. IF a sub-task fails during execution, THEN THE Agent SHALL pause execution, report the failure including the error description, the failed operation, and the affected files, and offer to retry with a different approach (up to 2 retry attempts per sub-task) or skip the step
5. THE Task_Planner SHALL respect file dependencies by ordering sub-tasks so that shared types and interfaces are created before consuming modules
6. WHEN the user requests to stop a running plan, THE Agent SHALL halt execution after the current sub-task completes (within 30 seconds of the stop request) and report the partial progress including completed sub-tasks, files modified, and remaining sub-tasks not yet executed
7. IF the user rejects the proposed execution plan, THEN THE Task_Planner SHALL allow the user to specify modifications and regenerate a revised plan incorporating the feedback within 10 seconds

### Requirement 7: Terminal and CLI Integration

**User Story:** As a developer, I want the Agent to read terminal output and execute build, test, and deployment commands, so that it can troubleshoot failures and verify its own changes without manual intervention.

#### Acceptance Criteria

1. THE Terminal_Bridge SHALL provide the Agent with read access to the output of all active terminal sessions (up to 10 concurrent sessions), including stdout, stderr, and exit codes, retaining at least the most recent 120 lines per session
2. WHEN the Agent needs to execute a shell command, THE Terminal_Bridge SHALL present the command to the user for approval before execution, displaying the full command string and a risk-level classification (safe, needs_approval, or blocked)
3. IF the user rejects a command presented for approval, THEN THE Terminal_Bridge SHALL cancel the command without execution and notify the Agent that approval was denied
4. WHEN a command executed by the Agent produces error output, THE Agent SHALL parse the error, identify the referenced file path and line number where available, and present a suggested fix to the user for approval before applying changes
5. THE Terminal_Bridge SHALL support running build commands, test suites, linters, and package manager operations in the project's working directory, executing at most one Agent-initiated command per terminal session at a time
6. IF a command executed by the Agent runs for more than 120 seconds without producing output, THEN THE Terminal_Bridge SHALL notify the user and offer to terminate the process
7. WHEN the Agent executes a sequence of commands as part of a plan, THE Terminal_Bridge SHALL capture the stdout, stderr, and exit code of each command and label the output with the corresponding plan step identifier
8. IF a command is classified as blocked by the safety validator, THEN THE Terminal_Bridge SHALL refuse execution and display a message indicating the reason the command was blocked

### Requirement 8: Self-Healing Build and Test Loop

**User Story:** As a developer, I want the Agent to automatically detect when its generated code breaks builds or fails tests and correct the code without my intervention, so that I receive working code on the first delivery.

#### Acceptance Criteria

1. WHEN the Agent applies code changes, THE Healing_Loop SHALL execute the project's configured build command and test suite and SHALL compare results against the pre-change test baseline to verify the changes introduce no new build errors or test failures
2. IF the build or tests fail after Agent-applied changes, THEN THE Healing_Loop SHALL parse the error output to identify failing file paths and error descriptions, generate corrective code changes targeting those failures, and re-run the build and test suite within 120 seconds per verification cycle
3. IF the Healing_Loop has attempted 3 correction cycles without resolving all failures, THEN THE Healing_Loop SHALL stop retrying and report the unresolved failure to the user including: the original error output, the list of files modified in each cycle, the corrective changes attempted, and the final failing build or test output
4. WHEN the Healing_Loop corrects code, THE Agent SHALL present the correction diff to the user with an explanation identifying the root cause and the applied fix
5. THE Healing_Loop SHALL maintain a per-session record of files modified and changes applied in each correction cycle, and IF the same file is modified with a reverting change that restores content from a previous cycle, THEN THE Healing_Loop SHALL halt the correction loop and report a conflicting-change condition to the user
6. IF the Healing_Loop exhausts its 3-cycle retry limit, THEN THE Agent SHALL revert all file modifications from the failed attempt and restore every affected file to its content state immediately prior to the first Agent-applied change in that attempt
7. IF the project has no configured build command or test suite, THEN THE Healing_Loop SHALL notify the user that self-healing verification cannot proceed and SHALL skip the automated correction loop

### Requirement 9: Custom Persona and Style Configuration

**User Story:** As a developer, I want to configure the Agent with my team's coding standards, naming conventions, and architectural patterns, so that generated code matches our project style without manual corrections.

#### Acceptance Criteria

1. THE Agent SHALL read persona configuration from a `punam.rules.md` file in the project root at session start and apply all specified conventions to generated code
2. IF the `punam.rules.md` file is absent, empty, or contains no parseable convention rules, THEN THE Agent SHALL proceed with code generation using only the implicit style patterns learned from existing project code and SHALL NOT display an error to the user
3. WHEN the persona configuration specifies naming conventions, THE Agent SHALL apply those conventions to all generated variable names, function names, class names, and file names such that 100% of newly generated identifiers conform to the specified casing and prefix/suffix rules
4. WHEN the persona configuration specifies architectural patterns, THE Agent SHALL follow those patterns when creating new files or suggesting structural changes, placing files in directories and using module structures consistent with the documented pattern
5. THE Agent SHALL infer implicit style patterns from a sample of at least 5 existing project files (or all files if fewer than 5 exist) in the active project, detecting indentation style (tabs or spaces and width), quote style (single or double), import ordering, and comment density, and SHALL apply the majority-detected pattern to all generated code
6. IF generated code violates a configured persona rule, THEN THE Agent SHALL detect the violation before presenting the code to the user and correct the code so that the presented output contains zero violations of explicitly configured rules
7. WHEN the user updates the persona configuration file, THE Agent SHALL detect the change within 5 seconds and apply the new rules to all subsequent code generation within the same session without requiring a restart
8. IF the `punam.rules.md` file exceeds 50 KB in size, THEN THE Agent SHALL read only the first 50 KB of content and SHALL indicate to the user that the configuration was truncated

### Requirement 10: Multi-Modal Input Understanding

**User Story:** As a developer, I want to provide images, UI mockups, or architectural diagrams to the Agent and have it scaffold corresponding code, so that I can translate visual designs into implementation faster.

#### Acceptance Criteria

1. WHEN the user provides an image file (PNG, JPG, SVG) in the chat, THE Agent SHALL analyze the visual content and produce a description of between 1 and 5 sentences identifying the UI elements, components, or diagram symbols depicted and their relevance to the current project
2. WHEN the user provides a UI mockup image with a request to implement it, THE Agent SHALL generate React component code that reflects the spatial arrangement of elements visible in the mockup using CSS layout properties, includes placeholder text and images for content areas shown in the mockup, and uses the project's detected styling approach from the Project_Index
3. WHEN the user provides an architectural diagram, THE Agent SHALL identify components, relationships, and data flows depicted in the diagram and suggest corresponding file structure and interfaces
4. THE Agent SHALL support image input through drag-and-drop into the chat panel or through file path references in chat messages, for files up to 10 MB in size
5. IF the provided image is unreadable, has a resolution below 50x50 pixels, or the Agent cannot identify at least one recognizable UI element, component, or diagram symbol, THEN THE Agent SHALL inform the user that it could not interpret the image and ask for clarification or a higher-quality version rather than generating code
6. WHEN generating code from visual input, THE Agent SHALL apply the project's existing component patterns and styling approach as detected from the Project_Index
7. IF the user provides a file in an unsupported format or a file that cannot be decoded as a valid image, THEN THE Agent SHALL inform the user of the supported formats (PNG, JPG, SVG) and request a compatible file
