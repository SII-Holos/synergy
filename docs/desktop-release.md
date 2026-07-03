# Synergy Desktop Release Runbook

`packages/desktop` is the production Electron application for Synergy. It uses `electron-builder`, app id `io.holosai.synergy`, product name `Synergy`, desktop shell executable name `synergy-desktop`, public runtime CLI name `synergy`, and protocol `synergy://`.

## Channels

- `stable`: packaged release channel, GitHub Releases update metadata enabled.
- `dev`: development channel, automatic updates disabled.

Stable desktop updates use `electron-updater` against the GitHub Release metadata files below. The app stores its desktop update preference under Electron `userData`; `auto` downloads in the background, `notify` reports availability, `manual` waits for an explicit check, and `none` disables checks. Settings and the bottom sidebar update prompt show availability, download progress, install readiness, and errors. Installing an already downloaded update stops the managed local server before calling Electron's updater install action.

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

Recommended Desktop installer artifacts:

- `Synergy-darwin-x64-${version}.pkg`
- `Synergy-darwin-arm64-${version}.pkg`
- `Synergy-win32-x64-${version}.exe`
- `Synergy-win32-arm64-${version}.exe`
- `Synergy-linux-x86_64-${version}.deb`
- `Synergy-linux-arm64-${version}.deb`
- `Synergy-${version}-checksums.txt`

Portable and updater artifacts are still published but are not the full Desktop + CLI install entry:

- macOS `.zip` is required by updater metadata.
- macOS `.dmg` is an app-bundle artifact and does not install the CLI link.
- Linux `.AppImage` and `.tar.gz` are portable/debug artifacts and do not install global commands.

Updater metadata expected on stable releases:

- `latest-mac.yml`
- `latest.yml`
- `latest-linux.yml`

## CLI Exposure

Desktop installers expose the same packaged runtime used by managed server mode:

- macOS `.pkg` creates `/usr/local/bin/synergy` as a symlink to `/Applications/Synergy.app/Contents/Resources/synergy/bin/synergy`.
- Windows NSIS creates `$INSTDIR\bin\synergy.cmd`, adds `$INSTDIR\bin` to the current user PATH, and forwards to `$INSTDIR\resources\synergy\bin\synergy.exe`.
- Linux `.deb` installs `synergy-desktop` for the Electron shell and `synergy` for `/opt/Synergy/resources/synergy/bin/synergy` through package lifecycle scripts.

Installers do not run the CLI installer, do not start the runtime, do not write shell rc files, and do not publish internal runtime helper binaries such as `ast-grep` to PATH. Desktop-managed CLI updates are handled by the Desktop updater; `synergy upgrade` reports that update path instead of running package-manager commands.

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
5. `stable_finalize` verifies npm candidates, runtime assets, recommended Desktop installer artifacts, portable artifacts, checksum, and updater metadata by reading the draft GitHub Release assets, then promotes npm tags and publishes the GitHub Release.

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
- Install `.pkg`, `.exe`, and `.deb` in platform runners or VMs and check `synergy --version` plus `synergy doctor`
- Confirm Windows does not expose internal runtime helper binaries through PATH
- Confirm Linux provides both `/usr/bin/synergy-desktop` for the desktop shell and `/usr/bin/synergy` for the runtime CLI
- Draft GitHub Release contains all expected recommended installer artifacts, portable artifacts, checksum, and updater metadata before finalize
