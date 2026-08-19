import z from "zod"
import { PLUGIN_API_4_BASE_SYNERGY_RANGE, PLUGIN_API_VERSION, PLUGIN_MANIFEST_VERSION } from "./version.js"
import { McpServerConfig } from "./mcp.js"
import { HOST_OWNED_MESSAGE_TYPES, PLUGIN_MODEL_ROLES } from "./plugin-types.js"
import { PluginToolId } from "./ids.js"

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
  enabledWhen: z
    .object({ setting: z.string().min(1), equals: z.union([z.string(), z.number(), z.boolean()]) })
    .strict()
    .optional(),
}).strict()

const CliCommandContribution = ContributionBase.extend({
  kind: z.literal("cli.command"),
  description: z.string().min(1),
  options: z.record(
    z.string(),
    z
      .object({
        type: z.enum(["boolean", "string", "number"]),
        description: z.string().min(1),
      })
      .strict(),
  ),
  timeoutMs: z.number().int().positive().optional(),
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
  server: McpServerConfig,
  enabledWhen: z
    .object({ setting: z.string().min(1), equals: z.union([z.string(), z.number(), z.boolean()]) })
    .strict()
    .optional(),
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
  defaultResource: z
    .object({ id: z.string().min(1), title: z.string().min(1), state: z.unknown().optional() })
    .strict()
    .optional(),
}).strict()

const NavigationItemContribution = UIBase.extend({
  kind: z.literal("ui.navigationItem"),
  placement: z.enum(["sidebar", "page"]),
}).strict()

const MessageRendererContribution = UIBase.extend({
  kind: z.literal("ui.messageRenderer"),
  messageType: z.string().min(1),
  tool: z.string().min(1).optional(),
}).strict()

const ComposerActionContribution = UIBase.extend({
  kind: z.literal("ui.composerAction"),
  slot: z.string().min(1),
}).strict()

const HeadlessUIBase = ContributionBase.extend({
  order: z.number().int(),
  component: Component,
})

const ComposerExtensionContribution = HeadlessUIBase.extend({
  kind: z.literal("ui.composerExtension"),
}).strict()

const SelectionExtensionContribution = HeadlessUIBase.extend({
  kind: z.literal("ui.selectionExtension"),
}).strict()

const TextSelectionSource = z.enum(["document", "code", "terminal"])
const TextSelectionOrigin = z.enum(["user_message", "assistant_message", "editable", "other"])

const TextActionContribution = ContributionBase.extend({
  kind: z.literal("ui.textAction"),
  label: z.string().min(1),
  icon: z.string().optional(),
  order: z.number().int(),
  operation: ContributionId,
  when: z
    .object({
      sources: z.array(TextSelectionSource).min(1).optional(),
      origins: z.array(TextSelectionOrigin).min(1).optional(),
      minChars: z.number().int().nonnegative().optional(),
      maxChars: z.number().int().positive().optional(),
      editable: z.boolean().optional(),
    })
    .strict()
    .optional(),
  presentation: z
    .object({
      kind: z.literal("popover"),
      component: Component,
      width: z.enum(["sm", "md", "lg"]).optional(),
    })
    .strict()
    .optional(),
}).strict()

const MessageSlotContribution = HeadlessUIBase.extend({
  kind: z.literal("ui.messageSlot"),
  slot: z.enum(["message.before", "message.after", "message.actions"]),
  roles: z.array(z.enum(["user", "assistant"])).optional(),
}).strict()

const SettingsContribution = UIBase.extend({
  kind: z.literal("ui.settings"),
  group: z.string().min(1),
  formSchema: JsonSchema.optional(),
  visibility: z.enum(["standard", "developer"]).optional(),
}).strict()
const SlotContribution = UIBase.extend({
  kind: z.literal("ui.slot"),
  slot: z.string().min(1),
  when: z.object({ session: z.boolean().optional() }).strict().optional(),
}).strict()

const ThemeContribution = ContributionBase.extend({
  kind: z.literal("ui.theme"),
  label: z.string().min(1),
  path: z
    .string()
    .min(1)
    .regex(/\.json$/),
}).strict()

const IconContribution = ContributionBase.extend({
  kind: z.literal("ui.icon"),
  path: z.string().min(1),
}).strict()

const LifecycleInstallContribution = ContributionBase.extend({ kind: z.literal("lifecycle.install") }).strict()
const LifecycleUpgradeContribution = ContributionBase.extend({ kind: z.literal("lifecycle.upgrade") }).strict()
const LifecycleUninstallContribution = ContributionBase.extend({ kind: z.literal("lifecycle.uninstall") }).strict()

export const PluginManifestContribution = z.discriminatedUnion("kind", [
  OperationContribution,
  EventContribution,
  ToolContribution,
  CliCommandContribution,
  HookContribution,
  AgentContribution,
  SkillContribution,
  McpContribution,
  AuthProviderContribution,
  WorkbenchPanelContribution,
  NavigationItemContribution,
  MessageRendererContribution,
  ComposerActionContribution,
  ComposerExtensionContribution,
  SelectionExtensionContribution,
  TextActionContribution,
  MessageSlotContribution,
  SettingsContribution,
  SlotContribution,
  ThemeContribution,
  IconContribution,
  LifecycleInstallContribution,
  LifecycleUpgradeContribution,
  LifecycleUninstallContribution,
])

export type PluginManifestContribution = z.infer<typeof PluginManifestContribution>

function trustedUIComponent(contribution: PluginManifestContribution) {
  if (contribution.kind === "ui.textAction") return contribution.presentation?.component
  if (!contribution.kind.startsWith("ui.") || !("component" in contribution)) return undefined
  return contribution.component
}

export function hasTrustedUIComponent(contribution: PluginManifestContribution): boolean {
  return Boolean(trustedUIComponent(contribution))
}

const Artifact = z.object({ entry: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict()

export const PluginManifestEnvelope = z
  .object({
    manifestVersion: z.number().int().positive(),
    apiVersion: z.string().min(1),
    compatibility: z
      .object({ synergy: z.string().min(1) })
      .strict()
      .default({ synergy: PLUGIN_API_4_BASE_SYNERGY_RANGE }),
  })
  .passthrough()

export const PluginManifestV4 = z
  .object({
    manifestVersion: z.literal(PLUGIN_MANIFEST_VERSION),
    apiVersion: z.literal(PLUGIN_API_VERSION),
    compatibility: z
      .object({ synergy: z.string().min(1) })
      .strict()
      .default({ synergy: PLUGIN_API_4_BASE_SYNERGY_RANGE }),
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
    const agentCapability = manifest.capabilities.find((item) => item.id === "agent.call")
    const modelRoles = agentCapability?.constraints?.modelRoles
    if (
      modelRoles !== undefined &&
      (!Array.isArray(modelRoles) ||
        modelRoles.length === 0 ||
        new Set(modelRoles).size !== modelRoles.length ||
        modelRoles.some(
          (role) => typeof role !== "string" || !(PLUGIN_MODEL_ROLES as readonly string[]).includes(role),
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "agent.call", "constraints", "modelRoles"],
        message: "agent.call modelRoles must contain unique PluginModelRole values",
      })
    }
    const settings = manifest.contributions.find((item) => item.kind === "ui.settings")
    const settingProperties =
      settings?.formSchema && typeof settings.formSchema.properties === "object" && settings.formSchema.properties
        ? (settings.formSchema.properties as Record<string, unknown>)
        : {}
    for (const contribution of manifest.contributions) {
      const contributionKey = `${contribution.kind}:${contribution.id}`
      if (ids.has(contributionKey)) {
        context.addIssue({
          code: "custom",
          path: ["contributions"],
          message: `Duplicate ${contribution.kind} contribution id ${contribution.id}`,
        })
      }
      ids.add(contributionKey)
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
        (contribution.kind === "tool" || contribution.kind === "mcp") &&
        contribution.enabledWhen &&
        !(contribution.enabledWhen.setting in settingProperties)
      ) {
        context.addIssue({
          code: "custom",
          path: ["contributions", contribution.id, "enabledWhen", "setting"],
          message: `Undeclared plugin setting ${contribution.enabledWhen.setting}`,
        })
      }
      if (contribution.kind === "hook" && contribution.point === "session.user-message.after") {
        if (!contribution.requires?.includes("session.read")) {
          context.addIssue({
            code: "custom",
            path: ["contributions", contribution.id, "requires"],
            message: "session.user-message.after requires session.read",
          })
        }
      }
      if (
        (contribution.kind === "ui.selectionExtension" || contribution.kind === "ui.textAction") &&
        !contribution.requires?.includes("selection.read")
      ) {
        context.addIssue({
          code: "custom",
          path: ["contributions", contribution.id, "requires"],
          message: `${contribution.kind} requires selection.read`,
        })
      }
      if (contribution.kind === "ui.textAction") {
        if (
          contribution.when?.minChars !== undefined &&
          contribution.when?.maxChars !== undefined &&
          contribution.when.minChars > contribution.when.maxChars
        ) {
          context.addIssue({
            code: "custom",
            path: ["contributions", contribution.id, "when"],
            message: "Text action minChars cannot exceed maxChars",
          })
        }
        const operation = manifest.contributions.find(
          (item) => item.kind === "operation" && item.id === contribution.operation,
        )
        if (
          !operation ||
          operation.kind !== "operation" ||
          operation.type !== "command" ||
          !operation.expose.includes("ui")
        ) {
          context.addIssue({
            code: "custom",
            path: ["contributions", contribution.id, "operation"],
            message: "Text action must reference a UI-exposed command operation",
          })
        }
      }
      if (contribution.kind === "tool" && contribution.input.type !== "object") {
        context.addIssue({
          code: "custom",
          path: ["contributions", contribution.id, "input", "type"],
          message: "Plugin tool input must be a top-level JSON Schema object",
        })
      }
      const component = trustedUIComponent(contribution)
      if (component && !manifest.artifacts.ui) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", "ui"],
          message: "Trusted UI contribution requires a UI artifact",
        })
      }
      if (component && manifest.artifacts.ui && component.entry !== manifest.artifacts.ui.entry) {
        context.addIssue({
          code: "custom",
          path: ["contributions", contribution.id, "component", "entry"],
          message: "Trusted UI component must use the verified UI artifact entry",
        })
      }
      if (contribution.kind === "ui.messageRenderer") {
        if (contribution.messageType === "tool") {
          const owned =
            contribution.tool &&
            manifest.contributions.some(
              (item) => item.kind === "tool" && PluginToolId.format(manifest.id, item.id) === contribution.tool,
            )
          if (!owned) {
            context.addIssue({
              code: "custom",
              path: ["contributions", contribution.id, "tool"],
              message: "Message renderer must target a Tool contributed by the same plugin",
            })
          }
        } else if (
          contribution.tool ||
          (HOST_OWNED_MESSAGE_TYPES as readonly string[]).includes(contribution.messageType)
        ) {
          context.addIssue({
            code: "custom",
            path: ["contributions", contribution.id, "messageType"],
            message: "Message renderer cannot replace a host-owned message type",
          })
        }
      }
    }
    const needsRuntime = manifest.contributions.some((item) =>
      [
        "operation",
        "tool",
        "hook",
        "cli.command",
        "authProvider",
        "lifecycle.install",
        "lifecycle.upgrade",
        "lifecycle.uninstall",
      ].includes(item.kind),
    )
    if (needsRuntime && !manifest.artifacts.runtime) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", "runtime"],
        message: "Executable contributions require a runtime artifact",
      })
    }
  })

export const PluginManifest = PluginManifestV4

export type PluginManifest = z.output<typeof PluginManifestV4>

export function manifestHasTrustedUI(manifest: Pick<PluginManifest, "contributions">): boolean {
  return manifest.contributions.some(hasTrustedUIComponent)
}
