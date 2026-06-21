import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "../config/config"
import { ControlProfileCompiler } from "../control-profile/compiler"
import { Agent } from "../agent/agent"
import { SandboxBackend } from "../sandbox/backend"
import { errors } from "./error"

const ControlProfileSummary = z
  .object({
    id: z.enum(["guarded", "autonomous", "full_access"]),
    label: z.string(),
    description: z.string(),
  })
  .meta({ ref: "ControlProfileSummary" })

const SandboxStatus = z
  .object({
    platform: z.string(),
    available: z.boolean(),
    backend: z.string().nullable(),
    supported: z.boolean(),
  })
  .meta({ ref: "SandboxStatus" })

const EffectiveProfileResult = z
  .object({
    profileId: z.string(),
    label: z.string(),
    source: z.enum(["agent", "config", "default"]),
    configProfile: z.string().optional(),
    agentProfile: z.string().optional(),
    agentName: z.string().optional(),
  })
  .meta({ ref: "EffectiveProfileResult" })

export const ControlProfileRoute = new Hono()
  .get(
    "/control-profiles",
    describeRoute({
      summary: "List control profiles",
      description: "List all available control profiles with their ids, labels, and descriptions.",
      operationId: "controlProfile.list",
      responses: {
        200: {
          description: "List of control profiles",
          content: {
            "application/json": {
              schema: resolver(ControlProfileSummary.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const profiles = await Promise.all(
        ControlProfileCompiler.profileIds.map(async (id) => {
          const [label, resolved] = await Promise.all([
            ControlProfileCompiler.getProfile(id),
            ControlProfileCompiler.resolve(id, {
              workspace: "/",
              workspaceType: "main",
              interactionMode: "attended",
            }),
          ])
          return { id, label: label.label, description: resolved.description }
        }),
      )
      return c.json(profiles)
    },
  )
  .get(
    "/control-profiles/effective",
    describeRoute({
      summary: "Get effective control profile",
      description:
        "Resolve the effective control profile for a given agent or the default. Precedence: agent config > top-level config > guarded default.",
      operationId: "controlProfile.effective",
      responses: {
        200: {
          description: "Effective profile resolution",
          content: {
            "application/json": {
              schema: resolver(EffectiveProfileResult),
            },
          },
        },
        ...errors(400),
      },
    }),
    validator(
      "query",
      z.object({
        agent: z.string().optional().describe("Agent name to resolve profile for"),
      }),
    ),
    async (c) => {
      const { agent: agentName } = c.req.valid("query")
      const cfg = await Config.get()
      const topLevelProfile = cfg.controlProfile
      let agentProfile: string | undefined
      let resolvedLabel = "Guarded"

      if (agentName) {
        const agent = await Agent.get(agentName)
        if (!agent) {
          return c.json({ error: `Agent "${agentName}" not found` }, 400)
        }
        agentProfile = agent.controlProfile
      }

      const effectiveId = ControlProfileCompiler.normalize(agentProfile ?? topLevelProfile)
      const source = agentProfile ? "agent" : topLevelProfile ? "config" : "default"

      try {
        const label = await ControlProfileCompiler.getProfile(effectiveId)
        resolvedLabel = label.label
      } catch {}

      return c.json({
        profileId: effectiveId,
        label: resolvedLabel,
        source,
        configProfile: topLevelProfile,
        agentProfile,
        agentName: agentName ?? undefined,
      })
    },
  )
  .get(
    "/sandbox/status",
    describeRoute({
      summary: "Get sandbox status",
      description: "Get the current sandbox platform availability and backend information.",
      operationId: "sandbox.status",
      responses: {
        200: {
          description: "Sandbox status information",
          content: {
            "application/json": {
              schema: resolver(SandboxStatus),
            },
          },
        },
      },
    }),
    async (c) => {
      const info = SandboxBackend.platformInfo()
      return c.json({
        platform: info.platform,
        available: info.available,
        backend: info.backend,
        supported: SandboxBackend.isPlatformSupported(info.platform),
      })
    },
  )
