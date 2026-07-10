//! Context Compressor — AST-Based Section Extraction for Large Files
//!
//! Extracts only relevant sections from large files using regex-based function
//! boundary detection (same approach as symbol_index.rs and call_graph.rs).
//! Sections ranked: 1=keyword match, 2=call-chain (2 levels), 3=exported.
//!
//! Commands:
//!   compress_file_ast — compress a file into ranked sections within a token budget

use serde::Serialize;
use std::collections::HashSet;
use tauri::State;

use crate::call_graph::CallGraphState;
use crate::{get_project_root, ProjectRoot};

// ── Data Types ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
pub struct CompressedFileResult {
    pub sections: Vec<CompressedSection>,
    pub imports: String,
    pub total_tokens: usize,
    pub omitted_ranges: Vec<OmittedRange>,
    pub fallback_used: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct CompressedSection {
    pub content: String,
    pub symbol_name: String,
    pub kind: String,
    pub start_line: usize,
    pub end_line: usize,
    pub rank: u8,
}

#[derive(Serialize, Debug, Clone)]
pub struct OmittedRange {
    pub start_line: usize,
    pub end_line: usize,
}

// ── Internal Helpers ───────────────────────────────────────────────────────────

fn estimate_tokens(text: &str) -> usize { (text.len() + 3) / 4 }

fn is_import_line(line: &str, ext: &str) -> bool {
    let t = line.trim();
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            t.starts_with("import ") || t.starts_with("import{")
                || t.starts_with("require(")
                || (t.starts_with("export ") && t.contains(" from "))
        }
        "py" => t.starts_with("import ") || t.starts_with("from "),
        "rs" => t.starts_with("use ") || t.starts_with("pub use "),
        _ => false,
    }
}

fn is_type_definition_line(line: &str, ext: &str) -> bool {
    let t = line.trim();
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            t.contains("interface ") || (t.contains("type ") && t.contains("="))
        }
        "rs" => {
            (t.starts_with("pub ") || t.starts_with("struct ") || t.starts_with("enum ") || t.starts_with("type "))
                && (t.contains("struct ") || t.contains("enum ") || t.contains("type "))
        }
        _ => false,
    }
}

fn is_exported(line: &str, ext: &str) -> bool {
    let t = line.trim();
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => t.starts_with("export "),
        "rs" => t.starts_with("pub ") || t.starts_with("pub(crate)"),
        "py" => !t.starts_with("_"),
        _ => false,
    }
}

/// Detect function/class boundaries. Returns Vec<(line_0idx, name, kind, exported)>.
fn detect_boundaries(lines: &[&str], ext: &str) -> Vec<(usize, String, String, bool)> {
    let boundary_re = match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => regex_lite::Regex::new(
            &[r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)",
              r"^\s*(?:export\s+)?class\s+(\w+)",
              r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?[\(<]",
              r"^\s+(?:public|private|protected|static|async)\s+(\w+)\s*\("].join("|"),
        ).ok(),
        "py" => regex_lite::Regex::new(
            r"^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)"
        ).ok(),
        "rs" => regex_lite::Regex::new(
            r"^\s*(?:pub(?:\s*\(\s*crate\s*\))?\s+)?(?:unsafe\s+)?(?:async\s+)?fn\s+(\w+)|^\s*(?:pub\s+)?struct\s+(\w+)|^\s*(?:pub\s+)?enum\s+(\w+)|^\s*(?:pub\s+)?trait\s+(\w+)"
        ).ok(),
        _ => None,
    };
    let re = match boundary_re { Some(r) => r, None => return Vec::new() };

    let mut boundaries = Vec::new();
    for (line_idx, line) in lines.iter().enumerate() {
        if let Some(caps) = re.captures(line) {
            for group_idx in 1..=caps.len().saturating_sub(1) {
                if let Some(m) = caps.get(group_idx) {
                    let name = m.as_str().to_string();
                    let kind = if line.contains("class ") { "class" }
                        else if line.contains("struct ") { "struct" }
                        else if line.contains("enum ") { "enum" }
                        else if line.contains("trait ") { "trait" }
                        else { "function" };
                    boundaries.push((line_idx, name, kind.to_string(), is_exported(line, ext)));
                    break;
                }
            }
        }
    }
    boundaries
}

// ── Tauri Command ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn compress_file_ast(
    file_path: String,
    query_keywords: Vec<String>,
    max_tokens: usize,
    state: State<ProjectRoot>,
    graph_state: State<CallGraphState>,
) -> Result<CompressedFileResult, String> {
    let root = get_project_root(&state)?;
    let validated = crate::validate_path_within_project(&file_path, &root)?;
    let content = std::fs::read_to_string(&validated)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let ext = file_path.rsplit('.').next().unwrap_or("").to_lowercase();
    let lines: Vec<&str> = content.lines().collect();
    let boundaries = detect_boundaries(&lines, &ext);

    if boundaries.is_empty() {
        return Ok(fallback_raw(&content, max_tokens));
    }

    // 1. Extract imports and type definitions (before first boundary)
    let first_boundary = boundaries[0].0;
    let mut import_lines = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if i >= first_boundary { break; }
        if is_import_line(line, &ext) || is_type_definition_line(line, &ext) {
            import_lines.push(*line);
        }
    }
    let imports_text = import_lines.join("\n");
    // Cap imports at 50% of budget
    let imports_budget = max_tokens / 2;
    let final_imports = if estimate_tokens(&imports_text) > imports_budget {
        imports_text.chars().take(imports_budget * 4).collect::<String>()
    } else {
        imports_text
    };
    let final_imports_tokens = estimate_tokens(&final_imports);

    // 2. Build raw sections
    let keywords_lower: Vec<String> = query_keywords.iter().map(|k| k.to_lowercase()).collect();
    struct RawSection { name: String, kind: String, start_line: usize, end_line: usize, body: String, exported: bool }

    let mut raw_sections: Vec<RawSection> = Vec::new();
    for idx in 0..boundaries.len() {
        let (start, ref name, ref kind, exported) = boundaries[idx];
        let end = if idx + 1 < boundaries.len() { boundaries[idx + 1].0 } else { lines.len() };
        raw_sections.push(RawSection {
            name: name.clone(), kind: kind.clone(),
            start_line: start + 1, end_line: end,
            body: lines[start..end].join("\n"), exported,
        });
    }

    // 3. Rank 1: sections containing query keywords
    let mut rank1_names: HashSet<String> = HashSet::new();
    let mut ranked: Vec<(u8, usize)> = Vec::new();
    for (i, sec) in raw_sections.iter().enumerate() {
        let body_lower = sec.body.to_lowercase();
        if keywords_lower.iter().any(|kw| body_lower.contains(kw)) {
            rank1_names.insert(sec.name.to_lowercase());
            ranked.push((1, i));
        }
    }

    // Rank 2: within 2 call-chain levels of rank-1 functions
    let mut rank2_names: HashSet<String> = HashSet::new();
    if let Ok(graph) = graph_state.0.read() {
        for r1 in &rank1_names {
            // Level 1
            if let Some(edges) = graph.forward.get(r1) {
                for e in edges { let c = e.callee.to_lowercase(); if !rank1_names.contains(&c) { rank2_names.insert(c); } }
            }
            if let Some(edges) = graph.reverse.get(r1) {
                for e in edges { let c = e.caller.to_lowercase(); if !rank1_names.contains(&c) { rank2_names.insert(c); } }
            }
        }
        // Level 2
        let l1: Vec<String> = rank2_names.iter().cloned().collect();
        for name in &l1 {
            if let Some(edges) = graph.forward.get(name) {
                for e in edges { let c = e.callee.to_lowercase(); if !rank1_names.contains(&c) { rank2_names.insert(c); } }
            }
            if let Some(edges) = graph.reverse.get(name) {
                for e in edges { let c = e.caller.to_lowercase(); if !rank1_names.contains(&c) { rank2_names.insert(c); } }
            }
        }
    }
    for (i, sec) in raw_sections.iter().enumerate() {
        let n = sec.name.to_lowercase();
        if !rank1_names.contains(&n) && rank2_names.contains(&n) { ranked.push((2, i)); }
    }

    // Rank 3: remaining exported functions
    for (i, sec) in raw_sections.iter().enumerate() {
        let n = sec.name.to_lowercase();
        if !rank1_names.contains(&n) && !rank2_names.contains(&n) && sec.exported {
            ranked.push((3, i));
        }
    }

    ranked.sort_by_key(|(rank, _)| *rank);

    // 4. Fill sections until max_tokens
    let mut remaining = max_tokens.saturating_sub(final_imports_tokens);
    let mut included: Vec<CompressedSection> = Vec::new();
    for (rank, sec_idx) in &ranked {
        let sec = &raw_sections[*sec_idx];
        let tok = estimate_tokens(&sec.body);
        if tok > remaining { continue; }
        remaining -= tok;
        included.push(CompressedSection {
            content: sec.body.clone(), symbol_name: sec.name.clone(),
            kind: sec.kind.clone(), start_line: sec.start_line,
            end_line: sec.end_line, rank: *rank,
        });
    }

    // 5. Compute omitted ranges
    included.sort_by_key(|s| s.start_line);
    let mut omitted: Vec<OmittedRange> = Vec::new();
    if let Some(first) = included.first() {
        if first.start_line > first_boundary + 1 {
            omitted.push(OmittedRange { start_line: first_boundary + 1, end_line: first.start_line - 1 });
        }
    }
    for i in 1..included.len() {
        let prev_end = included[i - 1].end_line;
        let curr_start = included[i].start_line;
        if curr_start > prev_end + 1 {
            omitted.push(OmittedRange { start_line: prev_end + 1, end_line: curr_start - 1 });
        }
    }
    if let Some(last) = included.last() {
        if last.end_line < lines.len() {
            omitted.push(OmittedRange { start_line: last.end_line + 1, end_line: lines.len() });
        }
    }

    let total_tokens = final_imports_tokens + included.iter().map(|s| estimate_tokens(&s.content)).sum::<usize>();

    Ok(CompressedFileResult { sections: included, imports: final_imports, total_tokens, omitted_ranges: omitted, fallback_used: false })
}

/// Fallback: return first `max_tokens` of raw text when parsing fails.
fn fallback_raw(content: &str, max_tokens: usize) -> CompressedFileResult {
    let truncated: String = content.chars().take(max_tokens * 4).collect();
    let tokens = estimate_tokens(&truncated);
    CompressedFileResult {
        sections: vec![CompressedSection {
            content: truncated, symbol_name: String::new(), kind: "raw".to_string(),
            start_line: 1, end_line: content.lines().count(), rank: 0,
        }],
        imports: String::new(), total_tokens: tokens, omitted_ranges: Vec::new(), fallback_used: true,
    }
}
