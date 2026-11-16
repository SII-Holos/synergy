# Decision Record: Bind organization Session identity

Status: implemented

## Problem

Independent member machines can use different directories for one organization project. Deriving Session ownership from each machine's directory creates inconsistent project identities. Copying ordinary metadata into a new or existing Session can also claim organizational ownership without the trusted admission that established it.

## Decision

The organization protocol owns a strict version 1 Session binding. The Runtime adapter registers it as optional Session metadata through the existing schema registry, including in selected member workers. Organization project IDs directly identify logical Scopes; directories remain local resource selections.

The generic registry supports explicit inheritance of owner fields and validation inside canonical Session write transactions. Validators receive detached views, and creation compares inherited fields against the current parent. The organization owner keeps its binding, Session identity and parent immutable under ordinary updates. New member Sessions require the matching organization. Ordinary import and fork cannot create a bound Session through copied metadata.

Historical records without organization fields stay unbound. An unloaded owner retains its fields on disk while public projection hides them; reinstall restores the registered view. Optional metadata requires no historical rewrite or new storage collection. Binding does not open execution: trusted command admission remains a separate requirement.

## Alternatives considered

**Derive project identity from local paths.** Independent members would produce different identities for the same project, while changing a directory could appear to change ownership.

**Validate only in the HTTP creation route.** Embedded clients, child Session creation and domain writes would bypass that check. Transactional validation at the canonical mutation owner applies consistently to those entrypoints.

**Automatically attach organization fields to historical or imported Sessions.** Neither a current account nor a local directory proves their original project and creator. Retained unbound data remains unbound; authorized creation needs explicit identity evidence.

## Consequences

The full API exposes optional organization binding metadata and generated clients include it. Member clients cannot use the ordinary unbound draft-creation path. Owner schemas remain outside Harness, while Harness supplies transaction-aware inheritance and validation. Tests cover shared logical identity across Homes, conflicting changes, child inheritance, rollback, HTTP and embedded rejection, restart, owner absence and reinstall. Organization command dispatch and transfer admission remain separate work.
