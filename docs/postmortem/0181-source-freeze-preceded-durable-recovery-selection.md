# Source freeze preceded durable recovery selection

## Executive summary

A recovery process killed after Source freezing and before saving its Reference left no supported cold preparation path. The original Source remained safely held, but the same CLI could not complete recovery. Recovery needs its original native preparation identity before the Reference exists.

## Summary

The command recognized a saved Reference and resumed its original retirement. An earlier crash retained an empty private work directory and frozen Source without that selector. Treating the directory as an incomplete arbitrary attempt preserved data but also rejected the original operation.

## Timeline

A real CLI child reached the original frozen operation and was killed before capture. The independent same-argument CLI retry failed while Source, Target and key material remained intact. The native preparation witness and restricted Service opener allowed the same retry to capture and save its Reference, then finish through the original pending-retirement owner. The saved-Reference fault regression moved its injection to the real retirement reservation without removing its original assertions.

## Root cause

The maintenance operation did not retain the original Target/work selection before checkpoint capture. The cold retry therefore could not distinguish a genuine incomplete preparation from an unrelated partial directory without borrowing a dead process's lease.

## Guardrails

The subprocess test kills an actual CLI after native freezing and checks original maintenance, Source and Target identities, retained key material and final ready state with execution disabled. Existing tests cover saved-Reference failure, lost SQL publication acknowledgement, partial native completion and arbitrary partial work. Kernel tests deny legacy-witness promotion and retirement or release through a cold capture lease.

## Lessons

A durable terminal selector does not cover the earlier native preparation window. Preserve the original operation before effects, and let each later owner require its own complete evidence. Partial H1 capture and external native configurations remain separate acceptance cases.
