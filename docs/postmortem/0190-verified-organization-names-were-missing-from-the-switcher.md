# Verified organization names were missing from the switcher

## Executive summary

The organization header displayed its verified name while the space switcher continued displaying the issuer hostname. The metadata response now updates the connection's existing name field under the original space view's lifetime.

## Summary

A real two-organization browser case successfully authenticated to both Services and opened their isolated project pages. Returning to the first organization through its visible name failed because the menu still contained only its hostname and account label.

## Timeline

The full Web regression reproduced the missing menu name after both successful logins. Inspection found an existing connection-name owner that the workspace metadata reader never called. The regression requires both verified organization names for repeated switches while retaining project isolation, personal drafts and late-response checks.

## Root cause

The workspace shell kept the organization name only in a component-local signal. The existing space registry, trigger and menu could not observe that value.

## Guardrails

The successful authorized metadata reader updates the existing registry using its captured space key. Its original view's abort signal and organization identity gate the result before either name is published. Hostnames remain a fallback before metadata arrives. This changes presentation metadata without replacing a connection, refreshing credentials or starting another request.

## Lessons

Publish shared identity labels through their existing owner so headers and navigation agree. A successful page render does not establish that returning through the surrounding shell works.
