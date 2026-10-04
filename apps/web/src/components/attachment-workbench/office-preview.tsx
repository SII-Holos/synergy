import { ErrorBoundary, lazy, Suspense, Switch, Match } from "solid-js"
import type { OfficeFormat } from "./office-contract"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { OfficeErrorState } from "./office-state"

const DocxReader = lazy(() => import("./docx-reader").then((module) => ({ default: module.DocxReader })))

const XlsxReader = lazy(() => import("./xlsx-reader").then((module) => ({ default: module.XlsxReader })))

const PptxReader = lazy(() => import("./pptx-reader").then((module) => ({ default: module.PptxReader })))

export function OfficePreview(props: { format: OfficeFormat; bytes: Uint8Array; filename?: string }) {
  return (
    <ErrorBoundary fallback={(error) => <OfficeErrorState error={error} />}>
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
          <Match when={props.format === "pptx"}>
            <PptxReader bytes={props.bytes} filename={props.filename} />
          </Match>
        </Switch>
      </Suspense>
    </ErrorBoundary>
  )
}
