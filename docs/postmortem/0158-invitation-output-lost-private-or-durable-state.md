# Invitation output lost private or durable state

## Executive summary

The initial invitation CLI checked output identity without rechecking its permissions and synced file bytes without syncing their directory entry. A permission change could expose the returned token, and a crash could lose the local marker after a remote mutation.

## Summary

Invitation creation discloses its token once and has no server request identifier for safe automatic replay. Its local output must remain private and be durably discoverable before dispatch.

## Timeline

A real HTTPS regression changed the actual output file from mode 0600 to 0644 after the service created the invitation but before returning its token. The original command succeeded and wrote the token to that public file. Descriptor and retained-path permission checks made the same regression reject the write and keep the token out of stdout. A second regression rejected directory synchronization at the public filesystem owner and verified zero HTTP requests, one retained failed marker and no automatic retry. Four CLI tests and 33 assertions pass with the adjacent private-input tests.

## Root cause

An unchanged inode does not establish private mode. File fsync also does not establish durability of a newly created pathname. The original checks covered the output bytes without proving both properties of the file used to retain them.

## Guardrails

Exclusively publish a prepared mode-0600 temporary file, sync the parent directory, and verify the original descriptor and retained pathname before HTTP. Check both permissions and identity around every subsequent write. Keep unknown outcomes inspectable and refuse any existing output path before another request. Packed executable tests repeat the same real HTTPS scenarios outside the checkout.

## Lessons

One-time secret output needs private byte storage and durable local discovery before the remote effect. A local marker cannot replace a server receipt or make an uncertain mutation safe to repeat.
