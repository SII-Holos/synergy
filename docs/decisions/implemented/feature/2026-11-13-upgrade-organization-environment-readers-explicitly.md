# Decision Record: Upgrade organization Environment readers explicitly

Status: implemented

## Problem

A Service that retains native Environment effects needs a reader that understands their actual ownership. The ordinary format-two selector predates those owners. An older process must reject the upgraded Home before opening SQL, and an interrupted upgrade must retain its original maintenance operation.

## Decision

Environment-capable Service Homes select `native-organization-service-environments-v1` without changing the native Home format, deployment or signing identity. A Home without that capability retains its ordinary reader and migration catalog. Removing configuration does not lower an established reader. Restored Homes require their separate verified reader upgrade.

`org upgrade --request-id` uses the existing organization parser and restricted native opener. It reads only the explicit Home's domain configuration and calls the original Home migration under its dedicated maintenance owner. The Service owner captures and verifies the actual deployment, signer, selected reader and canonical idle Environment inventory. Native cold owners inspect complete canonical records, Uses and mount state instead of treating an empty derived index as drainage.

The command retains its original request through real draining, frozen, releasing and released phases. Failures and cancellation leave that operation available for explicit same-request reconciliation. A successful response requires the exact target marker, completed central migration receipts and released original operation. It reports an upgrade receipt with a required restart, without starting HTTP, WebSockets or Agent execution. The independent executable uses the same command definition.

## Alternatives considered

**Upgrade during ordinary serving startup.** This would combine a reader transition with new resource admission and conceal the required native maintenance boundary.

**Treat target bytes or a released hold as complete.** Either can exist without the domain's other completion facts. Both and the central receipts must be checked.

## Consequences

The public command supports established ordinary format-two Service Homes with writable SQLite and local artifacts. Native resources must be idle and supported by their owning inventory checks. It does not initialize missing Homes, downgrade readers or broaden restoration and external-backup admission. The owning CLI tests kill actual upgrade children after durable phase boundaries and retry through the public parser. See [original maintenance ownership](../architecture/2026-11-13-resume-home-upgrades-through-original-maintenance-owners.md) and the [deployment procedure](../../../operations/organization-service.md#upgrade-and-recovery).
