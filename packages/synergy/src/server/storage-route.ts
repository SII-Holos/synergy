import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { SnapshotMaintenance } from "../session/snapshot-maintenance"

const StorageSnapshotStatistics = z
  .object({
    bytes: z.number().nonnegative(),
    allocatedBytes: z.number().nonnegative(),
    files: z.number().int().nonnegative(),
  })
  .meta({ ref: "StorageSnapshotStatistics" })

const StorageSnapshotOwnerCounts = z
  .object({
    legacy: z.number().int().nonnegative(),
    shared: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  })
  .meta({ ref: "StorageSnapshotOwnerCounts" })

const StorageSnapshotRetainedLegacy = z
  .object({
    unowned: z.number().int().nonnegative(),
    reclaimed: z.number().int().nonnegative(),
    sharedBaselines: z.number().int().nonnegative(),
    unregistered: z.number().int().nonnegative(),
  })
  .meta({ ref: "StorageSnapshotRetainedLegacy" })

const StorageSnapshotUsage = z
  .object({
    scopeID: z.string(),
    owners: StorageSnapshotOwnerCounts,
    retainedLegacy: StorageSnapshotRetainedLegacy,
    legacy: StorageSnapshotStatistics,
    shared: StorageSnapshotStatistics,
    indexes: StorageSnapshotStatistics,
  })
  .meta({ ref: "StorageSnapshotUsage" })

export const GlobalStorageRoute = new Hono().get(
  "/snapshot",
  describeRoute({
    summary: "Report snapshot storage usage",
    description:
      "Per-scope file snapshot storage report: owner counts by backend, retained legacy directories (unowned, reclaimed, shared baselines, unregistered), and legacy/shared/index storage statistics. Maintenance and deletion run through `synergy data snapshots`; this endpoint is read-only.",
    operationId: "storage.snapshot.usage",
    responses: {
      200: {
        description: "Snapshot storage usage per scope",
        content: {
          "application/json": {
            schema: resolver(StorageSnapshotUsage.array()),
          },
        },
      },
    },
  }),
  async (c) => {
    const usage = await SnapshotMaintenance.inspect()
    return c.json(usage)
  },
)
