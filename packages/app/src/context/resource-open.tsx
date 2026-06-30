import { createMemo, type ParentProps } from "solid-js"
import { useParams } from "@solidjs/router"
import {
  ResourceOpenProvider as BaseResourceOpenProvider,
  type OpenableResource,
  type ResourceOpenOptions,
} from "@ericsanchezok/synergy-ui/context/resource-open"
import { ImagePreview } from "@ericsanchezok/synergy-ui/image-preview"
import { isImageAttachment, resolveAttachmentUrl, type AttachmentFile } from "@ericsanchezok/synergy-ui/attachment-card"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"

function stripQueryAndHash(input: string) {
  const hashIndex = input.indexOf("#")
  const queryIndex = input.indexOf("?")
  if (hashIndex !== -1 && queryIndex !== -1) return input.slice(0, Math.min(hashIndex, queryIndex))
  if (hashIndex !== -1) return input.slice(0, hashIndex)
  if (queryIndex !== -1) return input.slice(0, queryIndex)
  return input
}

function fileUrlPath(input: string | undefined) {
  if (!input?.startsWith("file://")) return undefined
  const raw = stripQueryAndHash(input.slice("file://".length))
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function attachmentPath(file: AttachmentFile) {
  if (file.localPath) return file.localPath
  const source = file.source as { path?: unknown } | undefined
  if (typeof source?.path === "string" && source.path) return source.path
  const attachment = file.metadata?.attachment as Record<string, unknown> | undefined
  if (typeof attachment?.sourcePath === "string" && attachment.sourcePath) return attachment.sourcePath
  return fileUrlPath(file.url)
}

function filenameFor(resource: { filename?: string; url?: string; path?: string }) {
  if (resource.filename) return resource.filename
  const value = resource.path ?? resource.url
  if (!value) return "file"
  return stripQueryAndHash(value).split("/").filter(Boolean).at(-1) ?? "file"
}

export function ResourceOpenProvider(props: ParentProps) {
  const dialog = useDialog()
  const file = useFile()
  const layout = useLayout()
  const params = useParams()
  const sdk = useSDK()
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey()))

  const openWorkspaceFile = (path: string) => {
    if (!path) return false
    const tab = file.tab(path)
    void tabs().open(tab)
    void file.load(path)
    return true
  }

  const openUrl = (input: { url: string; mime?: string; filename?: string }) => {
    if (!input.url) return false
    if (input.mime?.startsWith("image/")) {
      dialog.show(() => <ImagePreview src={input.url} alt={filenameFor(input)} />)
      return true
    }
    window.open(input.url, "_blank", "noopener,noreferrer")
    return true
  }

  const openAttachment = (attachment: AttachmentFile, options?: ResourceOpenOptions & { serverUrl?: string }) => {
    const path = attachmentPath(attachment)
    if (options?.prefer === "workspace" && path) return openWorkspaceFile(path)

    const url = resolveAttachmentUrl(options?.serverUrl ?? sdk.url, attachment)
    if (isImageAttachment(attachment) && url && options?.prefer !== "workspace") {
      dialog.show(() => <ImagePreview src={url} alt={filenameFor({ filename: attachment.filename, url })} />)
      return true
    }

    if (path) return openWorkspaceFile(path)
    if (url) return openUrl({ url, mime: attachment.mime, filename: attachment.filename })
    return false
  }

  const open = (resource: OpenableResource, options?: ResourceOpenOptions) => {
    if (resource.kind === "attachment") {
      return openAttachment(resource.file, { ...options, serverUrl: resource.serverUrl })
    }
    if (resource.kind === "workspace-file") {
      return openWorkspaceFile(resource.path)
    }
    if (resource.kind === "url") {
      const path = fileUrlPath(resource.url)
      if (path) return openWorkspaceFile(path)
      return openUrl(resource)
    }
    return false
  }

  return <BaseResourceOpenProvider value={{ open, openAttachment }}>{props.children}</BaseResourceOpenProvider>
}
