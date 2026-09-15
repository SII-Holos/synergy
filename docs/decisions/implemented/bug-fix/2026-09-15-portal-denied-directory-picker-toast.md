# Decision Record: Surface Linux portal denial for the native directory picker

Status: implemented

## Problem

When Synergy Desktop is launched from a shell whose primary group was changed with `newgrp` (the `newgrp docker` pattern), every `org.freedesktop.portal.FileChooser` method call is rejected by xdg-desktop-portal with `AccessDenied: Portal operation not allowed: Unable to open /proc/<pid>/root`. The portal inspects the caller by opening `/proc/<pid>/root`, which the kernel gates behind `ptrace_may_access(PTRACE_MODE_READ_FSCREDS)`; a primary-GID mismatch between the Electron process and the portal service fails that check. Chromium 148 (embedded by Electron 42) maps the failed D-Bus method call to `ResponseError::kMethodCallFailed` and cancels the dialog, so `dialog.showOpenDialog` resolves `{canceled: true}` — indistinguishable from the user pressing Escape. The renderer therefore showed no feedback at all: the "Add project" button silently did nothing (SII-Holos/synergy#1396).

## Decision

The desktop main process now probes portal reachability before opening the native directory picker, and a detected denial is reported to the renderer as a permission failure with an actionable toast.

`apps/desktop/src/portal-probe.ts` runs one read-only `gdbus call --session --dest org.freedesktop.portal.Desktop --method org.freedesktop.portal.Settings.ReadAll` (Linux only, 3 s timeout) and classifies the result as `allowed`, `denied` (an `AccessDenied` / "Portal operation not allowed" reply), or `unavailable` (missing tooling, unknown failure). `ReadAll` traverses the same `g-authorize-method` caller inspection as `FileChooser`, so it fails identically in the broken environment; portal `Properties.Get` and `Introspect` bypass authorization and would false-positive.

`selectDirectoryWithNativeDialog` consults the probe after its existing authorization checks. A `denied` verdict returns a `{denied: true, message}` response variant instead of calling `showOpenDialog` (whose cancel-shaped result cannot be distinguished from a user cancel). `allowed` and `unavailable` proceed unchanged, so non-Linux platforms and hosts without `gdbus` keep their existing behavior. The probe verdict is cached for the desktop run because process credentials are fixed at exec time; only `unavailable` results are retried.

The preload bridge passes the denial variant through `mapSelectDirectoryDialogResponse` as plain `{denied: true, message}` data instead of raising an error, because the packaged app copies rejected promises across the `contextBridge` world boundary and that copy normalizes a custom `Error.name`, which would make a name-based sentinel unreliable. The web picker model detects the denial object and maps it to a dedicated error toast (`app.dialog.directory.toast.pickerDenied` / `pickerDeniedHint`, translated for zh-CN) explaining the changed-primary-group cause and the restart-from-a-normal-desktop-session recovery; every other rejection keeps the existing generic picker-failure toast. All picker toast copy is translated at use time through the active Lingui runtime supplied by the picker hook, never from the descriptor fallback text.

## Alternatives considered

**Extend the IPC response contract into a full structured failure taxonomy.** Adding first-class error categories to `selectDirectoryDialogResponseSchema` would preserve arbitrary failure kinds end to end, but Electron 42 loses the underlying D-Bus error before the main process ever sees it, so the contract could only carry the single failure we can actually detect today. The denial sentinel ships the same user-visible outcome with a much smaller contract change; the taxonomy can still be added if more failure classes become detectable.

**Report every dialog rejection instead of probing.** Treating any `showOpenDialog` failure or cancel-shaped anomaly as an error would require no probe, but the canceled shape is the normal user-cancel path on every platform, so every false positive teaches users to ignore the warning and risks flagging ordinary cancels as permission errors. The probe isolates the one condition that is provably broken before the dialog opens.

**Fall back to the server directory browser when the probe denies.** The server-browser path does not traverse the portal and would keep the feature usable, but it changes which filesystem is browsed relative to what the user asked for and masks the environment problem instead of surfacing it. The issue explicitly asks for an actionable explanation; automatic degradation can be a follow-up if users want it.

**Treat this as an upstream-only problem.** The silent cancel originates in Chromium (`VLOG(1)` on `kMethodCallFailed`), and GTK has the same silent-failure FIXME in `gtkfilechoosernativeportal.c`, but users meet the symptom in Synergy. Reporting upstream (flatpak/xdg-desktop-portal#1490 documents the mechanism class; the `newgrp` primary-GID trigger is not yet documented there) is worth doing alongside, not instead of, the local fix.

## Consequences

Users who launch Synergy from a `newgrp` shell now get an explicit, localized permission toast with a recovery path instead of a dead button; the generic failure toast remains for unrelated picker errors. The main process gains one cheap, read-only, Linux-only portal round-trip (cached after the first picker use; skipped entirely off Linux), and no sandbox, permission, or portal policy is weakened. The bridge response type is a wider union than the strict dialog response schema, so any future consumer of `dialog:select-directory` must handle the denial variant; the desktop handler in `main.ts` needed no change. The probe is one more dependency on `gdbus` being installed (present on every GNOME session via glib2); when it is missing the picker behaves exactly as before.
