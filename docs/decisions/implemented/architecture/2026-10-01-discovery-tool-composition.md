# Decision Record: Discovery toolkit composition

Status: implemented

## Problem

Embedding products own tool manifests and display metadata but could not select the exact built-in discovery definitions through the public registry interface.

## Decision

Expose ToolRegistry.discoveryTools as a factory returning the existing search_tools and expand_tools definitions. The registry obtains its built-in tools through the same factory. Hosts can reference these definitions for metadata while leaving automatic registry registration in place.

## Alternatives considered

Reimplementing discovery in the embedding product duplicates resolver behavior. Registering replacement providers creates duplicate tool IDs. Exporting private resolver internals expands an unnecessary coupling surface.

## Consequences

Discovery remains one implementation and one registration. The factory requires no product defaults and returns the same definitions used by the registry.
