use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use super::graph_builder::{DependencyGraph, DependencyViolation};

// ── Data Types ─────────────────────────────────────────────────────────────────

/// A single architecture rule definition.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchitectureRule {
    /// Rule identifier: "no_circular_dependencies", "ui_cannot_access_database", etc.
    pub id: String,
    /// Human-readable description of what the rule checks.
    pub description: String,
    /// Severity: "error" (blocks apply) or "warning" (advisory only).
    pub severity: String,
}

/// Configuration for the Architecture Guardrails Engine.
///
/// This is the equivalent of the YAML rules file, deserialized.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchitectureRules {
    pub rules: Vec<ArchitectureRule>,
    /// Optional layer definitions for rules like "services_cannot_import_components".
    /// Maps a layer name to a set of file path patterns (prefix matching).
    #[serde(default)]
    pub layers: HashMap<String, Vec<String>>,
}

/// Result of validating a set of changes against architecture rules.
#[derive(Serialize, Debug)]
pub struct ValidationResult {
    /// Whether the patch passes all error-level rules.
    pub allowed: bool,
    /// All violations found, both errors and warnings.
    pub violations: Vec<DependencyViolation>,
    /// Number of error-level violations.
    pub error_count: usize,
    /// Number of warning-level violations.
    pub warning_count: usize,
}

// ── Built-in Rules ─────────────────────────────────────────────────────────────

/// Built-in rule: detect circular dependencies in the dependency graph.
fn check_circular_dependencies(
    graph: &DependencyGraph,
    _layers: &HashMap<String, Vec<String>>,
) -> Vec<DependencyViolation> {
    let cycle_result = graph.detect_cycles();
    let mut violations = Vec::new();

    for cycle in &cycle_result.cycles {
        if cycle.len() <= 1 {
            continue;
        }
        violations.push(DependencyViolation {
            from_file: cycle[0].clone(),
            to_file: cycle.get(1).cloned().unwrap_or_default(),
            violation_type: "circular_dependency".to_string(),
            description: format!("Circular dependency detected: {}", cycle.join(" → ")),
        });
    }

    violations
}

/// Generic cross-layer rule: checks if any file in one layer imports from another layer.
fn check_cross_layer_access(
    graph: &DependencyGraph,
    layers: &HashMap<String, Vec<String>>,
    from_layer: &str,
    to_layer: &str,
    rule_id: &str,
) -> Vec<DependencyViolation> {
    let mut violations = Vec::new();

    let from_patterns = match layers.get(from_layer) {
        Some(p) => p,
        None => return violations,
    };
    let to_patterns = match layers.get(to_layer) {
        Some(p) => p,
        None => return violations,
    };

    for (from_file, deps) in &graph.forward {
        if !from_patterns.iter().any(|pat| from_file.starts_with(pat)) {
            continue;
        }
        for to_file in deps {
            if to_patterns.iter().any(|pat| to_file.starts_with(pat)) {
                violations.push(DependencyViolation {
                    from_file: from_file.clone(),
                    to_file: to_file.clone(),
                    violation_type: rule_id.to_string(),
                    description: format!(
                        "Layer violation: file in '{}' ({}) cannot import from '{}' ({})",
                        from_layer, from_file, to_layer, to_file
                    ),
                });
            }
        }
    }

    violations
}

/// Parse rule ID into `(from_layer, to_layer)` using naming conventions.
fn parse_layer_rule(rule_id: &str) -> Option<(String, String)> {
    let stripped = rule_id.strip_prefix("no_").unwrap_or(rule_id);

    if let Some(rest) = stripped.strip_suffix("_cannot_access_database") {
        return Some((rest.to_string(), "database".to_string()));
    }
    if let Some(rest) = stripped.strip_suffix("_cannot_import_components") {
        return Some((rest.to_string(), "components".to_string()));
    }
    if stripped.ends_with("_handle_db_only") {
        return Some(("_all".to_string(), "database".to_string()));
    }
    if let Some(rest) = stripped.strip_suffix("_cannot_import_infrastructure") {
        return Some((rest.to_string(), "infrastructure".to_string()));
    }

    // Generic: "{from}_cannot_import_{to}"
    if let Some(cannot_pos) = stripped.find("_cannot_import_") {
        let from = &stripped[..cannot_pos];
        let to = &stripped[cannot_pos + "_cannot_import_".len()..];
        if !from.is_empty() && !to.is_empty() {
            return Some((from.to_string(), to.to_string()));
        }
    }

    None
}

// ── Rule Execution ─────────────────────────────────────────────────────────────

/// Run all rules from the architecture configuration against the dependency graph.
pub fn validate_rules(
    rules_config: &ArchitectureRules,
    graph: &DependencyGraph,
) -> ValidationResult {
    let mut all_violations = Vec::new();
    let mut error_count = 0usize;
    let mut warning_count = 0usize;

    for rule in &rules_config.rules {
        let rule_violations = match rule.id.as_str() {
            "no_circular_dependencies" => {
                check_circular_dependencies(graph, &rules_config.layers)
            }
            _ => {
                if let Some((from_layer, to_layer)) = parse_layer_rule(&rule.id) {
                    if from_layer == "_all" {
                        let mut violations = check_cross_layer_access(
                            graph, &rules_config.layers, "repositories", &to_layer, &rule.id,
                        );
                        for (layer_name, _) in &rules_config.layers {
                            if layer_name != "repositories" {
                                violations.extend(check_cross_layer_access(
                                    graph, &rules_config.layers, layer_name, &to_layer, &rule.id,
                                ));
                            }
                        }
                        violations
                    } else {
                        check_cross_layer_access(
                            graph, &rules_config.layers, &from_layer, &to_layer, &rule.id,
                        )
                    }
                } else {
                    Vec::new()
                }
            }
        };

        let is_error = rule.severity == "error";
        for v in rule_violations {
            if is_error {
                error_count += 1;
            } else {
                warning_count += 1;
            }
            all_violations.push(v);
        }
    }

    ValidationResult {
        allowed: error_count == 0,
        violations: all_violations,
        error_count,
        warning_count,
    }
}

// ── Helper: re-analyze deps for specific files (without Tauri State) ───────────

fn analyze_deps_for_files(
    file_paths: &[String],
    project_root: &str,
) -> Result<super::dependency_analyzer::DependencyAnalysisResult, String> {
    use std::fs;
    use std::path::Path;

    let mut edges = Vec::new();
    let mut parse_errors = Vec::new();

    for file_path in file_paths {
        let full_path = Path::new(project_root).join(file_path);
        let ext = full_path.extension().and_then(|e| e.to_str()).unwrap_or("");

        if !super::dependency_analyzer::should_analyze(&full_path) {
            continue;
        }

        let content = match fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(err) => {
                parse_errors.push(format!("Failed to read {}: {}", file_path, err));
                continue;
            }
        };

        edges.extend(super::dependency_analyzer::parse_imports(&content, file_path, ext));
    }

    Ok(super::dependency_analyzer::DependencyAnalysisResult {
        edges,
        file_count: file_paths.len(),
        parse_errors,
    })
}

/// Validate AI-proposed changes against architecture rules.
///
/// This is the core function called before `apply_patch` executes.
pub fn validate_proposed_changes(
    rules_config: &ArchitectureRules,
    changed_files: &[String],
    project_root: &str,
) -> Result<ValidationResult, String> {
    let analysis = analyze_deps_for_files(changed_files, project_root)?;
    let graph = DependencyGraph::build_from_edges(&analysis.edges);
    Ok(validate_rules(rules_config, &graph))
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

/// Validate the current project against a set of architecture rules.
#[tauri::command]
pub fn validate_architecture(
    rules_json: String,
    state: State<crate::ProjectRoot>,
) -> Result<ValidationResult, String> {
    let rules_config: ArchitectureRules =
        serde_json::from_str(&rules_json).map_err(|e| format!("Invalid rules JSON: {}", e))?;
    let root = crate::get_project_root(&state)?;

    let deps = super::dependency_analyzer::analyze_all_files(&root);
    let graph = DependencyGraph::build_from_edges(&deps.edges);

    Ok(validate_rules(&rules_config, &graph))
}

/// Validate proposed file changes against architecture rules.
///
/// Called by the frontend before executing `apply_patch`.
#[tauri::command]
pub fn validate_patch_against_rules(
    rules_json: String,
    changed_files: Vec<String>,
    state: State<crate::ProjectRoot>,
) -> Result<ValidationResult, String> {
    let rules_config: ArchitectureRules =
        serde_json::from_str(&rules_json).map_err(|e| format!("Invalid rules JSON: {}", e))?;
    let root = crate::get_project_root(&state)?;
    validate_proposed_changes(&rules_config, &changed_files, &root)
}

/// Get the default/recommended architecture rules for a typical React+Tauri project.
#[tauri::command]
pub fn get_default_rules() -> ArchitectureRules {
    ArchitectureRules {
        rules: vec![
            ArchitectureRule {
                id: "no_circular_dependencies".to_string(),
                description: "Detect and prevent circular imports between files".to_string(),
                severity: "error".to_string(),
            },
            ArchitectureRule {
                id: "ui_cannot_access_database".to_string(),
                description: "UI components must not import database modules".to_string(),
                severity: "error".to_string(),
            },
            ArchitectureRule {
                id: "services_cannot_import_components".to_string(),
                description: "Service layer must not import UI components".to_string(),
                severity: "error".to_string(),
            },
            ArchitectureRule {
                id: "repositories_handle_db_only".to_string(),
                description: "Only repository layer should access database modules".to_string(),
                severity: "warning".to_string(),
            },
        ],
        layers: {
            let mut m = HashMap::new();
            m.insert("ui".to_string(), vec!["src/components/".to_string(), "src/pages/".to_string(), "src/views/".to_string()]);
            m.insert("services".to_string(), vec!["src/services/".to_string(), "src/api/".to_string()]);
            m.insert("repositories".to_string(), vec!["src/repositories/".to_string(), "src/database/".to_string(), "src/data/".to_string()]);
            m.insert("database".to_string(), vec!["src/database/".to_string(), "src/models/".to_string(), "src/schema/".to_string()]);
            m.insert("components".to_string(), vec!["src/components/".to_string()]);
            m.insert("infrastructure".to_string(), vec!["src-tauri/src/".to_string(), "src/lib/".to_string()]);
            m
        },
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::dependency_analyzer::DependencyEdge;

    fn make_edge(from: &str, to: &str, is_external: bool) -> DependencyEdge {
        DependencyEdge {
            from_file: from.to_string(),
            to_module: to.to_string(),
            import_kind: "es6_import".to_string(),
            is_external,
        }
    }

    fn default_layers() -> HashMap<String, Vec<String>> {
        let mut m = HashMap::new();
        m.insert("ui".to_string(), vec!["src/components/".to_string()]);
        m.insert("services".to_string(), vec!["src/services/".to_string()]);
        m.insert("database".to_string(), vec!["src/database/".to_string()]);
        m.insert("repositories".to_string(), vec!["src/repositories/".to_string()]);
        m.insert("components".to_string(), vec!["src/components/".to_string()]);
        m
    }

    fn default_rules_config() -> ArchitectureRules {
        ArchitectureRules {
            rules: vec![
                ArchitectureRule { id: "no_circular_dependencies".to_string(), description: "No circular deps".to_string(), severity: "error".to_string() },
                ArchitectureRule { id: "ui_cannot_access_database".to_string(), description: "UI cannot access DB".to_string(), severity: "error".to_string() },
                ArchitectureRule { id: "services_cannot_import_components".to_string(), description: "Services cannot import components".to_string(), severity: "error".to_string() },
            ],
            layers: default_layers(),
        }
    }

    #[test]
    fn test_circular_dependency_detected() {
        let edges = vec![make_edge("a.ts", "b.ts", false), make_edge("b.ts", "a.ts", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let config = default_rules_config();
        let result = validate_rules(&config, &graph);
        assert!(!result.allowed);
        assert!(result.error_count >= 1);
        assert!(result.violations.iter().any(|v| v.violation_type == "circular_dependency"));
    }

    #[test]
    fn test_no_circular_dependency_passes() {
        let edges = vec![make_edge("a.ts", "b.ts", false), make_edge("b.ts", "c.ts", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let config = default_rules_config();
        let result = validate_rules(&config, &graph);
        assert!(!result.violations.iter().any(|v| v.violation_type == "circular_dependency"));
    }

    #[test]
    fn test_ui_cannot_access_database_violation() {
        let edges = vec![make_edge("src/components/Button.tsx", "src/database/query.ts", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let config = default_rules_config();
        let result = validate_rules(&config, &graph);
        assert!(!result.allowed);
        assert!(result.violations.iter().any(|v| v.violation_type == "ui_cannot_access_database"));
    }

    #[test]
    fn test_ui_cannot_access_database_passes() {
        let edges = vec![make_edge("src/components/Button.tsx", "src/services/api.ts", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let config = default_rules_config();
        let result = validate_rules(&config, &graph);
        assert!(!result.violations.iter().any(|v| v.violation_type == "ui_cannot_access_database"));
    }

    #[test]
    fn test_services_cannot_import_components_violation() {
        let edges = vec![make_edge("src/services/api.ts", "src/components/Button.tsx", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let config = default_rules_config();
        let result = validate_rules(&config, &graph);
        assert!(!result.allowed);
        assert!(result.violations.iter().any(|v| v.violation_type == "services_cannot_import_components"));
    }

    #[test]
    fn test_warning_only_passes_allowed() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule { id: "no_circular_dependencies".to_string(), description: "Check circular deps".to_string(), severity: "warning".to_string() }],
            layers: default_layers(),
        };
        let edges = vec![make_edge("a.ts", "b.ts", false), make_edge("b.ts", "a.ts", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(result.allowed);
        assert_eq!(result.warning_count, 1);
        assert_eq!(result.error_count, 0);
    }

    #[test]
    fn test_parse_layer_rule() {
        assert_eq!(parse_layer_rule("ui_cannot_access_database"), Some(("ui".to_string(), "database".to_string())));
        assert_eq!(parse_layer_rule("services_cannot_import_components"), Some(("services".to_string(), "components".to_string())));
        assert_eq!(parse_layer_rule("repositories_handle_db_only"), Some(("_all".to_string(), "database".to_string())));
        assert_eq!(parse_layer_rule("no_circular_dependencies"), None);
    }

    #[test]
    fn test_empty_rules_passes() {
        let config = ArchitectureRules { rules: vec![], layers: default_layers() };
        let edges = vec![make_edge("src/components/Button.tsx", "src/database/query.ts", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(result.allowed);
        assert!(result.violations.is_empty());
    }
}