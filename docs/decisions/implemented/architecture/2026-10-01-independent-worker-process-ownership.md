# Decision Record: Independent worker process ownership

Status: implemented

## Problem

OwnedProcess required a Workspace access lease even when a host launched a trusted runtime worker with no model-visible Workspace. A synthetic Workspace lease could not establish the host's actual durable ownership or preserve uncertainty after supervisor loss.

## Decision

OwnedProcess accepts an explicit ownership callback. Before command activation it supplies the native process-tree reference for durable binding. The public reference inspector and termination operation reuse the same platform ownership implementation as Workspace execution. Existing Workspace leases remain owners of Workspace commands through this interface.

## Alternatives considered

A second worker launcher would duplicate activation, byte drainage, cancellation and platform liveness. Fabricated Workspace leases conflate physical process ownership with resource access. Root-PID checks cannot prove that escaped descendants have exited.

## Consequences

Hosts persist the reference before activation and release their claim only after verified whole-tree exit. Inspection may report uncertainty and must not trigger takeover. Release runs before private completion receipts are removed. The standalone worker test proves this without Workspace coordination. The Linux native suite additionally proves lost-supervisor uncertainty, cancellation readiness and persisted kernel completion; the macOS process and Workspace suites cover the existing ownership path. Windows behavior still requires its platform suite on Windows.
