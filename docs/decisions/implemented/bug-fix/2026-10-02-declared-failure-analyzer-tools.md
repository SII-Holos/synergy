# Decision Record: Honor declared tools in failure analyzers

Status: implemented

## Problem

The loop selected parts from each registered failure analyzer's tool set, but the record builder filtered them again against the built-in search set. A custom category could register successfully and receive no completed or errored records.

## Decision

Pass the analyzer's declared set into the shared record builder. Direct search callers retain the built-in set as the default. Completed results retain explicit failure metadata and errored results retain the existing diagnostic classification.

## Alternatives considered

**Add every custom tool to the built-in search set.** This conflates independently registered categories and requires generic Core edits for each host tool.

**Duplicate record classification in the loop.** This creates two classifiers that can disagree about failure semantics.

## Consequences

Runtime-specific analyzers receive only their declared tools. The change does not alter thresholds, Agent filters or injection ordering. Regression tests persist both completed and errored custom-tool parts in an owned Runtime before detecting the signal.
