# Decision Record: Clear organization conversations on owner invalidations

Status: implemented

## Problem

The organization service and Desktop Main return different public error codes for the same loss of access. Clearing only the transcript leaves a parent directory record, Composer and execution controls visible. Concurrent directory polling can then recreate descendants that have already lost their captured reader authority.

## Decision

Use one focused classifier for the documented service, Main and private-read authentication, access and binding errors. Unknown codes, diagnostic text, HTTP status numbers and unrelated nested data do not establish an authority change. Offline state, uncertain command admission and revision conflicts retain their existing recovery paths.

Directory, transcript and interaction readers report a recognized invalidation to the captured conversation owner. The owner clears its directory, sharing and resource presentation together, disposes descendants, fences in-flight directory responses and suspends automatic polling. Explicit Retry reads current authority before mounting a new conversation. Authentication recovery remains bound to the captured space, so a late failure cannot alter a newly selected account.

## Alternatives considered

**Clear only the reader that failed.** This leaves controls whose visibility depends on an obsolete parent record, and later directory polls can resurrect a failed reader.

**Treat every request failure as lost access.** Temporary disconnection and unconfirmed commands require their existing drafts and receipt recovery.

## Consequences

Focused tests exercise canonical and Main errors, preserve unknown and offline outcomes and release still-mounted password drafts on interaction denial. The isolated full-App browser regression covers a lowercase Main directory denial, removal of the title, transcript and controls, and explicit recovery with the retained ordinary Composer draft. Transcript-level denial uses the same parent cleanup rather than creating a separate authorization authority.
