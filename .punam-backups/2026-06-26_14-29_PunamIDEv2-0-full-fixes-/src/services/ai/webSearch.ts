/**
 * Web Search Service — Search the web via DuckDuckGo API for @web mentions.
 * Ported from Zenith IDE for Punam IDE.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  try {
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`
    );
    const data = await response.json();
    const results: WebSearchResult[] = [];

    if (data.Abstract) {
      results.push({
        title: data.Heading || "Summary",
        url: data.AbstractURL || "",
        snippet: data.Abstract,
      });
    }

    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, maxResults - results.length)) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.split(" - ")[0] || topic.Text.slice(0, 80),
            url: topic.FirstURL,
            snippet: topic.Text,
          });
        }
      }
    }

    return results.slice(0, maxResults);
  } catch {
    return [{
      title: "Search unavailable",
      url: "",
      snippet: `Could not search for: ${query}. Web search requires internet access.`,
    }];
  }
}

export function formatSearchResults(results: WebSearchResult[]): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`)
    .join("\n\n");
}
