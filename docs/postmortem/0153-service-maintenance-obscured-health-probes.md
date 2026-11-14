# Service maintenance obscured health probes

## Executive summary

Organization health entered ordinary maintenance admission. During a valid frozen hold it returned a generic business error; no separate process liveness endpoint existed. Health checks need their own read-only owner before business admission.

## Summary

The deployment plan requires separate process and admission checks. A real service fixture first observed a missing liveness path, then observed that adding the route alone still returned 503 during maintenance because the enclosing service admission rejected it before routing.

## Timeline

The loopback HTTP regression reproduced the missing route and admission failure. Exact GET/HEAD probes now enter the health owner without business admission while retaining common origin and security-header middleware. The focused health, service and maintenance suites pass together: 22 tests and 110 assertions.

## Root cause

The route's declared response did not control the earlier service admission layer. Reusing that layer for probes also made maintenance suspension indistinguishable from process failure.

## Guardrails

The native HTTP test freezes actual service maintenance, verifies live 200 and ready/legacy health 503 with declared bodies, checks an empty HEAD response, verifies readiness after release, and checks the closed handle without reentering its disposed context. Existing accepted-tail and shutdown tests continue to verify business admission and drainage. Probe reads create no operation tail.

## Lessons

Verify operational probes through the deployed service entry, including its admission wrappers. A handler-only test cannot establish the outer transport response.
