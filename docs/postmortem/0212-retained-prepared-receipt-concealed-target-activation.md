# Retained prepared receipt concealed target activation

## Executive summary

A destination could report its earlier prepared receipt as complete while an accepted activation was still running. Track the actual activation through its owning job registry and distinguish earlier receipts from that job's terminal outcome.

## Summary

Strict original-operation reconciliation rejected a terminal result after native-directory activation. The original observation did not retain which binding, revision, purpose or signature check failed. Source inspection found that preparation and preview registered in-flight jobs while activation did not. A controlled real destination fixture reproduced the resulting predecessor-state error without a lost signature or malformed proof.

## Timeline

- The original native-directory acceptance reached activation and failed strict terminal-fact validation after a fresh inspection.
- The destination fixture retained a genuine prepared receipt and held the next accepted activation at its original mapping callback.
- Original inspection returned complete/target-prepared while the activation callback remained held. The behavioral test failed at the required working state.
- Tracking the original activation through settlement passed the same held callback control and the native-directory integration, with strict final proof checks retained.

## Root cause

The inspection owner selected permanent receipts independently of a later activity that its registry did not represent. A valid predecessor receipt therefore looked terminal to observers reconciling an uncertain later operation. The completion helper correctly refused to treat that receipt as activation success.

The activity registry retains the exact accepted activation promise and removes only that promise after settlement. Existing activation checks, atomic Epoch publication and retained terminal receipts keep their original owners. Only preparation jobs carry a preparation-abort controller; retirement does not gain authority to cancel activation by observing it in the same registry.

## Guardrails

- [x] Machine check: `packages/organization-runtime/test/handoff-target.test.ts` — cold prepared owner, original held activation, private Sessions and prepared Epoch before release, then exact activated receipt.
- [x] Machine check: `packages/organization-runtime/test/handoff-native-existing.test.ts` — existing-directory adoption and original changed-target/replaced-source rejection controls.
- The [destination ownership decision](../decisions/implemented/architecture/2026-11-12-prepare-and-adopt-native-handoff-destinations.md) defines accepted activity and permanent-fact precedence.

## Lessons

Inspect each actual operation's lifetime independently of retained evidence from its predecessors. Observation must remain separate from operation-specific cancellation authority. Preserve the strict final proof validator when repairing activity reporting.
