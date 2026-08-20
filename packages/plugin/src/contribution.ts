import z from "zod"
import type {
  BlueprintAfterInput,
  PluginAgentCallAfterInput,
  PluginCortexTaskAfterInput,
  PluginInvocationContext,
  SessionUserMessageAfterInput,
} from "./context.js"
import type { PluginAgent, PluginSkill } from "./plugin-types.js"
import type { ToolDisplay, ToolResult } from "./tool.js"
import type { McpServerConfig } from "./mcp.js"

export type PluginJsonSchema = Record<string, unknown>
export interface PluginValidationSchema<T = unknown> {
  readonly _zod: unknown
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown }
}
export type PluginSchema<T = unknown> = PluginValidationSchema<T> | PluginJsonSchema

export interface PluginSettingCondition {
  setting: string
  equals: string | number | boolean
}

export interface ContributionBase<Kind extends string> {
  kind: Kind
  id: string
  requires?: string[]
}

export interface OperationContribution<Input = unknown, Output = unknown> extends ContributionBase<"operation"> {
  type: "query" | "command"
  expose: Array<"ui" | "sdk">
  input: PluginSchema<Input>
  output: PluginSchema<Output>
  timeoutMs?: number
  handler(input: Input, context: PluginInvocationContext): Promise<Output>
}

export interface EventContribution<Payload = unknown> extends ContributionBase<"event"> {
  payload: PluginSchema<Payload>
}

export interface ToolContribution<Input = unknown> extends ContributionBase<"tool"> {
  description: string
  input: PluginSchema<Input>
  exposure?: Record<string, unknown>
  display?: ToolDisplay
  enabledWhen?: PluginSettingCondition
  handler(input: Input, context: PluginInvocationContext): Promise<string | ToolResult>
}

export type PluginCliOption = {
  type: "boolean" | "string" | "number"
  description: string
}

export type PluginCliCommandResult = {
  stdout?: string
  stderr?: string
  exitCode: number
}

export interface CliCommandContribution extends ContributionBase<"cli.command"> {
  description: string
  options: Record<string, PluginCliOption>
  timeoutMs?: number
  handler(args: Record<string, unknown>, context: PluginInvocationContext): Promise<PluginCliCommandResult>
}

export type PluginSystemTransformInput = {
  phase: "budget" | "final"
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  messageID?: string
  small?: boolean
  system: string[]
}

export interface PluginHookPointInputs {
  "runtime.started": { endpointGeneration: string }
  "agent.call.after": PluginAgentCallAfterInput
  "cortex.task.after": PluginCortexTaskAfterInput
  "blueprint.after": BlueprintAfterInput
  "session.user-message.after": SessionUserMessageAfterInput
  "chat.system.transform": PluginSystemTransformInput
  /** @deprecated Use the stable `chat.system.transform` hook. */
  "experimental.chat.system.transform": PluginSystemTransformInput
}

export interface PluginHookPointOutputs {
  "chat.system.transform": { system: string[] }
  /** @deprecated Use the stable `chat.system.transform` hook. */
  "experimental.chat.system.transform": { system: string[] }
}

export interface HookContribution<Point extends string = string> extends ContributionBase<"hook"> {
  point: Point
  priority: number
  handler(
    input: Point extends keyof PluginHookPointInputs ? PluginHookPointInputs[Point] : unknown,
    context: PluginInvocationContext,
  ): Promise<Point extends keyof PluginHookPointOutputs ? PluginHookPointOutputs[Point] : unknown>
}

export interface AgentContribution extends ContributionBase<"agent"> {
  agent: PluginAgent
}

export interface SkillContribution extends ContributionBase<"skill"> {
  skill: PluginSkill
}

export interface McpContribution extends ContributionBase<"mcp"> {
  server: McpServerConfig
  enabledWhen?: PluginSettingCondition
}

export interface PluginAuthProviderProfile {
  name: string
  aliases?: string[]
  description?: string
  signupUrl?: string
  env?: string[]
  baseURL?: string
  modelsURL?: string
  authKind?: "api_key" | "oauth" | "oauth_external" | "none"
  fallbackModels?: string[]
  recommendation?: Record<string, unknown>
  methods?: Array<{
    type: "oauth" | "api" | "import"
    label: string
    prompts?: Array<Record<string, unknown>>
  }>
  hasLoader?: boolean
}

export interface AuthProviderContribution extends ContributionBase<"authProvider"> {
  profile: PluginAuthProviderProfile
  handler(input: { action: string; payload?: unknown }, context: PluginInvocationContext): Promise<unknown>
}

export interface TrustedComponentReference {
  source: string
  exportName?: string
}

interface UISurfaceContributionBase<Kind extends string> extends ContributionBase<Kind> {
  label: string
  icon?: string
  order: number
  component?: TrustedComponentReference
}

export interface WorkbenchPanelContribution extends UISurfaceContributionBase<"ui.workbenchPanel"> {
  surface: "side" | "bottom"
  cardinality: "exclusive" | "singleton" | "multi"
  requiresSession?: boolean
  defaultResource?: { id: string; title: string; state?: unknown }
}

export interface NavigationItemContribution extends UISurfaceContributionBase<"ui.navigationItem"> {
  placement: "sidebar" | "page"
}

export interface MessageRendererContribution extends UISurfaceContributionBase<"ui.messageRenderer"> {
  messageType: string
  tool?: string
}

export interface ComposerActionContribution extends UISurfaceContributionBase<"ui.composerAction"> {
  slot: string
}

interface HeadlessUIContributionBase<Kind extends string> extends ContributionBase<Kind> {
  order: number
  component: TrustedComponentReference
}

export interface ComposerExtensionContribution extends HeadlessUIContributionBase<"ui.composerExtension"> {}

export interface SelectionExtensionContribution extends HeadlessUIContributionBase<"ui.selectionExtension"> {}

export type PluginTextSelectionSource = "document" | "code" | "terminal"

export type PluginTextSelectionOrigin = "user_message" | "assistant_message" | "editable" | "other"

export type PluginTextSelectionSnapshot = {
  selectionId: string
  text: string
  source: PluginTextSelectionSource
  origin: PluginTextSelectionOrigin
  editable: boolean
  wholeContainer: boolean
}

export type PluginTextActionWhen = {
  sources?: PluginTextSelectionSource[]
  origins?: PluginTextSelectionOrigin[]
  minChars?: number
  maxChars?: number
  editable?: boolean
}

export type PluginTextActionPresentation = {
  kind: "popover"
  component: TrustedComponentReference
  width?: "sm" | "md" | "lg"
}

export interface TextActionContribution extends ContributionBase<"ui.textAction"> {
  label: string
  icon?: string
  order: number
  operation: string
  when?: PluginTextActionWhen
  presentation?: PluginTextActionPresentation
}

export interface MessageSlotContribution extends HeadlessUIContributionBase<"ui.messageSlot"> {
  slot: "message.before" | "message.after" | "message.actions"
  roles?: Array<"user" | "assistant">
}

export interface SettingsContribution extends UISurfaceContributionBase<"ui.settings"> {
  group: string
  formSchema?: PluginJsonSchema
  visibility?: "standard" | "developer"
}
export interface SlotContribution extends UISurfaceContributionBase<"ui.slot"> {
  /** Host-declared slot name, e.g. "sidebar.footer" or "session.empty". */
  slot: string
  /** Minimal visibility conditions. Omit to always show. */
  when?: { session?: boolean }
  /** A slot is a render position: it always needs a trusted component. */
  component: TrustedComponentReference
}

export interface ThemeContribution extends ContributionBase<"ui.theme"> {
  label: string
  path: string
}

export interface IconContribution extends ContributionBase<"ui.icon"> {
  path: string
}

export interface LifecycleUpgradeContribution extends ContributionBase<"lifecycle.upgrade"> {
  handler(input: { fromVersion: string; toVersion: string }, context: PluginInvocationContext): Promise<void>
}

export interface LifecycleInstallContribution extends ContributionBase<"lifecycle.install"> {
  handler(context: PluginInvocationContext): Promise<void>
}

export interface LifecycleUninstallContribution extends ContributionBase<"lifecycle.uninstall"> {
  handler(context: PluginInvocationContext): Promise<void>
}

export type PluginContribution =
  | OperationContribution
  | EventContribution
  | ToolContribution
  | HookContribution
  | CliCommandContribution
  | AgentContribution
  | SkillContribution
  | McpContribution
  | AuthProviderContribution
  | WorkbenchPanelContribution
  | NavigationItemContribution
  | MessageRendererContribution
  | ComposerActionContribution
  | ComposerExtensionContribution
  | SelectionExtensionContribution
  | TextActionContribution
  | MessageSlotContribution
  | SettingsContribution
  | SlotContribution
  | ThemeContribution
  | IconContribution
  | LifecycleInstallContribution
  | LifecycleUpgradeContribution
  | LifecycleUninstallContribution

export type ExecutablePluginContribution = Extract<PluginContribution, { handler: (...args: never[]) => unknown }>

export const EXECUTABLE_CONTRIBUTION_KINDS = [
  "operation",
  "tool",
  "hook",
  "cli.command",
  "authProvider",
  "lifecycle.install",
  "lifecycle.upgrade",
  "lifecycle.uninstall",
] as const

export function isExecutableContributionKind(kind: string): boolean {
  return (EXECUTABLE_CONTRIBUTION_KINDS as readonly string[]).includes(kind)
}

export function contributionHandlerId(contribution: PluginContribution): string | undefined {
  return "handler" in contribution ? `${contribution.kind}:${contribution.id}` : undefined
}

export function operation<Input, Output>(
  input: Omit<OperationContribution<Input, Output>, "kind" | "expose"> & {
    expose?: Array<"ui" | "sdk">
  },
): OperationContribution<Input, Output> {
  return { ...input, kind: "operation", expose: input.expose ?? ["ui"] }
}

export function event<Payload>(input: Omit<EventContribution<Payload>, "kind">): EventContribution<Payload> {
  return { ...input, kind: "event" }
}

export function tool<Input>(input: Omit<ToolContribution<Input>, "kind">): ToolContribution<Input> {
  return { ...input, kind: "tool" }
}

export function cliCommand(
  input: Omit<CliCommandContribution, "kind" | "options"> & { options?: Record<string, PluginCliOption> },
): CliCommandContribution {
  return { ...input, kind: "cli.command", options: input.options ?? {} }
}

export function hook<Point extends string>(
  input: Omit<HookContribution<Point>, "kind" | "priority"> & { priority?: number },
): HookContribution<Point> {
  return { ...input, kind: "hook", priority: input.priority ?? 0 }
}

export function agent(input: Omit<AgentContribution, "kind">): AgentContribution {
  return { ...input, kind: "agent" }
}

export function skill(input: Omit<SkillContribution, "kind">): SkillContribution {
  return { ...input, kind: "skill" }
}

export function mcp(input: Omit<McpContribution, "kind">): McpContribution {
  return { ...input, kind: "mcp" }
}

export function authProvider(input: Omit<AuthProviderContribution, "kind">): AuthProviderContribution {
  return { ...input, kind: "authProvider" }
}

export function workbenchPanel(
  input: Omit<WorkbenchPanelContribution, "kind" | "order"> & { order?: number },
): WorkbenchPanelContribution {
  return { ...input, kind: "ui.workbenchPanel", order: input.order ?? 1000 }
}

export function navigationItem(
  input: Omit<NavigationItemContribution, "kind" | "order"> & { order?: number },
): NavigationItemContribution {
  return { ...input, kind: "ui.navigationItem", order: input.order ?? 1000 }
}

export function messageRenderer(
  input: Omit<MessageRendererContribution, "kind" | "order"> & { order?: number },
): MessageRendererContribution {
  return { ...input, kind: "ui.messageRenderer", order: input.order ?? 1000 }
}

export function composerAction(
  input: Omit<ComposerActionContribution, "kind" | "order"> & { order?: number },
): ComposerActionContribution {
  return { ...input, kind: "ui.composerAction", order: input.order ?? 1000 }
}

export function composerExtension(
  input: Omit<ComposerExtensionContribution, "kind" | "order"> & { order?: number },
): ComposerExtensionContribution {
  return { ...input, kind: "ui.composerExtension", order: input.order ?? 1000 }
}

export function selectionExtension(
  input: Omit<SelectionExtensionContribution, "kind" | "order" | "requires"> & {
    order?: number
    requires?: ["selection.read"]
  },
): SelectionExtensionContribution {
  return { ...input, kind: "ui.selectionExtension", order: input.order ?? 1000, requires: ["selection.read"] }
}

export function textAction(
  input: Omit<TextActionContribution, "kind" | "order" | "requires"> & {
    order?: number
    requires?: ["selection.read"]
  },
): TextActionContribution {
  return { ...input, kind: "ui.textAction", order: input.order ?? 1000, requires: ["selection.read"] }
}

export function messageSlot(
  input: Omit<MessageSlotContribution, "kind" | "order"> & { order?: number },
): MessageSlotContribution {
  return { ...input, kind: "ui.messageSlot", order: input.order ?? 1000 }
}

export function settings(
  input: Omit<SettingsContribution, "kind" | "order"> & { order?: number },
): SettingsContribution {
  return { ...input, kind: "ui.settings", order: input.order ?? 1000 }
}
export function slot(input: Omit<SlotContribution, "kind" | "order"> & { order?: number }): SlotContribution {
  return { ...input, kind: "ui.slot", order: input.order ?? 1000 }
}

export function theme(input: Omit<ThemeContribution, "kind">): ThemeContribution {
  return { ...input, kind: "ui.theme" }
}

export function icon(input: Omit<IconContribution, "kind">): IconContribution {
  return { ...input, kind: "ui.icon" }
}

export function lifecycleUpgrade(input: Omit<LifecycleUpgradeContribution, "kind">): LifecycleUpgradeContribution {
  return { ...input, kind: "lifecycle.upgrade" }
}

export function lifecycleInstall(input: Omit<LifecycleInstallContribution, "kind">): LifecycleInstallContribution {
  return { ...input, kind: "lifecycle.install" }
}

export function lifecycleUninstall(
  input: Omit<LifecycleUninstallContribution, "kind">,
): LifecycleUninstallContribution {
  return { ...input, kind: "lifecycle.uninstall" }
}

export function schemaToJsonSchema(schema: PluginSchema): PluginJsonSchema {
  if ("_zod" in schema) {
    return z.toJSONSchema(schema as unknown as z.ZodType) as PluginJsonSchema
  }
  return structuredClone(schema)
}
