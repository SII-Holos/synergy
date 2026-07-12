import { Show } from "solid-js"
import { useNavigate, useLocation } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLayout } from "@/context/layout"

const DRAWER_TOOLS: Array<{ id: string; label: string; icon: SemanticIconTokenName; href: string }> = [
  { id: "agenda", label: "Agenda", icon: "agenda.main", href: "/agenda" },
  { id: "library", label: "Library", icon: "library.main", href: "/library" },
  { id: "performance", label: "Performance", icon: "performance.main", href: "/performance" },
  { id: "plugins", label: "Plugins", icon: "plugins.main", href: "/plugins/marketplace" },
]

export function MobileToolsDrawer() {
  const layout = useLayout()
  const navigate = useNavigate()
  const location = useLocation()

  function close() {
    layout.rightSidebar.hide()
  }

  function navigateAndClose(path: string) {
    navigate(path)
    close()
  }

  return (
    <Show when={layout.rightSidebar.opened()}>
      <div class="fixed inset-0 z-[100] flex md:hidden justify-end">
        {/* Backdrop */}
        <div
          class="absolute inset-0 bg-surface-overlay"
          style={{ animation: "mobileDrawerFadeIn 200ms ease-out both" }}
          onClick={close}
        />
        {/* Drawer panel — slides from the right */}
        <div
          class="relative w-[85vw] max-w-80 h-full bg-background-stronger flex flex-col shadow-2xl safe-right"
          style={{ animation: "mobileDrawerSlideInRight 250ms cubic-bezier(0.16, 1, 0.3, 1) both" }}
        >
          {/* Header */}
          <div class="flex items-center justify-between px-4 h-12 shrink-0 border-b border-border-weaker-base/60 safe-top">
            <span class="text-14-medium text-text-strong">Tools</span>
            <button
              type="button"
              class="flex items-center justify-center size-8 rounded-lg text-icon-weak-base hover:text-icon-base hover:bg-surface-raised-base-hover transition-colors"
              onClick={close}
            >
              <Icon name={getSemanticIcon("action.close")} size="normal" />
            </button>
          </div>

          {/* Body */}
          <div class="flex-1 min-h-0 overflow-y-auto safe-bottom py-2">
            {/* Tools */}
            <div class="px-4 pb-1.5">
              <span class="text-11-medium text-text-weak uppercase tracking-wider">Tools</span>
            </div>
            <div class="flex flex-col gap-0.5 px-3">
              {DRAWER_TOOLS.map((tool) => {
                const isActive =
                  tool.id === "plugins" ? location.pathname.startsWith("/plugins") : location.pathname === tool.href

                return (
                  <button
                    type="button"
                    classList={{
                      "flex items-center gap-3 w-full px-3 py-2.5 rounded-xl transition-colors": true,
                      "bg-surface-raised-base-hover text-text-strong": isActive,
                      "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !isActive,
                    }}
                    onClick={() => navigateAndClose(tool.href)}
                  >
                    <Icon name={getSemanticIcon(tool.icon)} size="normal" class="shrink-0" />
                    <span class="text-14-medium">{tool.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}
