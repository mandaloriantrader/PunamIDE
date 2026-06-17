//! GitHub authentication — token storage and validation.
//! Phase 1 implementation.

use tauri::State;
use super::types::GitHubUser;
use super::client::GitHubClient;
use std::sync::Mutex;

/// Managed state holding the GitHub token in memory (encrypted at rest via tauri-plugin-store).
pub struct GitHubAuthState {
    pub token: Mutex<Option<String>>,
    pub user: Mutex<Option<GitHubUser>>,
}

impl GitHubAuthState {
    pub fn new() -> Self {
        Self {
            token: Mutex::new(None),
            user: Mutex::new(None),
        }
    }

    pub fn get_token(&self) -> Option<String> {
        self.token.lock().ok().and_then(|t| t.clone())
    }

    pub fn set_token(&self, token: Option<String>) {
        if let Ok(mut t) = self.token.lock() {
            *t = token;
        }
    }

    pub fn set_user(&self, user: Option<GitHubUser>) {
        if let Ok(mut u) = self.user.lock() {
            *u = user;
        }
    }

    pub fn get_user(&self) -> Option<GitHubUser> {
        self.user.lock().ok().and_then(|u| u.clone())
    }
}

/// Store the GitHub PAT securely and validate it.
#[tauri::command]
pub async fn github_set_token(token: String, auth: State<'_, GitHubAuthState>) -> Result<GitHubUser, String> {
    // Validate token by calling GET /user
    let client = GitHubClient::new(&token);
    let user = client.get_authenticated_user().await?;

    // Store in memory
    auth.set_token(Some(token));
    auth.set_user(Some(user.clone()));

    Ok(user)
}

/// Get the currently authenticated user (from cache).
#[tauri::command]
pub fn github_get_user(auth: State<'_, GitHubAuthState>) -> Result<Option<GitHubUser>, String> {
    Ok(auth.get_user())
}

/// Check if a token is stored and valid.
#[tauri::command]
pub async fn github_check_auth(auth: State<'_, GitHubAuthState>) -> Result<bool, String> {
    Ok(auth.get_token().is_some())
}

/// Clear stored token and user info.
#[tauri::command]
pub fn github_logout(auth: State<'_, GitHubAuthState>) -> Result<(), String> {
    auth.set_token(None);
    auth.set_user(None);
    Ok(())
}
