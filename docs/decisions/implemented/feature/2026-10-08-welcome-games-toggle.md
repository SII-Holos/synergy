# Decision Record: Welcome games toggle

Status: implemented

## Problem

The new-task greeting randomly lazy-loads one of four interactive mini games (Tiny tower, Pixel slingshot, Falling blocks, Pixel squadron) whenever a session composer is shown in interactive mode. For users who treat the composer as a work entry point, the animated scene and its keyboard/pointer hooks are a distraction, and the scene bundle is fetched even when never played. There was no supported way to turn the games off without giving up the greeting entirely.

## Decision

A new optional boolean preference `welcomeGames` (default: enabled) lives in the workbench `ConfigShape` next to the other UI behavior preferences and is owned by the `general` config domain (`00-general.jsonc`), so it merges, imports and reloads through the existing domain machinery. The server bootstrap UI-preference projection whitelists the key so the Web app receives it in `sync.data.config` with the rest of the general preferences, and the generated SDK and configuration reference document it.

The Settings General panel renders a "New task games" switch in the Behavior section, wired through the standard settings form pipeline (`UI_DEFAULTS`, `GeneralStore`, `defaultSettingsState`, `ensureInit`, `buildGeneralPatch`) exactly like the adjacent `compactReasoning` boolean, and the settings catalog lists the row so search can find it.

`NewSessionGreeting` gates its interactive branch on the preference in addition to the existing interactive eligibility: when `welcomeGames` is `false` the plain greeting fallback renders instead of `WelcomeStage`, so no scene module is loaded, no ambient animation mounts, and none of the game's input listeners are installed. An unset preference preserves the previous behavior.

The plain greeting reuses the shared `.session-greeting` block, which is styled for the existing-session empty view (left-aligned, no stage padding). A scoped `.session-welcome-region > .session-greeting` rule mirrors the welcome stage's presentation for the new-task container — full height with the same responsive top padding, centered content capped at 50rem, and centered starter actions — so both branches of the greeting occupy the same visual position and only the scene below changes.

## Alternatives considered

**Frontend-only persisted flag.** A localStorage preference would avoid the config schema change, but it would not follow the user across browsers or deployments, would bypass the domain-owned Settings save flow that sibling UI preferences (activity display, workspace default, toast) use, and could not be set through config files or import.

**Remove the games entirely.** The scenes are an intentional product touch other users enjoy; removal is a product decision beyond a distraction report. A preference keeps the default experience intact.

**Respect only `prefers-reduced-motion`.** The stage already pauses motion under that media query, but it still loads the scene bundle, mounts the canvas and keeps the game status control; that addresses motion sensitivity, not the general distraction request.

## Consequences

Users can disable new-task games from Settings → General or by setting `"welcomeGames": false` in the general config file; the change applies through the normal config reload and immediate UI preference sync without a restart. The default remains unchanged, so existing users see no difference until they opt out.

The gate sits at the greeting branch, so disabling also skips the `AmbientField` portal and scene selection persistence; re-enabling restores the previous random scene draw. The four scene modules remain bundled and untouched, and the welcome stage's own behaviors (error boundary, reduced-motion pause, editing pause) are unaffected when the preference stays enabled.
