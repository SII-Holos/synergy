# Decision Record: Explain Runtime and resources at the product entry point

Status: implemented

## Problem

The README describes a local workspace without making the independent Agent Runtime, Workspace and Environment choices visible. Readers cannot distinguish remote execution from connecting separate Synergy services, and older screenshots do not explain the current workbench.

## Decision

The README introduces the three resource owners before feature descriptions and installation. It links their canonical architecture documents and distinguishes configured remote Docker execution from paired services and manual paused-task transfer. Additional native-computer providers are an integration opportunity, not an advertised built-in coordinator.

Product screenshots come from synthetic projects in an isolated Home and Desktop profile. The opening image shows the new-task greeting with its playable mini game; the workspace section retains the model-built Browser demo. Demonstrations use actual model responses and actual rendered artifacts. Public assets exclude credentials, private service addresses, personal conversations and runtime identifiers.

The product gallery covers Agenda, Library, Notes and Plugins. Synthetic schedules are paused after capture; automatically recorded demo experiences retain their real evaluation state. The [public screenshot procedure](../../../../.synergy/skill/develop-synergy/references/public-product-screenshots.md) owns capture, encoding checks and fixture retirement.

## Alternatives considered

**Keep deployment details only in architecture documents.** This leaves the product entry point implying that files, execution and inference must share a computer.

**Present arbitrary cloud-to-laptop control as a ready-made feature.** The built-in remote Environment configuration uses Docker, while device pairing connects independently owned services. Combining them in one claim would promise an unimplemented deployment.

## Consequences

Readers can choose a local workbench, embedded agent or hosted execution setup with the supported ownership model. The entry point stays concise by linking operational and protocol details. Real screenshots require a reproducible demo and privacy review whenever the product presentation changes.
