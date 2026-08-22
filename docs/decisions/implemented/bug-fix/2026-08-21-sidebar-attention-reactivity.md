# Decision Record: Keep the sidebar update notice branch mounted and reactive

Status: implemented

## Problem

The sidebar update card (`SidebarAttentionNotice`) froze at the first observed progress value. The user saw "Downloading Synergy / 0%" in the sidebar while the Settings page (same underlying `desktopStatus` signal) correctly showed "Downloading update, 87%". The card is rendered through a Solid `<Show when={props.notice}>` whose child eagerly captured the notice object (`const n = notice()`). The non-keyed child body only executes when the condition toggles truthiness; once the notice was truthy (phase `downloading`, percent 0), every later progress event updated the signal without re-running the child, so `n.progress` stayed 0 forever.

## Decision

Keep the `Show` non-keyed and read the notice through the reactive accessor everywhere in the child:

```tsx
<Show when={props.notice}>
  {(notice) => {
    const titleStr = () => __(notice()?.title)
    ...
```

Each reactive read (`notice()?.detail`, `notice()?.progress`, …) re-evaluates when `attention()` in `product-update.tsx` produces a fresh `ProductUpdateNotice`, so the card tracks progress in real time while the DOM branch — including the action button — stays mounted.

## Alternatives considered

- **Keyed `Show` (object identity)**: fixes the frozen progress with a two-line diff, but structurally cannot preserve the DOM branch. `attention()` re-emits a fresh object not only on progress changes but also on **background poll refreshes of the same logical notice** (web: 5-minute `refreshAll()` health poll re-deserializes `serverStatus`; desktop: periodic `check()` spreads a new status object through the event stream). When an actionable notice (phase `available`/`ready`/`error`, button enabled) is keyboard-focused, a poll refresh disposes and recreates the branch and drops focus to `document.body` — violating the keyboard-focus rule in `packages/app/AGENTS.md` (Preserve keyboard focus). Verified with a Playwright probe: focus `BUTTON.sb-attention-button` → `BODY` on a logically identical notice re-emit. Keyed rendering also defeats the `transition: width 220ms` on the progress bar (each update mounts a fresh span with no previous value) and churns the `aria-live="polite"` region.
- **Reading `props.notice` eagerly in the child without any other change**: not enough on its own — the non-keyed child body still only executes on truthiness flips, so the captured value would still be stale.

## Consequences

The sidebar update card tracks download progress in real time (matching the Settings page), the DOM branch stays mounted so keyboard focus survives background poll refreshes, and the CSS width transition animates progress updates. Playwright regression tests (`test/components/sidebar/sidebar-attention-notice.dom.test.tsx`) cover both directions: progress re-renders from 0% to 87% (fails against the pre-fix code), and button focus survives a logically identical notice re-emit with a fresh object identity (fails against the keyed variant). A sibling pattern audit found one structurally similar non-keyed `Show` child in `subagent-dock.tsx` (retry status); its `when` value is a non-reactive snapshot taken inside a tooltip content builder, so it is not affected by either failure mode and was left untouched.
