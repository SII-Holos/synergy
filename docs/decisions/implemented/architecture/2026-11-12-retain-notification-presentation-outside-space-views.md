# Decision Record: Retain notification presentation outside Space views

Status: implemented

## Problem

Space selection disposes business views. Completion and error observation must continue without retaining an inactive conversation, replacing the current page or borrowing its route. A source that survives navigation is insufficient when its Toast region still belongs to the disposed personal Layout. Browser permission also introduces an asynchronous interval during which the original source can retire.

## Decision

The App owns one canonical notification provider and Toast region outside selected Space views. Organization connections supply their existing identity-bound live sources. The personal GlobalSDK retains its existing event socket through presentation leases: the last view release clears active content interest and prepared view state, while Runtime replacement disposes the original socket and pending reads. Draft indexes remain lazy. Personal notification history keeps its existing Runtime cache and retention; organization metadata uses the bounded in-memory notification model rather than a durable inbox.

Personal Completion and Error consume the original event source and only request the target Session header for title and child suppression. They do not instantiate GlobalSync or load Scope history merely to notify. The original SDK lifetime guards that metadata request before delivery. Organization messages carry the recipient account, deployment, project and Session; they never reinterpret that identity as a personal Scope.

Platform notification calls accept an optional bodyless activation object containing `current` and `activate`. Browser permission, actual construction and click each check the captured original source. Toast uses that same pair. An activation object forbids fallback to its href after retirement; callers without it retain their original four-argument behavior. Valid activation selects the exact source Space before the ordinary authorized conversation route loads.

## Alternatives considered

**Keep the personal business tree mounted to preserve notifications.** That retains unrelated sync, plugin views, drafts and content interests. A presentation lease preserves only the existing event source.

**Open a second personal notification socket.** That duplicates observation and lifecycle reconciliation. The App reuses the canonical GlobalSDK connection.

**Let a stored href perform notification navigation.** A later login or replaced Runtime can reuse route identifiers. Click-time source checks select the original live identity, and failed checks do not navigate.

## Consequences

The real App browser fixture delivers an organization notice while another organization is selected, verifies unchanged appearance, opens its original account route and observes current authorization requests. It also retires old OS/toast actions, preserves one personal socket across Space changes, checks empty background content interests, suppresses child notices and rejects delayed headers from a replaced Runtime. Narrow light and wide dark screenshots show the ordinary expanded Toast action.

Platform DOM tests hold browser permission and invalidate click sources. The enrolled native fixture drives Completion through authenticated WSS and HTTPS, the generated client and the actual Web subscription adapter without exposing private title or Home content. Browser bridge fixtures and this live transport test establish different parts of delivery; they do not claim an operating-system notification popup or production Electron preload acceptance. Organization disconnection remains ephemeral with no replay of missed intervals.
