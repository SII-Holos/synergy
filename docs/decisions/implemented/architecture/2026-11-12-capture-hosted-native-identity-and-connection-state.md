# Decision Record: Capture Hosted native identity and connection state

Status: implemented

## Problem

The canonical Hosted SQL namespace does not contain its Home reader marker, binding, private machine key, enrollment or monotonic connection checkpoint. Copying only SQL loses these inputs. Normal provisioning can generate a replacement identity and cannot serve as recovery. The service must not acquire ownership of Runtime credential formats or import Runtime implementation modules.

## Decision

Organization Runtime owns one typed native Home segment through its trusted `./backup` entry. Its actual composition records Hosted identity and public TLS trust requirements. Capture consumes the original Snapshot checkpoint owner's opaque archive evidence under frozen native maintenance. The evidence retains its actual Runtime, primary Store, artifact configuration and callback lifetime.

Capture holds the existing provisioning identity lock, Home-format lock, Home-owner lock, enrollment lock and connection lock in that order until the segment is sealed. It reads the exact Home marker, ready binding, machine credential, enrollment and optional connection record. Registration and connection consistency remain with their existing owners; credential verification derives the public key from the original private key. The effective connection epoch remains the maximum of enrollment and stored connection epochs, while absence is preserved explicitly.

The shared Node-compatible record owner reads a bounded ordinary-file descriptor, rejects linked files or parents and verifies retained pathname and descriptor identity before returning parsed values and their exact bytes. Normal readers delegate to this same implementation. Cancellation closes the descriptor without replacing the original reason. Private key bytes remain inside the credential and native segment owners; the public verifier returns safe manifest metadata only.

The native facet uses the existing canonical Storage checkpoint representation and the existing encrypted outer recovery container. Its manifest binds the exact source namespace and file inventory. The cohort accepts an explicit trusted capture port for a Hosted participant, preserving the service-to-Runtime dependency direction. Native namespace identity still derives from the enrolled Home through native evidence, never the port's caller label.

Inert archived Home-two material uses the canonical Home owner's explicit archival reader contracts and Hosted binding schema. Owner and binding must name exactly the same supported historical contract, including the prior contract after the live reader advances. Capture still enters through the current-only live Home reader; archival compatibility never supplies an ordinary startup fallback.

## Alternatives considered

**Regenerate credentials during restore.** This loses original machine proof and can hide incomplete recovery material.

**Have the organization service copy a Hosted Home.** This would transfer private parsing and file-lock ownership into the wrong domain and risk including personal or transient launch material.

**Add an independent archive format.** The checkpoint and encrypted container already own integrity, key resolution, paging and complete-footer validation.

## Consequences

An independently opened cohort can verify the original Hosted machine tuple and later supply it to its owning recovery installer. This unit installs no target and starts no listener or Agent. Knowledge cache bytes, external resource owners, resumable target installation, new deployment/signing identity, current ACL reconciliation and unique old-writer proof remain required before full recovery or execution acceptance.

## Verification

`test/record.test.ts` first reproduced linked file and linked parent acceptance, then verifies exact bytes, descriptor cleanup under the original cancellation reason and retained-path replacement. `test/backup/native.test.ts` uses actual enrolled HTTPS Hosted Homes and native frozen checkpoint evidence. It covers absent and advanced connection checkpoints, a separate held connection writer during cancellation, a different fixed namespace, encrypted cohort reopen, and independent cold Home/registration/key-signature reads after the original source Runtime is closed and Home removed. A canonically reissued fixed native archive with the prior Home-two contract remains verifiable with the same machine key, while the ordinary binding parser rejects it. Existing Home and enrollment suites retain normal provisioning and TLS behavior. Full PRD recovery acceptance remains separate.
