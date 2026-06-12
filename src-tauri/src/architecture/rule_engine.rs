use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use super::graph_builder::{DependencyGraph, DependencyViolation};

// ── Data Types ─────────────────────────────────────────────────────────────────

/// A custom rule predicate — enables rules beyond the built-in naming conventions.
///
/// Supported types:
///   - "forbidden_import":     { "from_layer": "X", "to_layer": "Y" }
///   - "allowed_import":       { "from_layer": "X", "to_layer": "Y" }
///   - "must_have_test":       { "target_layer": "X", "test_pattern": "*.test.ts" }
///   - "max_dependents":       { "target_layer": "X", "max_count": 15 }
///   - "forbidden_file_import": { "from_file": "src/utils/auth.ts", "to_layer": "X" }
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CustomRule {
    #[serde(rename = "type")]
    pub predicate_type: String,
    #[serde(default)]
    pub from_layer: Option<String>,
    #[serde(default)]
    pub from_file: Option<String>,
    #[serde(default)]
    pub to_layer: Option<String>,
    #[serde(default)]
    pub to_file: Option<String>,
    #[serde(default)]
    pub test_pattern: Option<String>,
    #[serde(default)]
    pub max_count: Option<usize>,
}

/// A single architecture rule definition.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchitectureRule {
    pub id: String,
    pub description: String,
    pub severity: String,
    #[serde(default)]
    pub custom: Option<CustomRule>,
}

/// Configuration for the Architecture Guardrails Engine.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ArchitectureRules {
    pub rules: Vec<ArchitectureRule>,
    #[serde(default)]
    pub layers: HashMap<String, Vec<String>>,
}

/// Result of validating a set of changes against architecture rules.
#[derive(Serialize, Debug)]
pub struct ValidationResult {
    pub allowed: bool,
    pub violations: Vec<DependencyViolation>,
    pub error_count: usize,
    pub warning_count: usize,
}

// ── Built-in Rules ─────────────────────────────────────────────────────────────

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

    if let Some(cannot_pos) = stripped.find("_cannot_import_") {
        let from = &stripped[..cannot_pos];
        let to = &stripped[cannot_pos + "_cannot_import_".len()..];
        if !from.is_empty() && !to.is_empty() {
            return Some((from.to_string(), to.to_string()));
        }
    }

    if let Some(can_pos) = stripped.find("_can_import_") {
        let from = &stripped[..can_pos];
        let to = &stripped[can_pos + "_can_import_".len()..];
        if !from.is_empty() && !to.is_empty() {
            return Some((from.to_string(), to.to_string()));
        }
    }

    None
}

// ── Custom Rule Evaluation ─────────────────────────────────────────────────────

fn evaluate_custom_rule(
    custom: &CustomRule,
    layers: &HashMap<String, Vec<String>>,
    graph: &DependencyGraph,
    rule_id: &str,
) -> Vec<DependencyViolation> {
    match custom.predicate_type.as_str() {
        "forbidden_import" => {
            let from_layer = match &custom.from_layer {
                Some(l) => l,
                None => return Vec::new(),
            };
            let to_layer = match &custom.to_layer {
                Some(l) => l,
                None => return Vec::new(),
            };
            check_cross_layer_access(graph, layers, from_layer, to_layer, rule_id)
        }

        "allowed_import" => {
            Vec::new()
        }

        "must_have_test" => {
            let target_layer = match &custom.to_layer {
                Some(l) => l,
                None => return Vec::new(),
            };
            let test_pattern = match &custom.test_pattern {
                Some(p) => p.clone(),
                None => "*.test.*".to_string(),
            };

            let layer_patterns = match layers.get(target_layer) {
                Some(p) => p,
                None => return Vec::new(),
            };

            let mut violations = Vec::new();

            for file in &graph.files {
                if !layer_patterns.iter().any(|pat| file.starts_with(pat)) {
                    continue;
                }
                if file.contains(".test.") || file.contains(".spec.") {
                    continue;
                }

                let has_test = match graph.reverse.get(file) {
                    Some(dependents) => dependents.iter().any(|dep| {
                        simple_glob_match(dep, &test_pattern)
                            || (!test_pattern.contains('*') && dep.ends_with(&test_pattern))
                    }),
                    None => false,
                };

                if !has_test {
                    violations.push(DependencyViolation {
                        from_file: file.clone(),
                        to_file: String::new(),
                        violation_type: rule_id.to_string(),
                        description: format!(
                            "Missing test: file '{}' in layer '{}' has no matching test file (pattern: {})",
                            file, target_layer, test_pattern
                        ),
                    });
                }
            }

            violations
        }

        "max_dependents" => {
            let target_layer = match &custom.to_layer {
                Some(l) => l,
                None => return Vec::new(),
            };
            let max_count = custom.max_count.unwrap_or(15);

            let layer_patterns = match layers.get(target_layer) {
                Some(p) => p,
                None => return Vec::new(),
            };

            let mut violations = Vec::new();

            for file in &graph.files {
                if !layer_patterns.iter().any(|pat| file.starts_with(pat)) {
                    continue;
                }

                let dep_count = match graph.reverse.get(file) {
                    Some(deps) => deps.len(),
                    None => 0,
                };

                if dep_count > max_count {
                    violations.push(DependencyViolation {
                        from_file: file.clone(),
                        to_file: String::new(),
                        violation_type: rule_id.to_string(),
                        description: format!(
                            "Max dependents exceeded: '{}' has {} dependents (max: {}) — consider splitting",
                            file, dep_count, max_count
                        ),
                    });
                }
            }

            violations
        }

        "forbidden_file_import" => {
            let from_file = match &custom.from_file {
                Some(f) => f,
                None => return Vec::new(),
            };
            let to_layer = match &custom.to_layer {
                Some(l) => l,
                None => return Vec::new(),
            };
            let to_patterns = match layers.get(to_layer) {
                Some(p) => p,
                None => return Vec::new(),
            };

            let mut violations = Vec::new();

            if let Some(deps) = graph.forward.get(from_file) {
                for to_file in deps {
                    if to_patterns.iter().any(|pat| to_file.starts_with(pat)) {
                        violations.push(DependencyViolation {
                            from_file: from_file.clone(),
                            to_file: to_file.clone(),
                            violation_type: rule_id.to_string(),
                            description: format!(
                                "Forbidden import: '{}' imports '{}' which belongs to layer '{}'",
                                from_file, to_file, to_layer
                            ),
                        });
                    }
                }
            }

            violations
        }

        _ => {
            Vec::new()
        }
    }
}

fn simple_glob_match(path: &str, pattern: &str) -> bool {
    let pattern = pattern.replace("**", "___DOUBLESTAR___");
    let pattern = pattern.replace('*', "[^/]*");
    let pattern = pattern.replace("___DOUBLESTAR___", ".*");
    let regex = match regex_lite::Regex::new(&format!("^{}$", pattern)) {
        Ok(r) => r,
        Err(_) => return false,
    };
    regex.is_match(path)
}

// ── Rule Execution ─────────────────────────────────────────────────────────────

pub fn validate_rules(
    rules_config: &ArchitectureRules,
    graph: &DependencyGraph,
) -> ValidationResult {
    let mut all_violations = Vec::new();
    let mut error_count = 0usize;
    let mut warning_count = 0usize;

    for rule in &rules_config.rules {
        let rule_violations = if let Some(ref custom) = rule.custom {
            evaluate_custom_rule(custom, &rules_config.layers, graph, &rule.id)
        } else {
            match rule.id.as_str() {
                "no_circular_dependencies" => {
                    check_circular_dependencies(graph, &rules_config.layers)
                }
                _ => {
                    if let Some((from_layer, to_layer)) = parse_layer_rule(&rule.id) {
                        // "_can_import_" rules are allowlists — they don't generate violations.
                        // Only "_cannot_import_" and other deny rules produce violations.
                        if rule.id.contains("_can_import_") {
                            Vec::new()
                        } else if from_layer == "_all" {
                            // "repositories_handle_db_only" — flag all layers EXCEPT
                            // repositories importing from the target (database) layer
                            let mut violations = Vec::new();
                            for (layer_name, _) in &rules_config.layers {
                                if layer_name == "repositories" || layer_name == &to_layer {
                                    continue; // repositories IS allowed to access database
                                }
                                violations.extend(check_cross_layer_access(
                                    graph, &rules_config.layers, layer_name, &to_layer, &rule.id,
                                ));
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

// ── Helper ─────────────────────────────────────────────────────────────────────

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

#[tauri::command]
pub fn get_default_rules() -> ArchitectureRules {
    ArchitectureRules {
        rules: vec![
            ArchitectureRule {
                id: "no_circular_dependencies".to_string(),
                description: "Detect and prevent circular imports between files".to_string(),
                severity: "error".to_string(),
                custom: None,
            },
            ArchitectureRule {
                id: "ui_cannot_access_database".to_string(),
                description: "UI components must not import database modules".to_string(),
                severity: "error".to_string(),
                custom: None,
            },
            ArchitectureRule {
                id: "services_cannot_import_ui".to_string(),
                description: "Service layer must not import UI components".to_string(),
                severity: "error".to_string(),
                custom: None,
            },
            ArchitectureRule {
                id: "repositories_handle_db_only".to_string(),
                description: "Only repository layer should access database modules".to_string(),
                severity: "warning".to_string(),
                custom: None,
            },
        ],
        layers: {
            let mut m = HashMap::new();
            m.insert("ui".to_string(), vec!["src/components/".to_string(), "src/pages/".to_string(), "src/views/".to_string()]);
            m.insert("services".to_string(), vec!["src/services/".to_string(), "src/api/".to_string()]);
            m.insert("repositories".to_string(), vec!["src/repositories/".to_string(), "src/data/".to_string()]);
            m.insert("database".to_string(), vec!["src/database/".to_string(), "src/models/".to_string(), "src/schema/".to_string()]);
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
        m.insert("ui".to_string(), vec!["src/components/".to_string(), "src/pages/".to_string(), "src/views/".to_string()]);
        m.insert("services".to_string(), vec!["src/services/".to_string()]);
        m.insert("database".to_string(), vec!["src/database/".to_string()]);
        m.insert("repositories".to_string(), vec!["src/repositories/".to_string()]);
        m
    }

    fn default_rules_config() -> ArchitectureRules {
        ArchitectureRules {
            rules: vec![
                ArchitectureRule { id: "no_circular_dependencies".to_string(), description: "No circular deps".to_string(), severity: "error".to_string(), custom: None },
                ArchitectureRule { id: "ui_cannot_access_database".to_string(), description: "UI cannot access DB".to_string(), severity: "error".to_string(), custom: None },
                ArchitectureRule { id: "services_cannot_import_ui".to_string(), description: "Services cannot import components".to_string(), severity: "error".to_string(), custom: None },
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
        assert!(result.violations.iter().any(|v| v.violation_type == "services_cannot_import_ui"));
    }

    #[test]
    fn test_warning_only_passes_allowed() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule { id: "no_circular_dependencies".to_string(), description: "Check circular deps".to_string(), severity: "warning".to_string(), custom: None }],
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

    // ── Custom Rule Tests ──────────────────────────────────────────────────

    #[test]
    fn test_custom_forbidden_import() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule {
                id: "custom_rule_1".to_string(),
                description: "UI cannot import database".to_string(),
                severity: "error".to_string(),
                custom: Some(CustomRule {
                    predicate_type: "forbidden_import".to_string(),
                    from_layer: Some("ui".to_string()),
                    to_layer: Some("database".to_string()),
                    from_file: None,
                    to_file: None,
                    test_pattern: None,
                    max_count: None,
                }),
            }],
            layers: default_layers(),
        };
        let edges = vec![make_edge("src/components/Button.tsx", "src/database/query.ts", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(!result.allowed);
        assert_eq!(result.error_count, 1);
    }

    #[test]
    fn test_custom_allowed_import_no_violation() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule {
                id: "custom_allowed".to_string(),
                description: "Services CAN import repositories".to_string(),
                severity: "warning".to_string(),
                custom: Some(CustomRule {
                    predicate_type: "allowed_import".to_string(),
                    from_layer: Some("services".to_string()),
                    to_layer: Some("repositories".to_string()),
                    from_file: None,
                    to_file: None,
                    test_pattern: None,
                    max_count: None,
                }),
            }],
            layers: default_layers(),
        };
        let edges = vec![make_edge("src/services/api.ts", "src/repositories/userRepo.ts", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(result.allowed);
        assert_eq!(result.violations.len(), 0);
    }

    #[test]
    fn test_custom_must_have_test_violation() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule {
                id: "require_tests".to_string(),
                description: "Services must have test files".to_string(),
                severity: "error".to_string(),
                custom: Some(CustomRule {
                    predicate_type: "must_have_test".to_string(),
                    from_layer: None,
                    to_layer: Some("services".to_string()),
                    from_file: None,
                    to_file: None,
                    test_pattern: Some("test.ts".to_string()),
                    max_count: None,
                }),
            }],
            layers: default_layers(),
        };
        let edges = vec![
            make_edge("src/services/api.ts", "src/lib/utils.ts", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(!result.allowed);
        assert!(result.violations.iter().any(|v| v.violation_type == "require_tests"));
    }

    #[test]
    fn test_custom_must_have_test_passes() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule {
                id: "require_tests".to_string(),
                description: "Services must have test files".to_string(),
                severity: "error".to_string(),
                custom: Some(CustomRule {
                    predicate_type: "must_have_test".to_string(),
                    from_layer: None,
                    to_layer: Some("services".to_string()),
                    from_file: None,
                    to_file: None,
                    test_pattern: Some("test.ts".to_string()),
                    max_count: None,
                }),
            }],
            layers: default_layers(),
        };
        let edges = vec![
            make_edge("src/services/api.test.ts", "src/services/api.ts", false),
            make_edge("src/services/api.ts", "src/lib/utils.ts", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(result.allowed);
    }

    #[test]
    fn test_custom_max_dependents_violation() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule {
                id: "max_deps".to_string(),
                description: "Component files should not have too many dependents".to_string(),
                severity: "warning".to_string(),
                custom: Some(CustomRule {
                    predicate_type: "max_dependents".to_string(),
                    from_layer: None,
                    to_layer: Some("ui".to_string()),
                    from_file: None,
                    to_file: None,
                    test_pattern: None,
                    max_count: Some(2),
                }),
            }],
            layers: default_layers(),
        };
        let edges = vec![
            make_edge("src/pages/Home.tsx", "src/components/Button.tsx", false),
            make_edge("src/pages/About.tsx", "src/components/Button.tsx", false),
            make_edge("src/pages/Contact.tsx", "src/components/Button.tsx", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(result.violations.iter().any(|v| v.violation_type == "max_deps"));
    }

    #[test]
    fn test_custom_max_dependents_passes() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule {
                id: "max_deps".to_string(),
                description: "Component files should not have too many dependents".to_string(),
                severity: "error".to_string(),
                custom: Some(CustomRule {
                    predicate_type: "max_dependents".to_string(),
                    from_layer: None,
                    to_layer: Some("ui".to_string()),
                    from_file: None,
                    to_file: None,
                    test_pattern: None,
                    max_count: Some(5),
                }),
            }],
            layers: default_layers(),
        };
        let edges = vec![
            make_edge("src/pages/Home.tsx", "src/components/Button.tsx", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(result.allowed);
    }

    #[test]
    fn test_custom_forbidden_file_import() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule {
                id: "no_auth_in_ui".to_string(),
                description: "auth.ts must not be imported by UI components".to_string(),
                severity: "error".to_string(),
                custom: Some(CustomRule {
                    predicate_type: "forbidden_file_import".to_string(),
                    from_layer: None,
                    to_layer: Some("ui".to_string()),
                    from_file: Some("src/utils/auth.ts".to_string()),
                    to_file: None,
                    test_pattern: None,
                    max_count: None,
                }),
            }],
            layers: default_layers(),
        };
        let edges = vec![
            make_edge("src/utils/auth.ts", "src/components/LoginForm.tsx", false),
            make_edge("src/utils/auth.ts", "src/services/api.ts", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(!result.allowed);
        assert!(result.violations.iter().any(|v| v.violation_type == "no_auth_in_ui"));
    }

    #[test]
    fn test_custom_rule_ignores_unknown_type() {
        let config = ArchitectureRules {
            rules: vec![ArchitectureRule {
                id: "unknown_custom".to_string(),
                description: "Some unknown custom rule".to_string(),
                severity: "error".to_string(),
                custom: Some(CustomRule {
                    predicate_type: "nonexistent_type".to_string(),
                    from_layer: None,
                    to_layer: None,
                    from_file: None,
                    to_file: None,
                    test_pattern: None,
                    max_count: None,
                }),
            }],
            layers: default_layers(),
        };
        let edges = vec![make_edge("src/components/A.tsx", "src/database/B.ts", false)];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = validate_rules(&config, &graph);
        assert!(result.allowed);
        assert_eq!(result.violations.len(), 0);
    }
}
