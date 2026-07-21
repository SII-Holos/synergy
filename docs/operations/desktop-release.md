# Synergy Desktop Release Runbook

`packages/desktop` is the production Electron application for Synergy. This runbook covers its `electron-builder` packaging, app id `io.holosai.synergy`, product name `Synergy`, desktop shell executable `synergy-desktop`, public runtime CLI `synergy`, and `synergy://` protocol.

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

Native unread indicators use `build/unread-overlay.png` for the Windows taskbar overlay and `build/icon-unread.png` for the Linux tray fallback. `electron-builder.json` copies both fixed assets into `resources/icons`; keep the source assets and packaging assertions together when changing their runtime paths.

## Release Artifacts

Recommended Desktop installer artifacts:

- `Synergy-darwin-x64-${version}.pkg`
- `Synergy-darwin-arm64-${version}.pkg`
- `Synergy-win32-x64-${version}.exe`
- `Synergy-linux-x86_64-${version}.deb`
- `Synergy-linux-arm64-${version}.deb`
- `Synergy-${version}-checksums.txt`

Windows ARM64 Browser Host artifacts remain published, but the full Windows ARM64 Desktop/runtime is not a Stable target until all native runtime dependencies are available for that architecture.

Portable and updater artifacts are still published but are not the full Desktop + CLI install entry:

- macOS `.zip` is required by updater metadata.
- macOS `.dmg` is an app-bundle artifact and does not install the CLI link.
- Linux `.AppImage` and `.tar.gz` are portable/debug artifacts and do not install global commands.

The Linux `.deb` depends on the system `bubblewrap` package. Linux portable artifacts require users to install Bubblewrap separately.

The product release also publishes the minimal remote Browser Host for every supported OS/architecture:

- `synergy-browser-host-{darwin|win32|linux}-{x64|arm64}-${version}.zip`
- the matching `.manifest.json`
- the matching `.manifest.json.sig`

Each manifest is Ed25519-signed and contains the exact Synergy version, Browser protocol version, SHA-256, byte size, release URL, and executable path. The standalone server downloads a Host only when WebRTC presentation is first required, verifies the embedded public key, signature, digest, version, and protocol, and atomically extracts it below `Global.Path.data/browser/host`. Desktop installations use their built-in broker and do not download this artifact for local native presentation.

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
- `CSC_INSTALLER_LINK`
- `CSC_INSTALLER_KEY_PASSWORD`

Windows (optional; configure both values to sign artifacts):

- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

When both Windows values are absent, the release produces unsigned Windows artifacts. A partial Windows signing configuration fails validation.

GitHub upload/update feed:

- `GITHUB_TOKEN` or `GH_TOKEN`

Browser Host artifact trust:

- `BROWSER_HOST_MANIFEST_SIGNING_KEY` — base64 PKCS#8 Ed25519 private key used only by the release matrix
- `BROWSER_HOST_MANIFEST_PUBLIC_KEY` — base64 raw Ed25519 public key embedded in product runtime binaries

PR/package validation works without signing secrets. A product Release validates every required signing secret before publishing a candidate and verifies that the Browser Host private/public key pair matches.

## GitHub Actions Flow

Product release keeps the existing candidate/finalize model:

1. `stable_sandbox_assets` builds Linux x64/arm64 helpers for glibc and musl plus the Windows x64 helper, then uploads target-keyed assets. It never commits generated hashes.
2. `stable_candidate` validates signing material, downloads the helper assets, runs `script/release/stable-start.ts`, publishes npm candidates, builds core runtime assets, creates the draft GitHub Release, and uploads release state. Missing helpers or Browser Host trust material fail before publication.
3. `stable_desktop_package` runs a three-way desktop matrix for macOS, Windows, and Linux. macOS and Linux build x64/arm64 Desktop artifacts; Windows builds x64 Desktop artifacts. Every platform still builds x64/arm64 minimal Browser Host zips.
4. Each desktop matrix job rewrites package versions to the candidate version, builds matching Synergy runtimes with the Browser Host public key and helper hash embedded, packages Desktop, signs each Browser Host manifest with the independent Ed25519 signing key, and uploads the full platform bundle.
5. `stable_desktop_publish` downloads all desktop artifacts, generates `Synergy-${version}-checksums.txt`, and uploads the desktop assets to the draft GitHub Release.
6. `stable_finalize` verifies npm candidates, runtime assets, recommended Desktop installer artifacts, portable artifacts, checksum, and updater metadata by reading the draft GitHub Release assets, then promotes npm tags and publishes the GitHub Release.

## Failure Recovery

- If desktop packaging fails before upload, rerun the failed `stable_desktop_package` matrix job.
- If desktop upload fails, rerun `stable_desktop_publish`; it uses `gh release upload --clobber`.
- If checksum generation is wrong, delete the checksum asset from the draft release, rerun `stable_desktop_publish`, then rerun finalize.
- If notarization or code signing fails, verify the signing secrets and rerun only the affected platform matrix job before finalize.
- If Browser Host manifest signing fails, verify that the private/public key pair matches, rerun every platform matrix job, and replace all Host zip/manifest/signature assets together. Never reuse a manifest for a rebuilt zip.
- If finalize fails because desktop assets are missing, do not publish the draft release manually; restore the missing assets first, then rerun `stable_finalize`.

## Validation Checklist

- `bun run release:test`
- `bun run --cwd packages/desktop desktop:test`
- `bun run --cwd packages/desktop desktop:build`
- `bun run --cwd packages/desktop test:runtime`
- `bun run --cwd packages/desktop browser-host:dist`
- `cd packages/desktop && SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME=1 bunx electron-builder --dir --publish=never --config electron-builder.json` for config-only CI validation
- Install `.pkg`, `.exe`, and `.deb` in platform runners or VMs and check `synergy --version` plus `synergy doctor`
- Confirm every Linux/Windows runtime archive contains `sandbox/synergy-sandbox-*` and `synergy doctor` reports a verified helper
- Confirm Linux `.deb` installs Bubblewrap and portable Linux checks report a clear prerequisite when it is absent
- Confirm the packaged macOS Dock badge, Windows taskbar overlay, and Linux launcher/tray indicators appear for unread completion notices and clear after acknowledgement
- Confirm Windows does not expose internal runtime helper binaries through PATH
- Confirm Linux provides both `/usr/bin/synergy-desktop` for the desktop shell and `/usr/bin/synergy` for the runtime CLI
- Draft GitHub Release contains all expected recommended installer artifacts, portable artifacts, checksum, and updater metadata before finalize
- Draft GitHub Release contains six Browser Host zips, six exact-version manifests, and six signatures; tampered zip/signature tests pass before finalize
