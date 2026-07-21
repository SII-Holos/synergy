import { onCleanup, onMount, type ParentProps } from "solid-js"
import {
  ResourceOpenProvider as BaseResourceOpenProvider,
  type OpenableResource,
  type ResourceOpenOptions,
} from "@ericsanchezok/synergy-ui/context/resource-open"
import { ImagePreview, type ImagePreviewImage } from "@ericsanchezok/synergy-ui/image-preview"
import {
  isImageAttachment,
  resolveAttachmentUrl,
  resolveImagePreviewImage,
  type AttachmentFile,
} from "@ericsanchezok/synergy-ui/attachment-card"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useFile } from "@/context/file"
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

function previewableImageUrl(input: { url: string; mime?: string }): string | undefined {
  if (input.url.startsWith("data:")) return input.url.startsWith("data:image/") ? input.url : undefined
  if (input.url.startsWith("blob:")) return input.url
  try {
    const url = new URL(input.url)
    return url.protocol === "http:" || url.protocol === "https:" ? input.url : undefined
  } catch {
    return undefined
  }
}

function previewImageForUrl(input: { url: string; mime?: string; filename?: string }): ImagePreviewImage | undefined {
  const src = previewableImageUrl(input)
  if (!src) return undefined
  const filename = filenameFor(input)
  return {
    id: src,
    src,
    filename,
    mime: input.mime ?? "image/*",
    alt: filename,
    downloadUrl: src,
    externalUrl: src,
  }
}

export function ResourceOpenProvider(props: ParentProps) {
  const dialog = useDialog()
  const file = useFile()
  const sdk = useSDK()

  const openWorkspaceFile = (path: string) => {
    if (!path) return false
    void file.openWorkspaceFile(path)
    return true
  }

  const openUrl = (input: { url: string; mime?: string; filename?: string }) => {
    if (!input.url) return false
    if (input.mime?.startsWith("image/")) {
      const image = previewImageForUrl(input)
      if (image) {
        dialog.show(() => <ImagePreview images={[image]} />)
        return true
      }
      return false
    }
    window.open(input.url, "_blank", "noopener,noreferrer")
    return true
  }

  const openAttachment = (attachment: AttachmentFile, options?: ResourceOpenOptions & { serverUrl?: string }) => {
    const path = attachmentPath(attachment)
    if (options?.prefer === "workspace" && path) return openWorkspaceFile(path)

    const url = resolveAttachmentUrl(options?.serverUrl ?? sdk.url, attachment)
    if (isImageAttachment(attachment) && url && options?.prefer !== "workspace") {
      const image = resolveImagePreviewImage(options?.serverUrl ?? sdk.url, attachment, 0)
      if (!image) return false
      dialog.show(() => <ImagePreview images={[image]} />)
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

  onMount(() => {
    const listener = (event: Event) => {
      const resource = (event as CustomEvent<{ kind: "artifact" | "file"; uri: string }>).detail
      if (!resource?.uri) return
      if (resource.kind === "file") {
        openWorkspaceFile(resource.uri)
        return
      }
      const path = fileUrlPath(resource.uri)
      if (path) {
        openWorkspaceFile(path)
        return
      }
      if (/^(https?:|data:|blob:)/i.test(resource.uri)) {
        openUrl({ url: resource.uri })
        return
      }
      openWorkspaceFile(resource.uri)
    }
    window.addEventListener("synergy:plugin-open-resource", listener)
    onCleanup(() => window.removeEventListener("synergy:plugin-open-resource", listener))
  })

  return <BaseResourceOpenProvider value={{ open, openAttachment }}>{props.children}</BaseResourceOpenProvider>
}
