# Explicit background waited for automatic yield

## Executive summary

`background: true` was documented but ignored by the native Bash wait. Interactive commands could wait for input while the caller still lacked their process identity. Explicit background requests must use the existing tracked-process branch immediately after real start.

## Summary

A cloud execution acceptance fixture initially used the public background option and stalled before process interaction. Inspection found that the wait only consumed `yieldSeconds` and the automatic deadline. A separate native behavioral test reproduced the mismatch without organization transport.

## Timeline

The native child reached its real output/stdin barrier, but the tool remained pending. The first test observation used a background-only registry list and was corrected to the active-process owner. The resulting behavioral failure preceded the production change. The fix resolves the existing background wait for an explicit request and accurately labels its result.

## Root cause

The public schema and parameter type included the option, while the backend's wait ignored it. Automatic backgrounding worked, so callers using a short yield did not exercise the declared immediate behavior.

## Guardrails

The owning Environment Bash suite verifies the real process identity and running native operation before fixture cleanup. Normal completion, split UTF-8 output and refusal after pause remain covered alongside explicit background execution.

## Lessons

A declared tool parameter needs an effect-level behavioral assertion. Reusing automatic yielding in a fixture cannot establish the explicit parameter's semantics.
