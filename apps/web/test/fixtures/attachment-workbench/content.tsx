import { ErrorBoundary, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { ResourceOpenProvider } from "@ericsanchezok/synergy-ui/context/resource-open"
import type { ParentProps } from "solid-js"
import { DataProvider } from "@ericsanchezok/synergy-ui/context/data"
import type { AttachmentPart } from "@ericsanchezok/synergy-sdk"
import { AttachmentWorkbenchContent } from "../../../src/components/attachment-workbench/content"

const params = new URLSearchParams(location.search)
const [opened, setOpened] = createSignal("")
const attachment: AttachmentPart = {
  id: "attachment-original",
  sessionID: "session-original",
  messageID: "message-original",
  type: "attachment",
  mime: "image/svg+xml",
  filename: "original.svg",
  url:
    "data:image/svg+xml," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><text y="16">A</text></svg>'),
  metadata: { attachment: { sourcePath: "docs/original.svg" } },
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
    <I18nProvider i18n={setupI18n({ locale: "en" })}>
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
          </SourceProvider>
        </DataProvider>
        <output aria-label="Opened source">{opened()}</output>
      </ErrorBoundary>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
