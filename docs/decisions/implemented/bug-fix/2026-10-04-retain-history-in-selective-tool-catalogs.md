# Decision Record: Retain history in selective tool catalogs

Status: implemented

## Problem

A host can import Note, Cortex and local tools without their product registration. Tool-input migrations registered only by product bootstrap are then missing, so persisted calls retain retired parameter names when that host reopens a conversation.

## Decision

Each owning package exposes an explicit input-history registration function. Product registration delegates to it, and selective hosts invoke it during Runtime composition. Tool factories remain safe to import and call outside a Runtime. Mappings and migrations have one owner; registration does not enable native providers or product groups.

## Alternatives considered

Registering history while importing tools would require ambient Runtime state. Copying parameter mappings into each consumer would create independent migration definitions. Registering full product components would add capabilities that an embedding host did not select.

## Consequences

Selective hosts must register the history of the tool domains they use before sealing composition. Regression tests cover old inputs, preservation of current fields, repeated registration and independent Runtime instances. The existing durable input migration test verifies canonical history, unchanged raw audit bytes and idempotence.
