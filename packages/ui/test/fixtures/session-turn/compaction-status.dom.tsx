import { I18nProvider } from "@lingui/solid"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { Message, Part } from "@ericsanchezok/synergy-sdk/client"
import { CompactionCard } from "../../../src/components/compaction-card"
import { ResourceOpenProvider, type ActivityDetailTarget } from "../../../src/context/resource-open"
import { setupI18n } from "../../../src/testing/i18n"
import { applyThemeToDocument } from "../../../src/theme/application"
import { synergyTheme } from "../../../src/theme/default-themes"
import { resolveThemeVariant } from "../../../src/theme/resolve"
import "../../../src/components/icon.css"

const initial = {
  id: "attempt-1",
  sessionID: "compaction-session",
  role: "assistant",
  time: { created: 1 },
  metadata: { compactionAttempt: { state: "running" } },
} as Message
const [message, setMessage] = createSignal(initial)
const [part, setPart] = createSignal<Part>()
const [selected, setSelected] = createSignal<ActivityDetailTarget>()
const opened: ActivityDetailTarget[] = []
const theme = (mode: "light" | "dark") =>
  applyThemeToDocument(document, resolveThemeVariant(synergyTheme[mode]), mode, synergyTheme.id)
theme("light")

Object.assign(window, {
  compactionFixture: {
    state(state: "running" | "committed" | "failed", terminal = false) {
      setMessage({
        ...message(),
        time: { created: 1, completed: terminal || state !== "running" ? 2 : undefined },
        metadata: { compactionAttempt: { state } },
      } as Message)
      setPart(
        state === "committed"
          ? ({ id: "recovery", type: "compaction_recovery", summary: "Full continuation summary" } as Part)
          : undefined,
      )
    },
    replace() {
      setMessage({ ...initial, id: "attempt-2" })
      setPart(undefined)
    },
    opened: () => opened,
    theme,
  },
})

render(
  () => (
    <I18nProvider i18n={setupI18n()}>
      <ResourceOpenProvider
        value={{
          open: async () => ({ status: "cancelled" as const }),
          openActivityDetail: (target) => {
            opened.push(target)
            setSelected(target)
            return true
          },
          isActivityDetailSelected: (target) => selected()?.messageID === target.messageID,
        }}
      >
        <CompactionCard message={message()} part={part()} />
      </ResourceOpenProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
