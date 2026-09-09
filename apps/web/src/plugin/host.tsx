import { pluginPreviewChanged, pluginPreviewEnabled } from "./preview"
import { pluginExtensionTarget } from "./extension-diagnostics"
import { createExtensionOutlets, ExtensionOutletsProvider } from "@ericsanchezok/synergy-ui/context/extension-outlet"
import { createPluginExtensions } from "./extension-service"
import { PluginMenuOutlet } from "./menu-outlet"
import { PLUGIN_MENU_LOCATIONS, matchesPluginUICondition } from "@ericsanchezok/synergy-plugin"
import { useCommand } from "@/context/command"
import type { createCommandRegistry } from "@/context/command-registry"
import { installPluginCommands } from "./command-adapter"
import { createPluginSurfaceCommands } from "./surface-commands"
import { pluginMenus } from "./registries/menu-registry"
import { PLUGIN_GENERIC_SLOTS } from "@ericsanchezok/synergy-plugin"
import { createPluginSurfaceOverlays } from "./surface-overlays"
import { registerSkin, getSkin } from "./registries/skin-registry"
import {
  type Accessor,
  type Owner,
  getOwner,
  batch,
  createComponent,
  createContext,
  createEffect,
  createMemo,
  Show,
  createSignal,
  onCleanup,
  type Component,
  type ParentProps,
  useContext,
} from "solid-js"
import {
  type PluginComposerSurfaceContext,
  type PluginManifestContribution,
  type PluginSelectionSurfaceContext,
  type PluginTextActionSurfaceContext,
  type PluginMessageSurfaceContext,
  type PluginSurfaceContext,
  type PluginSettingsComponentProps,
  type PluginShellContext,
  type PluginWorkbenchSurfaceContext,
  hasTrustedUIComponent,
  trustedUIComponent,
} from "@ericsanchezok/synergy-plugin"
import type { ToolProps } from "@ericsanchezok/synergy-ui/message-part"
import { useGlobalSDK } from "@/context/global-sdk"
import { createPluginGenerations, type PreparedPluginUI } from "./generations"
import { createPluginEnvironment } from "./environment"
import { PluginComponentMount } from "./component-mount"
import { createPluginSurfaceAccess } from "./surface-access"
import { bindPluginWorkbench } from "./surface-workbench"
import { createWorkbenchService } from "./workbench-service"
import { useWorkbenchPanels } from "@/context/workbench"
import { bindPluginInput, bindPluginSession } from "./surface-session"
import { bindPluginConversation } from "./surface-conversation"
import { bindPluginComposerLayout } from "./surface-composer-layout"
import { createPluginSurfaceLifetime } from "./surface-lifetime"
import { createPluginSurfaceOperations } from "./surface-operations"
import { createPluginSurfaceEvents } from "./surface-events"
import { useServer } from "@/context/server"
import { fetchUIContributions, type PluginContribution } from "./api"
import { resolvePluginAssetUrl } from "./asset-url"
import { createPluginExportLoader, isCompatibleUIVersion, CURRENT_UI_API_VERSION } from "./loaders"
import {
  injectPluginStylesheet,
  loadPluginUIAssets,
  resolvePluginIconReference,
  type PluginUIAssets,
} from "./ui-assets"
import { pluginSurfaceId } from "./surface-id"
import { registerComposerSlot, type ComposerSlotProps } from "./registries/composer-slot-registry"
import { registerComposerExtension, type ComposerExtensionProps } from "./registries/composer-extension-registry"
import { registerIcon } from "./registries/icon-registry"
import { registerNavigation, type NavigationContentProps } from "./registries/navigation-registry"
import { registerPartRenderer } from "./registries/part-registry"
import { registerPluginToolRenderer } from "./registries/tool-renderer-registry"
import { registerSettingsSection } from "./registries/settings-registry"
import { registerWorkbenchPanel, type WorkbenchPanelContentProps } from "./registries/workbench-panel-registry"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { textSelectionController, type TextActionPresentationProps } from "@/context/text-selection"
import { registerSelectionExtension } from "./registries/selection-extension-registry"
import { registerMessageSlot } from "./registries/message-slot-registry"
import type { MessageSlotProps } from "@ericsanchezok/synergy-ui/message-slots"
import { createPluginSurfaceSettings } from "./surface-settings"
import { createPluginToolMessageContext } from "./tool-message-context"
import { pluginSlots } from "./slot-registry"
import { registerShell, getShell, type ShellRenderProps } from "./registries/shell-registry"
import { createShellPreference } from "./shell-preference"
import { useSafeUI } from "./ui-recovery"

/** Host-declared slots that generic `ui.slot` contributions may target. */
export const HOST_SLOTS = new Set<string>(PLUGIN_GENERIC_SLOTS)

export interface PluginUIStatus {
  state: "registered" | "loading" | "available" | "failed" | "incompatible"
  generation: string
  availableGeneration?: string
  reason?: string
}
export interface PluginUIError {
  pluginId: string
  message: string
  timestamp: number
}
interface PluginHostValue {
  reportError(error: Omit<PluginUIError, "timestamp">): void
  shell: ReturnType<typeof createShellPreference> & { current(): string; failed(id: string): void }
  skin: ReturnType<typeof createShellPreference>
  safeUI: boolean
  resources: ReturnType<typeof createPluginEnvironment>["resources"]
  environment: ReturnType<typeof createPluginEnvironment>["environment"]
  extensions(
    pluginId: string,
  ): Array<{ id: string; outlet: import("@ericsanchezok/synergy-plugin").PluginExtensionId; mounted: boolean }>
  plugins: () => PluginContribution[]
  status: () => Map<string, PluginUIStatus>
  loadedPluginIds: () => string[]
  errors: () => PluginUIError[]
  reload: () => Promise<void>
}

const PluginHostContext = createContext<PluginHostValue>()
const navigationPath = (pluginId: string, id: string) =>
  `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(id)}`

function surfaceContext(input: {
  contribution: PluginContribution
  contributionId: string
  kind: string
  serverUrl: string
  client: ReturnType<typeof useGlobalSDK>["client"]
  events: ReturnType<typeof useGlobalSDK>["event"]
  scopeKey: string
  sessionId?: string
  resource?: { id: string; title?: string; state?: unknown }
  environment: ReturnType<typeof createPluginEnvironment>
  commands: ReturnType<typeof createCommandRegistry>
  reportError(error: Omit<PluginUIError, "timestamp">): void
}): PluginSurfaceContext {
  const pluginId = input.contribution.pluginId
  const lifetime = createPluginSurfaceLifetime((error) => {
    console.error(`Plugin ${pluginId} surface cleanup failed`, error)
  })
  onCleanup(lifetime.dispose)
  const access = createPluginSurfaceAccess({
    lifetime: lifetime.context,
    capabilities: input.contribution.capabilities,
    current: () => input.sessionId === undefined || input.environment.sessionId() === input.sessionId,
  })
  const overlays = createPluginSurfaceOverlays({
    pluginId,
    lifetime: lifetime.context,
    access,
    reportError: input.reportError,
  })
  const requireHostActions = () => {
    lifetime.context.signal.throwIfAborted()
    if (!input.contribution.capabilities.includes("ui.hostActions"))
      throw new Error("Plugin is not approved for ui.hostActions")
  }
  const readSessions = () => {
    access.require("session.read")
    return input.environment.sessions
  }
  return {
    sessions: {
      list: () => readSessions().list(),
      get: (id) => readSessions().get(id),
      total: () => readSessions().total(),
      ready: () => readSessions().ready(),
      refresh: () => access.run("session.read", () => input.environment.sessions.refresh()),
    },
    lifetime: lifetime.context,
    overlays,
    extensions: createPluginExtensions(() => input.sessionId ?? input.environment.sessionId()),
    commands: createPluginSurfaceCommands({
      pluginId,
      commands: input.commands,
      menus: pluginMenus,
      lifetime: lifetime.context,
      access,
      context: () => ({
        session: Boolean(input.environment.sessionId()),
        page: input.environment.environment.route().page,
        platform: input.environment.environment.platform(),
        visible: input.environment.environment.visible(),
      }),
      reportError: input.reportError,
    }),
    environment: input.environment.environment,
    navigation: {
      open(route, options) {
        requireHostActions()
        lifetime.context.signal.throwIfAborted()
        input.environment.navigation.open(route, options)
      },
    },
    pluginId,
    scopeId: input.contribution.scopeId,
    sessionId: input.sessionId,
    surface: {
      kind: input.kind,
      id: input.contributionId,
      ...(input.resource ? { resource: input.resource } : {}),
    },
    operations: createPluginSurfaceOperations({
      client: input.client,
      pluginId,
      scopeId: input.contribution.scopeId,
      sessionId: input.sessionId,
      lifetime: lifetime.context,
      contributions: input.contribution.contributions,
    }),
    events: createPluginSurfaceEvents({
      events: input.events,
      pluginId,
      scopeId: input.contribution.scopeId,
      sessionId: input.sessionId,
      generation: input.contribution.generation,
      eventIds: input.contribution.contributions.filter((item) => item.kind === "event").map((item) => item.id),
      lifetime: lifetime.context,
    }),
    settings: createPluginSurfaceSettings({
      client: input.client,
      pluginId,
      scopeId: input.contribution.scopeId,
      canWrite: input.contribution.capabilities.includes("settings.write"),
      events: window,
      lifetime: lifetime.context,
    }),
    workbench: bindPluginWorkbench(input.environment.workbench, access, lifetime.context),
    resources: {
      open(resource) {
        requireHostActions()
        return input.environment.resources.open(resource)
      },
    },
  }
}

async function preparePluginSurfaces(input: {
  contributions: PluginContribution[]
  serverUrl: string
  client: ReturnType<typeof useGlobalSDK>["client"]
  events: ReturnType<typeof useGlobalSDK>["event"]
  scopeKey: string
  assets: PluginUIAssets
  owner: Owner | null
  environment: ReturnType<typeof createPluginEnvironment>
  commands: ReturnType<typeof createCommandRegistry>
  reportError(error: Omit<PluginUIError, "timestamp">): void
}) {
  const modules = createPluginExportLoader()
  const installs: Array<() => () => void> = []
  let disposers: Array<() => void> = []
  const errors: PluginUIError[] = input.assets.errors.map((error) => ({ ...error, timestamp: Date.now() }))
  const fail = (pluginId: string, message: string) => errors.push({ pluginId, message, timestamp: Date.now() })

  for (const plugin of input.contributions) {
    if (plugin.contributions.some((item) => item.kind === "ui.command"))
      installs.push(() =>
        installPluginCommands({
          contributions: plugin.contributions,
          owner: input.owner,
          context: () =>
            surfaceContext({ ...input, contribution: plugin, contributionId: "commands", kind: "ui.command" }),
        }),
      )
    const asset = (file: string) => resolvePluginAssetUrl(input.serverUrl, plugin.pluginId, plugin.generation, file)
    for (const stylesheet of input.assets.stylesheets.get(plugin.pluginId) ?? []) {
      installs.push(() =>
        injectPluginStylesheet(
          asset(stylesheet),
          plugin.uiArtifact!.resources!.find((resource) => resource.entry === stylesheet)!.sha256,
        ),
      )
    }
    const componentLoader = <Props extends object>(
      item: PluginManifestContribution,
      session: (props: Props) => string | undefined = () => input.environment.sessionId(),
      resource: (props: Props) => { id: string; title?: string; state?: unknown } | undefined = () => undefined,
      extendContext?: (context: PluginSurfaceContext, props: Props) => PluginSurfaceContext,
    ) => {
      if (!("component" in item) || !item.component) return undefined
      return async () => {
        const loaded = await modules.load<Component<{ context: PluginSurfaceContext }>>(
          plugin.pluginId,
          asset(item.component!.entry),
          item.component!.exportName,
          plugin.uiArtifact?.apiVersion,
          plugin.uiArtifact?.sha256,
        )
        const Wrapper: Component<Props> = (props) => {
          const identity = createMemo(() => JSON.stringify([session(props), resource(props)?.id]))
          return (
            <Show when={identity()} keyed>
              {(_identity) => {
                const context = surfaceContext({
                  contribution: plugin,
                  contributionId: item.id,
                  kind: item.kind,
                  serverUrl: input.serverUrl,
                  client: input.client,
                  events: input.events,
                  scopeKey: input.scopeKey,
                  sessionId: session(props),
                  resource: resource(props),
                  environment: input.environment,
                  commands: input.commands,
                  reportError: input.reportError,
                })
                return (
                  <PluginComponentMount
                    component={loaded.default}
                    context={extendContext?.(context, props) ?? context}
                    reportError={input.reportError}
                  />
                )
              }}
            </Show>
          )
        }
        return { default: Wrapper }
      }
    }

    const textActionComponentLoader = (item: Extract<PluginManifestContribution, { kind: "ui.textAction" }>) => {
      const component = item.presentation?.component
      if (!component) return undefined
      return async () => {
        const loaded = await modules.load<Component<{ context: PluginTextActionSurfaceContext }>>(
          plugin.pluginId,
          asset(component.entry),
          component.exportName,
          plugin.uiArtifact?.apiVersion,
          plugin.uiArtifact?.sha256,
        )
        const Wrapper: Component<TextActionPresentationProps> = (props) => {
          const context = surfaceContext({
            contribution: plugin,
            contributionId: item.id,
            kind: item.kind,
            serverUrl: input.serverUrl,
            client: input.client,
            events: input.events,
            scopeKey: input.scopeKey,
            sessionId: input.environment.sessionId(),
            environment: input.environment,
            commands: input.commands,
            reportError: input.reportError,
          })
          return createComponent(PluginComponentMount<PluginTextActionSurfaceContext>, {
            component: loaded.default,
            reportError: input.reportError,
            context: {
              ...context,
              textAction: {
                invocationId: props.invocationId,
                selection: props.selection,
                output: props.output,
                close: props.close,
              },
            } satisfies PluginTextActionSurfaceContext,
          })
        }
        return { default: Wrapper }
      }
    }

    const adapters = {
      "ui.shell": (item: Extract<PluginManifestContribution, { kind: "ui.shell" }>) => {
        if (!plugin.capabilities.includes("ui.shell")) {
          fail(plugin.pluginId, "Shell contribution is not approved for ui.shell")
          return
        }
        const extendShell = (context: PluginSurfaceContext, props: ShellRenderProps): PluginShellContext => {
          const access = createPluginSurfaceAccess({
            lifetime: context.lifetime,
            capabilities: plugin.capabilities.filter((capability) => item.requires?.includes(capability)),
            current: () => props.sessionId === context.sessionId,
          })
          let sourceInput: ShellRenderProps["input"]
          let boundInput: ShellRenderProps["input"]
          return {
            ...context,
            shell: props.shell,
            layout: props.layout,
            workbench: bindPluginWorkbench(props.workbench ?? input.environment.workbench, access, context.lifetime),
            session: props.session ? bindPluginSession(props.session, access) : undefined,
            conversation: props.conversation ? bindPluginConversation(props.conversation, access) : undefined,
            composerLayout: props.composerLayout ? bindPluginComposerLayout(props.composerLayout, access) : undefined,
            get input() {
              if (sourceInput !== props.input) {
                sourceInput = props.input
                boundInput = sourceInput ? bindPluginInput(sourceInput, access) : undefined
              }
              return boundInput
            },
          }
        }
        const loader = componentLoader<ShellRenderProps>(
          item,
          () => undefined,
          () => undefined,
          extendShell,
        )
        if (!loader) return
        const pages = Object.fromEntries(
          Object.entries(item.pages ?? {}).map(([page, component]) => [
            page,
            componentLoader<ShellRenderProps>(
              { ...item, component },
              (props) => props.sessionId,
              () => undefined,
              extendShell,
            ),
          ]),
        )
        installs.push(() =>
          registerShell({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            pluginId: plugin.pluginId,
            label: item.label,
            order: item.order,
            loader,
            pages,
          }),
        )
      },
      "ui.workbenchPanel": (item: Extract<PluginManifestContribution, { kind: "ui.workbenchPanel" }>) => {
        const loader = componentLoader<WorkbenchPanelContentProps>(
          item,
          () => input.environment.sessionId(),
          (props) =>
            props.tab.resourceId
              ? {
                  id: props.tab.resourceId,
                  ...(props.tab.title ? { title: props.tab.title } : {}),
                  ...(props.tab.state !== undefined ? { state: props.tab.state } : {}),
                }
              : undefined,
          (context, props): PluginWorkbenchSurfaceContext => {
            const source = createWorkbenchService(useWorkbenchPanels())
            const access = createPluginSurfaceAccess({
              lifetime: context.lifetime,
              capabilities: plugin.capabilities.filter((capability) => item.requires?.includes(capability)),
              current: () => input.environment.sessionId() === context.sessionId,
            })
            return {
              ...context,
              workbench: bindPluginWorkbench(source, access, context.lifetime),
              tab: () => {
                access.require("workbench.read")
                return props.tab
              },
            }
          },
        )
        if (!loader) {
          fail(plugin.pluginId, `Workbench panel ${item.id} has no trusted component`)
          return
        }
        installs.push(() =>
          registerWorkbenchPanel({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            label: item.label,
            icon: resolvePluginIconReference(plugin, item.icon),
            order: item.order,
            surface: item.surface,
            cardinality: item.cardinality,
            requiresSession: item.requiresSession,
            pluginId: plugin.pluginId,
            loader,
            defaultResource: item.defaultResource
              ? {
                  resourceId: item.defaultResource.id,
                  title: item.defaultResource.title,
                  state: item.defaultResource.state,
                  source: "plugin",
                }
              : undefined,
            createTab: item.defaultResource
              ? () => ({
                  resourceId: item.defaultResource!.id,
                  title: item.defaultResource!.title,
                  state: item.defaultResource!.state,
                  source: "plugin",
                })
              : undefined,
          }),
        )
      },
      "ui.navigationItem": (item: Extract<PluginManifestContribution, { kind: "ui.navigationItem" }>) => {
        const loader = componentLoader<NavigationContentProps>(item)
        if (!loader) {
          fail(plugin.pluginId, `Navigation item ${item.id} has no trusted component`)
          return
        }
        installs.push(() =>
          registerNavigation({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            navigationId: item.id,
            label: item.label,
            icon: resolvePluginIconReference(plugin, item.icon),
            order: item.order,
            placement: item.placement,
            path: navigationPath(plugin.pluginId, item.id),
            pluginId: plugin.pluginId,
            loader,
          }),
        )
      },
      "ui.messageRenderer": (item: Extract<PluginManifestContribution, { kind: "ui.messageRenderer" }>) => {
        const tool = item.tool
        if (tool) {
          const loader = componentLoader<ToolProps>(
            item,
            (props) => props.sessionId ?? input.environment.sessionId(),
            () => undefined,
            (context, props) => createPluginToolMessageContext(context, props),
          )
          if (loader) installs.push(() => registerPluginToolRenderer(tool, loader as never))
          return
        }
        const loader = componentLoader<{ sessionId?: string }>(
          item,
          (props) => props.sessionId ?? input.environment.sessionId(),
        )
        if (loader) installs.push(() => registerPartRenderer(item.messageType, undefined, loader as never))
      },
      "ui.composerAction": (item: Extract<PluginManifestContribution, { kind: "ui.composerAction" }>) => {
        const loader = componentLoader<ComposerSlotProps>(item, (props) => props.sessionId)
        if (loader)
          installs.push(() =>
            registerComposerSlot({
              id: pluginSurfaceId(plugin.pluginId, item.id),
              slot: item.slot as ComposerSlotProps["slot"],
              order: item.order,
              pluginId: plugin.pluginId,
              loader,
            }),
          )
      },
      "ui.composerExtension": (item: Extract<PluginManifestContribution, { kind: "ui.composerExtension" }>) => {
        const loader = componentLoader<ComposerExtensionProps>(
          item,
          (props) => props.sessionId,
          () => undefined,
          (context, props) => {
            const approved = new Set(plugin.capabilities)
            const declared = new Set(item.requires ?? [])
            const capabilities = new Set(
              ["composer.read", "composer.write", "composer.intercept"].filter(
                (capability) => approved.has(capability) && declared.has(capability),
              ),
            ) as ReadonlySet<"composer.read" | "composer.write" | "composer.intercept">
            const composer = props.controller.service({
              id: pluginSurfaceId(plugin.pluginId, item.id),
              order: item.order,
              capabilities,
            })
            onCleanup(() => composer.dispose())
            return { ...context, composer } satisfies PluginComposerSurfaceContext
          },
        )
        if (!loader) {
          fail(plugin.pluginId, `Composer extension ${item.id} has no trusted component`)
          return
        }
        installs.push(() =>
          registerComposerExtension({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            slot: "composer.extension",
            order: item.order,
            pluginId: plugin.pluginId,
            loader,
          }),
        )
      },
      "ui.selectionExtension": (item: Extract<PluginManifestContribution, { kind: "ui.selectionExtension" }>) => {
        const loader = componentLoader<object>(
          item,
          () => input.environment.sessionId(),
          () => undefined,
          (context) =>
            ({
              ...context,
              selection: {
                current: () => textSelectionController.current(),
                onSettled: (listener) => textSelectionController.onSettled(listener),
              },
            }) satisfies PluginSelectionSurfaceContext,
        )
        if (!loader) {
          fail(plugin.pluginId, `Selection extension ${item.id} has no trusted component`)
          return
        }
        installs.push(() =>
          registerSelectionExtension({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            slot: "selection.extension",
            order: item.order,
            pluginId: plugin.pluginId,
            loader,
          }),
        )
      },
      "ui.textAction": (item: Extract<PluginManifestContribution, { kind: "ui.textAction" }>) => {
        const presentationLoader = textActionComponentLoader(item)
        if (item.presentation && !presentationLoader) {
          fail(plugin.pluginId, `Text action ${item.id} has no trusted result component`)
          return
        }
        installs.push(() =>
          textSelectionController.registerAction({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            pluginId: plugin.pluginId,
            pluginName: plugin.name,
            label: item.label,
            icon: resolvePluginIconReference(plugin, item.icon),
            order: item.order,
            when: item.when,

            presentation:
              item.presentation && presentationLoader
                ? {
                    kind: item.presentation.kind,
                    width: item.presentation.width,
                    load: presentationLoader,
                  }
                : undefined,
            run: async (value, signal) => {
              const lifetime = createPluginSurfaceLifetime((error) => fail(plugin.pluginId, String(error)))
              try {
                return await createPluginSurfaceOperations({
                  client: input.client,
                  pluginId: plugin.pluginId,
                  scopeId: plugin.scopeId,
                  sessionId: input.environment.sessionId(),
                  contributions: plugin.contributions,
                  lifetime: lifetime.context,
                }).command(item.operation, value, { signal })
              } finally {
                lifetime.dispose()
              }
            },
          }),
        )
      },
      "ui.messageSlot": (item: Extract<PluginManifestContribution, { kind: "ui.messageSlot" }>) => {
        const loader = componentLoader<MessageSlotProps>(
          item,
          (props) => props.sessionId,
          () => undefined,
          (context, props) =>
            ({
              ...context,
              message: {
                id: props.messageId!,
                role: props.role!,
              },
            }) satisfies PluginMessageSurfaceContext,
        )
        if (!loader) {
          fail(plugin.pluginId, `Message slot ${item.id} has no trusted component`)
          return
        }
        installs.push(() =>
          registerMessageSlot({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            slot: item.slot,
            roles: item.roles,
            order: item.order,
            pluginId: plugin.pluginId,
            loader,
          }),
        )
      },
      "ui.settings": (item: Extract<PluginManifestContribution, { kind: "ui.settings" }>) => {
        const component = item.component
        const loader = component
          ? async () => {
              const loaded = await modules.load<Component<PluginSettingsComponentProps>>(
                plugin.pluginId,
                asset(component.entry),
                component.exportName,
                plugin.uiArtifact?.apiVersion,
                plugin.uiArtifact?.sha256,
              )
              const Wrapper: Component<PluginSettingsComponentProps> = (props) => (
                <PluginComponentMount
                  component={loaded.default}
                  context={props.context}
                  reportError={input.reportError}
                />
              )
              return { default: Wrapper }
            }
          : undefined
        const createContext = () =>
          surfaceContext({
            contribution: plugin,
            contributionId: item.id,
            kind: item.kind,
            serverUrl: input.serverUrl,
            client: input.client,
            events: input.events,
            scopeKey: input.scopeKey,
            environment: input.environment,
            commands: input.commands,
            reportError: input.reportError,
          })
        installs.push(() =>
          registerSettingsSection({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            label: item.label,
            icon: resolvePluginIconReference(plugin, item.icon),
            group: item.group,
            order: item.order,
            formSchema: item.formSchema,
            visibility: item.visibility,
            pluginId: plugin.pluginId,
            scopeId: plugin.scopeId,
            createContext,
            loader,
          }),
        )
      },
      "ui.slot": (item: Extract<PluginManifestContribution, { kind: "ui.slot" }>) => {
        if (!HOST_SLOTS.has(item.slot)) {
          fail(plugin.pluginId, `Slot ${item.slot} is not declared by the host`)
          return
        }
        if (!("component" in item) || !item.component) {
          fail(plugin.pluginId, `Slot contribution ${item.id} has no trusted component`)
          return
        }
        const loader = componentLoader<{ sessionId?: string }>(item, (props) => props.sessionId)
        installs.push(() =>
          pluginSlots.register({
            id: pluginSurfaceId(plugin.pluginId, item.id),
            slot: item.slot,
            label: item.label,
            icon: resolvePluginIconReference(plugin, item.icon),
            order: item.order,
            when: item.when,
            visible: () =>
              matchesPluginUICondition(item.when, {
                session: Boolean(input.environment.sessionId()),
                page: input.environment.environment.route().page,
                platform: input.environment.environment.platform(),
                visible: input.environment.environment.visible(),
              }),
            pluginId: plugin.pluginId,
            loader,
          }),
        )
      },
      "ui.theme": (item: Extract<PluginManifestContribution, { kind: "ui.theme" }>) => {
        void item
      },
      "ui.skin": (item: Extract<PluginManifestContribution, { kind: "ui.skin" }>) => {
        const loaded = input.assets.skins.get(pluginSurfaceId(plugin.pluginId, item.id))
        if (loaded) installs.push(() => registerSkin(loaded))
      },
      "ui.icon": (item: Extract<PluginManifestContribution, { kind: "ui.icon" }>) => {
        const loaded = input.assets.icons.get(pluginSurfaceId(plugin.pluginId, item.id))
        if (loaded) installs.push(() => registerIcon(loaded))
      },
    }

    for (const item of plugin.contributions) {
      const adapter = adapters[item.kind as keyof typeof adapters]
      if (adapter) adapter(item as never)
    }
  }
  try {
    if (errors.length)
      throw new AggregateError(
        errors.map((error) => new Error(error.message)),
        "Plugin UI preparation failed",
      )
    await Promise.all(
      input.contributions.flatMap((plugin) =>
        plugin.contributions.flatMap((item) => {
          const component = trustedUIComponent(item)
          const components = [
            ...(component ? [component] : []),
            ...(item.kind === "ui.shell" ? Object.values(item.pages ?? {}) : []),
          ]
          return components.map(async (component) => {
            const value = await modules.load(
              plugin.pluginId,
              resolvePluginAssetUrl(input.serverUrl, plugin.pluginId, plugin.generation, component.entry),
              component.exportName,
              plugin.uiArtifact?.apiVersion,
              plugin.uiArtifact?.sha256,
            )
            if (typeof value.default !== "function")
              throw new Error(`UI export ${component.exportName} is not a component`)
          })
        }),
      ),
    )
  } catch (error) {
    modules.dispose()
    throw error
  }
  return {
    install() {
      for (const install of installs) disposers.push(install())
    },
    uninstall() {
      const errors: unknown[] = []
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, "Plugin UI cleanup failed")
    },
    dispose: modules.dispose,
  } satisfies PreparedPluginUI
}

export function PluginHostProvider(props: ParentProps<{ scopeKey: Accessor<string> }>) {
  const outlets = createExtensionOutlets()
  const preview = pluginPreviewEnabled()
  const uiOwner = getOwner()
  const command = useCommand()
  const commands = { register: command.register, trigger: command.trigger, options: () => command.options }
  const environment = createPluginEnvironment(props.scopeKey)
  const server = useServer()
  const globalSDK = useGlobalSDK()
  for (const location of PLUGIN_MENU_LOCATIONS) {
    const loader = async () => ({ default: () => <PluginMenuOutlet location={location} /> })
    onCleanup(
      location === "composer.toolbar.right"
        ? registerComposerSlot({ id: `synergy:menus:${location}`, slot: location, order: 1000, loader })
        : pluginSlots.register({ id: `synergy:menus:${location}`, slot: location, order: 1000, loader }),
    )
  }

  const shellPreference = createShellPreference(() => server.url)
  const safeUI = useSafeUI()
  const skinPreference = createShellPreference(() => server.url, "skin")
  const skin = {
    selected: skinPreference.selected,
    select(id: string) {
      if (id !== "synergy" && !getSkin(id)) throw new Error("Skin is not available in the current Scope")
      skinPreference.select(id)
    },
  }
  const [failedShell, setFailedShell] = createSignal<ReturnType<typeof getShell>>()
  const shell = {
    current: () => {
      const selected = getShell(shellPreference.selected())
      return selected && selected !== failedShell() ? selected.id : "synergy"
    },
    failed: (id: string) => setFailedShell(getShell(id)),
    selected: shellPreference.selected,
    select(id: string) {
      if (id !== "synergy" && !getShell(id)) throw new Error("Shell is not available in the current Scope")
      setFailedShell(undefined)
      shellPreference.select(id)
    },
  }
  const scopeKey = props.scopeKey
  let reloadGeneration = 0
  let reloadController: AbortController | undefined
  let owner = ""
  const [plugins, setPlugins] = createSignal<PluginContribution[]>([])
  const [loaded, setLoaded] = createSignal<PluginContribution[]>([])
  const [status, setStatus] = createSignal(new Map<string, PluginUIStatus>())
  const [errors, setErrors] = createSignal<PluginUIError[]>([])
  const reportError = (error: Omit<PluginUIError, "timestamp">) => {
    setErrors((current) =>
      current.some((item) => item.pluginId === error.pluginId && item.message === error.message)
        ? current
        : [...current, { ...error, timestamp: Date.now() }],
    )
    setStatus((current) => {
      const previous = current.get(error.pluginId)
      return previous
        ? new Map(current).set(error.pluginId, { ...previous, state: "failed", reason: error.message })
        : current
    })
  }
  const generations = createPluginGenerations({
    async prepare(plugin, signal) {
      const serverUrl = server.url
      const scope = scopeKey()
      const incompatible =
        plugin.contributions.some(hasTrustedUIComponent) &&
        !isCompatibleUIVersion(plugin.uiArtifact?.apiVersion ?? "4.0", CURRENT_UI_API_VERSION)
      const reason = incompatible
        ? `Plugin ${plugin.pluginId} requires UI API ${plugin.uiArtifact?.apiVersion ?? "4.0"} but host is ${CURRENT_UI_API_VERSION}. Rebuild the plugin for UI API 5.`
        : undefined
      setStatus((current) =>
        new Map(current).set(plugin.pluginId, {
          ...current.get(plugin.pluginId),
          generation: plugin.generation,
          state: incompatible ? "incompatible" : "loading",
          reason,
        }),
      )
      if (reason)
        setErrors((current) => [
          ...current.filter((error) => error.pluginId !== plugin.pluginId),
          { pluginId: plugin.pluginId, message: reason, timestamp: Date.now() },
        ])
      const executable =
        incompatible || safeUI
          ? {
              ...plugin,
              uiArtifact: undefined,
              contributions: plugin.contributions.filter(
                (item) => !hasTrustedUIComponent(item) && !(safeUI && item.kind === "ui.skin"),
              ),
            }
          : plugin
      const assets = await loadPluginUIAssets(
        [{ ...executable, contributions: executable.contributions.filter((item) => item.kind !== "ui.theme") }],
        { serverUrl, signal },
      )
      signal.throwIfAborted()
      return preparePluginSurfaces({
        contributions: [executable],
        serverUrl,
        client: globalSDK.client,
        events: globalSDK.event,
        scopeKey: scope,
        assets,
        owner: uiOwner,
        commands,
        environment,
        reportError,
      })
    },
    changed(active) {
      const refreshPreview = preview && pluginPreviewChanged(loaded(), active)
      setLoaded(active)
      if (refreshPreview) queueMicrotask(() => window.location.reload())
      setStatus((current) => {
        const next = new Map(current)
        for (const plugin of active) {
          const previous = next.get(plugin.pluginId)
          next.set(plugin.pluginId, {
            generation: previous?.generation ?? plugin.generation,
            state: previous?.state === "incompatible" || previous?.state === "failed" ? previous.state : "available",
            availableGeneration: plugin.generation,
            reason: previous?.reason,
          })
        }
        return next
      })
    },
    error(plugin, error) {
      reportError({
        pluginId: plugin.pluginId,
        message: error instanceof AggregateError ? error.errors.map(String).join("; ") : String(error),
      })
    },
  })
  async function reload() {
    if (!server.url) return
    const revision = ++reloadGeneration
    reloadController?.abort()
    const controller = new AbortController()
    reloadController = controller
    try {
      const discovered = await fetchUIContributions(server.url, scopeKey(), controller.signal)
      if (revision !== reloadGeneration) return
      setPlugins(discovered)
      setStatus(
        (current) =>
          new Map(
            discovered.map((plugin) => [
              plugin.pluginId,
              current.get(plugin.pluginId) ?? { state: "registered", generation: plugin.generation },
            ]),
          ),
      )
      await generations.reconcile(discovered)
    } catch (error) {
      if (controller.signal.aborted || revision !== reloadGeneration) return
      reportError({ pluginId: "", message: error instanceof Error ? error.message : String(error) })
    }
  }
  let wasConnected = false
  createEffect(() => {
    const connected = globalSDK.connected()
    const nextOwner = JSON.stringify([server.url, scopeKey()])
    const changed = owner !== nextOwner
    if (changed) {
      owner = nextOwner
      reloadGeneration++
      reloadController?.abort()
      generations.clear()
      batch(() => {
        setPlugins([])
        setStatus(new Map())
        setErrors([])
      })
    }
    if (server.url && (changed || (connected && !wasConnected))) void reload()
    wasConnected = connected
  })
  onCleanup(
    globalSDK.event.listen(({ name, details }) => {
      if (details.type === "plugin.ui.updated" && (name === scopeKey() || name === "global")) void reload()
    }),
  )
  onCleanup(() => {
    reloadGeneration++
    reloadController?.abort()
    generations.dispose()
  })
  return (
    <ExtensionOutletsProvider value={outlets}>
      <PluginHostContext.Provider
        value={{
          plugins,
          extensions: (pluginId) =>
            loaded()
              .find((plugin) => plugin.pluginId === pluginId)
              ?.contributions.flatMap((item) => {
                const outlet = pluginExtensionTarget(item)
                return outlet ? [{ id: item.id, outlet, mounted: outlets.mounted(outlet) }] : []
              }) ?? [],
          status,
          loadedPluginIds: () => loaded().map((item) => item.pluginId),
          errors,
          reload,
          shell,
          skin,
          safeUI,
          environment: environment.environment,
          resources: environment.resources,
          reportError,
        }}
      >
        {props.children}
      </PluginHostContext.Provider>
    </ExtensionOutletsProvider>
  )
}

export function usePluginHost() {
  const value = useContext(PluginHostContext)
  if (!value) throw new Error("usePluginHost must be used within PluginHostProvider")
  return value
}
