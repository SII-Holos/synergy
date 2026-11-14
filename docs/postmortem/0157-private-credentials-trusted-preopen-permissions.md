# Private credentials trusted preopen permissions

## Executive summary

The new infrastructure loader checked private permissions before opening its credential file, but did not check permissions on the actual descriptor. A same-inode permission change between those operations could return credentials from a file that was already public when opened.

## Summary

The loader already rejected links, replacement identities, oversized content and changes during reading. Its initial path permission check did not establish the permissions of the opened file.

## Timeline

Review added an actual filesystem regression: after path inspection and before the real open, change the same file from mode 0600 to 0644. The original implementation returned PostgreSQL options. Checking actual descriptor permissions rejected the input; all four infrastructure tests and 22 assertions then passed. The service archives were rebuilt and installed outside the checkout again.

## Root cause

The descriptor's identity matched the earlier path, and its timestamps stayed stable after opening. Those checks therefore accepted a permission change completed before the descriptor's first stat.

## Guardrails

Validate private mode on the initial and final descriptor stats and the retained path alongside identity and metadata. Keep bounded reads and reject uncertain files without exposing contents or paths in errors. The regression changes the real file before delegating to the real open; it does not substitute descriptor results.

## Lessons

A preopen path check cannot establish descriptor permissions. Validate the property on the filesystem object actually used for the read.
