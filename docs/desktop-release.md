# Synergy Desktop Release Runbook

`packages/desktop` is the production Electron application for Synergy. It uses `electron-builder`, app id `io.holosai.synergy`, product name `Synergy`, executable name `synergy`, and protocol `synergy://`.

## Channels

- `stable`: packaged release channel, GitHub Releases update metadata enabled.
- `dev`: development channel, automatic updates disabled.

Stable desktop updates use `electron-updater` against the GitHub Release metadata files below. The app stores its desktop update preference under Electron `userData`; `auto` downloads in the background, `notify` reports availability, `manual` waits for an explicit check, and `none` disables checks. Installing an already downloaded update stops the managed local server before calling Electron's installer restart path.

Runtime environment:

- `SYNERGY_DESKTOP_CHANNEL=dev|stable`
- `SYNERGY_DESKTOP_SERVER_MODE=managed|external`
- `SYNERGY_DESKTOP_APP_URL` only applies to dev/external mode
- `SYNERGY_DESKTOP_LOG_DIR` overrides desktop/server logs

## Local Commands

```bash
bun run desktop:build
bun run desktop:test
bun run desktop:pack
bun run desktop:dist
```

`desktop:pack` and `desktop:dist` build the Electron main/preload bundles, prepare a current-platform Synergy runtime, and run `electron-builder`. Release workflows build the exact runtime target with `SYNERGY_BUILD_TARGETS` and inject it with `packages/desktop/script/after-pack.cjs`.

## Release Artifacts

Primary artifact naming contract:

- `Synergy-darwin-x64-${version}.dmg`
- `Synergy-darwin-arm64-${version}.dmg`
- `Synergy-win32-x64-${version}.exe`
- `Synergy-win32-arm64-${version}.exe`
- `Synergy-linux-x86_64-${version}.AppImage`
- `Synergy-linux-arm64-${version}.AppImage`
- `Synergy-${version}-checksums.txt`

Updater metadata expected on stable releases:

- `latest-mac.yml`
- `latest.yml`
- `latest-linux.yml`

## Required Secrets

macOS:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `CSC_LINK`
- `CSC_KEY_PASSWORD`

Windows:

- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

GitHub upload/update feed:

- `GITHUB_TOKEN` or `GH_TOKEN`

PR/package validation must work without signing secrets. Release workflows sign and notarize only when the relevant secrets are present.

## GitHub Actions Flow

Product release keeps the existing candidate/finalize model:

1. `stable_candidate` runs `script/release/stable-start.ts`, publishes npm candidates, builds core runtime assets, creates the draft GitHub Release, and uploads release state.
2. `stable_desktop_package` runs a three-way desktop matrix for macOS, Windows, and Linux. Each platform job builds both `x64` and `arm64` artifacts in one `electron-builder` invocation and generates updater metadata per platform.
3. Each desktop matrix job rewrites package versions to the candidate version, builds the matching Synergy runtimes via `SYNERGY_BUILD_TARGETS`, then packages the platform artifact set with `electron-builder`.
4. `stable_desktop_publish` downloads all desktop artifacts, generates `Synergy-${version}-checksums.txt`, and uploads the desktop assets to the draft GitHub Release.
5. `stable_finalize` verifies npm candidates, runtime assets, desktop artifacts, checksum, and updater metadata by reading the draft GitHub Release assets, then promotes npm tags and publishes the GitHub Release.

## Failure Recovery

- If desktop packaging fails before upload, rerun the failed `stable_desktop_package` matrix job.
- If desktop upload fails, rerun `stable_desktop_publish`; it uses `gh release upload --clobber`.
- If checksum generation is wrong, delete the checksum asset from the draft release, rerun `stable_desktop_publish`, then rerun finalize.
- If notarization or code signing fails, verify the signing secrets and rerun only the affected platform matrix job before finalize.
- If finalize fails because desktop assets are missing, do not publish the draft release manually; restore the missing assets first, then rerun `stable_finalize`.

## Validation Checklist

- `bun run --cwd packages/desktop desktop:test`
- `bun run --cwd packages/desktop desktop:build`
- `electron-builder --dir --publish=never` with `SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME=1` for config-only CI validation
- Linux CI runtime smoke under `xvfb`
- Draft GitHub Release contains all expected primary artifacts, checksum, and updater metadata before finalize
