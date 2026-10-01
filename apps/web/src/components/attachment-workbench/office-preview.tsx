import { lazy, Suspense } from "solid-js"
import type { OfficeFormat } from "./office-contract"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"

const DocxReader = lazy(() => import("./docx-reader").then((module) => ({ default: module.DocxReader })))

export function OfficePreview(props: { format: OfficeFormat; bytes: Uint8Array; filename?: string }) {
  return (
    <Suspense
      fallback={
        <div class="attachment-workbench-loading">
          <Spinner />
        </div>
      }
    >
      <DocxReader bytes={props.bytes} filename={props.filename} />
    </Suspense>
  )
}
