import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { OfficeErrorState, OfficeNotice } from "./office-state"
import { createOfficeWorkerReader } from "./office-worker-client"
import { SpreadsheetGrid } from "./xlsx-grid"

export function XlsxReader(props: { bytes: Uint8Array; filename?: string }) {
  const lingui = useLingui()
  const reader = createOfficeWorkerReader()
  const [sheet, setSheet] = createSignal(0)
  const [workbook] = createResource(
    () => props.bytes,
    (bytes) => reader.readSpreadsheet(bytes),
  )
  onCleanup(() => reader.cancel())
  const sheets = () => (workbook.error ? [] : (workbook()?.sheets ?? []))
  const current = createMemo(() => sheets()[Math.min(sheet(), sheets().length - 1)])
  return (
    <div class="office-reader">
      <OfficeNotice />
      <Show when={!workbook.error} fallback={<OfficeErrorState error={workbook.error} />}>
        <Show
          when={!workbook.loading && current()}
          fallback={
            <div class="attachment-workbench-loading">
              <Spinner />
            </div>
          }
        >
          {(value) => <SpreadsheetGrid sheet={value()} />}
        </Show>
      </Show>
      <div
        class="xlsx-worksheets"
        role="group"
        aria-label={lingui._({ id: "app.attachment.xlsx.worksheets", message: "Worksheets" })}
      >
        <For each={sheets()}>
          {(item, index) => (
            <button
              type="button"
              aria-pressed={index() === sheet()}
              title={item.name}
              onClick={() => setSheet(index())}
            >
              {item.name}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
