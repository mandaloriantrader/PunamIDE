//! Symbol Index — AST-Based Code Intelligence (Phase 2)
//!
//! Builds a persistent index mapping symbol names (functions, classes, structs,
//! enums, traits, modules) to their file locations. Enables fast lookups like:
//! "where is `handleAuth` defined?" and "find all classes in this file."
//!
//! Uses regex-based definition detection for TS/JS, Python, and Rust.
//! Index is stored in-memory via RwLock for fast concurrent reads.
//!
//! Commands:
//!   symbol_lookup   — find definition(s) of a symbol by name
//!   symbol_list_file — list all symbols defined in a file
//!   symbol_rebuild  — rebuild the entire symbol index from scratch
//!   symbol_stats    — get index statistics

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::RwLock;
use tauri::State;

use crate::{get_project_root, ProjectRoot, SKIP_DIRS, SKIP_FILES};

// ── Data Types ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
pub struct SymbolEntry {
    pub name: String,
    pub file: String,
    pub line: usize,
    pub kind: String,
    pub signature: String,
}

#[derive(Serialize, Debug)]
pub struct SymbolLookupResult {
    pub query: String,
    pub matches: Vec<SymbolEntry>,
    pub total_count: usize,
    pub query_time_ms: u64,
}

#[derive(Serialize, Debug)]
pub struct SymbolFileResult {
    pub file: String,
    pub symbols: Vec<SymbolEntry>,
    pub count: usize,
}

// ── Symbol Index State ─────────────────────────────────────────────────────────

pub struct SymbolIndexState(pub RwLock<SymbolIndex>);

#[derive(Clone)]
pub struct SymbolIndex {
    pub by_name: HashMap<String, Vec<SymbolEntry>>,
    pub by_file: HashMap<String, Vec<SymbolEntry>>,
    pub total_symbols: usize,
    pub total_files: usize,
    pub built_at: u64,
}

impl SymbolIndex {
    pub fn new() -> Self {
        SymbolIndex {
            by_name: HashMap::new(),
            by_file: HashMap::new(),
            total_symbols: 0,
            total_files: 0,
            built_at: 0,
        }
    }
}

// ── Symbol Detection ───────────────────────────────────────────────────────────

fn extract_symbols(content: &str, file_path: &str, ext: &str) -> Vec<SymbolEntry> {
    let lines_vec: Vec<&str> = content.lines().collect();
    let mut symbols = Vec::new();

    let re = match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            let combined = [
                r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)",
                r"^\s*(?:export\s+)?class\s+(\w+)",
                r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?[\(<]",
                r"^\s*(?:export\s+)?interface\s+(\w+)",
                r"^\s*(?:export\s+)?type\s+(\w+)\s*=",
                r"^\s+(?:public|private|protected|static|async)\s+(\w+)\s*\(",
            ].join("|");
            regex_lite::Regex::new(&combined).ok()
        }
        "py" => {
            regex_lite::Regex::new(r"^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)").ok()
        }
        "rs" => {
            regex_lite::Regex::new(
                r"^\s*(?:pub(?:\s*\(\s*crate\s*\))?\s+)?(?:unsafe\s+)?(?:async\s+)?fn\s+(\w+)|^\s*(?:pub\s+)?struct\s+(\w+)|^\s*(?:pub\s+)?trait\s+(\w+)|^\s*(?:pub\s+)?enum\s+(\w+)|^\s*(?:pub\s+)?mod\s+(\w+)|^\s*(?:pub\s+)?type\s+(\w+)|^\s*impl\s+(\w+)|^\s*impl\b"
            ).ok()
        }
        _ => None,
    };

    let re = match re {
        Some(r) => r,
        None => return symbols,
    };

    for (line_idx, line) in lines_vec.iter().enumerate() {
        if let Some(caps) = re.captures(line) {
            let (kind, name): (String, String) = match ext {
                "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
                    let get_name = |idx: usize| caps.get(idx).map(|m| m.as_str().to_string());
                    if let Some(fn_name) = get_name(1) {
                        if caps.get(3).map(|m| m.as_str()) == Some(&fn_name) {
                            ("arrow_function".to_string(), fn_name)
                        } else if caps.get(2).map(|m| m.as_str()) == Some(&fn_name) {
                            ("class".to_string(), fn_name)
                        } else {
                            ("function".to_string(), fn_name)
                        }
                    } else if let Some(cls_name) = get_name(2) {
                        ("class".to_string(), cls_name)
                    } else if let Some(iface_name) = get_name(4) {
                        ("interface".to_string(), iface_name)
                    } else if let Some(type_name) = get_name(5) {
                        ("type_alias".to_string(), type_name)
                    } else if let Some(method_name) = get_name(6) {
                        ("method".to_string(), method_name)
                    } else {
                        continue;
                    }
                }
                "py" => {
                    if let Some(fn_name) = caps.get(1).map(|m| m.as_str().to_string()) {
                        ("function".to_string(), fn_name)
                    } else if let Some(cls_name) = caps.get(2).map(|m| m.as_str().to_string()) {
                        ("class".to_string(), cls_name)
                    } else {
                        continue;
                    }
                }
                "rs" => {
                    if let Some(fn_name) = caps.get(1).map(|m| m.as_str().to_string()) {
                        ("function".to_string(), fn_name)
                    } else if let Some(struct_name) = caps.get(2).map(|m| m.as_str().to_string()) {
                        ("struct".to_string(), struct_name)
                    } else if let Some(trait_name) = caps.get(3).map(|m| m.as_str().to_string()) {
                        ("trait".to_string(), trait_name)
                    } else if let Some(enum_name) = caps.get(4).map(|m| m.as_str().to_string()) {
                        ("enum".to_string(), enum_name)
                    } else if let Some(mod_name) = caps.get(5).map(|m| m.as_str().to_string()) {
                        ("module".to_string(), mod_name)
                    } else if let Some(type_name) = caps.get(6).map(|m| m.as_str().to_string()) {
                        ("type_alias".to_string(), type_name)
                    } else if let Some(impl_name) = caps.get(7).map(|m| m.as_str().to_string()) {
                        ("impl_block".to_string(), impl_name)
                    } else {
                        ("impl_block".to_string(), String::new())
                    }
                }
                _ => continue,
            };

            symbols.push(SymbolEntry {
                name,
                file: file_path.to_string(),
                line: line_idx + 1,
                kind,
                signature: line.trim().to_string(),
            });
        }
    }

    symbols
}

fn should_analyze_ext(ext: &str) -> bool {
    matches!(ext, "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "rs")
}

// ── Index Building ─────────────────────────────────────────────────────────────

fn build_index(root: &str) -> Result<SymbolIndex, String> {
    let root_path = Path::new(root);
    let mut by_name: HashMap<String, Vec<SymbolEntry>> = HashMap::new();
    let mut by_file: HashMap<String, Vec<SymbolEntry>> = HashMap::new();
    let mut total_symbols = 0usize;
    let mut total_files = 0usize;

    walk_and_index(
        root_path,
        root_path,
        &mut by_name,
        &mut by_file,
        &mut total_symbols,
        &mut total_files,
        0,
    );

    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    Ok(SymbolIndex {
        by_name,
        by_file,
        total_symbols,
        total_files,
        built_at,
    })
}

fn walk_and_index(
    dir: &Path,
    root: &Path,
    by_name: &mut HashMap<String, Vec<SymbolEntry>>,
    by_file: &mut HashMap<String, Vec<SymbolEntry>>,
    total_symbols: &mut usize,
    total_files: &mut usize,
    depth: usize,
) {
    if depth > 8 { return; }

    let items = match fs::read_dir(dir) {
        Ok(i) => i,
        Err(_) => return,
    };

    for item in items.filter_map(|e| e.ok()) {
        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if name.starts_with('.') { continue; }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) { continue; }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) { continue; }

        if is_dir {
            walk_and_index(&path, root, by_name, by_file, total_symbols, total_files, depth + 1);
        } else {
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_string();
            if !should_analyze_ext(&ext) { continue; }

            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if content.len() > 200_000 { continue; }

            let relative = path.strip_prefix(root).unwrap_or(&path)
                .to_string_lossy().replace('\\', "/");
            let symbols = extract_symbols(&content, &relative, &ext);

            if !symbols.is_empty() {
                for sym in &symbols {
                    let key = sym.name.to_lowercase();
                    by_name.entry(key).or_default().push(sym.clone());
                }
                by_file.insert(relative, symbols.clone());
                *total_symbols += symbols.len();
            }
            *total_files += 1;
        }
    }
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn symbol_lookup(
    name: String,
    state: State<ProjectRoot>,
    index_state: State<SymbolIndexState>,
) -> Result<SymbolLookupResult, String> {
    let _root = get_project_root(&state)?;
    let start = std::time::Instant::now();

    let index = index_state
        .0
        .read()
        .map_err(|_| "Symbol index lock error".to_string())?;

    let key = name.to_lowercase();
    let mut matches = index.by_name.get(&key).cloned().unwrap_or_default();
    matches.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)));
    let count = matches.len();

    Ok(SymbolLookupResult {
        query: name,
        matches,
        total_count: count,
        query_time_ms: start.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub fn symbol_list_file(
    file_path: String,
    state: State<ProjectRoot>,
    index_state: State<SymbolIndexState>,
) -> Result<SymbolFileResult, String> {
    let _root = get_project_root(&state)?;

    let index = index_state
        .0
        .read()
        .map_err(|_| "Symbol index lock error".to_string())?;

    let symbols = index.by_file.get(&file_path).cloned().unwrap_or_default();
    let count = symbols.len();

    Ok(SymbolFileResult { file: file_path, symbols, count })
}

#[tauri::command]
pub fn symbol_rebuild(
    state: State<ProjectRoot>,
    index_state: State<SymbolIndexState>,
) -> Result<usize, String> {
    let root = get_project_root(&state)?;
    let index = build_index(&root)?;
    let total = index.total_symbols;

    let mut stored = index_state
        .0
        .write()
        .map_err(|_| "Symbol index lock error".to_string())?;
    *stored = index;

    Ok(total)
}

#[tauri::command]
pub fn symbol_stats(
    index_state: State<SymbolIndexState>,
) -> Result<serde_json::Value, String> {
    let index = index_state
        .0
        .read()
        .map_err(|_| "Symbol index lock error".to_string())?;

    let mut top_symbols: Vec<(&String, usize)> = index.by_name.iter()
        .filter_map(|(name, entries)| {
            if entries.len() > 1 { Some((name, entries.len())) } else { None }
        })
        .collect();
    top_symbols.sort_by(|a, b| b.1.cmp(&a.1));

    let top_10: Vec<serde_json::Value> = top_symbols.iter().take(10).map(|(name, count)| {
        let kinds: Vec<&str> = index.by_name[*name].iter().map(|e| e.kind.as_str()).collect();
        serde_json::json!({ "name": name, "definitions": count, "kinds": kinds })
    }).collect();

    Ok(serde_json::json!({
        "total_symbols": index.total_symbols,
        "total_files_scanned": index.total_files,
        "unique_symbol_names": index.by_name.len(),
        "built_at_unix_ms": index.built_at,
        "top_duplicate_symbols": top_10,
    }))
}

#[tauri::command]
pub fn symbol_rebuild_file(
    file_path: String,
    content: String,
    state: State<ProjectRoot>,
    index_state: State<SymbolIndexState>,
) -> Result<usize, String> {
    let _root = get_project_root(&state)?;

    // Determine file extension for symbol extraction
    let ext = Path::new(&file_path)
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    if !should_analyze_ext(&ext) {
        return Ok(0);
    }

    // Extract new symbols from the provided content
    let new_symbols = extract_symbols(&content, &file_path, &ext);
    let new_count = new_symbols.len();

    // Acquire write lock on the index
    let mut index = index_state
        .0
        .write()
        .map_err(|_| "Symbol index lock error".to_string())?;

    // Remove all existing entries for this file from by_name
    if let Some(old_symbols) = index.by_file.remove(&file_path) {
        let old_count = old_symbols.len();
        for sym in &old_symbols {
            let key = sym.name.to_lowercase();
            if let Some(entries) = index.by_name.get_mut(&key) {
                entries.retain(|e| e.file != file_path);
                if entries.is_empty() {
                    index.by_name.remove(&key);
                }
            }
        }
        index.total_symbols = index.total_symbols.saturating_sub(old_count);
    }

    // Insert new symbols
    if !new_symbols.is_empty() {
        for sym in &new_symbols {
            let key = sym.name.to_lowercase();
            index.by_name.entry(key).or_default().push(sym.clone());
        }
        index.by_file.insert(file_path, new_symbols);
        index.total_symbols += new_count;
    }

    // Update timestamp
    index.built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    Ok(new_count)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_ts_function() {
        let content = "function handleSubmit(event: Event) {\n  console.log('submit');\n}";
        let symbols = extract_symbols(content, "test.ts", "ts");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "handleSubmit");
        assert_eq!(symbols[0].kind, "function");
        assert_eq!(symbols[0].line, 1);
    }

    #[test]
    fn test_extract_ts_class() {
        let content = "export class AuthService {\n  login() {}\n}";
        let symbols = extract_symbols(content, "auth.ts", "ts");
        assert!(symbols.iter().any(|s| s.kind == "class" && s.name == "AuthService"));
    }

    #[test]
    fn test_extract_ts_interface() {
        let content = "interface User {\n  name: string;\n}";
        let symbols = extract_symbols(content, "types.ts", "ts");
        assert!(symbols.iter().any(|s| s.kind == "interface" && s.name == "User"));
    }

    #[test]
    fn test_extract_python() {
        let content = "def calculate_total(items):\n    return sum(items)";
        let symbols = extract_symbols(content, "calc.py", "py");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "calculate_total");
    }

    #[test]
    fn test_extract_python_class() {
        let content = "class Database:\n    def connect(self):\n        pass";
        let symbols = extract_symbols(content, "db.py", "py");
        assert!(symbols.iter().any(|s| s.kind == "class" && s.name == "Database"));
        assert!(symbols.iter().any(|s| s.kind == "function" && s.name == "connect"));
    }

    #[test]
    fn test_extract_rust() {
        let content = "pub fn main() {\n    println!(\"hello\");\n}";
        let symbols = extract_symbols(content, "main.rs", "rs");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "main");
        assert_eq!(symbols[0].kind, "function");
    }

    #[test]
    fn test_extract_rust_struct() {
        let content = "pub struct Config {\n    pub path: String,\n}";
        let symbols = extract_symbols(content, "config.rs", "rs");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Config");
        assert_eq!(symbols[0].kind, "struct");
    }
}