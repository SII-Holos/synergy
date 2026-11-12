# CLI reference merged unrelated command names

## Executive summary

The CLI reference generator keyed detail sections by leaf command name. Adding a second `serve` or `register` silently replaced another group's description and options. Reference generation succeeded while documenting the wrong invocation.

## Summary

The command table tracked top-level ownership, but detailed blocks shared a global map. Source discovery also reached neighboring declarations that were not necessarily registered under that owner. The ambiguity affected organization commands and existing resource, secret and debugging groups.

## Timeline

The new Runtime `serve` command replaced the organization service's `--origin` and `--web` with `--kind`. A generated-artifact regression failed because `org serve` and `org-runtime serve` were not separately present. Static symbol resolution through actual builder registrations, imported arrays and declared contributions retained both paths and their own options. Existing contribution tests also preserved Data aliases and Plugin Kit exports.

## Root cause

A declaration's leaf name is not its CLI invocation. Neither a global name map nor every command reachable through imports establishes its registered parent.

## Guardrails

Follow actual builder registrations and explicit contribution selections without importing command modules. Keep each complete invocation path, reject conflicting registrations at that path, and test separate options for identically named commands. Bind the static compiler host only to the collected CLI source graph. Regenerate the reference through its owner rather than editing generated Markdown.

## Lessons

Generated documentation needs behavioral checks for the published artifact. Successful generation cannot prove that distinct registered commands retained their parameters.
