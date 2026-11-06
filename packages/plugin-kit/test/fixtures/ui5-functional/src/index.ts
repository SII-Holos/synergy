import { z } from "zod"
import {
  capability,
  definePlugin,
  event,
  operation,
  settings,
  slot,
  textAction,
  uiCommand,
  uiMenu,
  workbenchPanel,
} from "@ericsanchezok/synergy-plugin"

const access = [
  "ui.hostActions",
  "ui.commands",
  "workbench.read",
  "workbench.write",
  "settings.read",
  "settings.write",
  "selection.read",
]
export default definePlugin({
  id: "ui5-functional",
  version: "1.0.0",
  description: "Reference functional plugin for UI API 5",
  capabilities: access.map((id) => capability(id)),
  contributions: [
    operation({
      id: "increment",
      type: "command",
      requires: ["settings.read", "settings.write"],
      input: z.object({}),
      output: z.object({ count: z.number() }),
      async handler(_, context) {
        if (!context.settings?.get || !context.settings.replace) throw new Error("Settings access is unavailable")
        const state = await context.settings.get()
        const count = (typeof state.count === "number" ? state.count : 0) + 1
        await context.settings.replace({ ...state, count })
        await context.events.publish("changed", { count })
        return { count }
      },
    }),
    event({ id: "changed", payload: z.object({ count: z.number() }) }),
    uiCommand({ id: "increment", title: "Increment example counter", operation: "increment", keybind: "mod+shift+u" }),
    uiMenu({ id: "increment", command: "increment", location: "app.footer", order: 10 }),
    operation({
      id: "uppercase",
      type: "command",
      input: z.object({ selection: z.object({ text: z.string() }).passthrough() }).passthrough(),
      output: z.object({ text: z.string() }),
      async handler({ selection }) {
        return { text: selection.text.toUpperCase() }
      },
    }),
    textAction({
      id: "uppercase",
      label: "Uppercase selection",
      operation: "uppercase",
      when: { minChars: 1 },
      presentation: { kind: "popover", component: { source: "./src/selection.tsx" } },
    }),
    slot({
      id: "launcher",
      slot: "app.footer",
      label: "Example resources",
      requires: access,
      component: { source: "./src/launcher.tsx" },
    }),
    workbenchPanel({
      id: "notes",
      label: "Example notes",
      surface: "side",
      cardinality: "multi",
      requires: access,
      component: { source: "./src/panel.tsx" },
      defaultResource: { id: "first", title: "First note" },
    }),
    settings({
      id: "preferences",
      label: "Example preferences",
      group: "plugins",
      requires: ["settings.read", "settings.write"],
      component: { source: "./src/settings.tsx" },
    }),
  ],
})
