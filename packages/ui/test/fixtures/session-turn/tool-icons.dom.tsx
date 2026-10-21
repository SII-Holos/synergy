import { For } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import type { AssistantMessage, ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { setupI18n } from "../../../src/testing/i18n"
import { DataProvider } from "../../../src/context/data"
import { ActivityTrace } from "../../../src/components/activity-trace"
import { ToolResultBody } from "../../../src/components/tool-result-body"
import { getToolInfo } from "../../../src/components/message-part"
import { registerIcon } from "../../../src/plugin/icon-registry"
import { Icon } from "../../../src/components/icon"
import { getSemanticIcon } from "../../../src/components/semantic-icon"
import "../../../src/components/tool-renders"
import "../../../src/styles/index.css"

const image = (fill: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${fill}" d="M3 3h18v18H3z"/></svg>`)}`
const sources = [
  { src: image("black"), theme: "light" },
  { src: image("white"), theme: "dark" },
]
const cases = [
  { tool: "bash", input: { command: "bun test" } },
  { tool: "read", input: { filePath: "README.md" } },
  { tool: "skill", input: { name: "frontend" } },
  { tool: "plugin__example__lookup", metadata: { display: { icon: "logo" } } },
  { tool: "mcp__notion__fetch", metadata: { display: { icon: sources } } },
  { tool: "mcp__anysearch__search", input: { query: "icons" }, metadata: { display: { icon: sources } } },
  { tool: "mcp__other__lookup" },
]
const message = { id: "m", sessionID: "s", role: "assistant", time: { created: 1 } } as AssistantMessage
let disposeLogo: (() => void) | undefined

const dispose = render(
  () => (
    <I18nProvider i18n={setupI18n()}>
      <DataProvider
        data={{ session: [], session_diff: {}, message: {}, part: {} }}
        directory={null}
        serverUrl="http://localhost"
        runtime={{ permissionsFor: () => [], questionsFor: () => [], statusFor: () => undefined }}
        hasFeature={() => true}
      >
        <main style="padding: 32px; max-width: 960px; margin: auto">
          <h1>Tool icon integration</h1>
          <div id="reasoning-icon">
            <Icon name={getSemanticIcon("session.reasoning")} />
          </div>
          <For each={cases}>
            {(item) => {
              const part: ToolPart = {
                id: item.tool,
                type: "tool",
                sessionID: "s",
                messageID: "m",
                callID: item.tool,
                tool: item.tool,
                state: {
                  status: "completed",
                  input: item.input ?? {},
                  metadata: item.metadata ?? {},
                  output: "",
                  title: item.tool,
                  time: { start: 1, end: 2 },
                },
              }
              return (
                <section data-tool-case={item.tool} style="padding: 18px 0">
                  <h2>{item.tool}</h2>
                  <div data-surface="process">
                    <ActivityTrace
                      group={{
                        kind: "activity-group",
                        key: item.tool,
                        message,
                        family: "generic",
                        scopeKey: "",
                        state: "done",
                        receipt: false,
                        steps: [
                          {
                            part,
                            family: "generic",
                            scopeKey: "",
                            state: "done",
                            ...getToolInfo(item.tool, part.state.input, part.state.metadata),
                          },
                        ],
                      }}
                      serverUrl="http://localhost"
                      motion={false}
                    />
                  </div>
                  <div data-surface="detail">
                    <ToolResultBody part={part} serverUrl="http://localhost" hasFeature={() => true} hideDetails />
                  </div>
                </section>
              )
            }}
          </For>
        </main>
      </DataProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)

Object.assign(globalThis, {
  toolIconFixture: {
    register() {
      disposeLogo = registerIcon({
        name: "example:logo",
        pluginId: "example",
        svgContent: '<svg viewBox="0 0 24 24" data-tool-logo="example"><path d="M2 2h20v20H2z"/></svg>',
      })
    },
    unregister() {
      disposeLogo?.()
    },
    dispose,
  },
})
