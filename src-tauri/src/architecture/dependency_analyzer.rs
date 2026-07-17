use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use tauri::State;
use walkdir::WalkDir;

use crate::{get_project_root, ProjectRoot, SKIP_DIRS, SKIP_FILES};

// ── Static regex cache — compiled once, reused across all calls ────────────────
use regex_lite::Regex;

fn es6_side_effect_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"import\s+['"]([^'"]+)['"]"#).unwrap())
}

fn es6_from_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"import\s+(?:type\s+)?(?:\{[^}]*\}|[^*\s{][^{]*?)\s+from\s+['"]([^'"]+)['"]"#).unwrap())
}

fn commonjs_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"require\s*\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap())
}

fn dynamic_import_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)"#).unwrap())
}

fn python_from_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"from\s+([\.\w]+)\s+import\s"#).unwrap())
}

fn python_import_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"^import\s+([\.\w]+(?:\s*,\s*[\.\w]+)*)"#).unwrap())
}

fn rust_use_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"use\s+((?:crate|self|super|[\w]+)(?:::[^{]*?)?)"#).unwrap())
}

fn rust_extern_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"extern\s+crate\s+(\w+)"#).unwrap())
}

// ── Data Types ─────────────────────────────────────────────────────────────────

/// A directed dependency edge: `from_file` imports `to_module`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
pub struct DependencyEdge {
    /// The file that contains the import statement (relative path from project root).
    pub from_file: String,
    /// The module or file being imported (resolved relative path when possible).
    pub to_module: String,
    /// The type of import: "es6_import", "commonjs_require", "python_import", "rust_use", etc.
    pub import_kind: String,
    /// Whether this is an external/dependency import (true) or a local project import (false).
    pub is_external: bool,
}

/// Result of analyzing dependencies in a file or set of files.
#[derive(Serialize, Debug)]
pub struct DependencyAnalysisResult {
    pub edges: Vec<DependencyEdge>,
    pub file_count: usize,
    pub parse_errors: Vec<String>,
}

// ── Language-specific Parsers ──────────────────────────────────────────────────

/// Parse ES6 `import` statements from TypeScript/JavaScript source.
///
/// Handles:
///   import { X } from './foo'
///   import X from './foo'
///   import * as X from './foo'
///   import './foo'
///   import type { X } from './foo'
fn parse_es6_imports(content: &str, file_path: &str) -> Vec<DependencyEdge> {
    let mut edges = Vec::new();

    // Regex 1: side-effect imports — import 'module' (no "from" keyword)
    let re_side_effect = es6_side_effect_regex();

    for cap in re_side_effect.captures_iter(content) {
        let import_path = cap.get(1).unwrap().as_str().to_string();
        let is_external = is_external_import(&import_path);
        edges.push(DependencyEdge {
            from_file: file_path.to_string(),
            to_module: import_path,
            import_kind: "es6_import".to_string(),
            is_external,
        });
    }

    // Regex 2: all "from" imports — import X from 'module', import {X} from 'module', import type {X} from 'module'
    let re_from = es6_from_regex();
    for cap in re_from.captures_iter(content) {
        let import_path = cap.get(1).unwrap().as_str().to_string();
        let is_external = is_external_import(&import_path);
        edges.push(DependencyEdge {
            from_file: file_path.to_string(),
            to_module: import_path,
            import_kind: "es6_import".to_string(),
            is_external,
        });
    }

    // Deduplicate by to_module
    let mut seen = HashSet::new();
    edges.retain(|e| seen.insert(e.to_module.clone()));
    edges
}

/// Parse CommonJS `require()` calls.
///
/// Handles: const x = require('foo'), require('foo'), etc.
fn parse_commonjs_requires(content: &str, file_path: &str) -> Vec<DependencyEdge> {
    let mut edges = Vec::new();
    let re = commonjs_regex();

    for cap in re.captures_iter(content) {
        let import_path = cap.get(1).unwrap().as_str().to_string();
        let is_external = is_external_import(&import_path);
        edges.push(DependencyEdge {
            from_file: file_path.to_string(),
            to_module: import_path,
            import_kind: "commonjs_require".to_string(),
            is_external,
        });
    }

    edges
}

/// Parse `dynamic import()` expressions.
///
/// Handles: import('./foo'), import(`./foo`), etc.
fn parse_dynamic_imports(content: &str, file_path: &str) -> Vec<DependencyEdge> {
    let mut edges = Vec::new();
    let re = dynamic_import_regex();

    for cap in re.captures_iter(content) {
        let import_path = cap.get(1).unwrap().as_str().to_string();
        let is_external = is_external_import(&import_path);
        edges.push(DependencyEdge {
            from_file: file_path.to_string(),
            to_module: import_path,
            import_kind: "dynamic_import".to_string(),
            is_external,
        });
    }

    edges
}

/// Parse Python `import` and `from ... import` statements.
///
/// Handles:
///   import os
///   import numpy as np
///   from collections import defaultdict
///   from .module import something
fn parse_python_imports(content: &str, file_path: &str) -> Vec<DependencyEdge> {
    let mut edges = Vec::new();

    // from X import Y
    let re_from = python_from_regex();
    for cap in re_from.captures_iter(content) {
        let module = cap.get(1).unwrap().as_str().to_string();
        let is_external = is_external_python_import(&module);
        edges.push(DependencyEdge {
            from_file: file_path.to_string(),
            to_module: module,
            import_kind: "python_from_import".to_string(),
            is_external,
        });
    }

    // import X or import X as Y
    let re_import = python_import_regex();
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(cap) = re_import.captures(trimmed) {
            let modules_str = cap.get(1).unwrap().as_str();
            for module in modules_str.split(',') {
                let module = module.trim().to_string();
                if module.is_empty() {
                    continue;
                }
                let is_external = is_external_python_import(&module);
                edges.push(DependencyEdge {
                    from_file: file_path.to_string(),
                    to_module: module,
                    import_kind: "python_import".to_string(),
                    is_external,
                });
            }
        }
    }

    edges
}

/// Parse Rust `use` statements and `extern crate` declarations.
///
/// Handles:
///   use std::collections::HashMap;
///   use crate::module::foo;
///   use super::bar;
///   use serde::{Serialize, Deserialize};
///   extern crate some_crate;
fn parse_rust_imports(content: &str, file_path: &str) -> Vec<DependencyEdge> {
    let mut edges = Vec::new();

    // use statements — extract the module path (first identifier segment before ::)
    // Simplified: capture the first crate/self/super segment
    let re_use = rust_use_regex();
    for cap in re_use.captures_iter(content) {
        let use_path = cap.get(1).unwrap().as_str().trim().to_string();
        // Extract top-level module/crate name
        let top_level = use_path.split("::").next().unwrap_or(&use_path).to_string();
        let is_external = !matches!(top_level.as_str(), "crate" | "self" | "super")
            && is_external_import(&top_level);
        edges.push(DependencyEdge {
            from_file: file_path.to_string(),
            to_module: use_path,
            import_kind: "rust_use".to_string(),
            is_external,
        });
    }

    // extern crate
    let re_extern = rust_extern_regex();
    for cap in re_extern.captures_iter(content) {
        let crate_name = cap.get(1).unwrap().as_str().to_string();
        edges.push(DependencyEdge {
            from_file: file_path.to_string(),
            to_module: crate_name,
            import_kind: "rust_extern_crate".to_string(),
            is_external: true,
        });
    }

    edges
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// Determine if a JS/TS import path is external (not starting with . or /).
/// Scoped packages (@scope/pkg) ARE external — they live in node_modules.
fn is_external_import(path: &str) -> bool {
    !path.starts_with('.') && !path.starts_with('/') && !path.starts_with('#')
}

/// Heuristic for external Python imports: no leading dot means it's likely external.
/// (Relative imports use leading dots: `from .foo import bar`)
fn is_external_python_import(module: &str) -> bool {
    !module.starts_with('.')
}

/// Check if a file should be analyzed for dependencies based on its extension.
pub(crate) fn should_analyze(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "rs") => true,
        _ => false,
    }
}

/// Check if a path should be skipped (matches SKIP_DIRS patterns).
fn should_skip_dir(dir_name: &str) -> bool {
    SKIP_DIRS.contains(&dir_name)
}

/// Check if a file should be skipped (matches SKIP_FILES patterns).
fn should_skip_file(file_name: &str) -> bool {
    SKIP_FILES.contains(&file_name)
}

/// Parse imports from file content based on its extension.
pub(crate) fn parse_imports(content: &str, file_path: &str, extension: &str) -> Vec<DependencyEdge> {
    match extension {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            let mut edges = Vec::new();
            edges.extend(parse_es6_imports(content, file_path));
            edges.extend(parse_commonjs_requires(content, file_path));
            edges.extend(parse_dynamic_imports(content, file_path));
            // Deduplicate by (to_module, import_kind)
            let mut seen = HashSet::new();
            edges.retain(|e| seen.insert((e.to_module.clone(), e.import_kind.clone())));
            edges
        }
        "py" => {
            let mut edges = parse_python_imports(content, file_path);
            let mut seen = HashSet::new();
            edges.retain(|e| seen.insert((e.to_module.clone(), e.import_kind.clone())));
            edges
        }
        "rs" => {
            let mut edges = parse_rust_imports(content, file_path);
            let mut seen = HashSet::new();
            edges.retain(|e| seen.insert((e.to_module.clone(), e.import_kind.clone())));
            edges
        }
        _ => Vec::new(),
    }
}

// ── Core Analysis Function ─────────────────────────────────────────────────────

/// Walk the project directory and parse imports from all supported source files.
pub(crate) fn analyze_all_files(project_root: &str) -> DependencyAnalysisResult {
    let mut edges = Vec::new();
    let mut file_count = 0usize;
    let mut parse_errors = Vec::new();

    for entry in WalkDir::new(project_root)
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden directories and known skip dirs
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !name.starts_with('.') && !should_skip_dir(&name);
            }
            // Skip known skip files
            !should_skip_file(&e.file_name().to_string_lossy())
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                parse_errors.push(format!("Walk error: {}", err));
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if !should_analyze(path) {
            continue;
        }

        let rel_path = path
            .strip_prefix(project_root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(err) => {
                parse_errors.push(format!("Failed to read {}: {}", rel_path, err));
                continue;
            }
        };

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let file_edges = parse_imports(&content, &rel_path, ext);
        edges.extend(file_edges);
        file_count += 1;
    }

    DependencyAnalysisResult {
        edges,
        file_count,
        parse_errors,
    }
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

/// Analyze all dependencies in the project.
///
/// Walks the project directory, parsing imports from TypeScript, JavaScript,
/// Python, and Rust source files. Returns a list of dependency edges.
///
/// Returns: DependencyAnalysisResult { edges, file_count, parse_errors }
#[tauri::command]
pub fn analyze_dependencies(
    state: State<ProjectRoot>,
) -> Result<DependencyAnalysisResult, String> {
    let root = get_project_root(&state)?;
    Ok(analyze_all_files(&root))
}

/// Analyze dependencies for a specific set of files.
///
/// Useful for incremental analysis when only a few files have changed.
/// Each path should be relative to the project root.
///
/// Returns: DependencyAnalysisResult { edges, file_count, parse_errors }
#[tauri::command]
pub fn analyze_file_dependencies(
    file_paths: Vec<String>,
    state: State<ProjectRoot>,
) -> Result<DependencyAnalysisResult, String> {
    let root = get_project_root(&state)?;
    let mut edges = Vec::new();
    let mut parse_errors = Vec::new();

    for file_path in &file_paths {
        let full_path = Path::new(&root).join(file_path);
        let ext = full_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        if !should_analyze(&full_path) {
            continue;
        }

        let content = match fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(err) => {
                parse_errors.push(format!("Failed to read {}: {}", file_path, err));
                continue;
            }
        };

        edges.extend(parse_imports(&content, file_path, ext));
    }

    Ok(DependencyAnalysisResult {
        edges,
        file_count: file_paths.len(),
        parse_errors,
    })
}

/// Build the full dependency graph for the project (Phase 3).
///
/// Scans all project files, parses imports, and constructs the DependencyGraph
/// with forward/reverse edge maps, file list, and stats. This is the primary
/// data structure consumed by ArchitectureMap.ts for module/layer/system analysis.
///
/// Returns the serialized DependencyGraph.
#[tauri::command]
pub fn build_dependency_graph(
    state: State<ProjectRoot>,
) -> Result<super::graph_builder::DependencyGraph, String> {
    let root = get_project_root(&state)?;
    let analysis = analyze_all_files(&root);
    Ok(super::graph_builder::DependencyGraph::build_from_edges(&analysis.edges))
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_es6_default_import() {
        let content = r#"import React from 'react';"#;
        let edges = parse_es6_imports(content, "test.tsx");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to_module, "react");
        assert!(edges[0].is_external);
    }

    #[test]
    fn test_es6_named_import() {
        let content = r#"import { useState, useEffect } from 'react';"#;
        let edges = parse_es6_imports(content, "test.tsx");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to_module, "react");
    }

    #[test]
    fn test_es6_local_import() {
        let content = r#"import { helper } from './utils/helper';"#;
        let edges = parse_es6_imports(content, "test.ts");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to_module, "./utils/helper");
        assert!(!edges[0].is_external);
    }

    #[test]
    fn test_es6_type_import() {
        let content = r#"import type { Props } from './types';"#;
        let edges = parse_es6_imports(content, "test.ts");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to_module, "./types");
    }

    #[test]
    fn test_commonjs_require() {
        let content = r#"const fs = require('fs');"#;
        let edges = parse_commonjs_requires(content, "test.js");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to_module, "fs");
        assert!(edges[0].is_external);
    }

    #[test]
    fn test_dynamic_import() {
        let content = r#"const mod = import('./lazy');"#;
        let edges = parse_dynamic_imports(content, "test.ts");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to_module, "./lazy");
        assert!(!edges[0].is_external);
    }

    #[test]
    fn test_deduplication() {
        let content = "import React from 'react';\nimport { useState } from 'react';";
        let edges = parse_imports(content, "test.tsx", "tsx");
        // Should deduplicate 'react' by import_kind
        assert_eq!(edges.len(), 1);
    }

    #[test]
    fn test_python_import() {
        let content = "import os\nimport numpy as np";
        let edges = parse_python_imports(content, "test.py");
        assert_eq!(edges.len(), 2);
        // "os" should be first
        assert_eq!(edges[0].to_module, "os");
        assert!(edges[0].is_external);
        assert_eq!(edges[1].to_module, "numpy");
    }

    #[test]
    fn test_python_from_import() {
        let content = "from collections import defaultdict";
        let edges = parse_python_imports(content, "test.py");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to_module, "collections");
        assert_eq!(edges[0].import_kind, "python_from_import");
    }

    #[test]
    fn test_python_relative_import() {
        let content = "from .module import something";
        let edges = parse_python_imports(content, "test.py");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to_module, ".module");
        assert!(!edges[0].is_external);
    }

    #[test]
    fn test_rust_use() {
        let content = "use std::collections::HashMap;";
        let edges = parse_rust_imports(content, "test.rs");
        assert_eq!(edges.len(), 1);
        assert!(edges[0].to_module.contains("std"));
    }

    #[test]
    fn test_rust_crate_use() {
        let content = "use crate::module::foo;";
        let edges = parse_rust_imports(content, "test.rs");
        assert_eq!(edges.len(), 1);
        assert!(!edges[0].is_external);
    }

    #[test]
    fn test_rust_extern_crate() {
        let content = "extern crate serde;";
        let edges = parse_rust_imports(content, "test.rs");
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].to_module, "serde");
        assert!(edges[0].is_external);
    }
}