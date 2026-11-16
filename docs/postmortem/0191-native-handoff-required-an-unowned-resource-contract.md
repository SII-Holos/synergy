# Native handoff required an unowned resource contract

## Executive summary

An explicit native-to-none Environment mapping could freeze, prepare and surrender a real Session, then fail commit because it had no organization resource contract. The coordinator now performs the original resource CAS only when organization resources or an existing contract require it.

## Summary

The actual signed source inspection reported a default borrowed native Environment. Two enrolled Runtimes completed native preparation and surrender with an explicit none target, while the canonical resource selection remained revision zero and null. Commit incorrectly rejected that valid combination.

## Timeline

The real controller regression reached commit and reproduced `HANDOFF_BLOCKED`. After the narrow condition changed, the same flow completed activation, preserved the empty resource contract and left the destination paused with no Environment selected.

## Root cause

The new Environment mapping branch entered organization resource rebinding for every mapping, including pure native and none choices. Its existing contract requirement then rejected a Session that had never selected organization resources.

## Guardrails

Organization selections still use the existing revisioned transaction for both infrastructure roles. Pure native/none mappings retain their original absence of organization resources and still require signed consent, native preparation and epoch activation. The regression uses original inspection and controllers, without creating a resource contract or fabricating completion facts.

## Lessons

A native mapping and an organization resource transaction have different authority owners. Optional resources must remain absent when their owner never granted them.
