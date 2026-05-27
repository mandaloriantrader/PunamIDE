//! GitHub Pull Requests — create, list, merge, review, comment.
//! Phase 4 implementation.

use serde::{Deserialize, Serialize};
use tauri::State;
use super::auth::GitHubAuthState;
use super::client::GitHubClient;
use super::types::PullRequest;

// ─── API Response Types ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ApiPullRequest {
    number: u32,
    title: String,
    body: Option<String>,
    state: String,
    html_url: String,
    head: ApiPrRef,
    base: ApiPrRef,
    user: ApiUser,
    created_at: String,
    updated_at: String,
    draft: Option<bool>,
    mergeable: Option<bool>,
}

#[derive(Deserialize)]
struct ApiPrRef {
    #[serde(rename = "ref")]
    ref_name: String,
}

#[derive(Deserialize)]
struct ApiUser {
    login: String,
}

#[derive(Deserialize)]
struct ApiComment {
    id: u64,
    body: String,
    user: ApiUser,
    created_at: String,
}

impl From<ApiPullRequest> for PullRequest {
    fn from(pr: ApiPullRequest) -> Self {
        PullRequest {
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.state,
            html_url: pr.html_url,
            head_ref: pr.head.ref_name,
            base_ref: pr.base.ref_name,
            user_login: pr.user.login,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            draft: pr.draft.unwrap_or(false),
            mergeable: pr.mergeable,
        }
    }
}

// ─── Request Bodies ───────────────────────────────────────────────────────────

#[derive(Serialize)]
struct CreatePrBody {
    title: String,
    body: Option<String>,
    head: String,
    base: String,
    draft: bool,
}

#[derive(Serialize)]
struct MergePrBody {
    merge_method: String,
}

#[derive(Serialize)]
struct CommentBody {
    body: String,
}

// ─── Merge result ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MergeResult {
    pub merged: bool,
    pub message: String,
    pub sha: Option<String>,
}

#[derive(Deserialize)]
struct ApiMergeResult {
    merged: Option<bool>,
    message: Option<String>,
    sha: Option<String>,
}

// ─── Helper ───────────────────────────────────────────────────────────────────

fn get_client(auth: &State<GitHubAuthState>) -> Result<GitHubClient, String> {
    let token = auth.get_token().ok_or("Not authenticated. Connect to GitHub first.")?;
    Ok(GitHubClient::new(&token))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Create a new pull request.
#[tauri::command]
pub async fn github_create_pr(
    owner: String,
    repo: String,
    title: String,
    body: Option<String>,
    head: String,
    base: String,
    draft: bool,
    auth: State<'_, GitHubAuthState>,
) -> Result<PullRequest, String> {
    let client = get_client(&auth)?;
    let req_body = CreatePrBody { title, body, head, base, draft };
    let path = format!("/repos/{}/{}/pulls", owner, repo);
    let pr: ApiPullRequest = client.post(&path, &req_body).await?;
    Ok(pr.into())
}

/// List pull requests for a repository.
#[tauri::command]
pub async fn github_list_prs(
    owner: String,
    repo: String,
    state: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    auth: State<'_, GitHubAuthState>,
) -> Result<Vec<PullRequest>, String> {
    let client = get_client(&auth)?;
    let st = state.unwrap_or_else(|| "open".to_string());
    let pg = page.unwrap_or(1);
    let pp = per_page.unwrap_or(30);
    let path = format!("/repos/{}/{}/pulls?state={}&page={}&per_page={}", owner, repo, st, pg, pp);
    let prs: Vec<ApiPullRequest> = client.get(&path).await?;
    Ok(prs.into_iter().map(|p| p.into()).collect())
}

/// Get a single pull request by number.
#[tauri::command]
pub async fn github_get_pr(
    owner: String,
    repo: String,
    number: u32,
    auth: State<'_, GitHubAuthState>,
) -> Result<PullRequest, String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}/pulls/{}", owner, repo, number);
    let pr: ApiPullRequest = client.get(&path).await?;
    Ok(pr.into())
}

/// Merge a pull request.
#[tauri::command]
pub async fn github_merge_pr(
    owner: String,
    repo: String,
    number: u32,
    method: Option<String>,
    auth: State<'_, GitHubAuthState>,
) -> Result<MergeResult, String> {
    let client = get_client(&auth)?;
    let merge_method = method.unwrap_or_else(|| "merge".to_string());
    let body = MergePrBody { merge_method };
    let path = format!("/repos/{}/{}/pulls/{}/merge", owner, repo, number);
    let result: ApiMergeResult = client.put(&path, &body).await?;
    Ok(MergeResult {
        merged: result.merged.unwrap_or(false),
        message: result.message.unwrap_or_default(),
        sha: result.sha,
    })
}

/// Close a pull request without merging.
#[tauri::command]
pub async fn github_close_pr(
    owner: String,
    repo: String,
    number: u32,
    auth: State<'_, GitHubAuthState>,
) -> Result<PullRequest, String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}/pulls/{}", owner, repo, number);
    #[derive(Serialize)]
    struct CloseBody { state: String }
    let body = CloseBody { state: "closed".to_string() };
    let pr: ApiPullRequest = client.patch(&path, &body).await?;
    Ok(pr.into())
}

/// List comments on a pull request.
#[tauri::command]
pub async fn github_pr_list_comments(
    owner: String,
    repo: String,
    number: u32,
    auth: State<'_, GitHubAuthState>,
) -> Result<Vec<super::types::Comment>, String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}/issues/{}/comments", owner, repo, number);
    let comments: Vec<ApiComment> = client.get(&path).await?;
    Ok(comments.into_iter().map(|c| super::types::Comment {
        id: c.id,
        body: c.body,
        user_login: c.user.login,
        created_at: c.created_at,
    }).collect())
}

/// Add a comment to a pull request.
#[tauri::command]
pub async fn github_pr_add_comment(
    owner: String,
    repo: String,
    number: u32,
    body: String,
    auth: State<'_, GitHubAuthState>,
) -> Result<super::types::Comment, String> {
    let client = get_client(&auth)?;
    let path = format!("/repos/{}/{}/issues/{}/comments", owner, repo, number);
    let req_body = CommentBody { body };
    let comment: ApiComment = client.post(&path, &req_body).await?;
    Ok(super::types::Comment {
        id: comment.id,
        body: comment.body,
        user_login: comment.user.login,
        created_at: comment.created_at,
    })
}
