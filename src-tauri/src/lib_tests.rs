// =====================================================================
// Rust Unit Tests for PunamIDE core algorithms
// Included via #[cfg(test)] mod lib_tests; in lib.rs
// =====================================================================

use super::*;
use super::index_commands::*;
use super::search_commands::search_directory;
use super::terminal_commands::uuid_simple;

// --- tokenize_code ---

#[test]
fn test_tokenize_code_basic() {
    let tokens = tokenize_code("function hello_world() { return abc123; }");
    assert!(tokens.contains(&"hello_world".to_string()));
    assert!(tokens.contains(&"abc123".to_string()));
    // Stop words should be filtered
    assert!(!tokens.contains(&"function".to_string()));
    assert!(!tokens.contains(&"return".to_string()));
}

#[test]
fn test_tokenize_code_empty() {
    let tokens = tokenize_code("");
    assert!(tokens.is_empty());
}

#[test]
fn test_tokenize_code_stop_words_filtered() {
    let tokens = tokenize_code("const let var function return class import export");
    // All are stop words
    assert!(tokens.is_empty());
}

#[test]
fn test_tokenize_code_short_tokens_filtered() {
    let tokens = tokenize_code("a bc def");
    // "a" is 1 char, "bc" is 2 chars — both filtered (<3)
    // "def" is 3 chars — kept
    assert_eq!(tokens, vec!["def".to_string()]);
}

// --- is_stop_word ---

#[test]
fn test_is_stop_word_true() {
    assert!(is_stop_word("function"));
    assert!(is_stop_word("return"));
    assert!(is_stop_word("const"));
    assert!(is_stop_word("let"));
    assert!(is_stop_word("class"));
}

#[test]
fn test_is_stop_word_false() {
    assert!(!is_stop_word("user"));
    assert!(!is_stop_word("database"));
    assert!(!is_stop_word("render"));
}

// --- levenshtein ---

#[test]
fn test_levenshtein_identical() {
    assert_eq!(levenshtein("hello", "hello"), 0);
}

#[test]
fn test_levenshtein_one_substitution() {
    assert_eq!(levenshtein("hello", "hallo"), 1);
}

#[test]
fn test_levenshtein_empty() {
    assert_eq!(levenshtein("", "abc"), 3);
    assert_eq!(levenshtein("abc", ""), 3);
    assert_eq!(levenshtein("", ""), 0);
}

#[test]
fn test_levenshtein_known_distances() {
    // "kitten" → "sitting" = 3
    assert_eq!(levenshtein("kitten", "sitting"), 3);
    // "saturday" → "sunday" = 3
    assert_eq!(levenshtein("saturday", "sunday"), 3);
}

// --- char_similarity ---

#[test]
fn test_char_similarity_identical() {
    let sim = char_similarity("hello", "hello");
    assert!((sim - 1.0).abs() < 0.001);
}

#[test]
fn test_char_similarity_completely_different() {
    let sim = char_similarity("abc", "xyz");
    assert!((sim - 0.0).abs() < 0.001);
}

#[test]
fn test_char_similarity_empty() {
    assert!((char_similarity("", "") - 1.0).abs() < 0.001);
    assert!((char_similarity("a", "") - 0.0).abs() < 0.001);
    assert!((char_similarity("", "b") - 0.0).abs() < 0.001);
}

// --- line_similarity ---

#[test]
fn test_line_similarity_identical_lists() {
    let a = &["hello", "world"];
    let b = &["hello", "world"];
    let sim = line_similarity(a, b);
    assert!((sim - 1.0).abs() < 0.001);
}

#[test]
fn test_line_similarity_different_lengths() {
    let a = &["hello"];
    let b = &["hello", "world"];
    assert!((line_similarity(a, b) - 0.0).abs() < 0.001);
}

#[test]
fn test_line_similarity_empty() {
    assert!((line_similarity(&[], &[]) - 1.0).abs() < 0.001);
}

// --- fuzzy_find_block ---

#[test]
fn test_fuzzy_find_exact_match() {
    let content = "line1\nline2\nline3\nline4\nline5";
    let search = "line2\nline3";
    let result = fuzzy_find_block(content.to_string(), search.to_string(), 0.8).unwrap();
    assert!(result.matched);
    assert_eq!(result.start_line, 1);
    assert_eq!(result.end_line, 3);
}

#[test]
fn test_fuzzy_find_no_match() {
    let content = "aaaa\nbbbb\ncccc";
    let search = "xxxx\nyyyy";
    let result = fuzzy_find_block(content.to_string(), search.to_string(), 0.8).unwrap();
    assert!(!result.matched);
}

#[test]
fn test_fuzzy_find_empty_search() {
    let result = fuzzy_find_block("test".to_string(), "".to_string(), 0.5).unwrap();
    assert!(!result.matched);
}

// --- diff_strings ---

#[test]
fn test_diff_identical() {
    let result = diff_strings("hello\nworld".to_string(), "hello\nworld".to_string());
    assert_eq!(result.additions, 0);
    assert_eq!(result.deletions, 0);
    assert!(result.hunks.is_empty());
}

#[test]
fn test_diff_one_line_added() {
    let old = "line1\nline2";
    let new = "line1\ninserted\nline2";
    let result = diff_strings(old.to_string(), new.to_string());
    assert_eq!(result.additions, 1);
    assert_eq!(result.deletions, 0);
}

#[test]
fn test_diff_one_line_removed() {
    let old = "line1\nremoved\nline2";
    let new = "line1\nline2";
    let result = diff_strings(old.to_string(), new.to_string());
    assert_eq!(result.deletions, 1);
    assert_eq!(result.additions, 0);
}

#[test]
fn test_diff_completely_different() {
    let result = diff_strings("old".to_string(), "new".to_string());
    assert!(result.additions + result.deletions > 0);
}

#[test]
fn test_diff_empty_strings() {
    let result = diff_strings("".to_string(), "".to_string());
    assert_eq!(result.additions, 0);
    assert_eq!(result.deletions, 0);
}

// --- validate_path_within_project ---

#[test]
fn test_validate_path_within_project_valid_subpath() {
    let root = std::env::temp_dir().to_string_lossy().to_string();
    let path = std::path::Path::new(&root).join("test_subdir_punam");
    let result = validate_path_within_project(&path.to_string_lossy(), &root);
    // Ancestor exists (temp_dir) and is within root, so this validates
    assert!(result.is_ok());
}

#[test]
fn test_validate_path_within_project_outside_path() {
    let root = std::env::temp_dir().to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    let outside = "C:\\Windows\\System32";
    #[cfg(not(target_os = "windows"))]
    let outside = "/etc";
    let result = validate_path_within_project(outside, &root);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("outside"));
}

// --- search_directory ---

#[test]
fn test_search_exists_in_content() {
    let temp = std::env::temp_dir().join("punam_test_search");
    let _ = std::fs::create_dir_all(&temp);
    let file_path = temp.join("test.txt");
    std::fs::write(&file_path, "hello world\nfoo bar\nhello again").unwrap();

    let mut results: Vec<SearchResult> = Vec::new();
    let root_str = temp.to_string_lossy().to_string();
    let _ = search_directory(&temp, &root_str, "hello", &mut results, 0, &None, &None);

    assert_eq!(results.len(), 2);
    assert_eq!(results[0].line, 1);
    assert!(results[0].preview.contains("hello"));

    let _ = std::fs::remove_dir_all(&temp);
}

// --- index_directory ---

#[test]
fn test_index_directory_collects_files() {
    let temp = std::env::temp_dir().join("punam_test_index");
    let _ = std::fs::create_dir_all(&temp);
    std::fs::write(temp.join("readme.md"), "# Test").unwrap();
    std::fs::write(temp.join("config.json"), "{}").unwrap();

    let mut entries: Vec<FileIndexEntry> = Vec::new();
    index_directory(&temp, &temp, &mut entries, 0);

    assert_eq!(entries.len(), 2);
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert!(paths.iter().any(|p| p.contains("readme.md")));
    assert!(paths.iter().any(|p| p.contains("config.json")));

    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn test_index_directory_marks_binary() {
    let temp = std::env::temp_dir().join("punam_test_binary");
    let _ = std::fs::create_dir_all(&temp);
    std::fs::write(temp.join("image.png"), "fake png data").unwrap();

    let mut entries: Vec<FileIndexEntry> = Vec::new();
    index_directory(&temp, &temp, &mut entries, 0);

    assert_eq!(entries.len(), 1);
    assert!(entries[0].is_binary);

    let _ = std::fs::remove_dir_all(&temp);
}

// --- uuid_simple ---

#[test]
fn test_uuid_simple_is_nonempty() {
    let id = uuid_simple();
    assert!(!id.is_empty());
    assert!(id.len() >= 8);
}

#[test]
fn test_uuid_simple_is_unique() {
    let id1 = uuid_simple();
    std::thread::sleep(std::time::Duration::from_micros(10));
    let id2 = uuid_simple();
    assert_ne!(id1, id2);
}

// --- SKIP_DIRS / SKIP_FILES ---

#[test]
fn test_skip_dirs_contains_common() {
    assert!(SKIP_DIRS.contains(&"node_modules"));
    assert!(SKIP_DIRS.contains(&".git"));
    assert!(SKIP_DIRS.contains(&"target"));
    assert!(SKIP_DIRS.contains(&"dist"));
}

#[test]
fn test_skip_files_contains_lockfiles() {
    assert!(SKIP_FILES.contains(&"package-lock.json"));
    assert!(SKIP_FILES.contains(&"yarn.lock"));
    assert!(SKIP_FILES.contains(&"Cargo.lock"));
}