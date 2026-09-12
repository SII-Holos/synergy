import { expect, mock, test } from "bun:test"
import type {
  PluginComposerLayoutService,
  PluginConversationService,
  PluginInputService,
  PluginSessionService,
} from "@ericsanchezok/synergy-plugin"
import { bindPluginInput, bindPluginSession } from "../../src/plugin/surface-session"
import { bindPluginConversation } from "../../src/plugin/surface-conversation"
import { bindPluginComposerLayout } from "../../src/plugin/surface-composer-layout"
import { createPluginSurfaceAccess } from "../../src/plugin/surface-access"
import { createPluginSurfaceLifetime } from "../../src/plugin/surface-lifetime"

function fixture<T extends object>(values: Partial<T>): T {
  return new Proxy(values, {
    get(target, key) {
      if (!(key in target)) throw new Error(`Unexpected fixture access: ${String(key)}`)
      return Reflect.get(target, key)
    },
  }) as T
}
function access(capabilities: string[]) {
  const lifetime = createPluginSurfaceLifetime((error) => {
    throw error
  })
  return {
    lifetime,
    service: createPluginSurfaceAccess({ lifetime: lifetime.context, capabilities, current: () => true }),
  }
}

test("input and session adapters retain entity reads and reject revoked asynchronous results", async () => {
  const owner = access(["composer.read", "composer.write", "session.read", "session.submit"])
  const pending = Promise.withResolvers<void>()
  let submissions = 0
  const source = fixture<PluginInputService>({
    ready: () => true,
    submit: () => {
      submissions++
      return pending.promise
    },
  })
  const input = bindPluginInput(source, owner.service)
  const messages: ReturnType<PluginSessionService["messages"]> = []
  const session = bindPluginSession(fixture<PluginSessionService>({ messages: () => messages }), owner.service)
  expect(input.ready()).toBe(true)
  expect(session.messages()).toBe(messages)
  expect(() => session.rewind("message")).toThrow("session.control")
  const submitted = input.submit()
  expect(submissions).toBe(1)
  owner.lifetime.dispose()
  pending.resolve()
  await expect(submitted).rejects.toThrow("disposed")
  expect(() => session.messages()).toThrow("disposed")
})

test("conversation and composer references are released with the surface without retaining host DOM", () => {
  const owner = access(["composer.read", "session.read"])
  const mounted: unknown[] = []
  const input = fixture<PluginInputService>({ ready: () => true })
  const layout = bindPluginComposerLayout(
    fixture<PluginComposerLayoutService>({ input: () => input, mount: (value) => mounted.push(value) }),
    owner.service,
  )
  const conversation = bindPluginConversation(
    fixture<PluginConversationService>({ setScrollRef: (value) => mounted.push(value) }),
    owner.service,
  )
  const element = {} as HTMLDivElement
  layout.mount(element)
  conversation.setScrollRef(element)
  expect(layout.input()).toBe(layout.input())
  expect(layout.input()?.ready()).toBe(true)
  expect(mounted).toEqual([element, element])
  owner.lifetime.dispose()
  expect(mounted).toEqual([element, element, undefined, undefined])
  layout.mount(undefined)
  conversation.setScrollRef(undefined)
  expect(mounted).toHaveLength(4)
  expect(() => layout.input()).toThrow("disposed")
})

test("workbench adapter opens resource identity and validates moves against the owning surface", async () => {
  const { createWorkbenchService } = await import("../../src/plugin/workbench-service")
  type Source = Parameters<typeof createWorkbenchService>[0]
  const moved: unknown[] = []
  const opened: unknown[] = []
  const service = createWorkbenchService(
    fixture<Source>({
      surface: (surface) =>
        fixture<ReturnType<Source["surface"]>>({
          tabs: () => (surface === "side" ? [{ id: "tab", panelId: "fixture:panel" }] : []),
        }),
      openPanel: async (id, options) => {
        opened.push([id, options])
        return undefined
      },
      moveTab: (...args) => {
        moved.push(args)
      },
    }),
  )
  await service.open("fixture:panel", { id: "resource", title: "Document", state: { page: 2 } })
  expect(opened).toEqual([
    ["fixture:panel", { init: { resourceId: "resource", title: "Document", state: { page: 2 }, source: "plugin" } }],
  ])
  expect(() => service.move("bottom", "tab", 0)).toThrow("unavailable")
  expect(() => service.move("side", "tab", -1)).toThrow("non-negative")
  service.move("side", "tab", 0)
  expect(moved).toEqual([["side", "tab", 0]])
})

test("declared commands connect only their menus and dispatch the declared operation", async () => {
  const { installPluginCommands } = await import("../../src/plugin/command-adapter")
  type Context = ReturnType<Parameters<typeof installPluginCommands>[0]["context"]>
  const commands: Parameters<Context["commands"]["register"]>[0][] = []
  const invoked: unknown[] = []
  const dispose = installPluginCommands({
    owner: null,
    context: () =>
      fixture<Context>({
        commands: fixture<Context["commands"]>({
          register: (command) => {
            commands.push(command)
            return () => {}
          },
        }),
        operations: fixture<Context["operations"]>({
          command: async <Output>(...args: [string, unknown?]) => {
            invoked.push(args)
            return undefined as Output
          },
        }),
      }),
    contributions: [
      { kind: "ui.command", id: "run", title: "Run", operation: "refresh", input: { force: true } },
      { kind: "ui.menu", order: 0, id: "menu", command: "run", location: "session.header.actions" },
      { kind: "ui.menu", order: 0, id: "other", command: "unrelated", location: "session.header.actions" },
    ],
  })
  try {
    expect(commands).toHaveLength(1)
    expect(commands[0]?.menus).toHaveLength(1)
    await commands[0]!.execute()
    expect(invoked).toEqual([["refresh", { force: true }]])
  } finally {
    dispose()
  }
})

for (const binding of ["scroll", "content"] as const) {
  test(`conversation ${binding} releases retain element ownership across swaps and permission disposal`, () => {
    const owner = access(["session.read"])
    const successor = access(["session.read"])
    const refs = mock((_element: HTMLElement | undefined, _releaseOf?: HTMLElement) => {})
    const source = fixture<PluginConversationService>({
      setScrollRef: refs,
      autoScroll: fixture<PluginConversationService["autoScroll"]>({ contentRef: refs }),
    })
    const first = bindPluginConversation(source, owner.service)
    const next = bindPluginConversation(source, successor.service)
    const bind = (
      service: PluginConversationService,
      element: HTMLDivElement | undefined,
      releaseOf?: HTMLDivElement,
    ) =>
      binding === "scroll"
        ? service.setScrollRef(element, releaseOf)
        : service.autoScroll.contentRef(element, releaseOf)
    const oldElement = document.createElement("div")
    const newElement = document.createElement("div")
    try {
      bind(first, oldElement)
      bind(first, newElement)
      expect(refs.mock.calls).toEqual([[oldElement], [undefined, oldElement], [newElement]])
      bind(first, undefined, oldElement)
      expect(refs).toHaveBeenCalledTimes(3)
      bind(next, oldElement)
      owner.lifetime.dispose()
      expect(refs.mock.calls.slice(-2)).toEqual([[oldElement], [undefined, newElement]])
      bind(first, undefined, newElement)
      expect(refs).toHaveBeenCalledTimes(5)
      expect(() => bind(first, newElement)).toThrow("disposed")
      bind(next, undefined, oldElement)
      expect(refs.mock.calls.at(-1)).toEqual([undefined, oldElement])
      successor.lifetime.dispose()
      expect(refs).toHaveBeenCalledTimes(6)
    } finally {
      owner.lifetime.dispose()
      successor.lifetime.dispose()
    }
  })
}
