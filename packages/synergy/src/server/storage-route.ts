import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { SnapshotMaintenance } from "../session/snapshot-maintenance"
import { SnapshotLease } from "../session/snapshot-lease"
import { SnapshotStore } from "../session/snapshot-store"

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

const StorageSnapshotCleanCandidate = z
  .object({
    sessionID: z.string(),
    bytes: z.number().nonnegative(),
    reason: z.enum(["reclaimed", "unowned"]),
  })
  .meta({ ref: "StorageSnapshotCleanCandidate" })

const StorageSnapshotCleanResult = z
  .object({
    scopeID: z.string(),
    applied: z.boolean(),
    candidates: z.array(StorageSnapshotCleanCandidate),
    removed: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
    skippedProtected: z.number().int().nonnegative(),
    errors: z.array(z.string()),
  })
  .meta({ ref: "StorageSnapshotCleanResult" })

const StorageSnapshotCleanFailure = z
  .object({
    scopeID: z.string(),
    message: z.string(),
  })
  .meta({ ref: "StorageSnapshotCleanFailure" })

const StorageSnapshotCleanBatch = z
  .object({
    results: z.array(StorageSnapshotCleanResult),
    failures: z.array(StorageSnapshotCleanFailure),
  })
  .meta({ ref: "StorageSnapshotCleanBatch" })

const StorageSnapshotCleanInput = z
  .object({
    scopeID: z.string().min(1).optional(),
    apply: z.boolean().optional().default(false),
  })
  .meta({ ref: "StorageSnapshotCleanInput" })

export const GlobalStorageRoute = new Hono()
  .get(
    "/snapshot",
    describeRoute({
      summary: "Report snapshot storage usage",
      description:
        "Per-scope file snapshot storage report: owner counts by backend, retained legacy directories (unowned, reclaimed, shared baselines, unregistered), and legacy/shared/index storage statistics. Read-only; reclamation is a separate POST.",
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
  .post(
    "/snapshot/clean",
    describeRoute({
      summary: "Reclaim unowned legacy snapshot directories",
      description:
        "Reclaim retained legacy snapshot directories with no owner record and no session record, including the __reclaimed__ scope. The shared store and directories with owners are never touched. Dry run by default; apply refuses a scope whose integrity check fails. Conflicts with running maintenance or a corrupted scope return 409.",
      operationId: "storage.snapshot.clean",
      requestBody: {
        required: true,
        content: {},
      },
      responses: {
        200: {
          description:
            "Per-scope clean reports plus failures for scopes that could not run (batch requests without scopeID keep completed work when a later scope fails)",
          content: {
            "application/json": {
              schema: resolver(StorageSnapshotCleanBatch),
            },
          },
        },
        409: {
          description:
            "A scope-targeted request found storage busy or its integrity check failed; nothing was reclaimed",
          content: {
            "application/json": {
              schema: resolver(z.object({ message: z.string() })),
            },
          },
        },
      },
    }),
    validator("json", StorageSnapshotCleanInput),
    async (c) => {
      const { scopeID, apply } = c.req.valid("json")
      if (scopeID !== undefined) {
        try {
          const result = await SnapshotMaintenance.clean(SnapshotStore.component(scopeID), { apply })
          return c.json({ results: [result], failures: [] })
        } catch (error) {
          if (error instanceof SnapshotLease.BusyError || error instanceof SnapshotStore.StorageError) {
            return c.json({ message: error.message }, 409)
          }
          throw error
        }
      }
      const results = []
      const failures: Array<{ scopeID: string; message: string }> = []
      for (const scope of await SnapshotMaintenance.scopes()) {
        try {
          results.push(await SnapshotMaintenance.clean(scope, { apply }))
        } catch (error) {
          if (error instanceof SnapshotLease.BusyError || error instanceof SnapshotStore.StorageError) {
            failures.push({ scopeID: scope, message: error.message })
            continue
          }
          throw error
        }
      }
      return c.json({ results, failures })
    },
  )
