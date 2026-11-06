# Decision Record: Welcome games toggle

Status: implemented

## Problem

The new-task greeting randomly lazy-loads one of four interactive mini games (Tiny tower, Pixel slingshot, Falling blocks, Pixel squadron) whenever a session composer is shown in interactive mode. For users who treat the composer as a work entry point, the animated scene and its keyboard/pointer hooks are a distraction, and the scene bundle is fetched even when never played. There was no supported way to turn the games off without giving up the greeting entirely.

## Decision

A new optional boolean preference `welcomeGames` (default: enabled) lives in the workbench `ConfigShape` next to the other UI behavior preferences and is owned by the `general` config domain (`00-general.jsonc`), so it merges, imports and reloads through the existing domain machinery. The server bootstrap UI-preference projection whitelists the key so the Web app receives it in `sync.data.config` with the rest of the general preferences, and the generated SDK and configuration reference document it.

The Settings General panel renders a "New task games" switch in the Behavior section, wired through the standard settings form pipeline (`UI_DEFAULTS`, `GeneralStore`, `defaultSettingsState`, `ensureInit`, `buildGeneralPatch`) exactly like the adjacent `compactReasoning` boolean, and the settings catalog lists the row so search can find it.

`NewSessionGreeting` belongs to the new-task route and gates its interactive branch on the preference: when `welcomeGames` is `false` the plain greeting fallback renders instead of `WelcomeStage`, so no scene module is loaded, no ambient animation mounts, and none of the game's input listeners are installed. An unset preference enables games.

The plain `.session-greeting` shares `WelcomeHeading` with the game stage. Full height, responsive top padding and centered starter actions preserve the introduction's position. Existing Session loading and emptiness use the separate conversation loader, as described in [Session navigation presentation](../bug-fix/2026-10-10-session-navigation-presentation.md).

## Alternatives considered

**Frontend-only persisted flag.** A localStorage preference would avoid the config schema change, but it would not follow the user across browsers or deployments, would bypass the domain-owned Settings save flow that sibling UI preferences (activity display, workspace default, toast) use, and could not be set through config files or import.

**Remove the games entirely.** The scenes are an intentional product touch other users enjoy; removal is a product decision beyond a distraction report. A preference keeps the default experience intact.

**Respect only `prefers-reduced-motion`.** The stage already pauses motion under that media query, but it still loads the scene bundle, mounts the canvas and keeps the game status control; that addresses motion sensitivity, not the general distraction request.

## Consequences

Users can disable new-task games from Settings → General or by setting `"welcomeGames": false` in the general config file; the change applies through the normal config reload and immediate UI preference sync without a restart. The default remains unchanged, so existing users see no difference until they opt out.

The gate sits at the greeting branch, so disabling skips the `AmbientField` portal, the lazy scene module load and the greeting mount. Scene selection still runs: new-task navigation calls `welcome.begin()` unconditionally, which draws the rotating scene and writes it to sessionStorage, so re-enabling resumes from the same selection cycle instead of restarting it. The four scene modules remain bundled and untouched, and the welcome stage's own behaviors (error boundary, reduced-motion pause, editing pause) are unaffected when the preference stays enabled.

The greeting DOM suite runs in its own browser process through the App runner. It mounts the real welcome stage and production styles, observes zero scene loads for an explicit opt-out, and exercises reactive disabling and re-enabling with ambient portal teardown. The plain greeting also retains reachable starter actions through native Tab, Enter and Space navigation in light and dark themes at narrow and short viewport sizes. Settings tests retain default hydration and unchanged-patch coverage.
