# GitHub Release Instructions

Use this repository as a public downloads and community hub for PunamIDE.

## Repository

Recommended public repository:

```text
punamide-downloads
```

Source code should remain private in a separate repository.

## Create Release

Create a GitHub Release with:

```text
Tag: v0.1.0-alpha
Release title: PunamIDE v0.1.0 Alpha
Recommended asset: PunamIDE-Setup-v0.1.0-alpha.exe
Optional asset: PunamIDE-v0.1.0-alpha-x64.msi
```

## Steps

1. Build the Windows alpha installer.
2. Confirm the installer filename:

   ```text
   PunamIDE-Setup-v0.1.0-alpha.exe
   PunamIDE-v0.1.0-alpha-x64.msi
   ```

3. Open GitHub Releases.
4. Click **Draft a new release**.
5. Enter tag:

   ```text
   v0.1.0-alpha
   ```

6. Enter release title:

   ```text
   PunamIDE v0.1.0 Alpha
   ```

7. Paste the release notes from:

   ```text
   RELEASE_NOTES_v0.1.0-alpha.md
   ```

8. Upload the installer assets:

   ```text
   PunamIDE-Setup-v0.1.0-alpha.exe
   PunamIDE-v0.1.0-alpha-x64.msi
   ```

9. Publish the release.

## Website Download Link

After publishing, link the website download button to:

```text
https://github.com/punamide/punamide-downloads/releases/download/v0.1.0-alpha/PunamIDE-Setup-v0.1.0-alpha.exe
```

Or link directly to the release:

```text
https://github.com/punamide/punamide-downloads/releases/tag/v0.1.0-alpha
```
