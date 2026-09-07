import type { PluginComposerLayoutService, PluginInputService } from "@ericsanchezok/synergy-plugin"
import type { createPluginSurfaceAccess } from "./surface-access"
import { bindPluginInput } from "./surface-session"

export function bindPluginComposerLayout(
  source: PluginComposerLayoutService,
  access: ReturnType<typeof createPluginSurfaceAccess>,
): PluginComposerLayoutService {
  const read = () => {
    access.require("composer.read")
    return source
  }
  let input: PluginInputService | undefined
  let boundInput: PluginInputService | undefined
  let release: (() => void) | undefined
  return {
    input() {
      const next = read().input()
      if (next !== input) {
        input = next
        boundInput = next ? bindPluginInput(next, access) : undefined
      }
      return boundInput
    },
    mount(element) {
      if (!element) {
        release?.()
        release = undefined
        return
      }
      read()
      release?.()
      release = element
        ? access.own("composer.read", () => {
            source.mount(element)
            return () => source.mount(undefined)
          })
        : undefined
    },
    ready: () => read().ready(),
    isNewSession: () => read().isNewSession(),
    readOnly: () => read().readOnly(),
    isGlobal: () => read().isGlobal(),
    pendingText: () => read().pendingText(),
    scopeName: () => read().scopeName(),
    branch: () => read().branch(),
    lastModified: () => read().lastModified(),
    links: () =>
      read()
        .links()
        .map((link) => ({
          ...link,
          open() {
            access.require("ui.hostActions")
            link.open()
          },
        })),
    render: (part) => read().render(part),
  }
}
