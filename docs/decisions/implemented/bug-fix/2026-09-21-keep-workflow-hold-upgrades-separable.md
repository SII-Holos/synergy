# Decision Record: Keep workflow hold upgrades separable from historical import

Status: implemented

## Problem

The retired BlueprintLoop waiting-status migration had no execution classification. The central migration planner therefore treated it as a shared historical barrier, disabling deferred import even for released stores with no held loops. Startup waited for unrelated conversation history before admitting new work.

## Decision

The BlueprintLoop migration explicitly runs at startup. It converts global loop records and latches resident sessions; the existing owner-local session migration converts the matching historical Blueprint phase and preserves its hold when that owner is imported. Recovery may prepare an individual held owner without importing unrelated history.

## Alternatives considered

**Run after historical convergence.** This leaves retired loop statuses visible to current workflow readers, whose transition table no longer accepts them.

**Stage every historical owner first.** This makes a global workflow metadata conversion defeat bounded startup for all users, including those with no loops.

## Consequences

The released 3.0.22 fixture and its real completion ledger remain the eligibility baseline. A second fixture adds the retired waiting loop and bound session shape, verifies the loop and pause conversion, admits new work while unrelated history remains pending, and then imports that history explicitly. No migration IDs or completion-ledger semantics change.
