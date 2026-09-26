# Decision Record: Preserve session decision recovery

Status: implemented

## Problem

Question and permission controls could issue duplicate decisions, inherit answers across requests and lose asynchronous failures. Startup failures retained active steps and discarded structured causes.

## Decision

Key decisions by Session and request, retain selections and diagnostics, lock pending actions, and reconcile pending server requests before retry. Separate saved submission from execution initialization, terminate failed step motion and reconcile input status before a recovery action.

## Alternatives considered

A toast-only failure loses the request context. Blind retries cannot distinguish failed delivery from a lost successful reply. Component identity alone does not isolate two requests rendered through one retained surface.

## Consequences

Generated SDK operations remain Scope-aware. Browser tests exercise retained choices, request replacement, lost permission responses, failed startup and narrow layouts.
