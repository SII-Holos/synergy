# Discovery connectivity was reported as identity change

## Executive summary

An organization discovery request could fail to reach its server and still show an organization or account replacement warning. The authorization flow now reports connectivity failure before validating a successful discovery response.

## Summary

A real two-organization browser fixture observed a closed discovery connection. The generated SDK returned an error result without discovery data; parsing the missing data classified it as an invalid authority response. The page then advised connecting a new space.

## Timeline

A focused regression reproduced the incorrect classification for a rejected network request. The correction and its HTTP-unavailable neighbor passed with the existing popup, cancellation and authority validation tests.

## Root cause

Discovery response parsing ran before checking whether the HTTP exchange succeeded. The generated client's returned error did not throw into the surrounding transport catch.

## Guardrails

The authorization owner first requires a successful HTTP response. Network failures and unsuccessful HTTP responses use the existing unavailable state, close the pending popup and release its listener. Successful but malformed or mismatched discovery responses retain their existing rejection behavior.

## Lessons

Generated clients can return transport errors as values. Check availability before interpreting missing response data as an identity mismatch.
