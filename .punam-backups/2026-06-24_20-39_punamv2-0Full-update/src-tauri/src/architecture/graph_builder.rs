use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

use super::dependency_analyzer::DependencyEdge;

// ── Data Types ─────────────────────────────────────────────────────────────────

/// A directed dependency graph for the project.
///
/// Stores forward edges (who depends on what) and reverse edges (who depends on me).
/// Supports cycle detection, topological sort, and impact analysis queries.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DependencyGraph {
    /// Map from file path to the list of files/modules it imports (forward edges).
    pub forward: HashMap<String, Vec<String>>,
    /// Map from file path to the list of files that import it (reverse edges).
    pub reverse: HashMap<String, Vec<String>>,
    /// All file paths in the graph.
    pub files: Vec<String>,
    /// Statistics about the graph.
    pub stats: GraphStats,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GraphStats {
    pub total_files: usize,
    pub total_edges: usize,
    pub local_edges: usize,
    pub external_edges: usize,
}

/// Result of a cycle detection check.
#[derive(Serialize, Debug)]
pub struct CycleCheckResult {
    pub has_cycles: bool,
    pub cycles: Vec<Vec<String>>, // each cycle is a list of file paths
}

/// A single violation found during rule checking.
#[derive(Serialize, Debug)]
pub struct DependencyViolation {
    pub from_file: String,
    pub to_file: String,
    pub violation_type: String, // e.g., "circular_dependency"
    pub description: String,
}

/// DFS color for cycle detection.
#[derive(Clone, PartialEq)]
enum Color {
    White,
    Gray,
    Black,
}

impl DependencyGraph {
    /// Build a dependency graph from a set of dependency edges.
    ///
    /// Edges with `is_external = true` are counted in stats but excluded from
    /// forward/reverse maps since they don't represent project-internal dependencies.
    pub fn build_from_edges(edges: &[DependencyEdge]) -> Self {
        let mut forward: HashMap<String, Vec<String>> = HashMap::new();
        let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
        let mut seen_files = HashSet::new();
        let mut local_edge_count = 0usize;
        let mut external_edge_count = 0usize;

        for edge in edges {
            seen_files.insert(edge.from_file.clone());
            seen_files.insert(edge.to_module.clone());

            if edge.is_external {
                external_edge_count += 1;
                // Don't add to forward/reverse for external deps
                // (they pollute the graph with noise like "react", "fs", etc.)
                continue;
            }

            local_edge_count += 1;

            // Forward edge: from_file → to_module
            forward
                .entry(edge.from_file.clone())
                .or_default()
                .push(edge.to_module.clone());

            // Reverse edge: to_module ← from_file
            reverse
                .entry(edge.to_module.clone())
                .or_default()
                .push(edge.from_file.clone());
        }

        // Ensure every file has at least an empty entry in forward/reverse
        for file in &seen_files {
            forward.entry(file.clone()).or_default();
            reverse.entry(file.clone()).or_default();
        }

        let mut files: Vec<String> = seen_files.into_iter().collect();
        files.sort();
        let total_files = files.len();

        DependencyGraph {
            forward,
            reverse,
            files,
            stats: GraphStats {
                total_files: total_files,
                total_edges: local_edge_count + external_edge_count,
                local_edges: local_edge_count,
                external_edges: external_edge_count,
            },
        }
    }

    /// Detect cycles in the graph using DFS with white/gray/black coloring.
    ///
    /// Returns all cycles found (each cycle is a list of file paths forming the cycle).
    pub fn detect_cycles(&self) -> CycleCheckResult {
        let mut colors: HashMap<&str, Color> = self
            .files
            .iter()
            .map(|f| (f.as_str(), Color::White))
            .collect();
        let mut cycles: Vec<Vec<String>> = Vec::new();

        for file in &self.files {
            if matches!(colors.get(file.as_str()), Some(Color::White)) {
                let mut path: Vec<String> = Vec::new();
                self.dfs_cycle_detect(
                    file,
                    &mut colors,
                    &mut path,
                    &mut cycles,
                );
            }
        }

        CycleCheckResult {
            has_cycles: !cycles.is_empty(),
            cycles,
        }
    }

    fn dfs_cycle_detect<'a>(
        &'a self,
        current: &'a str,
        colors: &mut HashMap<&'a str, Color>,
        path: &mut Vec<String>,
        cycles: &mut Vec<Vec<String>>,
    ) {
        colors.insert(current, Color::Gray);
        path.push(current.to_string());

        if let Some(deps) = self.forward.get(current) {
            for dep in deps {
                match colors.get(dep.as_str()) {
                    Some(Color::Gray) => {
                        // Found a back edge → cycle detected
                        // Extract the cycle from path
                        if let Some(cycle_start) = path.iter().position(|f| f == dep) {
                            let mut cycle: Vec<String> =
                                path[cycle_start..].to_vec();
                            cycle.push(dep.clone()); // close the cycle
                            cycles.push(cycle);
                        }
                    }
                    Some(Color::White) => {
                        self.dfs_cycle_detect(dep, colors, path, cycles);
                    }
                    _ => {} // Black — already fully explored
                }
            }
        }

        colors.insert(current, Color::Black);
        path.pop();
    }

    /// Find all files that depend on a given file (directly or transitively).
    ///
    /// This is useful for impact analysis: "If I change file X, what else might break?"
    pub fn find_dependents(&self, file_path: &str) -> Vec<String> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut result = Vec::new();

        queue.push_back(file_path.to_string());

        while let Some(current) = queue.pop_front() {
            if let Some(dependents) = self.reverse.get(&current) {
                for dep in dependents {
                    if visited.insert(dep.clone()) {
                        result.push(dep.clone());
                        queue.push_back(dep.clone());
                    }
                }
            }
        }

        result
    }

    /// Find all files that a given file imports (directly).
    pub fn get_direct_dependencies(&self, file_path: &str) -> Vec<String> {
        self.forward
            .get(file_path)
            .cloned()
            .unwrap_or_default()
    }

    /// Find all files that a given file imports (transitively).
    pub fn get_transitive_dependencies(&self, file_path: &str) -> Vec<String> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut result = Vec::new();

        queue.push_back(file_path.to_string());

        while let Some(current) = queue.pop_front() {
            if let Some(deps) = self.forward.get(&current) {
                for dep in deps {
                    if visited.insert(dep.clone()) {
                        result.push(dep.clone());
                        queue.push_back(dep.clone());
                    }
                }
            }
        }

        result
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::super::dependency_analyzer::DependencyEdge;
    use super::*;

    fn make_edge(from: &str, to: &str, is_external: bool) -> DependencyEdge {
        DependencyEdge {
            from_file: from.to_string(),
            to_module: to.to_string(),
            import_kind: "es6_import".to_string(),
            is_external,
        }
    }

    #[test]
    fn test_build_simple_graph() {
        let edges = vec![
            make_edge("a.ts", "b.ts", false),
            make_edge("b.ts", "c.ts", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);

        assert_eq!(graph.stats.total_files, 3);
        assert_eq!(graph.stats.local_edges, 2);
        assert_eq!(graph.get_direct_dependencies("a.ts"), vec!["b.ts"]);
        assert_eq!(graph.get_direct_dependencies("b.ts"), vec!["c.ts"]);
        assert!(graph.get_direct_dependencies("c.ts").is_empty());
    }

    #[test]
    fn test_external_filtered() {
        let edges = vec![
            make_edge("app.ts", "react", true),
            make_edge("app.ts", "./utils", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);

        // "react" should not appear in forward edges since it's external
        let deps = graph.get_direct_dependencies("app.ts");
        assert_eq!(deps, vec!["./utils"]);
        assert_eq!(graph.stats.external_edges, 1);
        assert_eq!(graph.stats.local_edges, 1);
    }

    #[test]
    fn test_find_dependents() {
        let edges = vec![
            make_edge("a.ts", "b.ts", false),
            make_edge("c.ts", "b.ts", false),
            make_edge("d.ts", "a.ts", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);

        let dependents = graph.find_dependents("b.ts");
        let mut sorted = dependents;
        sorted.sort();
        // d.ts → a.ts → b.ts, so d.ts is also a transitive dependent of b.ts
        assert_eq!(sorted, vec!["a.ts", "c.ts", "d.ts"]);
    }

    #[test]
    fn test_transitive_dependencies() {
        let edges = vec![
            make_edge("a.ts", "b.ts", false),
            make_edge("b.ts", "c.ts", false),
            make_edge("c.ts", "d.ts", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);

        let deps = graph.get_transitive_dependencies("a.ts");
        assert_eq!(deps.len(), 3);
        assert!(deps.contains(&"b.ts".to_string()));
        assert!(deps.contains(&"c.ts".to_string()));
        assert!(deps.contains(&"d.ts".to_string()));
    }

    #[test]
    fn test_no_cycles() {
        let edges = vec![
            make_edge("a.ts", "b.ts", false),
            make_edge("b.ts", "c.ts", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = graph.detect_cycles();
        assert!(!result.has_cycles);
        assert!(result.cycles.is_empty());
    }

    #[test]
    fn test_simple_cycle() {
        let edges = vec![
            make_edge("a.ts", "b.ts", false),
            make_edge("b.ts", "a.ts", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = graph.detect_cycles();
        assert!(result.has_cycles);
        assert!(!result.cycles.is_empty());
    }

    #[test]
    fn test_transitive_cycle() {
        let edges = vec![
            make_edge("a.ts", "b.ts", false),
            make_edge("b.ts", "c.ts", false),
            make_edge("c.ts", "a.ts", false),
        ];
        let graph = DependencyGraph::build_from_edges(&edges);
        let result = graph.detect_cycles();
        assert!(result.has_cycles);
        assert_eq!(result.cycles.len(), 1);
    }
}