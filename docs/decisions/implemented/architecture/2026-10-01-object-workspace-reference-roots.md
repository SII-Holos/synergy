# Decision Record: Explicit object Workspace reference roots

Status: implemented

## Problem

An object Workspace has no native directory. Absolute model file references could not resolve until execution mounted files, and an execution mount changed their namespace. Embedded hosts also needed the Question toolkit without choosing a CLI product flag.

## Decision

Object Workspace backend specifications may select a canonical absolute virtualRoot. Resource resolution validates it before execution admission and exposes it for object-only file access. FileView resolves references beneath that root to the same relative Workspace entry after a live mount changes physical location. Paths outside both the selected virtual root and physical mount remain invalid. A virtual root grants no native filesystem access and does not rewrite shell commands.

The Question domain exposes its existing toolkit factory. Default product registration retains its existing client selection; explicit hosts select the same toolkit through the public interface.

## Alternatives considered

Host-specific file rewrites duplicate generic resource semantics. Pretending an object Workspace is a native directory introduces another storage authority. Product flags unnecessarily couple host composition to client registration.

## Consequences

Object file tools can retain stable references without allocating execution. Execution keeps its actual working directory, and paths are resolved against the selected Workspace. Existing relative object paths and default Question registration keep their behavior.
