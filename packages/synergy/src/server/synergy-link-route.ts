import { SynergyLinkTargetRuntime } from "@/synergy-link/target-runtime"
import { SynergyLinkTargetService } from "@/synergy-link/target-service"
import { SynergyLinkTarget } from "@/synergy-link/types"
import { Storage } from "@/storage/storage"
import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { errors } from "./error"

const TargetParams = z.object({ id: SynergyLinkTarget.ID })
const RemoveResult = z.object({ success: z.literal(true) }).meta({ ref: "SynergyLinkTargetRemoveResult" })

export const SynergyLinkRoute = new Hono()
  .get(
    "/targets",
    describeRoute({
      summary: "List Synergy Link targets",
      description: "List the persisted remote Synergy targets available on this installation.",
      operationId: "synergyLink.targets",
      responses: {
        200: {
          description: "Persisted Synergy Link targets",
          content: { "application/json": { schema: resolver(SynergyLinkTarget.View.array()) } },
        },
      },
    }),
    async (c) => c.json(await SynergyLinkTargetRuntime.list()),
  )
  .post(
    "/targets",
    describeRoute({
      summary: "Create a Synergy Link target",
      operationId: "synergyLink.targetCreate",
      responses: {
        200: {
          description: "Created target",
          content: { "application/json": { schema: resolver(SynergyLinkTarget.Info) } },
        },
        ...errors(400),
      },
    }),
    validator("json", SynergyLinkTarget.CreateInput),
    async (c) => {
      try {
        return c.json(await SynergyLinkTargetService.create(c.req.valid("json")))
      } catch (error) {
        return badRequest(c, error)
      }
    },
  )
  .patch(
    "/targets/:id",
    describeRoute({
      summary: "Update a Synergy Link target",
      operationId: "synergyLink.targetUpdate",
      responses: {
        200: {
          description: "Updated target",
          content: { "application/json": { schema: resolver(SynergyLinkTarget.Info) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", TargetParams),
    validator("json", SynergyLinkTarget.PatchInput),
    async (c) => {
      try {
        return c.json(await SynergyLinkTargetService.update(c.req.valid("param").id, c.req.valid("json")))
      } catch (error) {
        return targetError(c, error)
      }
    },
  )
  .delete(
    "/targets/:id",
    describeRoute({
      summary: "Remove a Synergy Link target",
      operationId: "synergyLink.targetRemove",
      responses: {
        200: {
          description: "Target removed",
          content: { "application/json": { schema: resolver(RemoveResult) } },
        },
        ...errors(404),
      },
    }),
    validator("param", TargetParams),
    async (c) => {
      try {
        await SynergyLinkTargetService.remove(c.req.valid("param").id)
        return c.json({ success: true as const })
      } catch (error) {
        return targetError(c, error)
      }
    },
  )
  .post(
    "/targets/:id/probe",
    describeRoute({
      summary: "Test a Synergy Link target",
      description: "Open or heartbeat a remote session to verify authorization and observe host capabilities.",
      operationId: "synergyLink.targetProbe",
      responses: {
        200: {
          description: "Observed target",
          content: { "application/json": { schema: resolver(SynergyLinkTarget.View) } },
        },
        ...errors(400, 404),
      },
    }),
    validator("param", TargetParams),
    async (c) => {
      try {
        return c.json(await SynergyLinkTargetRuntime.probe(c.req.valid("param").id))
      } catch (error) {
        return targetError(c, error)
      }
    },
  )

function targetError(c: Context, error: unknown) {
  if (error instanceof Storage.NotFoundError) return c.json(error.toObject(), 404)
  return badRequest(c, error)
}

function badRequest(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return c.json({ data: { message }, errors: [], success: false as const }, 400)
}
