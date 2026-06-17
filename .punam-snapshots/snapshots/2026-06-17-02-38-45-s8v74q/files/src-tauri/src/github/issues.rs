//! GitHub Issues — list, create, comment.
//! Phase 5 implementation.

use serde::{Deserialize, Serialize};
use tauri::State;
use super::auth::GitHubAuthState;
use super::client::GitHubClient;
use super::types::{Issue, Comment};

// ─── API Response Types ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ApiIssue {
    number: u32,
    title: String,
    body: Option<String>,
    state: String,
    html_url: String,
    user: ApiUser,
    labels: Vec<ApiLabel>,
    created_at: String,
    updated_at: String,
    pull_request: Option<serde_json::Value>, // present if it's a PR
}

#[derive(Deserialize)]
struct ApiUser {
    login: String,
}

#[derive(Deserialize)]
struct ApiLabel {
    name: String,
}

#[derive(Deserialize)]
struct ApiComment {
    id: u64,
    body: String,
    user: ApiUser,
    created_at: String,
}

impl From<ApiIssue> for Issue {
    fn from(i: ApiIssue) -> Self {
        Issue {
            number: i.number,
            title: i.title,
            body: i.body,
            state: i.state,
            html_url: i.html_url,
            user_login: i.user.login,
            labels: i.labels.into_iter().map(|l| l.name).collect(),
            created_at: i.created_at,
            updated_at: i.updated_at,
        }
    }
}

// ─── Request Bodies ───────────────────────────────────────────────────────────

#[derive(Serialize)]
struct CreateIssueBody {
    title: String,
    body: Option<String>,
    labels: Vec<String>,
}

#[derive(Serialize)]
struct CommentBody {
    body: String,
}

// ─── Helper ───────────────────────────────────────────────────────────────────

fn get_client(auth: &State<GitHubAuthState>) -> Result<GitHubClient, String> {
    let token = auth.get_token().ok_or("Not authenticated. Connect to GitHub first.")?;
    Ok(GitHubClient::new(&token))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// List issues for a repository (excludes pull requests).
#[tauri::command]
pub async fn github_list_issues(
    owner: String,
    repo: String,
    state: Option<String>,
    labels: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    auth: State<'_, GitHubAuthState>,
) -> Result<Vec<Issue>, String> {
    let client = get_client(&auth)?;
    let st = state.unwrap_or_else(|| "open".to_string());
    let pg = page.unwrap_or(1);
    let pp = per_page.unwrap_or(30);

    let mut path = format!("/repos/{}/{}/issues?state={}&page={}&per_page={}", owner, repo, st, pg, pp);
    if let Some(ref l) = labels {
        path.push_str(&format!("&labels={}", l));
    }

    let issues: Vec<ApiIssue> = client.get(&path).await?;
    // Filter out pull requests (GitHub API returns PRs in issues endpoint)
    Ok(issues.into_iter()
        .filter(|i| i.pull_request.is_none())
        .map(|i| i.into())
        .collect())
}

/// Create a new issue.
#[tauri::command]
pub async fn github_create_issue(
    owner: String,
    repo: String,
    title: String,
    body: Option<String>,
    labels: Vec<String>,
    auth: State<'_, GitHubAuthState>,
) -> Result<Issue, String> {
    let client = get_client(&auth)?;
    let req_body = CreateIssueBody { title, body, labels };
    let path = format!("/repos/{}/{}/issues", owner, repo);
    let issue: ApiIssue = client.post(&path, &req_body).await?;
    Ok(issue.into())
}

/// Close an issue.
#[tauri::command]
pub async fn github_close_issue(
    owner: String,
    repo: String,
    number: u32,
    auth: State<'_, GitHubAuthState>,
) -> Result<Issue, String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}/issues/{}", owner, repo, number);
    #[derive(Serialize)]
    struct CloseBody { state: String }
    let body = CloseBody { state: "closed".to_string() };
    let issue: ApiIssue = client.patch(&path, &body).await?;
    Ok(issue.into())
}

/// List comments on an issue.
#[tauri::command]
pub async fn github_issue_list_comments(
    owner: String,
    repo: String,
    number: u32,
    auth: State<'_, GitHubAuthState>,
) -> Result<Vec<Comment>, String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}/issues/{}/comments", owner, repo, number);
    let comments: Vec<ApiComment> = client.get(&path).await?;
    Ok(comments.into_iter().map(|c| Comment {
        id: c.id,
        body: c.body,
        user_login: c.user.login,
        created_at: c.created_at,
    }).collect())
}

/// Add a comment to an issue.
#[tauri::command]
pub async fn github_issue_add_comment(
    owner: String,
    repo: String,
    number: u32,
    body: String,
    auth: State<'_, GitHubAuthState>,
) -> Result<Comment, String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}/issues/{}/comments", owner, repo, number);
    let req_body = CommentBody { body };
    let comment: ApiComment = client.post(&path, &req_body).await?;
    Ok(Comment {
        id: comment.id,
        body: comment.body,
        user_login: comment.user.login,
        created_at: comment.created_at,
    })
}
