export const PUNAM_DISCORD_URL = "https://discord.gg/PFp9KWY3eY";
export const PUNAM_WEBSITE_URL = "https://punamide.com";
export const PUNAM_GITHUB_URL = "https://github.com/punamide/punamide-downloads";
export const PUNAM_LICENSE = "MIT";
export const PUNAM_VERSION = "v0.1.0 Alpha";
export const PUNAM_BUILD_NUMBER = "alpha.1";
export const PUNAM_RELEASE_DATE = "2026-06-02";
export const PUNAM_RELEASE_CHANNEL = "Alpha";

export const SENTRY_DSN =
  import.meta.env.VITE_SENTRY_DSN ||
  "https://9b6be054e87420e6c3bfdfa4e5a6704d@o4511492457299968.ingest.de.sentry.io/4511492464705616";

export const ALPHA_RELEASE_NOTES = [
  "Frontend crash reporting is enabled through Sentry.",
  "Diagnostics are generated locally and only exported when you choose.",
  "Feedback reports do not include source files, prompts, or API keys.",
];

export const PUNAM_CHANGELOG = [
  "v0.1.0 Alpha",
  "Added Help feedback, diagnostics, Discord, and About flows.",
  "Added Sentry-backed frontend error reporting.",
  "Added local log export and privacy-aware diagnostic reports.",
];
