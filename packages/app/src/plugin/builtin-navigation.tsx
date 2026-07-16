import { pluginNav } from "@/locales/messages"
import type { Component } from "solid-js"
import { registerNavigation, type NavigationContentProps } from "./registries/navigation-registry"

const builtinNavigation: Array<Parameters<typeof registerNavigation>[0]> = [
  {
    id: "clarus",
    navigationId: "clarus",
    label: "Clarus",
    iconToken: "clarus.main",
    placement: "sidebar",
    path: "/clarus",
    order: 5,
    loader: async () => {
      const clarus = await import("@/components/clarus")
      const ClarusNavigation: Component<NavigationContentProps> = (props) => (
        <clarus.ClarusPanel navigateToSession={props.navigateToSession!} />
      )
      return { default: ClarusNavigation }
    },
  },
  {
    id: "agenda",
    navigationId: "agenda",
    label: pluginNav.agenda.id,
    labelDescriptor: pluginNav.agenda,
    iconToken: "agenda.main",
    placement: "sidebar",
    path: "/agenda",
    order: 10,
    loader: async () => {
      const agenda = await import("@/components/agenda")
      const AgendaNavigation: Component<NavigationContentProps> = () => <agenda.AgendaPanel />
      return { default: AgendaNavigation }
    },
  },
  {
    id: "library",
    navigationId: "library",
    label: pluginNav.library.id,
    labelDescriptor: pluginNav.library,
    iconToken: "library.main",
    placement: "sidebar",
    path: "/library",
    order: 20,
    loader: async () => {
      const library = await import("@/components/library")
      const LibraryNavigation: Component<NavigationContentProps> = () => <library.LibraryPanel />
      return { default: LibraryNavigation }
    },
  },
  {
    id: "performance",
    navigationId: "performance",
    label: pluginNav.performance.id,
    labelDescriptor: pluginNav.performance,
    iconToken: "performance.main",
    placement: "sidebar",
    path: "/performance",
    order: 30,
    loader: async () => {
      const performance = await import("@/components/performance/panel")
      const PerformanceNavigation: Component<NavigationContentProps> = () => <performance.PerformancePanel />
      return { default: PerformanceNavigation }
    },
  },
  {
    id: "plugins",
    navigationId: "plugins",
    label: pluginNav.plugins.id,
    labelDescriptor: pluginNav.plugins,
    iconToken: "plugins.main",
    placement: "sidebar",
    path: "/plugins/marketplace",
    order: 40,
    active: (pathname) => pathname === "/plugins/marketplace" || /^\/plugins\/[^/]+$/.test(pathname),
    loader: async () => {
      const marketplace = await import("./marketplace")
      const PluginsNavigation: Component<NavigationContentProps> = () => <marketplace.MarketplacePage />
      return { default: PluginsNavigation }
    },
  },
]

for (const entry of builtinNavigation) {
  registerNavigation(entry)
}
