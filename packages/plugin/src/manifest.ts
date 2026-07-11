import z from "zod"
import { PLUGIN_API_VERSION, PLUGIN_MANIFEST_VERSION } from "./version.js"

const Id = z.string().regex(/^[a-z][a-z0-9.-]*$/)
const ContributionId = z.string().regex(/^[a-z][A-Za-z0-9._-]*$/)
const CapabilityId = z.string().regex(/^[a-z][A-Za-z0-9.-]*$/)
const JsonSchema = z.record(z.string(), z.unknown())
const Capability = z
  .object({
    id: CapabilityId,
    constraints: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const ContributionBase = z.object({
  kind: z.string(),
  id: ContributionId,
  requires: z.array(CapabilityId).optional(),
})

const Component = z
  .object({
    entry: z.string().min(1),
    exportName: z.string().min(1),
  })
  .strict()

const OperationContribution = ContributionBase.extend({
  kind: z.literal("operation"),
  type: z.enum(["query", "command"]),
  expose: z.array(z.enum(["ui", "sdk"])).min(1),
  input: JsonSchema,
  output: JsonSchema,
  timeoutMs: z.number().int().positive().optional(),
}).strict()

const EventContribution = ContributionBase.extend({
  kind: z.literal("event"),
  payload: JsonSchema,
}).strict()

const ToolContribution = ContributionBase.extend({
  kind: z.literal("tool"),
  description: z.string().min(1),
  input: JsonSchema,
  exposure: z.record(z.string(), z.unknown()).optional(),
  display: z.record(z.string(), z.unknown()).optional(),
}).strict()

const HookContribution = ContributionBase.extend({
  kind: z.literal("hook"),
  point: z.string().min(1),
  priority: z.number().int(),
}).strict()

const AgentContribution = ContributionBase.extend({
  kind: z.literal("agent"),
  agent: z.record(z.string(), z.unknown()),
}).strict()
const SkillContribution = ContributionBase.extend({
  kind: z.literal("skill"),
  skill: z.record(z.string(), z.unknown()),
}).strict()
const McpContribution = ContributionBase.extend({
  kind: z.literal("mcp"),
  server: z.record(z.string(), z.unknown()),
}).strict()
const AuthProviderProfile = z
  .object({
    name: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    description: z.string().optional(),
    signupUrl: z.string().optional(),
    env: z.array(z.string()).optional(),
    baseURL: z.string().optional(),
    modelsURL: z.string().optional(),
    authKind: z.enum(["api_key", "oauth", "oauth_external", "none"]).optional(),
    fallbackModels: z.array(z.string()).optional(),
    recommendation: z.record(z.string(), z.unknown()).optional(),
    methods: z
      .array(
        z
          .object({
            type: z.enum(["oauth", "api", "import"]),
            label: z.string(),
            prompts: z.array(z.record(z.string(), z.unknown())).optional(),
          })
          .strict(),
      )
      .optional(),
    hasLoader: z.boolean().optional(),
  })
  .strict()
const AuthProviderContribution = ContributionBase.extend({
  kind: z.literal("authProvider"),
  provider: AuthProviderProfile,
}).strict()

const UIBase = ContributionBase.extend({
  label: z.string().min(1),
  icon: z.string().optional(),
  order: z.number().int(),
  component: Component.optional(),
})

const WorkbenchPanelContribution = UIBase.extend({
  kind: z.literal("ui.workbenchPanel"),
  surface: z.enum(["side", "bottom"]),
  cardinality: z.enum(["exclusive", "singleton", "multi"]),
  requiresSession: z.boolean().optional(),
}).strict()

const NavigationItemContribution = UIBase.extend({
  kind: z.literal("ui.navigationItem"),
  placement: z.enum(["sidebar", "page"]),
}).strict()

const MessageRendererContribution = UIBase.extend({
  kind: z.literal("ui.messageRenderer"),
  messageType: z.string().min(1),
}).strict()

const ComposerActionContribution = UIBase.extend({
  kind: z.literal("ui.composerAction"),
  slot: z.string().min(1),
}).strict()

const SettingsContribution = UIBase.extend({
  kind: z.literal("ui.settings"),
  group: z.string().min(1),
  formSchema: JsonSchema.optional(),
  visibility: z.enum(["standard", "developer"]).optional(),
}).strict()

const ThemeContribution = ContributionBase.extend({
  kind: z.literal("ui.theme"),
  label: z.string().min(1),
  path: z.string().min(1),
}).strict()

const IconContribution = ContributionBase.extend({
  kind: z.literal("ui.icon"),
  path: z.string().min(1),
}).strict()

const LifecycleUpgradeContribution = ContributionBase.extend({ kind: z.literal("lifecycle.upgrade") }).strict()
const LifecycleUninstallContribution = ContributionBase.extend({ kind: z.literal("lifecycle.uninstall") }).strict()

export const PluginManifestContribution = z.discriminatedUnion("kind", [
  OperationContribution,
  EventContribution,
  ToolContribution,
  HookContribution,
  AgentContribution,
  SkillContribution,
  McpContribution,
  AuthProviderContribution,
  WorkbenchPanelContribution,
  NavigationItemContribution,
  MessageRendererContribution,
  ComposerActionContribution,
  SettingsContribution,
  ThemeContribution,
  IconContribution,
  LifecycleUpgradeContribution,
  LifecycleUninstallContribution,
])

export type PluginManifestContribution = z.infer<typeof PluginManifestContribution>

const Artifact = z.object({ entry: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict()

export const PluginManifest = z
  .object({
    manifestVersion: z.literal(PLUGIN_MANIFEST_VERSION),
    apiVersion: z.literal(PLUGIN_API_VERSION),
    id: Id,
    name: z.string().min(1).max(128),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/),
    description: z.string().min(1).max(1024),
    author: z.string().optional(),
    homepage: z.string().url().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    icon: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    capabilities: z.array(Capability),
    contributions: z.array(PluginManifestContribution),
    artifacts: z
      .object({
        generation: z.string().min(1),
        runtime: Artifact.optional(),
        ui: Artifact.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>()
    const capabilities = new Set(manifest.capabilities.map((item) => item.id))
    for (const contribution of manifest.contributions) {
      if (ids.has(contribution.id)) {
        context.addIssue({
          code: "custom",
          path: ["contributions"],
          message: `Duplicate contribution id ${contribution.id}`,
        })
      }
      ids.add(contribution.id)
      for (const required of contribution.requires ?? []) {
        if (!capabilities.has(required)) {
          context.addIssue({
            code: "custom",
            path: ["contributions", contribution.id, "requires"],
            message: `Undeclared capability ${required}`,
          })
        }
      }
      if (
        contribution.kind.startsWith("ui.") &&
        "component" in contribution &&
        contribution.component &&
        !manifest.artifacts.ui
      ) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", "ui"],
          message: "Trusted UI contribution requires a UI artifact",
        })
      }
    }
    const needsRuntime = manifest.contributions.some((item) =>
      ["operation", "tool", "hook", "authProvider", "lifecycle.upgrade", "lifecycle.uninstall"].includes(item.kind),
    )
    if (needsRuntime && !manifest.artifacts.runtime) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", "runtime"],
        message: "Executable contributions require a runtime artifact",
      })
    }
  })

export type PluginManifest = z.infer<typeof PluginManifest>
