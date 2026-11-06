import { ErrorBoundary, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@ericsanchezok/synergy-ui/font"
import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme"
import { ResourceOpenProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import type { ParentProps } from "solid-js"
import { DataProvider } from "@ericsanchezok/synergy-ui/context/data"
import type { AttachmentPart } from "@ericsanchezok/synergy-sdk"
import { AttachmentWorkbenchContent } from "../../../src/components/attachment-workbench/content"
import { messages as en } from "../../../src/locales/en/messages.po"
import { messages as zh } from "../../../src/locales/zh-CN/messages.po"
import { messages as pseudo } from "../../../src/locales/pseudo/messages.po"
import "@ericsanchezok/synergy-ui/styles"
import "../../../src/index.css"

const params = new URLSearchParams(location.search)
const [opened, setOpened] = createSignal("")
const html = params.has("html")
const png = params.has("png")
const locale = params.get("locale") ?? "en"
const attachment: AttachmentPart = {
  id: "attachment-original",
  sessionID: "session-original",
  messageID: "message-original",
  type: "attachment",
  mime: html ? "text/html" : png ? "image/png" : "image/svg+xml",
  filename: html
    ? "responsive-preview-with-a-long-filename.html"
    : png
      ? "narrow-panel-image-preview.png"
      : "original.svg",
  url: html
    ? "data:text/html," + encodeURIComponent("<!doctype html><html><body><h1>Preview document</h1></body></html>")
    : png
      ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
      : "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><text y="16">A</text></svg>',
        ),
  metadata: { attachment: { sourcePath: "docs/original.svg", size: 70 } },
}
function Appearance(props: ParentProps) {
  useTheme().setColorScheme(params.get("theme") === "dark" ? "dark" : "light")
  return (
    <div id="preview-pane" class="synergy-workbench-canvas" style="height:600px;width:100%">
      {props.children}
    </div>
  )
}
function SourceProvider(props: ParentProps) {
  return params.has("source") ? (
    <ResourceOpenProvider
      value={{
        open: async (resource) => {
          if (resource.kind === "workspace-file") setOpened(resource.path)
          return { status: "opened" }
        },
      }}
    >
      {props.children}
    </ResourceOpenProvider>
  ) : (
    props.children
  )
}
render(
  () => (
    <MetaProvider>
      <Font />
      <I18nProvider i18n={setupI18n({ locale, messages: { en, "zh-CN": zh, pseudo } })}>
        <ThemeProvider>
          <Appearance>
            <ErrorBoundary fallback={(error) => <div role="alert">{String(error)}</div>}>
              <DataProvider
                data={{
                  session: [],
                  session_diff: {},
                  message: {},
                  part: params.has("remote") ? {} : { "message-original": [attachment] },
                }}
                directory={null}
                serverUrl={location.origin}
              >
                <SourceProvider>
                  <MarkedProvider>
                    <AttachmentWorkbenchContent
                      pluginId="builtin"
                      panelId="attachment"
                      tab={{
                        id: "original-tab",
                        panelId: "attachment",
                        state: {
                          version: 1,
                          sessionID: "session-original",
                          messageID: "message-original",
                          attachmentID: "attachment-original",
                        },
                      }}
                    />
                  </MarkedProvider>
                </SourceProvider>
              </DataProvider>
              <output aria-label="Opened source">{opened()}</output>
            </ErrorBoundary>
          </Appearance>
        </ThemeProvider>
      </I18nProvider>
    </MetaProvider>
  ),
  document.getElementById("root")!,
)
