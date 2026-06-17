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
    id: z.enum(["review", "workspace", "auto_review", "full_access"]),
    label: z.string(),
    description: z.string(),
  })
  .meta({ ref: "ControlProfileSummary" })

const PROFILE_DESCRIPTIONS: Record<string, string> = {
  review: "Read-only workspace access. Denies shell, network, and writes. All operations require manual review.",
  workspace: "Full read/write within the workspace directory. Restricted network. Shell requires approval.",
  auto_review: "Same workspace boundaries as workspace, but low-risk reads are auto-approved.",
  full_access: "Unrestricted filesystem, shell, and network access. Only identity/communication ops require approval.",
}

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
      const profiles = ControlProfileCompiler.profileIds.map((id) => ({
        id,
        label: ControlProfileCompiler.getProfile(id).label,
        description: PROFILE_DESCRIPTIONS[id] ?? "",
      }))
      return c.json(profiles)
    },
  )
  .get(
    "/control-profiles/effective",
    describeRoute({
      summary: "Get effective control profile",
      description:
        "Resolve the effective control profile for a given agent or the default. Precedence: agent config > top-level config > default workspace.",
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
      let resolvedLabel = "工作区"

      if (agentName) {
        const agent = await Agent.get(agentName)
        if (!agent) {
          return c.json({ error: `Agent "${agentName}" not found` }, 400)
        }
        agentProfile = agent.controlProfile
      }

      const effectiveId = agentProfile ?? topLevelProfile ?? "workspace"
      const source = agentProfile ? "agent" : topLevelProfile ? "config" : "default"

      try {
        const label = ControlProfileCompiler.getProfile(effectiveId)
        resolvedLabel = label.label
      } catch {
        // Invalid profile id — fall back to workspace
        resolvedLabel = "工作区"
      }

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
