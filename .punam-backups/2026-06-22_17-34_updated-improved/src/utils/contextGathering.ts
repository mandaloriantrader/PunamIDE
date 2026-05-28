/**
 * Smart Context Engine utilities for PunamIDE.
 * Provides framework detection and git status for AI context enrichment.
 */

/**
 * Detect project frameworks by parsing package.json and Cargo.toml content.
 */
export function detectFrameworks(packageJsonContent: string | null, cargoTomlContent: string | null): string[] {
  const frameworks: string[] = [];

  if (packageJsonContent) {
    try {
      const packageJson = JSON.parse(packageJsonContent);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      if (deps.react) frameworks.push("React");
      if (deps.vue) frameworks.push("Vue.js");
      if (deps.angular || deps["@angular/core"]) frameworks.push("Angular");
      if (deps.next) frameworks.push("Next.js");
      if (deps.vite) frameworks.push("Vite");
      if (deps["@tauri-apps/api"]) frameworks.push("Tauri");
      if (deps["monaco-editor"] || deps["@monaco-editor/react"]) frameworks.push("Monaco Editor");
      if (deps.express) frameworks.push("Express");
      if (deps.tailwindcss) frameworks.push("Tailwind CSS");
      if (deps.typescript) frameworks.push("TypeScript");
    } catch {
      // Invalid JSON — skip
    }
  }

  if (cargoTomlContent) {
    if (cargoTomlContent.includes("tauri =") || cargoTomlContent.includes("tauri-")) frameworks.push("Tauri (Rust)");
    if (cargoTomlContent.includes("tokio =")) frameworks.push("Tokio");
    if (cargoTomlContent.includes("actix") || cargoTomlContent.includes("axum")) frameworks.push("Rust Web Framework");
    if (cargoTomlContent.includes("serde =")) frameworks.push("Serde");
  }

  return [...new Set(frameworks)];
}
