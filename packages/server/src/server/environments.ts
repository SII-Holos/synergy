import { Hono } from "hono"
import { z } from "zod"
import { describeRoute, resolver, validator } from "hono-openapi"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentControl } from "@ericsanchezok/synergy-harness/environment/control"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"
import { errors } from "./error"

const EnvironmentParam = z.object({ environmentID: z.string().min(1) })
const OperationParam = EnvironmentParam.extend({ operationID: z.string().min(1) })

export const EnvironmentsRoute = () =>
  new Hono()
    .get(
      "/profiles",
      describeRoute({
        summary: "List configured Workspace and Environment profiles",
        operationId: "environment.profiles",
        responses: {
          200: {
            description: "Available profiles without credentials",
            content: { "application/json": { schema: resolver(ResourceProfiles.Summary) } },
          },
          ...errors(400),
        },
      }),
      async (c) => c.json(await ResourceProfiles.list()),
    )
    .get(
      "/",
      describeRoute({
        summary: "List Environments in a Scope",
        operationId: "environment.list",
        responses: {
          200: {
            description: "Environment catalog",
            content: { "application/json": { schema: resolver(Environment.Info.array()) } },
          },
          ...errors(400),
        },
      }),
      async (c) => c.json(await Environment.list(ScopeContext.current.scope.id)),
    )
    .post(
      "/",
      describeRoute({
        summary: "Select an Environment profile without allocating compute",
        operationId: "environment.create",
        responses: {
          200: {
            description: "Logical Environment",
            content: { "application/json": { schema: resolver(Environment.Info) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("json", z.object({ profile: z.string().min(1), requestID: z.string().min(1).max(128) }).strict()),
      async (c) => {
        const { profile, requestID } = c.req.valid("json")
        return c.json(
          await ResourceProfiles.createEnvironment({
            profile,
            scopeID: ScopeContext.current.scope.id,
            ownerID: `api:${requestID}`,
          }),
        )
      },
    )
    .get(
      "/:environmentID",
      describeRoute({
        summary: "Get an Environment",
        operationId: "environment.get",
        responses: {
          200: { description: "Environment", content: { "application/json": { schema: resolver(Environment.Info) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", EnvironmentParam),
      async (c) => c.json(await Environment.get(c.req.valid("param").environmentID, ScopeContext.current.scope.id)),
    )
    .get(
      "/:environmentID/activity",
      describeRoute({
        summary: "Inspect retained Environment work without allocating compute",
        operationId: "environment.activity",
        responses: {
          200: {
            description: "Activity and unfinished operations",
            content: { "application/json": { schema: resolver(EnvironmentControl.Activity) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", EnvironmentParam),
      async (c) =>
        c.json(await EnvironmentControl.activity({ ...c.req.valid("param"), scopeID: ScopeContext.current.scope.id })),
    )
    .post(
      "/:environmentID/reconcile",
      describeRoute({
        summary: "Reconcile the current Environment allocation",
        operationId: "environment.reconcile",
        responses: {
          200: {
            description: "Reconciled Environment",
            content: { "application/json": { schema: resolver(Environment.Info) } },
          },
          ...errors(400, 404, 409, 503),
        },
      }),
      validator("param", EnvironmentParam),
      async (c) =>
        c.json(await Environment.reconcile(c.req.valid("param").environmentID, ScopeContext.current.scope.id)),
    )
    .post(
      "/:environmentID/release",
      describeRoute({
        summary: "Save attached Workspaces and reclaim unused compute",
        operationId: "environment.release",
        responses: {
          200: {
            description: "Released Environment",
            content: { "application/json": { schema: resolver(Environment.Info) } },
          },
          ...errors(400, 404, 409, 503),
        },
      }),
      validator("param", EnvironmentParam),
      validator("json", z.object({ expectedGeneration: z.number().int().nonnegative() }).strict()),
      async (c) =>
        c.json(
          await Environment.deallocate(c.req.valid("param").environmentID, {
            ...c.req.valid("json"),
            scopeID: ScopeContext.current.scope.id,
          }),
        ),
    )
    .post(
      "/:environmentID/execution/:operationID/recover",
      describeRoute({
        summary: "Inspect an existing execution and retry saving without repeating its command",
        operationId: "environment.recoverExecution",
        responses: {
          200: {
            description: "Existing execution outcome",
            content: { "application/json": { schema: resolver(EnvironmentExecution.Info) } },
          },
          ...errors(400, 404, 409, 503),
        },
      }),
      validator("param", OperationParam),
      async (c) =>
        c.json(
          await EnvironmentControl.recoverExecution({
            ...c.req.valid("param"),
            scopeID: ScopeContext.current.scope.id,
          }),
        ),
    )
    .post(
      "/:environmentID/execution/:operationID/cancel",
      describeRoute({
        summary: "Request cancellation of existing physical execution",
        operationId: "environment.cancelExecution",
        responses: {
          200: {
            description: "Durable cancellation status",
            content: { "application/json": { schema: resolver(EnvironmentExecution.Info) } },
          },
          ...errors(400, 404, 409, 503),
        },
      }),
      validator("param", OperationParam),
      async (c) =>
        c.json(
          await EnvironmentControl.cancelExecution({ ...c.req.valid("param"), scopeID: ScopeContext.current.scope.id }),
        ),
    )
    .post(
      "/:environmentID/file/:operationID/recover",
      describeRoute({
        summary: "Recover an existing Workspace mutation without repeating uncertain effects",
        operationId: "environment.recoverFile",
        responses: {
          200: {
            description: "File operation outcome",
            content: { "application/json": { schema: resolver(WorkspaceOperations.Summary) } },
          },
          ...errors(400, 404, 409, 503),
        },
      }),
      validator("param", OperationParam),
      async (c) =>
        c.json(
          await EnvironmentControl.recoverFile({ ...c.req.valid("param"), scopeID: ScopeContext.current.scope.id }),
        ),
    )
