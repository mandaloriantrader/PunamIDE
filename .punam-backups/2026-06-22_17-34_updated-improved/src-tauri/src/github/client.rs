//! GitHub API HTTP client wrapper.
//! All API calls go through this client with proper auth headers.

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::de::DeserializeOwned;
use super::types::GitHubUser;

const GITHUB_API_BASE: &str = "https://api.github.com";
const USER_AGENT_VALUE: &str = "PunamIDE/2.0";

/// HTTP client for GitHub API calls.
pub struct GitHubClient {
    client: reqwest::Client,
    token: String,
}

impl GitHubClient {
    /// Create a new client with the given PAT.
    pub fn new(token: &str) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
        headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
        headers.insert(
            "X-GitHub-Api-Version",
            HeaderValue::from_static("2022-11-28"),
        );

        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            client,
            token: token.to_string(),
        }
    }

    /// Make an authenticated GET request.
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let url = format!("{}{}", GITHUB_API_BASE, path);
        let resp = self.client
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API error ({}): {}", status.as_u16(), body));
        }

        resp.json::<T>().await.map_err(|e| format!("Parse error: {}", e))
    }

    /// Make an authenticated POST request with JSON body.
    pub async fn post<T: DeserializeOwned, B: serde::Serialize>(&self, path: &str, body: &B) -> Result<T, String> {
        let url = format!("{}{}", GITHUB_API_BASE, path);
        let resp = self.client
            .post(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body_text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API error ({}): {}", status.as_u16(), body_text));
        }

        resp.json::<T>().await.map_err(|e| format!("Parse error: {}", e))
    }

    /// Make an authenticated PUT request with JSON body.
    pub async fn put<T: DeserializeOwned, B: serde::Serialize>(&self, path: &str, body: &B) -> Result<T, String> {
        let url = format!("{}{}", GITHUB_API_BASE, path);
        let resp = self.client
            .put(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body_text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API error ({}): {}", status.as_u16(), body_text));
        }

        resp.json::<T>().await.map_err(|e| format!("Parse error: {}", e))
    }

    /// Make an authenticated PATCH request with JSON body.
    pub async fn patch<T: DeserializeOwned, B: serde::Serialize>(&self, path: &str, body: &B) -> Result<T, String> {
        let url = format!("{}{}", GITHUB_API_BASE, path);
        let resp = self.client
            .patch(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body_text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API error ({}): {}", status.as_u16(), body_text));
        }

        resp.json::<T>().await.map_err(|e| format!("Parse error: {}", e))
    }

    /// Make an authenticated DELETE request.
    pub async fn delete(&self, path: &str) -> Result<(), String> {
        let url = format!("{}{}", GITHUB_API_BASE, path);
        let resp = self.client
            .delete(&url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token))
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        let status = resp.status();
        if !status.is_success() {
            let body_text = resp.text().await.unwrap_or_default();
            return Err(format!("GitHub API error ({}): {}", status.as_u16(), body_text));
        }

        Ok(())
    }

    /// Validate token by fetching authenticated user.
    pub async fn get_authenticated_user(&self) -> Result<GitHubUser, String> {
        #[derive(serde::Deserialize)]
        struct ApiUser {
            login: String,
            id: u64,
            avatar_url: String,
            name: Option<String>,
            email: Option<String>,
            html_url: String,
        }

        let api_user: ApiUser = self.get("/user").await?;

        Ok(GitHubUser {
            login: api_user.login,
            id: api_user.id,
            avatar_url: api_user.avatar_url,
            name: api_user.name,
            email: api_user.email,
            html_url: api_user.html_url,
        })
    }
}
