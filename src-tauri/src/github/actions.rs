//! GitHub Actions — workflow run status, re-run.
//! Phase 5 implementation.

use serde::{Deserialize, Serialize};
use tauri::State;
use super::auth::GitHubAuthState;
use super::client::GitHubClient;
use super::types::WorkflowRun;

// ─── API Response Types ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ApiWorkflowRunsResponse {
    total_count: u32,
    workflow_runs: Vec<ApiWorkflowRun>,
}

#[derive(Deserialize)]
struct ApiWorkflowRun {
    id: u64,
    name: Option<String>,
    status: String,
    conclusion: Option<String>,
    html_url: String,
    head_branch: Option<String>,
    created_at: String,
}

impl From<ApiWorkflowRun> for WorkflowRun {
    fn from(r: ApiWorkflowRun) -> Self {
        WorkflowRun {
            id: r.id,
            name: r.name.unwrap_or_else(|| "Workflow".to_string()),
            status: r.status,
            conclusion: r.conclusion,
            html_url: r.html_url,
            head_branch: r.head_branch.unwrap_or_default(),
            created_at: r.created_at,
        }
    }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

fn get_client(auth: &State<GitHubAuthState>) -> Result<GitHubClient, String> {
    let token = auth.get_token().ok_or("Not authenticated. Connect to GitHub first.")?;
    Ok(GitHubClient::new(&token))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// List recent workflow runs for a repository.
#[tauri::command]
pub async fn github_list_workflow_runs(
    owner: String,
    repo: String,
    branch: Option<String>,
    per_page: Option<u32>,
    auth: State<'_, GitHubAuthState>,
) -> Result<Vec<WorkflowRun>, String> {
    let client = get_client(&auth)?;
    let pp = per_page.unwrap_or(10);

    let mut path = format!("/repos/{}/{}/actions/runs?per_page={}", owner, repo, pp);
    if let Some(ref b) = branch {
        path.push_str(&format!("&branch={}", b));
    }

    let response: ApiWorkflowRunsResponse = client.get(&path).await?;
    Ok(response.workflow_runs.into_iter().map(|r| r.into()).collect())
}

/// Get a specific workflow run.
#[tauri::command]
pub async fn github_get_workflow_run(
    owner: String,
    repo: String,
    run_id: u64,
    auth: State<'_, GitHubAuthState>,
) -> Result<WorkflowRun, String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}/actions/runs/{}", owner, repo, run_id);
    let run: ApiWorkflowRun = client.get(&path).await?;
    Ok(run.into())
}

/// Re-run a failed workflow.
#[tauri::command]
pub async fn github_rerun_workflow(
    owner: String,
    repo: String,
    run_id: u64,
    auth: State<'_, GitHubAuthState>,
) -> Result<(), String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}/actions/runs/{}/rerun", owner, repo, run_id);
    // POST with empty body
    #[derive(Serialize)]
    struct Empty {}
    let _: serde_json::Value = client.post(&path, &Empty {}).await
        .or_else(|e| {
            // GitHub returns 201 with empty body for re-run
            if e.contains("Parse error") {
                Ok(serde_json::Value::Null)
            } else {
                Err(e)
            }
        })?;
    Ok(())
}
