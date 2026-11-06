# Decision Record: Preserve history message windows

Status: implemented

## Problem

Locate and reconnect rebuild a history window with `replace`. That rebuild started from an empty message list, so a still-pending optimistic root disappeared even though the server page cannot contain it. Kanban, prefetch, and any other shared latest `messagePage` also write the same session window. Once the session was in history mode, that latest page replaced the visible slice, its cursors, and its part buckets.

## Decision

`planMessagePageApply` keeps a still-pending optimistic root when a history apply uses `replace`, without recording it as a new unseen arrival. A named `mode` of `"latest"` or `"history"` still owns the window: return-to-latest, refresh, and compaction may replace it. A call that omits `mode` is a shared latest page. When the current window is already history, the result is `preserved-history`: the caller may seed the latest Context projection and must not write messages, cursors, or parts. The session loader always names a mode. Kanban and prefetch follow the preserved result.

## Alternatives considered

**Leave the optimistic root only in `pendingLatestIds`.** That flag is the unseen-arrival notice for history mode. The root was already visible, and locate or reconnect would remove the message the user had just sent.

**Refuse every latest page while history mode is active.** Return-to-latest, explicit refresh, and compaction must still replace the visible window. Only shared loaders are refused.

**Give Kanban a separate message window.** The board and the session reader share one scope window. A second copy would diverge on events, parts, and eviction. The shared window stays; shared applies stop displacing history.

## Consequences

A pending optimistic root survives locate and a reconnect retained window, including when the located page already fills the cap. Shared latest pages leave a history window's messages, metadata, and parts in place and can still publish latest Context usage. Authoritative latest applies and ordinary history prepends keep their previous behavior. The rule is in [frontend data sync](../../../architecture/frontend-data-sync.md).
