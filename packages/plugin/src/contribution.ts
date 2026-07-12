import z from "zod"
import type { PluginCortexTaskAfterInput, PluginInvocationContext } from "./context.js"
import type { PluginAgent, PluginSkill } from "./plugin-types.js"
import type { ToolDisplay, ToolResult } from "./tool.js"

export type PluginJsonSchema = Record<string, unknown>
export type PluginSchema<T = unknown> = z.ZodType<T> | PluginJsonSchema

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

export interface PluginHookPointInputs {
  "cortex.task.after": PluginCortexTaskAfterInput
}

export interface HookContribution<Point extends string = string> extends ContributionBase<"hook"> {
  point: Point
  priority: number
  handler(
    input: Point extends keyof PluginHookPointInputs ? PluginHookPointInputs[Point] : unknown,
    context: PluginInvocationContext,
  ): Promise<unknown>
}

export interface AgentContribution extends ContributionBase<"agent"> {
  agent: PluginAgent
}

export interface SkillContribution extends ContributionBase<"skill"> {
  skill: PluginSkill
}

export interface McpContribution extends ContributionBase<"mcp"> {
  server: Record<string, unknown>
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
}

export interface ComposerActionContribution extends UISurfaceContributionBase<"ui.composerAction"> {
  slot: string
}

export interface SettingsContribution extends UISurfaceContributionBase<"ui.settings"> {
  group: string
  formSchema?: PluginJsonSchema
  visibility?: "standard" | "developer"
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

export interface LifecycleUninstallContribution extends ContributionBase<"lifecycle.uninstall"> {
  handler(context: PluginInvocationContext): Promise<void>
}

export type PluginContribution =
  | OperationContribution
  | EventContribution
  | ToolContribution
  | HookContribution
  | AgentContribution
  | SkillContribution
  | McpContribution
  | AuthProviderContribution
  | WorkbenchPanelContribution
  | NavigationItemContribution
  | MessageRendererContribution
  | ComposerActionContribution
  | SettingsContribution
  | ThemeContribution
  | IconContribution
  | LifecycleUpgradeContribution
  | LifecycleUninstallContribution

export type ExecutablePluginContribution = Extract<PluginContribution, { handler: (...args: never[]) => unknown }>

export const EXECUTABLE_CONTRIBUTION_KINDS = [
  "operation",
  "tool",
  "hook",
  "authProvider",
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

export function settings(
  input: Omit<SettingsContribution, "kind" | "order"> & { order?: number },
): SettingsContribution {
  return { ...input, kind: "ui.settings", order: input.order ?? 1000 }
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

export function lifecycleUninstall(
  input: Omit<LifecycleUninstallContribution, "kind">,
): LifecycleUninstallContribution {
  return { ...input, kind: "lifecycle.uninstall" }
}

export function schemaToJsonSchema(schema: PluginSchema): PluginJsonSchema {
  if ("_zod" in schema) return z.toJSONSchema(schema as z.ZodType) as PluginJsonSchema
  return structuredClone(schema)
}
