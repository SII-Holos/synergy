# Decision Record: Runtime shutdown after terminal WebSocket completion

Status: implemented

## Problem

A completed terminal can close its WebSocket and save its files while the enclosing Runtime never finishes closing. The pinned Bun server retains a closed WebSocket and its stop promise does not resolve, preventing controller recovery and clean process exit.

## Decision

Source development, CI, release builds, published runtime package requirements and the Execution Host image use Bun 1.4.2. The full-product regression opens a real terminal, receives its complete output, observes the server closing the socket, awaits Runtime closure and requires the child process to exit. A bounded observer kills only its own failed child and treats that deadline as a failure.

The regression reproduces the failure on Bun 1.3.14 and passes on Bun 1.4.2. The upstream [server-side close issue](https://github.com/oven-sh/bun/issues/36223) describes the same minimal server defect. The selected [stable release](https://bun.sh/blog/bun-v1.4.2) also includes the fix for the earlier 1.4.1 AsyncLocalStorage regression. The runtime package packer records the provenance beside the minimum version. Windows Job handles retain Bun's pointer-or-bigint representation, including handles read from native output buffers, without narrowing them through JavaScript numbers.

Local acceptance freezes the actual executing binary along with source and dependencies. Starting a run under another binary fails before driver side effects. Reports can still audit older frozen experiments without rerunning them.

## Alternatives considered

**Bound or ignore the server stop promise.** This hides an undrained transport and falsely reports successful Runtime closure. The independent process-exit oracle must remain authoritative.

**Use a special terminal close sequence.** Closing through the client works around one trigger but does not cover other ordinary server-initiated closes. The minimal Bun reproduction fails without Synergy, so the fix belongs in the runtime dependency.

## Consequences

Consumers of published runtime packages need Bun 1.4.2 or later. The repository validates one consistent pinned version across local source, CI and distribution builds. The shutdown test requires the native PTY helper and uses no model provider. Runtime dependency changes require fresh frozen acceptance inputs rather than borrowing results from the earlier binary.
