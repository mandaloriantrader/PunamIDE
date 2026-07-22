//! Call Graph — Function-Level Call Edge Detection (Phase 2)
//!
//! Detects which functions call which other functions within a codebase.
//! Uses regex-based call-site detection for TS/JS, Python, and Rust files.
//! Integrates with the Symbol Index for cross-file call resolution.
//!
//! Commands:
//!   callgraph_lookup    — find all callers of a function
//!   callgraph_callees   — find all functions called by a function
//!   callgraph_build     — rebuild the entire call graph

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::RwLock;

use crate::{SKIP_DIRS, SKIP_FILES};

// ── Data Types ─────────────────────────────────────────────────────────────────

/// A single call edge: `caller` (in `caller_file`) calls `callee` (likely in `callee_file`).
#[derive(Serialize, Debug, Clone)]
pub struct CallEdge {
    /// Name of the calling function
    pub caller: String,
    /// File where the caller is defined
    pub caller_file: String,
    /// Line number of the call site
    pub call_line: usize,
    /// Name of the called function
    pub callee: String,
    /// The raw call expression (e.g., "foo()" or "await bar(x)")
    pub call_expression: String,
}

/// Result of "what calls X?" query.
#[derive(Serialize, Debug)]
pub struct CallGraphLookupResult {
    pub function_name: String,
    pub callers: Vec<CallEdge>,
    pub total_callers: usize,
    pub query_time_ms: u64,
}

/// Result of "what does X call?" query.
#[derive(Serialize, Debug)]
pub struct CallGraphCalleesResult {
    pub function_name: String,
    pub callees: Vec<CallEdge>,
    pub total_callees: usize,
    pub query_time_ms: u64,
}

// ── Call Graph State ───────────────────────────────────────────────────────────

pub struct CallGraphState(pub RwLock<CallGraph>);

#[derive(Clone)]
pub struct CallGraph {
    /// function_name_lowercase → edges where this function IS THE CALLER
    pub forward: HashMap<String, Vec<CallEdge>>,
    /// function_name_lowercase → edges where this function IS THE CALLEE
    pub reverse: HashMap<String, Vec<CallEdge>>,
    pub total_edges: usize,
    pub total_functions: usize,
    pub built_at: u64,
}

impl CallGraph {
    pub fn new() -> Self {
        CallGraph {
            forward: HashMap::new(),
            reverse: HashMap::new(),
            total_edges: 0,
            total_functions: 0,
            built_at: 0,
        }
    }
}

// ── Call Detection ─────────────────────────────────────────────────────────────

/// Extract call edges from a single function body.
/// `function_name` is the name of the enclosing function.
/// Returns edges for each call site found.
fn extract_calls_from_body(
    body_lines: &[&str],
    function_name: &str,
    file_path: &str,
    base_line: usize, // 0-indexed starting line of the body in the file
    ext: &str,
) -> Vec<CallEdge> {
    let mut edges = Vec::new();

    let re = match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            // Match: identifier(args) or await identifier(args)
            // Exclude keywords: if, for, while, switch, return, throw, new, typeof, instanceof
            regex_lite::Regex::new(r"(?:await\s+)?(\w+)\s*\(").ok()
        }
        "py" => {
            regex_lite::Regex::new(r"(\w+)\s*\(").ok()
        }
        "rs" => {
            // Match: identifier!(args) or identifier(args) or identifier::method(args)
            regex_lite::Regex::new(r"(\w+)(?:!)?\s*\(").ok()
        }
        _ => None,
    };

    let re = match re {
        Some(r) => r,
        None => return edges,
    };

    // Keywords to exclude from call detection
    let keywords: HashSet<&str> = [
        "if", "else", "for", "while", "switch", "case", "return",
        "throw", "new", "typeof", "instanceof", "catch", "finally",
        "function", "class", "const", "let", "var", "import", "export",
        "break", "continue", "yield", "async", "await", "try", "with",
        "println", "print", "assert", "panic", "Ok", "Err", "Some", "None",
        "typeof", "keyof", "in", "of", "from", "as", "is",
    ].iter().cloned().collect();

    for (offset, line) in body_lines.iter().enumerate() {
        if line.trim().starts_with("//") || line.trim().starts_with("/*") || line.trim().starts_with("*") {
            continue;
        }
        if let Some(caps) = re.captures(line) {
            if let Some(name_match) = caps.get(1) {
                let callee = name_match.as_str().to_string();
                // Skip keywords and self-calls
                if keywords.contains(callee.as_str()) { continue; }
                if callee == function_name { continue; }
                // Skip very short names (likely not real functions)
                if callee.len() < 2 { continue; }

                edges.push(CallEdge {
                    caller: function_name.to_string(),
                    caller_file: file_path.to_string(),
                    call_line: base_line + offset + 1,
                    callee,
                    call_expression: line.trim().to_string(),
                });
            }
        }
    }

    edges
}

/// Detect function boundaries in a file and extract call edges from each.
fn extract_calls_from_file(content: &str, file_path: &str, ext: &str) -> Vec<CallEdge> {
    let lines: Vec<&str> = content.lines().collect();
    let mut all_edges = Vec::new();

    let boundary_re = match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            let combined = [
                r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)",
                r"^\s*(?:export\s+)?class\s+(\w+)",
                r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?[\(<]",
                r"^\s+(?:public|private|protected|static|async)\s+(\w+)\s*\(",
            ].join("|");
            regex_lite::Regex::new(&combined).ok()
        }
        "py" => {
            regex_lite::Regex::new(r"^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)").ok()
        }
        "rs" => {
            regex_lite::Regex::new(
                r"^\s*(?:pub(?:\s*\(\s*crate\s*\))?\s+)?(?:unsafe\s+)?(?:async\s+)?fn\s+(\w+)"
            ).ok()
        }
        _ => None,
    };

    let boundary_re = match boundary_re {
        Some(r) => r,
        None => return all_edges,
    };

    // Find all function boundaries
    let mut boundaries: Vec<(usize, String)> = Vec::new(); // (line_idx, name)
    for (line_idx, line) in lines.iter().enumerate() {
        if let Some(caps) = boundary_re.captures(line) {
            for group_idx in 1..=4 {
                if let Some(name_match) = caps.get(group_idx) {
                    boundaries.push((line_idx, name_match.as_str().to_string()));
                    break;
                }
            }
        }
    }

    // For each boundary, extract calls from its body
    for idx in 0..boundaries.len() {
        let (start, ref name) = boundaries[idx];
        let body_start = start + 1; // skip the declaration line
        let body_end = if idx + 1 < boundaries.len() {
            boundaries[idx + 1].0
        } else {
            lines.len()
        };

        if body_start < body_end {
            let body_lines = &lines[body_start..body_end];
            let edges = extract_calls_from_body(body_lines, name, file_path, body_start, ext);
            all_edges.extend(edges);
        }
    }

    all_edges
}

// ── Graph Building ─────────────────────────────────────────────────────────────

fn build_call_graph(root: &str) -> Result<CallGraph, String> {
    let root_path = Path::new(root);
    let mut forward: HashMap<String, Vec<CallEdge>> = HashMap::new();
    let mut reverse: HashMap<String, Vec<CallEdge>> = HashMap::new();
    let mut total_edges = 0usize;
    let mut seen_functions: HashSet<String> = HashSet::new();

    walk_and_extract_calls(
        root_path, root_path,
        &mut forward, &mut reverse, &mut total_edges, &mut seen_functions, 0,
    );

    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    Ok(CallGraph {
        forward,
        reverse,
        total_edges,
        total_functions: seen_functions.len(),
        built_at,
    })
}

fn walk_and_extract_calls(
    dir: &Path, root: &Path,
    forward: &mut HashMap<String, Vec<CallEdge>>,
    reverse: &mut HashMap<String, Vec<CallEdge>>,
    total_edges: &mut usize,
    seen_functions: &mut HashSet<String>,
    depth: usize,
) {
    if depth > 8 { return; }

    let items = match fs::read_dir(dir) { Ok(i) => i, Err(_) => return };

    for item in items.filter_map(|e| e.ok()) {
        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if name.starts_with('.') { continue; }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) { continue; }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) { continue; }

        if is_dir {
            walk_and_extract_calls(&path, root, forward, reverse, total_edges, seen_functions, depth + 1);
        } else {
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_string();
            if !matches!(ext.as_str(), "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "rs") { continue; }

            let content = match fs::read_to_string(&path) { Ok(c) => c, Err(_) => continue };
            if content.len() > 200_000 { continue; }

            let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let edges = extract_calls_from_file(&content, &relative, &ext);

            for edge in &edges {
                // Forward: caller → callee
                let key = edge.caller.to_lowercase();
                forward.entry(key.clone()).or_default().push(edge.clone());
                // Reverse: callee ← caller
                reverse.entry(edge.callee.to_lowercase()).or_default().push(edge.clone());
                seen_functions.insert(edge.caller.clone());
                seen_functions.insert(edge.callee.clone());
                *total_edges += 1;
            }
        }
    }
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

/// Find all callers of a given function name (case-insensitive).
#[tauri::command]
pub fn callgraph_lookup(
    function_name: String,
    state: tauri::State<crate::ProjectRoot>,
    graph_state: tauri::State<CallGraphState>,
) -> Result<CallGraphLookupResult, String> {
    let _root = crate::get_project_root(&state)?;
    let start = std::time::Instant::now();

    let graph = graph_state.0.read().map_err(|_| "Lock error".to_string())?;
    let key = function_name.to_lowercase();
    let callers = graph.reverse.get(&key).cloned().unwrap_or_default();
    let total = callers.len();

    Ok(CallGraphLookupResult {
        function_name,
        callers,
        total_callers: total,
        query_time_ms: start.elapsed().as_millis() as u64,
    })
}

/// Find all functions called by a given function (case-insensitive).
#[tauri::command]
pub fn callgraph_callees(
    function_name: String,
    state: tauri::State<crate::ProjectRoot>,
    graph_state: tauri::State<CallGraphState>,
) -> Result<CallGraphCalleesResult, String> {
    let _root = crate::get_project_root(&state)?;
    let start = std::time::Instant::now();

    let graph = graph_state.0.read().map_err(|_| "Lock error".to_string())?;
    let key = function_name.to_lowercase();
    let callees = graph.forward.get(&key).cloned().unwrap_or_default();
    let total = callees.len();

    Ok(CallGraphCalleesResult {
        function_name,
        callees,
        total_callees: total,
        query_time_ms: start.elapsed().as_millis() as u64,
    })
}

/// Rebuild the call graph from scratch.
#[tauri::command]
pub async fn callgraph_build(
    state: tauri::State<'_, crate::ProjectRoot>,
    graph_state: tauri::State<'_, CallGraphState>,
) -> Result<usize, String> {
    let root = crate::get_project_root(&state)?;
    let graph = tauri::async_runtime::spawn_blocking(move || build_call_graph(&root))
        .await
        .map_err(|e| format!("Call graph build panicked: {}", e))??;
    let total = graph.total_edges;

    let mut stored = graph_state.0.write().map_err(|_| "Lock error".to_string())?;
    *stored = graph;

    Ok(total)
}

#[tauri::command]
pub fn callgraph_stats(
    graph_state: tauri::State<CallGraphState>,
) -> Result<serde_json::Value, String> {
    let graph = graph_state.0.read().map_err(|_| "Lock error".to_string())?;
    Ok(serde_json::json!({
        "total_edges": graph.total_edges,
        "total_functions": graph.total_functions,
        "built_at_unix_ms": graph.built_at,
    }))
}

/// Rebuild call graph edges for a single file.
/// Removes all existing edges where `caller_file == file_path`, re-extracts
/// edges from the provided `content`, inserts new edges, and returns the count.
#[tauri::command]
pub fn callgraph_rebuild_file(
    file_path: String,
    content: String,
    graph_state: tauri::State<CallGraphState>,
) -> Result<usize, String> {
    // Determine the file extension for language-appropriate regex detection
    let ext = file_path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_string();

    // Re-extract call edges from the new content
    let new_edges = extract_calls_from_file(&content, &file_path, &ext);
    let new_edge_count = new_edges.len();

    let mut graph = graph_state.0.write().map_err(|_| "Lock error".to_string())?;

    // Remove all existing edges where caller_file == file_path from forward map
    for edges in graph.forward.values_mut() {
        edges.retain(|e| e.caller_file != file_path);
    }
    // Remove empty keys from forward map
    graph.forward.retain(|_, v| !v.is_empty());

    // Remove all existing edges where caller_file == file_path from reverse map
    for edges in graph.reverse.values_mut() {
        edges.retain(|e| e.caller_file != file_path);
    }
    // Remove empty keys from reverse map
    graph.reverse.retain(|_, v| !v.is_empty());

    // Insert new edges into both forward and reverse maps
    for edge in &new_edges {
        let forward_key = edge.caller.to_lowercase();
        graph.forward.entry(forward_key).or_default().push(edge.clone());

        let reverse_key = edge.callee.to_lowercase();
        graph.reverse.entry(reverse_key).or_default().push(edge.clone());
    }

    // Recompute totals
    graph.total_edges = graph.forward.values().map(|v| v.len()).sum();
    let mut seen_functions: HashSet<String> = HashSet::new();
    for edges in graph.forward.values() {
        for edge in edges {
            seen_functions.insert(edge.caller.clone());
            seen_functions.insert(edge.callee.clone());
        }
    }
    graph.total_functions = seen_functions.len();

    Ok(new_edge_count)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_calls_js() {
        let lines = vec!["  helper();", "  validate(input);", "  const x = getData();"];
        let edges = extract_calls_from_body(&lines, "myFunc", "test.ts", 10, "ts");
        assert!(edges.iter().any(|e| e.callee == "helper"));
        assert!(edges.iter().any(|e| e.callee == "validate"));
        assert!(edges.iter().any(|e| e.callee == "getData"));
    }

    #[test]
    fn test_extract_calls_python() {
        let lines = vec!["    helper()", "    result = validate(data)", "    print('hello')"];
        let edges = extract_calls_from_body(&lines, "my_func", "test.py", 10, "py");
        assert!(edges.iter().any(|e| e.callee == "helper"));
    }

    #[test]
    fn test_extract_calls_rust() {
        let lines = vec!["    helper();", "    let x = validate(input);"];
        let edges = extract_calls_from_body(&lines, "my_fn", "test.rs", 10, "rs");
        assert!(edges.iter().any(|e| e.callee == "helper"));
        assert!(edges.iter().any(|e| e.callee == "validate"));
    }

    #[test]
    fn test_skips_keywords() {
        let lines = vec!["  if (x > 0) {", "  for (let i = 0; i < 10; i++) {", "  return result;"];
        let edges = extract_calls_from_body(&lines, "myFunc", "test.ts", 10, "ts");
        // No edges should match if/for/return
        assert!(!edges.iter().any(|e| e.callee == "if"));
        assert!(!edges.iter().any(|e| e.callee == "for"));
        assert!(!edges.iter().any(|e| e.callee == "return"));
    }
}