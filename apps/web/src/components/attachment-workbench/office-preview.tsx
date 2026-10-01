import { lazy, Suspense, Switch, Match } from "solid-js"
import type { OfficeFormat } from "./office-contract"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"

const DocxReader = lazy(() => import("./docx-reader").then((module) => ({ default: module.DocxReader })))

const XlsxReader = lazy(() => import("./xlsx-reader").then((module) => ({ default: module.XlsxReader })))

export function OfficePreview(props: { format: OfficeFormat; bytes: Uint8Array; filename?: string }) {
  return (
    <Suspense
      fallback={
        <div class="attachment-workbench-loading">
          <Spinner />
        </div>
      }
    >
      <Switch>
        <Match when={props.format === "docx"}>
          <DocxReader bytes={props.bytes} filename={props.filename} />
        </Match>
        <Match when={props.format === "xlsx"}>
          <XlsxReader bytes={props.bytes} filename={props.filename} />
        </Match>
      </Switch>
    </Suspense>
  )
}
