import { createResource, onCleanup } from "solid-js"
import { createOfficeWorkerReader } from "./office-worker-client"
import { OfficePaginatedReader } from "./office-pages"

export function PptxReader(props: { bytes: Uint8Array; filename?: string }) {
  const reader = createOfficeWorkerReader()
  const [content] = createResource(
    () => props.bytes,
    (bytes) => reader.readPresentation(bytes),
  )
  onCleanup(() => reader.cancel())
  return (
    <OfficePaginatedReader
      document={content.error ? undefined : content()}
      error={content.error}
      loading={content.loading}
      filename={props.filename}
    />
  )
}
