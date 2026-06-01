//! GitHub Gists — create gist from code.
//! Phase 5 implementation.

use serde::{Deserialize, Serialize};
use tauri::State;
use super::auth::GitHubAuthState;
use super::client::GitHubClient;
use super::types::GistInfo;
use std::collections::HashMap;

// ─── API Types ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ApiGist {
    id: String,
    html_url: String,
    description: Option<String>,
    public: bool,
    created_at: String,
}

impl From<ApiGist> for GistInfo {
    fn from(g: ApiGist) -> Self {
        GistInfo {
            id: g.id,
            html_url: g.html_url,
            description: g.description,
            public: g.public,
            created_at: g.created_at,
        }
    }
}

// ─── Request Body ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct CreateGistBody {
    description: Option<String>,
    public: bool,
    files: HashMap<String, GistFileContent>,
}

#[derive(Serialize)]
struct GistFileContent {
    content: String,
}

// ─── Helper ───────────────────────────────────────────────────────────────────

fn get_client(auth: &State<GitHubAuthState>) -> Result<GitHubClient, String> {
    let token = auth.get_token().ok_or("Not authenticated. Connect to GitHub first.")?;
    Ok(GitHubClient::new(&token))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Create a new gist with one or more files.
#[tauri::command]
pub async fn github_create_gist(
    filename: String,
    content: String,
    public: bool,
    description: Option<String>,
    auth: State<'_, GitHubAuthState>,
) -> Result<GistInfo, String> {
    let client = get_client(&auth)?;

    let mut files = HashMap::new();
    files.insert(filename, GistFileContent { content });

    let body = CreateGistBody {
        description,
        public,
        files,
    };

    let gist: ApiGist = client.post("/gists", &body).await?;
    Ok(gist.into())
}

/// Create a gist with multiple files.
#[tauri::command]
pub async fn github_create_multi_gist(
    files: HashMap<String, String>,
    public: bool,
    description: Option<String>,
    auth: State<'_, GitHubAuthState>,
) -> Result<GistInfo, String> {
    let client = get_client(&auth)?;

    let gist_files: HashMap<String, GistFileContent> = files
        .into_iter()
        .map(|(name, content)| (name, GistFileContent { content }))
        .collect();

    let body = CreateGistBody {
        description,
        public,
        files: gist_files,
    };

    let gist: ApiGist = client.post("/gists", &body).await?;
    Ok(gist.into())
}
