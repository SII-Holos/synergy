# Background Bash released native preparation too early

## Executive summary

The real Main handoff acceptance failed during its initial ordinary Native Bash command. Bash had legitimately returned a background result, but tool disposal immediately released preparation still owned by the running process. The original completion guard rejected cleanup.

## Summary

Both real enrolled-runtime scenarios reproduced the same failure before handoff. A held native stdin child then demonstrated the required lifetime: tool disposal closes preparation admission while its policy and execution Use remain until original completion and saving.

## Timeline

The full-chain failure identified premature preparation release. The owning regression passed after cleanup transferred to the process. A separate real copied-resource assertion first failed, then passed after both preparation and retention required the exact registered resource object. Existing process fixtures were updated to supply their original registered Host origin; production origin validation remained strict.

## Root cause

Tool invocation lifetime was treated as native execution lifetime. A background result ends one observer while the process, preparation and accepted resource admission remain live. A structural copy also lacked the new private lifetime guard until exact-object validation was added.

## Guardrails

The original process holds cleanup-only preparation authority bound to canonical identity and provenance. Saving completes before preparation and admission release. New preparation fails after disposal or through a copied object. Pending and unknown executions retain their canonical owners. Real process and preparation neighbors preserve output, saving, checkpoint conflicts and paused stream behavior.

## Lessons

An observer returning cannot release an accepted producer's resources. Final cleanup needs the original private owner and actual saved completion.
