# Recommended Repository Structure

Use this structure for the public downloads repository.

```text
punamide-downloads/
|
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── SUPPORT.md
├── DISCUSSIONS_CATEGORIES.md
├── RELEASE_NOTES_v0.1.0-alpha.md
├── GITHUB_RELEASE_INSTRUCTIONS.md
├── REPOSITORY_STRUCTURE.md
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md
│       ├── feature_request.md
│       └── alpha_feedback.md
├── assets/
│   ├── logo.png
│   ├── screenshots/
│   └── installer/
└── releases/
```

## Notes

- Keep source code out of this repository.
- Store public-facing screenshots in `assets/screenshots`.
- Store release planning files in `releases` only if useful.
- Upload actual installers through GitHub Releases, not regular Git commits.
- Keep private diagnostics, keys, tokens, and source files out of this repository.
