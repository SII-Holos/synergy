# Decision Record: Key the sidebar update notice by object identity

Status: implemented

## Problem

The sidebar update card (`SidebarAttentionNotice`) froze at the first observed progress value. The user saw "Downloading Synergy / 0%" in the sidebar while the Settings page (same underlying `desktopStatus` signal) correctly showed "Downloading update, 87%". The card is rendered through a non-keyed Solid `<Show when={props.notice}>` whose child eagerly captured the notice object (`const n = notice()`). Non-keyed `Show` only re-runs its child when the condition toggles truthiness; once the notice was truthy (phase `downloading`, percent 0), every subsequent progress event updated the shared signal but never re-ran the child, so `n.progress` stayed 0 forever. The Settings page reads the signal reactively and rendered every update.

## Decision

Make the `Show` keyed and read the child argument as the value directly:

```tsx
<Show when={props.notice} keyed>
  {(notice) => {
    const n = notice
    ...
```

With `keyed`, the condition memo compares by object identity instead of truthiness. `attention()` in `product-update.tsx` is a `createMemo` that builds a fresh `ProductUpdateNotice` object on every status change, so each progress event produces a new identity and the child re-runs with the latest progress. When the notice disappears (phase returns to idle/checking) the child is torn down as before.

## Alternatives considered

- **Lazy accessor inside the child** (`const n = () => props.notice`, read `n()` in JSX): also correct and idiomatic, but touches every render site in the component. The one-attribute keyed change is the minimal diff.
- **Reading `props.notice` directly in the child without keyed**: not enough on its own — the non-keyed child body still only executes on truthiness flips, so `props.notice` would still be stale.

## Consequences

The sidebar update card now tracks download progress in real time, matching the Settings page. Identity-keyed `Show` re-runs the child on every new notice object; the component body is small and cheap, so there is no measurable render cost. A Playwright regression test (`test/components/sidebar/sidebar-attention-notice.dom.test.tsx`) mounts the component, updates the notice from 0% to 87%, and asserts the progress bar style and detail text follow — it fails against the pre-fix code (progress stuck at 0%) and passes with the fix.
