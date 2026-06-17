use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::State;

use crate::FileIndexEntry;
use crate::ProjectRoot;
use crate::ProjectIndexCache;
use crate::CodebaseIndex;
use crate::CodeSearchHit;
use crate::TfIdfIndex;
use crate::CodeChunk;
use crate::CHUNK_LINES;
use crate::CHUNK_OVERLAP;
use crate::DOCSTRING_LOOKBACK;
use crate::FuzzyMatchResult;
use crate::RelevantContext;
use crate::ContextFile;
use crate::AIContext;
use crate::get_project_root;
use crate::validate_path_within_project;
use crate::SKIP_DIRS;
use crate::SKIP_FILES;

// --- Project Context Cache ---

#[tauri::command]
pub fn get_project_index(state: State<ProjectRoot>, cache: State<ProjectIndexCache>) -> Result<Vec<FileIndexEntry>, String> {
    let cached = cache.0.read().map_err(|_| "Lock error".to_string())?;
    if !cached.is_empty() {
        return Ok(cached.clone());
    }
    // If cache is empty, build it now
    drop(cached);
    refresh_project_index(state, cache)
}

#[tauri::command]
pub fn refresh_project_index(state: State<ProjectRoot>, cache: State<ProjectIndexCache>) -> Result<Vec<FileIndexEntry>, String> {
    let root = get_project_root(&state)?;
    let root_path = Path::new(&root);
    let mut entries = Vec::new();
    index_directory(root_path, root_path, &mut entries, 0);
    let mut cached = cache.0.write().map_err(|_| "Lock error".to_string())?;
    *cached = entries.clone();
    Ok(entries)
}

#[tauri::command]
pub fn update_file_index(path: String, state: State<ProjectRoot>, cache: State<ProjectIndexCache>) -> Result<(), String> {
    let root = get_project_root(&state)?;
    let safe_path = validate_path_within_project(&path, &root)?;
    let root_path = Path::new(&root);
    let file_path = Path::new(&safe_path);

    let relative = file_path.strip_prefix(root_path)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");

    let mut cached = cache.0.write().map_err(|_| "Lock error".to_string())?;

    // Remove old entry for this path
    cached.retain(|e| e.path != relative);

    // Add updated entry if file still exists
    if file_path.is_file() {
        if let Some(entry) = build_index_entry(file_path, root_path) {
            cached.push(entry);
        }
    }

    Ok(())
}

pub(crate) fn index_directory(dir: &Path, root: &Path, entries: &mut Vec<FileIndexEntry>, depth: usize) {
    if depth > 8 || entries.len() > 5000 { return; }

    let items = match fs::read_dir(dir) {
        Ok(items) => items,
        Err(_) => return,
    };

    for item in items.filter_map(|e| e.ok()) {
        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);

        // Skip hidden, ignored dirs, and lock files
        if name.starts_with('.') { continue; }
        if is_dir && SKIP_DIRS.contains(&name.as_str()) { continue; }
        if !is_dir && SKIP_FILES.contains(&name.as_str()) { continue; }

        if is_dir {
            index_directory(&path, root, entries, depth + 1);
        } else {
            if let Some(entry) = build_index_entry(&path, root) {
                entries.push(entry);
            }
        }
    }
}

pub(crate) fn build_index_entry(file_path: &Path, root: &Path) -> Option<FileIndexEntry> {
    let metadata = fs::metadata(file_path).ok()?;
    let size = metadata.len();

    // Skip files > 500KB
    if size > 500_000 { return None; }

    let extension = file_path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // Skip binary extensions
    let binary_exts = ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp",
        "woff", "woff2", "ttf", "eot", "otf", "mp3", "mp4", "wav",
        "zip", "tar", "gz", "rar", "7z", "pdf", "exe", "dll", "so"];
    if binary_exts.contains(&extension.as_str()) {
        return Some(FileIndexEntry {
            path: file_path.strip_prefix(root).unwrap_or(file_path).to_string_lossy().replace('\\', "/"),
            extension,
            size,
            modified: metadata.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            preview: String::new(),
            is_binary: true,
        });
    }

    // Read first 500 chars as preview
    let preview = fs::read_to_string(file_path).ok()
        .map(|s| s.chars().take(500).collect::<String>())
        .unwrap_or_default();

    Some(FileIndexEntry {
        path: file_path.strip_prefix(root).unwrap_or(file_path).to_string_lossy().replace('\\', "/"),
        extension,
        size,
        modified: metadata.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
        preview,
        is_binary: false,
    })
}

// --- Rust Fuzzy Edit Engine ---

#[tauri::command]
pub fn fuzzy_find_block(content: String, search_text: String, threshold: f64) -> Result<FuzzyMatchResult, String> {
    let content_lines: Vec<&str> = content.lines().collect();
    let search_lines: Vec<&str> = search_text.lines().map(|l| l.trim_end()).collect();
    let window_size = search_lines.len();

    if window_size == 0 || content_lines.len() < window_size {
        return Ok(FuzzyMatchResult { start_line: 0, end_line: 0, score: 0.0, matched: false });
    }

    let mut best_score: f64 = 0.0;
    let mut best_start: usize = 0;

    for i in 0..=(content_lines.len() - window_size) {
        let window: Vec<&str> = content_lines[i..i + window_size].iter()
            .map(|l| l.trim_end())
            .collect();
        let score = line_similarity(&window, &search_lines);
        if score > best_score {
            best_score = score;
            best_start = i;
        }
    }

    if best_score >= threshold {
        Ok(FuzzyMatchResult {
            start_line: best_start,
            end_line: best_start + window_size,
            score: best_score,
            matched: true,
        })
    } else {
        Ok(FuzzyMatchResult { start_line: 0, end_line: 0, score: best_score, matched: false })
    }
}

pub(crate) fn line_similarity(a: &[&str], b: &[&str]) -> f64 {
    if a.len() != b.len() { return 0.0; }
    if a.is_empty() { return 1.0; }

    let mut total: f64 = 0.0;
    for i in 0..a.len() {
        if a[i] == b[i] {
            total += 1.0;
        } else {
            total += char_similarity(a[i], b[i]);
        }
    }
    total / a.len() as f64
}

pub(crate) fn char_similarity(a: &str, b: &str) -> f64 {
    if a == b { return 1.0; }
    if a.is_empty() || b.is_empty() { return 0.0; }
    let max_len = a.len().max(b.len());
    if max_len == 0 { return 1.0; }
    // For very long lines, use a quick heuristic
    if max_len > 300 {
        let prefix_match = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
        return prefix_match as f64 / max_len as f64;
    }
    let dist = levenshtein(a, b);
    1.0 - (dist as f64 / max_len as f64)
}

pub(crate) fn levenshtein(a: &str, b: &str) -> usize {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let a_len = a_bytes.len();
    let b_len = b_bytes.len();

    let mut prev: Vec<usize> = (0..=b_len).collect();
    let mut curr = vec![0usize; b_len + 1];

    for i in 1..=a_len {
        curr[0] = i;
        for j in 1..=b_len {
            let cost = if a_bytes[i - 1] == b_bytes[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b_len]
}

// --- Rust TF-IDF Codebase Index ---

#[tauri::command]
pub fn index_codebase(state: State<ProjectRoot>, index_state: State<CodebaseIndex>) -> Result<usize, String> {
    let root = get_project_root(&state)?;
    let root_path = Path::new(&root);

    let mut chunks: Vec<CodeChunk> = Vec::new();
    collect_chunks(root_path, root_path, &mut chunks, 0);

    // Build inverted index
    let mut inverted: HashMap<String, Vec<(usize, f64)>> = HashMap::new();
    for idx in 0..chunks.len() {
        let tokens = tokenize_code(&chunks[idx].content);
        let token_count = tokens.len();
        if token_count == 0 { continue; }

        let mut freq: HashMap<&str, usize> = HashMap::new();
        for t in &tokens {
            *freq.entry(t.as_str()).or_insert(0) += 1;
        }
        for (token, count) in freq {
            let tf = count as f64 / token_count as f64;
            inverted.entry(token.to_string()).or_default().push((idx, tf));
        }
    }

    let chunk_count = chunks.len();
    let mut idx = index_state.0.write().map_err(|_| "Lock error".to_string())?;
    *idx = Some(TfIdfIndex { chunks, inverted });

    Ok(chunk_count)
}

#[tauri::command]
pub fn search_codebase(query: String, top_k: usize, index_state: State<CodebaseIndex>) -> Result<Vec<CodeSearchHit>, String> {
    let idx_guard = index_state.0.read().map_err(|_| "Lock error".to_string())?;
    let index = idx_guard.as_ref().ok_or("Codebase not indexed yet. Call index_codebase first.")?;

    let query_tokens = tokenize_code(&query);
    if query_tokens.is_empty() { return Ok(vec![]); }

    let doc_count = index.chunks.len() as f64;
    let mut scores: HashMap<usize, f64> = HashMap::new();

    for token in &query_tokens {
        if let Some(entries) = index.inverted.get(token.as_str()) {
            let idf = (doc_count / (entries.len() as f64 + 1.0)).ln() + 1.0;
            for &(chunk_idx, tf) in entries {
                *scores.entry(chunk_idx).or_insert(0.0) += tf * idf;
            }
        }
    }

    let mut sorted: Vec<(usize, f64)> = scores.into_iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let results: Vec<CodeSearchHit> = sorted.into_iter().take(top_k).map(|(idx, score)| {
        let chunk = &index.chunks[idx];
        CodeSearchHit {
            path: chunk.path.clone(),
            start_line: chunk.start_line,
            end_line: chunk.end_line,
            snippet: chunk.content.chars().take(200).collect(),
            score,
        }
    }).collect();

    Ok(results)
}

/// Extract imports from the first 80 lines of a source file.
/// Returns `Vec<String>` of import statements (one per line).
fn extract_imports(lines: &[&str], ext: &str) -> Vec<String> {
    let limit = lines.len().min(80);
    let mut imports: Vec<String> = Vec::new();
    for i in 0..limit {
        let line = lines[i].trim();
        if line.is_empty() || line.starts_with("//") || line.starts_with("/*") || line.starts_with('*') {
            continue;
        }
        let is_import = match ext {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
                line.starts_with("import ") || line.starts_with("const ") && line.contains("require(")
                    || line.starts_with("let ") && line.contains("require(")
                    || line.starts_with("var ") && line.contains("require(")
            }
            "py" => {
                line.starts_with("import ") || line.starts_with("from ")
            }
            "rs" => {
                line.starts_with("use ") || line.starts_with("extern crate ")
                    || line.starts_with("mod ") || line.starts_with("#[")
            }
            _ => false,
        };
        if is_import {
            imports.push(lines[i].to_string());
        } else if imports.len() > 0 && !is_import {
            // Once we've collected imports and hit a non-import line, stop
            // unless it's a continuation (line wrapped with parens)
            if !line.starts_with('(') && !line.starts_with('{') && !lines[i].ends_with(',') {
                break;
            }
        }
    }
    imports
}

/// Detect chunk boundaries using language-aware regex patterns for
/// functions, classes, methods, structs, traits, and impl blocks.
/// Falls back to fixed-size windows for unrecognized patterns.
fn collect_function_chunks(
    lines: &[&str],
    relative: &str,
    ext: &str,
    imports: Vec<String>,
    chunks: &mut Vec<CodeChunk>,
) {
    if lines.is_empty() { return; }

    // ----- Regex patterns for boundary detection -----
    // TS/JS: function, class, method, arrow function (const/let/var = (...) =>, = function)
    // Python: def, class
    // Rust: fn, struct, trait, impl, enum, mod
    let boundary_re = match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            regex_lite::Regex::new(
                r"^\s*(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function|(?:public|private|protected|static|async)\s+(\w+)\s*\()"
            )
        }
        "py" => {
            regex_lite::Regex::new(r"^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)")
        }
        "rs" => {
            regex_lite::Regex::new(r"^\s*(?:pub(?:\s*\(\s*crate\s*\))?\s+)?(?:async\s+)?fn\s+(\w+)|^\s*(?:pub\s+)?struct\s+(\w+)|^\s*(?:pub\s+)?trait\s+(\w+)|^\s*(?:pub\s+)?enum\s+(\w+)|^\s*impl\b|^\s*(?:pub\s+)?mod\s+(\w+)")
        }
        _ => { return collect_window_fallback(lines, relative, imports, chunks); }
    };

    let boundary_re = match boundary_re {
        Ok(r) => r,
        Err(_) => { return collect_window_fallback(lines, relative, imports, chunks); }
    };

    // ----- Find all chunk boundaries -----
    // boundaries: Vec<(start_line_0idx, chunk_type, name, signature_line)>
    let mut boundaries: Vec<(usize, String, String, String)> = Vec::new();

    for (line_idx, line) in lines.iter().enumerate() {
        if let Some(caps) = boundary_re.captures(line) {
            // Determine chunk type and name
            let (chunk_type, name) = match ext {
                "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
                    if let Some(fn_name) = caps.get(1) {
                        ("function".to_string(), fn_name.as_str().to_string())
                    } else if let Some(cls_name) = caps.get(2) {
                        ("class".to_string(), cls_name.as_str().to_string())
                    } else if let Some(arrow_name) = caps.get(3) {
                        ("arrow_function".to_string(), arrow_name.as_str().to_string())
                    } else if let Some(fn_assign) = caps.get(4) {
                        ("function".to_string(), fn_assign.as_str().to_string())
                    } else if let Some(method_name) = caps.get(5) {
                        ("method".to_string(), method_name.as_str().to_string())
                    } else {
                        ("block".to_string(), String::new())
                    }
                }
                "py" => {
                    if let Some(fn_name) = caps.get(1) {
                        ("function".to_string(), fn_name.as_str().to_string())
                    } else if let Some(cls_name) = caps.get(2) {
                        ("class".to_string(), cls_name.as_str().to_string())
                    } else {
                        ("block".to_string(), String::new())
                    }
                }
                "rs" => {
                    if let Some(fn_name) = caps.get(1) {
                        ("function".to_string(), fn_name.as_str().to_string())
                    } else if let Some(struct_name) = caps.get(2) {
                        ("struct".to_string(), struct_name.as_str().to_string())
                    } else if let Some(trait_name) = caps.get(3) {
                        ("trait".to_string(), trait_name.as_str().to_string())
                    } else if let Some(enum_name) = caps.get(4) {
                        ("enum".to_string(), enum_name.as_str().to_string())
                    } else if caps.get(5).is_some() {
                        ("module".to_string(), caps.get(5).unwrap().as_str().to_string())
                    } else {
                        ("impl_block".to_string(), String::new())
                    }
                }
                _ => ("block".to_string(), String::new()),
            };

            // Signature: current line (trimmed)
            let signature = line.trim().to_string();

            boundaries.push((line_idx, chunk_type, name, signature));
        }
    }

    if boundaries.is_empty() {
        // No boundaries found → fall back to window chunking
        return collect_window_fallback(lines, relative, imports, chunks);
    }

    // ----- Build chunks from boundaries -----
    for idx in 0..boundaries.len() {
        let (start, ref chunk_type, ref name, ref signature) = boundaries[idx];
        let end = if idx + 1 < boundaries.len() {
            boundaries[idx + 1].0 // next boundary start (exclusive)
        } else {
            lines.len()
        };

        // Include docstring/comments above the function (lookback)
        let chunk_start = if start > 0 {
            let mut lookback = start.saturating_sub(1);
            let mut lb = 0;
            while lb < DOCSTRING_LOOKBACK && lookback > 0 {
                let prev = lines[lookback].trim();
                if prev.is_empty() || prev.starts_with("//") || prev.starts_with("/*")
                    || prev.starts_with('*') || prev.starts_with("///") || prev.starts_with("# ")
                    || prev.starts_with("'''") || prev.starts_with("\"\"\"")
                    || prev.starts_with("#[") || prev.starts_with("//!")
                {
                    lb += 1;
                    if lookback == 0 { break; }
                    lookback -= 1;
                } else {
                    break;
                }
            }
            if lookback < start.saturating_sub(1) { lookback + 1 } else { start }
        } else {
            start
        };

        let chunk_lines = &lines[chunk_start..end];
        let content = chunk_lines.join("\n");
        let token_count = tokenize_code(&content).len();

        // Only include imports on the first chunk of each file
        let chunk_imports = if chunks.iter().any(|c: &CodeChunk| c.path == relative) {
            Vec::new()
        } else {
            imports.clone()
        };

        chunks.push(CodeChunk {
            path: relative.to_string(),
            start_line: chunk_start + 1, // 1-indexed
            end_line: end,
            content,
            token_count,
            chunk_type: chunk_type.clone(),
            name: name.clone(),
            signature: signature.clone(),
            imports: chunk_imports,
        });
    }
}

/// Fallback: fixed-size window chunking for files that don't match
/// any known function/class boundary pattern.
fn collect_window_fallback(
    lines: &[&str],
    relative: &str,
    imports: Vec<String>,
    chunks: &mut Vec<CodeChunk>,
) {
    let mut i = 0;
    while i < lines.len() {
        let end = (i + CHUNK_LINES).min(lines.len());
        let chunk_content: String = lines[i..end].join("\n");
        let token_count = tokenize_code(&chunk_content).len();
        let chunk_imports = if chunks.iter().any(|c: &CodeChunk| c.path == relative) {
            Vec::new()
        } else {
            imports.clone()
        };
        chunks.push(CodeChunk {
            path: relative.to_string(),
            start_line: i + 1,
            end_line: end,
            content: chunk_content,
            token_count,
            chunk_type: "block".to_string(),
            name: String::new(),
            signature: String::new(),
            imports: chunk_imports,
        });
        i += CHUNK_LINES - CHUNK_OVERLAP;
        if end >= lines.len() { break; }
    }
}

pub(crate) fn collect_chunks(dir: &Path, root: &Path, chunks: &mut Vec<CodeChunk>, depth: usize) {
    if depth > 8 || chunks.len() > 10000 { return; }

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
            collect_chunks(&path, root, chunks, depth + 1);
        } else {
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_string();
            let binary_exts = ["png","jpg","jpeg","gif","webp","ico","bmp","woff","woff2",
                "ttf","eot","otf","mp3","mp4","wav","zip","tar","gz","rar","pdf","exe","dll"];
            if binary_exts.contains(&ext.as_str()) { continue; }

            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if content.len() > 200_000 { continue; } // skip huge files

            let relative = path.strip_prefix(root).unwrap_or(&path)
                .to_string_lossy().replace('\\', "/");
            let lines: Vec<&str> = content.lines().collect();

            // Extract imports from file header
            let imports = extract_imports(&lines, &ext);

            // Use function/class boundary-aware chunking
            collect_function_chunks(&lines, &relative, &ext, imports, chunks);
        }
    }
}

pub(crate) fn tokenize_code(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
        .filter(|t| t.len() > 2 && t.len() < 40)
        .filter(|t| !is_stop_word(t))
        .map(|t| t.to_string())
        .collect()
}

pub(crate) fn is_stop_word(word: &str) -> bool {
    matches!(word,
        "the" | "and" | "for" | "are" | "but" | "not" | "you" | "all" |
        "can" | "had" | "her" | "was" | "one" | "our" | "out" | "has" |
        "from" | "this" | "that" | "with" | "have" | "will" | "each" |
        "make" | "like" | "been" | "than" | "them" | "then" | "into" |
        "import" | "export" | "const" | "function" | "return" | "class" |
        "true" | "false" | "null" | "undefined" | "let" | "var" | "new"
    )
}

pub(crate) fn ext_boost(path: &str) -> f64 {
    match path.rsplit('.').next().unwrap_or("") {
        "ts" | "tsx" | "js" | "jsx" => 1.2, "rs" | "py" | "go" => 1.1,
        "css" | "scss" | "less" => 0.7, "html" => 0.8,
        "json" | "toml" | "yaml" | "yml" => 0.6, "md" | "txt" => 0.4,
        _ => 1.0,
    }
}

pub(crate) fn refresh_project_index_impl(root: &str, cache: &State<ProjectIndexCache>) -> Result<(), String> {
    let mut entries = Vec::new();
    index_directory(Path::new(root), Path::new(root), &mut entries, 0);
    let mut cached = cache.0.write().map_err(|_| "Lock error".to_string())?;
    *cached = entries;
    Ok(())
}

// --- Unified Context Engine ---

#[tauri::command]
pub fn get_relevant_context(
    query: String,
    open_tab_paths: Vec<String>,
    max_files: usize,
    state: State<ProjectRoot>,
    cache: State<ProjectIndexCache>,
    code_index: State<CodebaseIndex>,
) -> Result<RelevantContext, String> {
    let root = get_project_root(&state)?;
    let root_path = Path::new(&root);

    // 1. Ensure project index is built
    let index = {
        let cached = cache.0.read().map_err(|_| "Lock error".to_string())?;
        if cached.is_empty() {
            drop(cached);
            refresh_project_index_impl(&root, &cache)?;
            cache.0.read().map_err(|_| "Lock error".to_string())?.clone()
        } else {
            cached.clone()
        }
    };

    let project_name = root_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.clone());

    if index.is_empty() {
        return Ok(RelevantContext {
            project_summary: format!("Project: {} (no files indexed)", project_name),
            relevant_files: Vec::new(),
            git_status: Vec::new(),
            open_tab_paths,
            total_tokens_estimate: 0,
        });
    }

    // 2. Build scored file list combining TF-IDF + token overlap
    let mut scored_files: Vec<(f64, String)> = Vec::new();
    let query_lower = query.to_lowercase();

    // 2a. Try TF-IDF codebase index first (deep semantic)
    if let Ok(idx_guard) = code_index.0.read() {
        if let Some(ref tfidf) = *idx_guard {
            let query_tokens = tokenize_code(&query);
            if !query_tokens.is_empty() {
                let doc_count = tfidf.chunks.len() as f64;
                let mut tf_scores: HashMap<usize, f64> = HashMap::new();
                for token in &query_tokens {
                    if let Some(entries) = tfidf.inverted.get(token.as_str()) {
                        let idf = (doc_count / (entries.len() as f64 + 1.0)).ln() + 1.0;
                        for &(chunk_idx, tf) in entries {
                            *tf_scores.entry(chunk_idx).or_insert(0.0) += tf * idf;
                        }
                    }
                }
                // Aggregate by file path (max chunk score per file)
                let mut file_scores: HashMap<String, f64> = HashMap::new();
                for (chunk_idx, score) in tf_scores {
                    let path = &tfidf.chunks[chunk_idx].path;
                    let entry = file_scores.entry(path.clone()).or_insert(0.0);
                    *entry = entry.max(score);
                }
                for (path, score) in file_scores {
                    scored_files.push((score * ext_boost(&path), path));
                }
            }
        }
    }

    // 2b. Token-overlap scoring against file index previews
    let query_tokens = tokenize_code(&query);
    for entry in index.iter() {
        if entry.is_binary || entry.preview.is_empty() { continue; }
        if scored_files.iter().any(|(_, p)| p == &entry.path) { continue; }

        let file_tokens = tokenize_code(&entry.preview);
        let mut score: f64 = 0.0;
        for qt in &query_tokens {
            for ft in &file_tokens {
                if ft.contains(qt.as_str()) || qt.contains(ft.as_str()) {
                    score += 1.0;
                }
            }
        }

        if score > 0.0 {
            score *= ext_boost(&entry.path);
            let filename = entry.path.rsplit('/').next().unwrap_or(&entry.path).to_lowercase();
            if query_lower.contains(&filename.replace('.', "")) { score += 5.0; }
            scored_files.push((score, entry.path.clone()));
        }
    }

    // 3. Git recency boost
    let mut git_status_lines: Vec<String> = Vec::new();
    // Clone state before git_status consumes it — needed later for dependency graph
    if let Ok(statuses) = crate::git_commands::git_status(state.clone()) {
        let modified_set: std::collections::HashSet<String> = statuses.iter().map(|s| s.path.clone()).collect();
        for (score, path) in scored_files.iter_mut() {
            if modified_set.contains(path.as_str()) { *score *= 1.5; }
        }
        git_status_lines = statuses.iter().map(|s| format!("[{}] {}", s.status.to_uppercase(), s.path)).collect();
    }

    // 4. Open tab boost (3x)
    let tab_set: std::collections::HashSet<&str> = open_tab_paths.iter().map(|s| s.as_str()).collect();
    for (score, path) in scored_files.iter_mut() {
        if tab_set.contains(path.as_str()) { *score *= 3.0; }
    }

    // 5. Sort and take top
    scored_files.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let top_file_paths: Vec<String> = scored_files.iter()
        .take(max_files.max(3))
        .filter(|(s, _)| *s > 0.0)
        .map(|(_, path)| path.clone())
        .collect();

    // 5b. Pull dependency neighbors from the architecture graph
    //     (files that import or are imported by top-scoring files)
    let neighbor_paths = if let Ok(graph) = crate::architecture::dependency_analyzer::build_dependency_graph(state.clone()) {
        let mut neighbors = std::collections::HashSet::new();
        for path in &top_file_paths {
            // Files that directly depend on this file
            for dep in graph.find_dependents(path) {
                if !top_file_paths.contains(&dep) { neighbors.insert(dep); }
            }
            // Files this file directly depends on
            for dep in graph.get_direct_dependencies(path) {
                if !top_file_paths.contains(&dep) { neighbors.insert(dep); }
            }
        }
        neighbors.into_iter().collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    // Build ContextFile entries: top files first (full relevance), then neighbors (lower relevance)
    let mut top_files: Vec<ContextFile> = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();

    // Primary files
    for (score, path) in scored_files.iter()
        .take(max_files.max(3))
        .filter(|(s, _)| *s > 0.0)
    {
        if seen_paths.contains(path.as_str()) { continue; }
        seen_paths.insert(path.clone());
        let full_path = root_path.join(path);
        let content = fs::read_to_string(&full_path).ok().unwrap_or_default();
        let trimmed = if content.len() > 3000 {
            format!("{}...\n[truncated]", &content[..3000])
        } else { content };
        top_files.push(ContextFile { path: path.clone(), content: trimmed, relevance: *score });
    }

    // Neighbor files (lower relevance, limited to avoid bloat)
    let neighbor_limit = (max_files / 2).max(3);
    for path in neighbor_paths.iter().take(neighbor_limit) {
        if seen_paths.contains(path.as_str()) { continue; }
        seen_paths.insert(path.clone());
        let full_path = root_path.join(path);
        if let Ok(content) = fs::read_to_string(&full_path) {
            let trimmed = if content.len() > 1500 {
                format!("{}...\n[truncated]", &content[..1500])
            } else { content };
            top_files.push(ContextFile {
                path: path.clone(),
                content: trimmed,
                relevance: 0.5, // marked as dependency neighbor
            });
        }
    }

    let tokens = top_files.iter().map(|f| f.content.len() / 4).sum::<usize>()
        + git_status_lines.len() * 10 + 500;

    Ok(RelevantContext {
        project_summary: format!("Project: {} ({} files). Query: {}", project_name, index.len(), query),
        relevant_files: top_files,
        git_status: git_status_lines,
        open_tab_paths,
        total_tokens_estimate: tokens,
    })
}

// --- Legacy AI Context Builder ---

#[tauri::command]
pub fn build_ai_context(query: String, max_files: usize, state: State<ProjectRoot>, cache: State<ProjectIndexCache>) -> Result<AIContext, String> {
    let root = get_project_root(&state)?;
    let index = cache.0.read().map_err(|_| "Lock error".to_string())?;

    if index.is_empty() {
        return Ok(AIContext {
            project_summary: format!("Project at: {}", root),
            relevant_files: Vec::new(),
            total_tokens_estimate: 0,
        });
    }

    let query_tokens = tokenize_code(&query);
    let mut scored_files: Vec<(f64, &FileIndexEntry)> = Vec::new();

    for entry in index.iter() {
        if entry.is_binary || entry.preview.is_empty() { continue; }

        let file_tokens = tokenize_code(&entry.preview);
        let mut score = 0.0;

        // Score based on token overlap
        for qt in &query_tokens {
            for ft in &file_tokens {
                if ft.contains(qt.as_str()) || qt.contains(ft.as_str()) {
                    score += 1.0;
                }
            }
        }

        // Boost by file extension relevance
        let ext_boost_val = match entry.extension.as_str() {
            "ts" | "tsx" | "js" | "jsx" => 1.2,
            "rs" => 1.1,
            "py" => 1.1,
            "css" | "scss" => 0.8,
            "json" | "toml" | "yaml" => 0.7,
            "md" => 0.5,
            _ => 1.0,
        };
        score *= ext_boost_val;

        // Boost if query mentions the filename
        let filename = entry.path.split('/').last().unwrap_or(&entry.path).to_lowercase();
        if query.to_lowercase().contains(&filename.replace('.', "")) {
            score += 5.0;
        }

        if score > 0.0 {
            scored_files.push((score, entry));
        }
    }

    scored_files.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let top_files: Vec<ContextFile> = scored_files.iter()
        .take(max_files)
        .filter_map(|(score, entry)| {
            let full_path = Path::new(&root).join(&entry.path);
            let content = fs::read_to_string(&full_path).ok()?;
            // Limit to 2000 chars per file for context
            let trimmed = if content.len() > 2000 {
                format!("{}...\n[truncated]", &content[..2000])
            } else {
                content
            };
            Some(ContextFile {
                path: entry.path.clone(),
                content: trimmed,
                relevance: *score,
            })
        })
        .collect();

    let total_tokens_estimate = top_files.iter()
        .map(|f| f.content.len() / 4) // rough token estimate
        .sum();

    let file_count = index.len();
    let project_summary = format!(
        "Project: {} ({} files). Query: {}",
        root.split(['/', '\\']).last().unwrap_or(&root),
        file_count,
        query
    );

    Ok(AIContext {
        project_summary,
        relevant_files: top_files,
        total_tokens_estimate,
    })
}