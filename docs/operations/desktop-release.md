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

`desktop:pack` and `desktop:dist` build the Electron main/preload bundles, prepare a current-platform Synergy runtime with the Web application, schema, and native runtime assets, and run `electron-builder`. Release workflows build the exact runtime targets with `SYNERGY_BUILD_TARGETS`, run the same runtime preparation step, and inject each complete runtime with `packages/desktop/script/after-pack.cjs`. Packaging fails before copying when the runtime lacks its executable, `app/index.html`, schema, required sandbox helper, or a valid `runtime-manifest.sha256`.

Native unread indicators use `build/unread-overlay.png` for the Windows taskbar overlay and `build/icon-unread.png` for the Linux tray fallback. `electron-builder.json` copies both fixed assets into `resources/icons`; keep the source assets and packaging assertions together when changing their runtime paths.

## Release Artifacts

Recommended Desktop installer artifacts:

- `Synergy-darwin-x64-${version}.pkg`
- `Synergy-darwin-arm64-${version}.pkg`
- `Synergy-win32-x64-${version}.exe`
- `Synergy-linux-amd64-${version}.deb`
- `Synergy-linux-arm64-${version}.deb`
- `Synergy-${version}-checksums.txt`
- `Synergy-${version}-cli-checksums.txt` — SHA-256 of every CLI runtime archive (`synergy-*` and `synergy-link-*`), generated and uploaded by `stable_candidate`

Windows ARM64 Browser Host artifacts remain published, but the full Windows ARM64 Desktop/runtime is not a Stable target until all native runtime dependencies are available for that architecture.

Portable and updater artifacts are still published but are not the full Desktop + CLI install entry:

- macOS `.zip` is required by updater metadata.
- macOS `.dmg` is an app-bundle artifact and does not install the CLI link.
- Linux `.AppImage` and `.tar.gz` are portable/debug artifacts and do not install global commands.

Linux x64 artifact names follow each format's native architecture label: `amd64` for `.deb`, `x86_64` for `.AppImage`, and `x64` for `.tar.gz`.

The Linux `.deb` depends on the system `bubblewrap` package. Linux portable artifacts require users to install Bubblewrap separately.

The product release also publishes the minimal remote Browser Host for every supported OS/architecture:

- `synergy-browser-host-{darwin|win32|linux}-{x64|arm64}-${version}.zip`
- the matching `.manifest.json`
- the matching `.manifest.json.sig`

Each manifest is Ed25519-signed and contains the exact Synergy version, Browser protocol version, SHA-256, byte size, release URL, and executable path. The standalone server downloads a Host only when WebRTC presentation is first required, verifies the embedded public key, signature, digest, version, and protocol, and atomically extracts it below `Global.Path.data/browser/host`. Desktop installations use their built-in broker and do not download this artifact for local native presentation. Manifest generation opens the completed ZIP before hashing or signing and fails unless the declared executable entry exists. The exact paths are `Synergy Browser Host.app/Contents/MacOS/Synergy Browser Host` on macOS, `Synergy Browser Host.exe` on Windows, and `synergy-browser-host` on Linux. Electron Builder executable names and manifest paths must continue to derive from this shared release contract.

The same release also publishes signed Chromium installation metadata for `darwin-x64`, `darwin-arm64`, `win32-x64`, `linux-x64`, and `linux-arm64`:

- `synergy-chromium-{platform}-{arch}-${version}.manifest.json`
- the matching `.manifest.json.sig`

Each Chromium manifest binds the Synergy version and target to the exact Playwright-pinned browser version, revision, upstream archive URL, executable path, SHA-256, and byte size. Release runners download and hash only their own platform archives; the Chromium archives remain on the Playwright CDN. `synergy browser install` verifies the signed manifest and archive before an atomic managed install.

Every packaged runtime also includes the matching Playwright Core package under `browser-runtime/playwright-core`, the platform-independent ONNX Web module and WASM binary under `lib/onnxruntime-web`, and the SVG raster WASM binary plus bundled Noto Sans SC fallback fonts under `lib/resvg-wasm`. The SVG raster sidecar carries its MPL-2.0 license text and exact-version Source Code Form pointer; the fallback fonts carry their OFL-1.1 license. Artifact validation requires all three sidecars, both font subsets, and their notice files. The curl installer and Desktop packaging must preserve these directories so Browser startup, local embedding, and SVG preview rendering never resolve runtime dependencies or fonts from the release runner's checkout.

Every runtime archive and Desktop runtime carries `runtime-manifest.sha256` with one `<sha256>  <relative-path>` entry per line covering the executable, the native helpers (`bin/ast-grep` or `bin/ast-grep.exe`, `vec0.so`, `vec0.dylib`, or `vec0.dll`, and `watcher.node`), `app/index.html`, `schema/config.schema.json`, the Playwright Core and ONNX Web sidecars, the Holos CLI files, and the platform sandbox helper. Release packaging verifies the manifest against the runtime directory before archiving and re-verifies every checksum against the extracted archive contents; Desktop packaging refuses to copy a runtime whose manifest is missing, incomplete, or fails checksum validation. The curl installer verifies each manifest entry (rejecting absolute or `..` paths) on the extracted bundle before replacing the installed runtime, and `synergy upgrade` verifies the installed manifest when present. An archive without a manifest is treated as legacy: the installer accepts it with a warning, and both the installer and upgrade verification fall back to required-file checks.

The curl installer downloads the CLI checksum asset beside the selected archive and verifies that archive before extraction. Manifest-backed releases fail closed when the published checksum is unavailable, malformed, duplicated, or mismatched; historical archives without a runtime manifest remain installable through the legacy required-file contract. The installer uses a private temporary directory, rejects absolute paths, drive-letter paths, parent-directory traversal, backslash paths, and archive symbolic or hard links before extraction, then rejects any extracted symbolic link. It validates the runtime manifest and required-file contract before touching the current installation, backs up the complete managed runtime, verifies the installed copy, and restores the backup if any apply or post-install verification step fails. A successful restore removes the backup; if restoration itself fails, the recovery backup is preserved and its path is reported for manual recovery.

musl Linux archives (`synergy-linux-*-musl`) intentionally exclude `bin/ast-grep` and the `vec0` SQLite vector extension because no musl-compatible release assets exist for them; their manifests omit those entries and runtime preparation removes any residual copies. `watcher.node` is different: @parcel/watcher publishes musl packages, so every Linux target — glibc and musl — ships the watcher binding. glibc Linux, macOS, and Windows archives require all native helpers and fail packaging when any of them is missing.

Updater metadata expected on stable releases:

- `latest-mac.yml`
- `latest.yml`
- `latest-linux.yml`
- `latest-linux-arm64.yml`

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

Windows (optional, enables code signing):

- `WINDOWS_CERTIFICATE` — base64-encoded PKCS#12 certificate provided to `electron-builder` as `CSC_LINK`
- `WINDOWS_CERTIFICATE_PASSWORD` — password provided as `CSC_KEY_PASSWORD`

When both are configured, Windows packaging forces Authenticode code signing and verifies the resulting executable signature before upload. When both are absent, Windows artifacts are built unsigned and the signature verification step is skipped; `electron-builder` verifies update signatures only for signed updates. Providing exactly one of the two secrets fails validation before packaging, so a partially rotated credential never produces an unsigned artifact.

Windows signing is irreversible once enabled: if any previously published release shipped a signed Windows installer, a release without the signing secrets fails validation before packaging, because existing signed installations verify automatic updates against the certificate publisher and would reject an unsigned installer.

GitHub upload/update feed:

- `GITHUB_TOKEN` or `GH_TOKEN`

Browser artifact trust:

- `BROWSER_HOST_MANIFEST_SIGNING_KEY` — base64 PKCS#8 Ed25519 private key used only by the release matrix to sign Browser Host and Chromium manifests; the workflow passes it to the Chromium generator as `SYNERGY_BROWSER_MANIFEST_SIGNING_KEY`
- `BROWSER_HOST_MANIFEST_PUBLIC_KEY` — base64 raw Ed25519 public key passed to runtime builds as `SYNERGY_BROWSER_MANIFEST_PUBLIC_KEY` and embedded in product binaries

PR/package validation works without signing secrets. A product Release validates every required macOS signing secret before publishing a candidate, verifies the one private/public key pair shared by Browser Host and Chromium manifest signing, and additionally validates Windows signing material when configured.

## GitHub Actions Flow

Product release keeps the existing candidate/finalize model:

1. `stable_sandbox_assets` builds Linux x64/arm64 helpers for glibc and musl plus the Windows x64 helper, then uploads target-keyed assets. It never commits generated hashes.
2. `stable_candidate` validates signing material, downloads the helper assets, selects the requested bump after the highest stable version already published by any release-managed npm package, runs `script/release/stable-start.ts`, publishes npm candidates, builds core runtime assets, packages the CLI archives (validating each against its `runtime-manifest.sha256` after extraction), generates and uploads `Synergy-${version}-cli-checksums.txt`, creates the draft GitHub Release, verifies the draft asset names, downloads each published CLI archive and the checksum asset, rejects any missing, extra, malformed, or mismatched checksum entry, and repeats the archive path/link and extracted runtime-manifest validation against the downloaded bytes.
3. `stable_desktop_package` runs a three-way desktop matrix for macOS, Windows, and Linux. macOS and Linux build x64/arm64 Desktop artifacts; Windows builds x64 Desktop artifacts. Every platform still builds x64/arm64 minimal Browser Host zips.
4. Each desktop matrix job rewrites package versions to the candidate version, builds matching Synergy runtimes with the Browser Host public key and helper hash embedded, assembles their Web application, schema, and native runtime assets, packages Desktop, signs each Browser Host manifest with the independent Ed25519 signing key, and uploads the full platform bundle. When Windows signing material is configured, Windows packaging forces Authenticode code signing and verifies that the resulting executable has a valid signature before upload; without it, and only when no previous release was signed, Windows artifacts are built unsigned.
5. `stable_desktop_publish` downloads all desktop artifacts, generates `Synergy-${version}-checksums.txt` for the Desktop artifacts, and uploads them to the draft GitHub Release. The CLI checksum asset is separate and was already uploaded by `stable_candidate`.
6. `stable_finalize` verifies npm candidates, downloads every CLI runtime archive, recomputes its SHA-256 against the published CLI checksum asset, rejects unsafe archive paths or links, extracts it into a private temporary directory, and re-validates its `runtime-manifest.sha256` and required target contract. It then verifies recommended Desktop installer artifacts, portable artifacts, Desktop checksum, and updater metadata from the draft GitHub Release before promoting npm tags and publishing the GitHub Release.

Within that flow, each platform matrix job also generates and signs Chromium manifests for its supported target archives. `stable_desktop_publish` uploads the Browser Host and Chromium manifests, and `stable_finalize` verifies those Browser assets before publication.

Registry read-after-write checks use cache-busted, no-store requests. A successful npm write is not verified through a previously cached version or dist-tag response.

## Failure Recovery

- If desktop packaging fails before upload, rerun the failed `stable_desktop_package` matrix job.
- If desktop upload fails, rerun `stable_desktop_publish`; it uses `gh release upload --clobber`.
- If Desktop checksum generation is wrong, delete `Synergy-${version}-checksums.txt` from the draft release, rerun `stable_desktop_publish`, then rerun finalize.
- If the CLI checksum asset is missing or wrong, replace `Synergy-${version}-cli-checksums.txt` in the draft release (regenerate it from the packaged CLI archives and upload with `gh release upload --clobber`), then rerun `stable_finalize`. Do not rerun `stable_candidate` to fix it: the candidate version is already published, so a rerun computes the next version instead of repairing this draft.
- If notarization or code signing fails, verify the affected platform's signing secrets and rerun only that platform matrix job before finalize. For Windows, confirm that `WINDOWS_CERTIFICATE` is a base64-encoded PKCS#12 certificate, its password matches, and the packaged executable reports a valid Authenticode signature.
- If Browser manifest signing fails, verify that the private/public key pair matches, rerun every affected platform matrix job, and replace the corresponding Host or Chromium manifest/signature assets together. Never reuse a manifest for a rebuilt archive.
- If finalize fails because desktop assets are missing, do not publish the draft release manually; restore the missing assets first, then rerun `stable_finalize`.

## Validation Checklist

- `bun run release:test`
- `bun run --cwd packages/desktop desktop:test`
- `bun run --cwd packages/desktop desktop:build`
- `bun run --cwd packages/desktop test:runtime`
- `bun run --cwd packages/desktop browser-host:dist`
- `cd packages/desktop && SYNERGY_DESKTOP_ALLOW_MISSING_RUNTIME=1 bunx electron-builder --dir --publish=never --config electron-builder.json` for config-only CI validation
- Install `.pkg`, `.exe`, and `.deb` in platform runners or VMs and check `synergy --version` plus `synergy doctor`
- Confirm every packaged Desktop runtime contains `app/index.html`, `schema/config.schema.json`, and a valid `runtime-manifest.sha256`, and that its managed server returns HTML from `/` after `/global/health` becomes healthy.
- Confirm every Linux/Windows runtime archive contains `sandbox/synergy-sandbox-*` and `synergy doctor` reports a verified helper
- Confirm every CLI archive passes `runtime-manifest.sha256` validation after extraction both during local packaging and after download in `stable_finalize`; unsafe member paths and symbolic or hard links must fail before extraction. musl Linux archives omit `bin/ast-grep` and `vec0.*` but keep `watcher.node`, while glibc, macOS, and Windows archives contain all three.
- Confirm Linux `.deb` installs Bubblewrap and portable Linux checks report a clear prerequisite when it is absent
- Confirm the packaged macOS Dock badge, Windows taskbar overlay, and Linux launcher/tray indicators appear for unread completion notices and clear after acknowledgement
- Confirm Windows does not expose internal runtime helper binaries through PATH
- Confirm Windows product-release packaging signs and verifies the packaged executable when signing material is configured, and that updater signature verification remains enabled
- Confirm a downloaded Desktop update installs only through the explicit install-and-restart action and does not install automatically when the user quits
- Confirm Linux provides both `/usr/bin/synergy-desktop` for the desktop shell and `/usr/bin/synergy` for the runtime CLI
- Draft GitHub Release contains all expected recommended installer artifacts, portable artifacts, both checksum assets (`Synergy-${version}-checksums.txt` and `Synergy-${version}-cli-checksums.txt`), and all four updater metadata files before finalize
- Draft GitHub Release contains six Browser Host zips, six exact-version manifests, and six signatures; every manifest executable exists at its exact platform path inside the matching zip, and tampered zip/signature tests pass before finalize
- Draft GitHub Release contains five exact-version Chromium manifests and five signatures for the supported standalone install targets; signature, target-substitution, and archive-tampering tests pass before finalize.
