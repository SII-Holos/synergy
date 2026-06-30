import { $ } from "bun"
import path from "path"
import fs from "fs/promises"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Global } from "@/global"
import type { Migration } from "@/migration"
import { SessionEndpoint } from "./endpoint"
import { Info } from "./types"
import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { SessionNav } from "./nav"
import { SessionProgress } from "./progress"

import { MigrationRegistry } from "@/migration/registry"
const log = Log.create({ service: "session.migration" })

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries) as T
}

function normalizeLegacyHolosMetadata(metadata: Record<string, unknown>): {
  metadata: Record<string, unknown> | undefined
  changed: boolean
} {
  const original = JSON.stringify(metadata)
  const next: Record<string, unknown> = { ...metadata }
  const legacyChannel = asRecord(metadata.channel)
  const holos = compact({
    inbound:
      metadata.inboundSurface === "holos" || metadata.fromChannel === true || legacyChannel?.type === "holos"
        ? true
        : undefined,
    senderId: asString(metadata.holosSenderId) ?? asString(legacyChannel?.senderId),
    senderName: asString(metadata.holosSenderName) ?? asString(legacyChannel?.senderName),
    messageId: asString(metadata.holosMessageId),
    replyToMessageId: asString(metadata.replyToHolosMessageId),
  })
  const quote = compact({
    messageId: asString(metadata.replyToMessageId),
    text: asString(metadata.quotedText),
    senderName: asString(metadata.quotedSenderName),
  })

  delete next.inboundSurface
  delete next.holosSenderId
  delete next.holosSenderName
  delete next.holosMessageId
  delete next.replyToHolosMessageId
  delete next.replyToMessageId
  delete next.quotedText
  delete next.quotedSenderName
  delete next.fromChannel
  delete next.channel

  const currentHolos = asRecord(metadata.holos)
  const currentQuote = asRecord(metadata.quote)

  if (currentHolos)
    next.holos = compact({
      inbound: currentHolos.inbound === true ? true : holos?.inbound,
      senderId: asString(currentHolos.senderId) ?? holos?.senderId,
      senderName: asString(currentHolos.senderName) ?? holos?.senderName,
      messageId: asString(currentHolos.messageId) ?? holos?.messageId,
      replyToMessageId: asString(currentHolos.replyToMessageId) ?? holos?.replyToMessageId,
    })
  else if (holos) next.holos = holos

  if (currentQuote)
    next.quote = compact({
      messageId: asString(currentQuote.messageId) ?? quote?.messageId,
      text: asString(currentQuote.text) ?? quote?.text,
      senderName: asString(currentQuote.senderName) ?? quote?.senderName,
    })
  else if (quote) next.quote = quote

  const normalized = compact(next)
  return { metadata: normalized, changed: JSON.stringify(normalized) !== original }
}

function attachmentSummary(part: Record<string, unknown>): string {
  const filename = typeof part.filename === "string" && part.filename ? part.filename : "attachment"
  const mime = typeof part.mime === "string" && part.mime ? part.mime : "application/octet-stream"
  return `${filename} (${mime})`
}

function defaultAttachmentModel(part: Record<string, unknown>, owner: "user" | "tool") {
  const mime = typeof part.mime === "string" ? part.mime : ""
  if (owner === "user" && mime.startsWith("image/")) {
    return { mode: "provider-file", summary: attachmentSummary(part) }
  }
  return { mode: "summary", summary: attachmentSummary(part) }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  return items.length > 0 ? items : undefined
}

function migrateAttachmentPresentation(presentation: unknown): {
  value: MessageV2.AttachmentPresentation | undefined
  changed: boolean
} {
  const record = asRecord(presentation)
  if (!record) return { value: undefined, changed: presentation !== undefined }

  const next: MessageV2.AttachmentPresentation = {}

  if (record.hidden === true || record.mode === "hidden") next.hidden = true
  if (
    record.renderer === "image" ||
    record.renderer === "video" ||
    record.renderer === "audio" ||
    record.renderer === "thumbnail" ||
    record.renderer === "file"
  ) {
    next.renderer = record.renderer
  }
  if (record.size === "original" || record.size === "small" || record.size === "medium" || record.size === "large") {
    next.size = record.size
  }
  if (typeof record.crop === "boolean") next.crop = record.crop

  const value = compact(next)
  return { value, changed: JSON.stringify(value) !== JSON.stringify(record) }
}

function migrateDisplayMetadata(display: unknown): {
  value: Record<string, unknown> | undefined
  changed: boolean
  primaryAttachmentIds?: string[]
} {
  const record = asRecord(display)
  if (!record) return { value: undefined, changed: display !== undefined }

  const original = JSON.stringify(record)
  const next: Record<string, unknown> = { ...record }
  const primaryAttachmentIds = stringArray(next.primaryAttachmentIds)

  if (next.visibility === "media") {
    if (next.kind === undefined || next.kind === "default") next.kind = "media-generation"
    if (next.toolCard === undefined) next.toolCard = "hidden"
    delete next.visibility
  }

  if (next.presentation === "artifact-only" || next.presentation === "attachment-only") {
    if (next.toolCard === undefined) next.toolCard = "hidden"
  }
  delete next.presentation
  delete next.primaryAttachmentIds

  const value = compact(next)
  return { value, changed: JSON.stringify(value) !== original, primaryAttachmentIds }
}

function migrateAttachmentMetadata(metadata: unknown): Record<string, unknown> | undefined {
  const record = asRecord(metadata)
  if (!record) return undefined
  const next: Record<string, unknown> = { ...record }
  if (next.kind === "artifact") next.kind = "attachment"
  if (asRecord(next.artifact) && !asRecord(next.attachment)) next.attachment = next.artifact
  delete next.artifact

  const display = asRecord(next.display)
  if (display) next.display = migrateDisplayMetadata(display).value

  return compact(next)
}

function migrateAttachmentPart(input: unknown, owner: "user" | "tool"): { value: unknown; changed: boolean } {
  const part = asRecord(input)
  if (!part) return { value: input, changed: false }
  const next: Record<string, unknown> = { ...part }
  let changed = false

  if (next.type === "file") {
    next.type = "attachment"
    changed = true
  }

  if (next.type !== "attachment") return { value: input, changed }

  const presentation = migrateAttachmentPresentation(next.presentation)
  if (presentation.changed) {
    next.presentation = presentation.value
    changed = true
  }
  if (!asRecord(next.model)) {
    next.model = defaultAttachmentModel(next, owner)
    changed = true
  }

  const migratedMetadata = migrateAttachmentMetadata(next.metadata)
  if (JSON.stringify(migratedMetadata) !== JSON.stringify(next.metadata)) {
    next.metadata = migratedMetadata
    changed = true
  }

  return { value: next, changed }
}

function migrateToolDisplayMetadata(metadata: unknown): {
  value: unknown
  changed: boolean
  primaryAttachmentIds?: string[]
} {
  const record = asRecord(metadata)
  if (!record) return { value: metadata, changed: false }
  const original = JSON.stringify(record)
  const next: Record<string, unknown> = { ...record }
  const primaryFromMetadata = stringArray(next.primaryAttachmentIds)
  delete next.primaryAttachmentIds

  if (next.kind === "artifact") next.kind = "attachment"
  if (asRecord(next.artifact) && !asRecord(next.attachment)) next.attachment = next.artifact
  delete next.artifact

  let primaryAttachmentIds = primaryFromMetadata
  const display = migrateDisplayMetadata(next.display)
  if (display.primaryAttachmentIds) primaryAttachmentIds = display.primaryAttachmentIds
  if (display.value) next.display = display.value
  else delete next.display

  const migrated = compact(next)
  return {
    value: migrated,
    changed: JSON.stringify(migrated) !== original,
    primaryAttachmentIds,
  }
}

function applyPrimaryAttachmentVisibility(
  attachments: unknown[],
  primaryAttachmentIds: string[] | undefined,
): { value: unknown[]; changed: boolean } {
  if (!primaryAttachmentIds?.length) return { value: attachments, changed: false }
  const ids = new Set(primaryAttachmentIds)
  const matched = attachments.some((attachment) => {
    const record = asRecord(attachment)
    return typeof record?.id === "string" && ids.has(record.id)
  })
  if (!matched) return { value: attachments, changed: false }

  let changed = false
  const value = attachments.map((attachment) => {
    const record = asRecord(attachment)
    if (!record || typeof record.id !== "string" || ids.has(record.id)) return attachment

    const presentation = migrateAttachmentPresentation(record.presentation).value ?? {}
    const next = {
      ...record,
      presentation: {
        ...presentation,
        hidden: true,
      },
    }
    changed = true
    return next
  })

  return { value, changed }
}

const legacyAttachmentPattern = String.raw`"type"\s*:\s*"file"|"artifact-only"|"attachment-only"|"primaryAttachmentIds"|"kind"\s*:\s*"artifact"|"artifact"\s*:|"mode"\s*:\s*"(inline|card|hidden)"|"primary"\s*:\s*true`
const legacyToolDisplayPattern = String.raw`"visibility"\s*:\s*"media"|"attachment-only"|"primaryAttachmentIds"`
const attachmentPartGlob = new Bun.Glob("sessions/**/parts/*.json")
const legacyAttachmentMarkers = [
  '"type":"file"',
  '"type": "file"',
  '"artifact-only"',
  '"attachment-only"',
  '"primaryAttachmentIds"',
  '"kind":"artifact"',
  '"kind": "artifact"',
  '"artifact":',
  '"artifact" :',
  '"mode":"inline"',
  '"mode": "inline"',
  '"mode":"card"',
  '"mode": "card"',
  '"mode":"hidden"',
  '"mode": "hidden"',
  '"primary":true',
  '"primary": true',
]
const legacyToolDisplayMarkers = [
  '"visibility":"media"',
  '"visibility": "media"',
  '"visibility" : "media"',
  '"attachment-only"',
  '"primaryAttachmentIds"',
]

type AttachmentPartCandidate = {
  key: string[]
  scopeID: string
  sessionID: string
  messageID: string
  text: string
}

function needsAttachmentMigration(text: string) {
  return legacyAttachmentMarkers.some((marker) => text.includes(marker))
}

function needsToolDisplayMigration(text: string) {
  return legacyToolDisplayMarkers.some((marker) => text.includes(marker))
}

function candidateFromRelativePath(relativePath: string, text: string): AttachmentPartCandidate | undefined {
  const parts = relativePath.replace(/\.json$/i, "").split(/[\\/]/)
  if (parts.length !== 7) return undefined
  const [root, scopeID, sessionID, messages, messageID, partRoot, partID] = parts
  if (root !== "sessions" || messages !== "messages" || partRoot !== "parts") return undefined
  return {
    key: parts,
    scopeID,
    sessionID,
    messageID,
    text,
  }
}

async function existingRipgrepPath() {
  const system = Bun.which("rg")
  if (system) return system
  const bundled = path.join(Global.Path.bin, process.platform === "win32" ? "rg.exe" : "rg")
  return (await Bun.file(bundled)
    .exists()
    .catch(() => false))
    ? bundled
    : undefined
}

async function findLegacyAttachmentPartPaths() {
  const sessionsRoot = path.join(Global.Path.data, "sessions")
  if (!(await fs.stat(sessionsRoot).catch(() => undefined))?.isDirectory()) return []
  const rg = await existingRipgrepPath()
  if (!rg) return undefined

  const proc = Bun.spawn(
    [
      rg,
      "--files-with-matches",
      "--hidden",
      "--follow",
      "--glob=**/parts/*.json",
      "--",
      legacyAttachmentPattern,
      sessionsRoot,
    ],
    {
      stdout: "pipe",
      stderr: "ignore",
      maxBuffer: 1024 * 1024 * 50,
    },
  )
  const [text, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stdout), proc.exited])
  if (exitCode !== 0 && exitCode !== 1) {
    log.warn("legacy attachment part candidate search failed", { exitCode })
    return []
  }
  return text.split(/\r?\n/).filter(Boolean)
}

async function findLegacyToolDisplayPartPaths() {
  const sessionsRoot = path.join(Global.Path.data, "sessions")
  if (!(await fs.stat(sessionsRoot).catch(() => undefined))?.isDirectory()) return []
  const rg = await existingRipgrepPath()
  if (!rg) return undefined

  const proc = Bun.spawn(
    [
      rg,
      "--files-with-matches",
      "--hidden",
      "--follow",
      "--glob=**/parts/*.json",
      "--",
      legacyToolDisplayPattern,
      sessionsRoot,
    ],
    {
      stdout: "pipe",
      stderr: "ignore",
      maxBuffer: 1024 * 1024 * 50,
    },
  )
  const [text, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stdout), proc.exited])
  if (exitCode !== 0 && exitCode !== 1) {
    log.warn("legacy tool display part candidate search failed", { exitCode })
    return []
  }
  return text.split(/\r?\n/).filter(Boolean)
}

async function collectLegacyAttachmentPartCandidates(): Promise<AttachmentPartCandidate[]> {
  const candidates: AttachmentPartCandidate[] = []
  const pending: Promise<void>[] = []
  const flush = async () => {
    if (pending.length === 0) return
    await Promise.all(pending.splice(0))
  }

  const paths = await findLegacyAttachmentPartPaths()
  const scan = async function* () {
    if (paths) {
      for (const filepath of paths) yield filepath
      return
    }
    for await (const relativePath of attachmentPartGlob.scan({ cwd: Global.Path.data, onlyFiles: true })) {
      yield path.join(Global.Path.data, relativePath)
    }
  }

  for await (const filepath of scan()) {
    pending.push(
      Bun.file(filepath)
        .text()
        .then((text) => {
          if (!needsAttachmentMigration(text)) return
          const candidate = candidateFromRelativePath(path.relative(Global.Path.data, filepath), text)
          if (candidate) candidates.push(candidate)
        })
        .catch(() => undefined),
    )
    if (pending.length >= 64) await flush()
  }
  await flush()
  return candidates.sort((a, b) => a.key.join("/").localeCompare(b.key.join("/")))
}

async function collectLegacyToolDisplayPartCandidates(): Promise<AttachmentPartCandidate[]> {
  const candidates: AttachmentPartCandidate[] = []
  const pending: Promise<void>[] = []
  const flush = async () => {
    if (pending.length === 0) return
    await Promise.all(pending.splice(0))
  }

  const paths = await findLegacyToolDisplayPartPaths()
  const scan = async function* () {
    if (paths) {
      for (const filepath of paths) yield filepath
      return
    }
    for await (const relativePath of attachmentPartGlob.scan({ cwd: Global.Path.data, onlyFiles: true })) {
      yield path.join(Global.Path.data, relativePath)
    }
  }

  for await (const filepath of scan()) {
    pending.push(
      Bun.file(filepath)
        .text()
        .then((text) => {
          if (!needsToolDisplayMigration(text)) return
          const candidate = candidateFromRelativePath(path.relative(Global.Path.data, filepath), text)
          if (candidate) candidates.push(candidate)
        })
        .catch(() => undefined),
    )
    if (pending.length >= 64) await flush()
  }
  await flush()
  return candidates.sort((a, b) => a.key.join("/").localeCompare(b.key.join("/")))
}

async function migrateSessionAttachmentParts(progress: (current: number, total: number) => void) {
  const tasks = await collectLegacyAttachmentPartCandidates()
  if (tasks.length === 0) return

  let done = 0
  let changedCount = 0
  for (const { scopeID, sessionID, messageID, key, text } of tasks) {
    const scope = Identifier.asScopeID(scopeID)
    const sid = Identifier.asSessionID(sessionID)
    const mid = Identifier.asMessageID(messageID)
    let part: any
    try {
      part = JSON.parse(text)
    } catch {
      part = await Storage.read<any>(key).catch(() => undefined)
    }
    if (part) {
      const owner =
        part.type === "file"
          ? (await Storage.read<MessageV2.Info>(StoragePath.messageInfo(scope, sid, mid)).catch(() => undefined))
              ?.role === "user"
            ? "user"
            : "tool"
          : "tool"
      const migratedPart = migrateAttachmentPart(part, owner)
      let next = migratedPart.value as Record<string, unknown>
      let changed = migratedPart.changed

      if (next?.type === "tool") {
        const state = asRecord(next.state)
        if (state?.status === "completed") {
          const migratedState: Record<string, unknown> = { ...state }
          const attachments = Array.isArray(state.attachments) ? state.attachments : undefined
          const metadata = migrateToolDisplayMetadata(state.metadata)
          if (attachments) {
            const migratedAttachments = attachments.map((attachment) => migrateAttachmentPart(attachment, "tool"))
            const nextAttachments = migratedAttachments.map((item) => item.value)
            const visibility = applyPrimaryAttachmentVisibility(nextAttachments, metadata.primaryAttachmentIds)
            if (migratedAttachments.some((item) => item.changed) || visibility.changed) {
              migratedState.attachments = visibility.value
              changed = true
            }
          }
          if (metadata.changed) {
            migratedState.metadata = metadata.value
            changed = true
          }
          if (changed) next = { ...next, state: migratedState }
        }
      }

      const metadata = migrateToolDisplayMetadata(next.metadata)
      if (metadata.changed) {
        next = { ...next, metadata: metadata.value }
        changed = true
      }

      if (changed) {
        await Storage.write(key, next)
        changedCount++
      }
    }

    done++
    progress(done, tasks.length)
  }

  log.info("session attachment part migration complete", { total: tasks.length, changed: changedCount })
}

function migrateToolPartDisplayMetadata(part: Record<string, unknown>): {
  value: Record<string, unknown>
  changed: boolean
} {
  let next = { ...part }
  let changed = false

  const state = asRecord(next.state)
  if (state) {
    const migratedState = { ...state }
    const metadata = migrateToolDisplayMetadata(state.metadata)
    const attachments = Array.isArray(state.attachments) ? state.attachments : undefined
    if (attachments) {
      const visibility = applyPrimaryAttachmentVisibility(attachments, metadata.primaryAttachmentIds)
      if (visibility.changed) {
        migratedState.attachments = visibility.value
        changed = true
      }
    }
    if (metadata.changed) {
      migratedState.metadata = metadata.value
      changed = true
    }
    if (changed) next = { ...next, state: migratedState }
  }

  const metadata = migrateToolDisplayMetadata(next.metadata)
  if (metadata.changed) {
    next = { ...next, metadata: metadata.value }
    changed = true
  }

  return { value: next, changed }
}

async function migrateSessionToolDisplayMetadata(progress: (current: number, total: number) => void) {
  const tasks = await collectLegacyToolDisplayPartCandidates()
  if (tasks.length === 0) return

  let done = 0
  let changedCount = 0
  for (const { key, text } of tasks) {
    let part: any
    try {
      part = JSON.parse(text)
    } catch {
      part = await Storage.read<any>(key).catch(() => undefined)
    }

    if (part?.type === "tool") {
      const migrated = migrateToolPartDisplayMetadata(part)
      if (migrated.changed) {
        await Storage.write(key, migrated.value)
        changedCount++
      }
    }

    done++
    progress(done, tasks.length)
  }

  log.info("session tool display metadata migration complete", { total: tasks.length, changed: changedCount })
}

async function repairPendingReplyFlags(progress: (current: number, total: number) => void) {
  const scopeIDs = await Storage.scan(["sessions"])
  const tasks: Array<{ scopeID: string; sessionID: string; info: Info }> = []

  for (const scopeID of scopeIDs) {
    const scope = Identifier.asScopeID(scopeID)
    const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scope))
    const sessions = await Storage.readMany<Info>(
      sessionIDs.map((sessionID) => StoragePath.sessionInfo(scope, Identifier.asSessionID(sessionID))),
    )

    for (const info of sessions) {
      if (!info || info.time.archived || info.pendingReply !== true) continue
      tasks.push({ scopeID, sessionID: info.id, info })
    }
  }

  if (tasks.length === 0) return

  let done = 0
  let cleared = 0
  for (const { scopeID, sessionID, info } of tasks) {
    const scope = Identifier.asScopeID(scopeID)
    const sid = Identifier.asSessionID(sessionID)
    try {
      const messages = await MessageV2.filterCompacted(MessageV2.stream({ scopeID, sessionID }))
      const pendingReply = SessionProgress.pendingReply(messages)
      if (!pendingReply) {
        await Storage.write(StoragePath.sessionInfo(scope, sid), {
          ...info,
          pendingReply: undefined,
        })
        cleared++
      }
    } catch (error) {
      log.warn("failed to repair pendingReply flag", { scopeID, sessionID, error: String(error) })
    }

    done++
    progress(done, tasks.length)
  }

  log.info("pendingReply repair complete", { checked: tasks.length, cleared })
}

async function migrateActiveRevertState(progress: (current: number, total: number) => void) {
  const scopeIDs = await Storage.scan(["sessions"]).catch(() => [])
  const tasks: Array<{ scopeID: string; sessionID: string; info: any }> = []

  for (const scopeID of scopeIDs) {
    const scope = Identifier.asScopeID(scopeID)
    const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
    const sessions = await Storage.readMany<any>(
      sessionIDs.map((sessionID) => StoragePath.sessionInfo(scope, Identifier.asSessionID(sessionID))),
    )
    for (const info of sessions) {
      if (!info?.revert?.messageID) continue
      tasks.push({ scopeID, sessionID: info.id, info })
    }
  }

  if (tasks.length === 0) return

  let done = 0
  for (const { scopeID, sessionID, info } of tasks) {
    const scope = Identifier.asScopeID(scopeID)
    const sid = Identifier.asSessionID(sessionID)
    const messageIDs = await Storage.scan(StoragePath.sessionMessagesRoot(scope, sid)).catch(() => [])
    const cutoff = messageIDs.findIndex((messageID) => messageID >= info.revert.messageID)
    const droppedIDs = cutoff >= 0 ? messageIDs.slice(cutoff) : []
    const droppedUserIDs: string[] = []
    const files = new Set<string>()
    const patchPartIDs: string[] = []

    for (const messageID of droppedIDs) {
      const mid = Identifier.asMessageID(messageID)
      const msg = await Storage.read<MessageV2.Info>(StoragePath.messageInfo(scope, sid, mid)).catch(() => undefined)
      if (msg?.role === "user" && (msg as MessageV2.User).metadata?.synthetic !== true) droppedUserIDs.push(messageID)

      const partIDs = await Storage.scan(StoragePath.messageParts(scope, sid, mid)).catch(() => [])
      const parts = await Storage.readMany<MessageV2.Part>(
        partIDs.map((partID) => StoragePath.messagePart(scope, sid, mid, Identifier.asPartID(partID))),
      )
      for (const part of parts) {
        if (part?.type !== "patch") continue
        patchPartIDs.push(part.id)
        for (const file of part.files) files.add(file)
      }
    }

    const eventID = Identifier.ascending("history")
    const history = droppedIDs.length
      ? {
          rollback: {
            id: eventID,
            numTurns: Math.max(1, droppedUserIDs.length),
            created: Date.now(),
            messageID: droppedUserIDs[0],
            droppedMessageIDs: droppedIDs,
            droppedUserMessageIDs: droppedUserIDs,
            files: Array.from(files),
            patchPartIDs,
            canUnrollback: true,
          },
        }
      : undefined

    if (history) {
      await Storage.write(StoragePath.sessionHistoryEvent(scope, sid, Identifier.asHistoryID(eventID)), {
        id: eventID,
        sessionID,
        type: "rollback",
        time: {
          created: history.rollback.created,
        },
        numTurns: history.rollback.numTurns,
        droppedMessageIDs: history.rollback.droppedMessageIDs,
        droppedUserMessageIDs: history.rollback.droppedUserMessageIDs,
        files: history.rollback.files,
        patchPartIDs: history.rollback.patchPartIDs,
      })
    }

    const rest = { ...info }
    delete rest.revert
    await Storage.write(StoragePath.sessionInfo(scope, sid), {
      ...rest,
      history,
    })

    done++
    progress(done, tasks.length)
  }

  log.info("active revert state migrated to rollback history", { total: tasks.length })
}

export const migrations: Migration[] = [
  {
    id: "20260411-session-endpoint-index",
    description: "Backfill endpoint session index and remove legacy channel index",
    async up(progress) {
      const scopeIDs = await Storage.scan(["sessions"])
      const tasks: Array<{ scopeID: string; sessionID: string }> = []

      for (const scopeID of scopeIDs) {
        const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))
        for (const sessionID of sessionIDs) {
          tasks.push({ scopeID, sessionID })
        }
      }

      if (tasks.length === 0) return

      let done = 0
      for (const { scopeID, sessionID } of tasks) {
        const scope = Identifier.asScopeID(scopeID)
        const session = Identifier.asSessionID(sessionID)
        const info = await Storage.read<Info>(StoragePath.sessionInfo(scope, session)).catch(() => undefined)

        if (info?.endpoint && !info.time.archived) {
          const endpointKey = SessionEndpoint.toKey(info.endpoint)
          await Storage.write(StoragePath.endpointSession(endpointKey, session), {
            sessionID: info.id,
            scopeID,
          })
        }

        done++
        progress(done, tasks.length)
      }

      await Storage.removeTree(["channel_session"]).catch(() => undefined)
      log.info("endpoint session index backfill complete", { total: tasks.length })
    },
  },
  {
    id: "20260411-holos-message-metadata-shape",
    description: "Normalize legacy Holos message metadata into grouped fields",
    async up(progress) {
      const scopeIDs = await Storage.scan(["sessions"])
      const tasks: Array<{ scopeID: string; sessionID: string; messageID: string }> = []

      for (const scopeID of scopeIDs) {
        const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))
        for (const sessionID of sessionIDs) {
          const messageIDs = await Storage.scan(
            StoragePath.sessionMessagesRoot(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
          ).catch(() => [])
          for (const messageID of messageIDs) {
            tasks.push({ scopeID, sessionID, messageID })
          }
        }
      }

      if (tasks.length === 0) return

      let done = 0
      for (const { scopeID, sessionID, messageID } of tasks) {
        const scope = Identifier.asScopeID(scopeID)
        const session = Identifier.asSessionID(sessionID)
        const message = Identifier.asMessageID(messageID)
        const info = await Storage.read<MessageV2.Info>(StoragePath.messageInfo(scope, session, message)).catch(
          () => undefined,
        )
        if (info?.metadata) {
          const metadata = info.metadata as Record<string, unknown>
          const normalized = normalizeLegacyHolosMetadata(metadata)
          if (normalized.changed) {
            await Storage.write(StoragePath.messageInfo(scope, session, message), {
              ...info,
              metadata: normalized.metadata,
            })
          }
        }

        done++
        progress(done, tasks.length)
      }

      log.info("holos message metadata normalization complete", { total: tasks.length })
    },
  },
  {
    id: "20260423-session-page-index-and-last-exchange",
    description: "Build session page index per scope and backfill lastExchange on session info",
    async up(progress) {
      const scopeIDs = await Storage.scan(["sessions"])
      if (scopeIDs.length === 0) return

      let totalSessions = 0
      const scopeTasks: Array<{ scopeID: string; sessionIDs: string[] }> = []
      for (const scopeID of scopeIDs) {
        const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))
        if (sessionIDs.length > 0) {
          scopeTasks.push({ scopeID, sessionIDs })
          totalSessions += sessionIDs.length
        }
      }

      if (totalSessions === 0) return

      let done = 0
      for (const { scopeID, sessionIDs } of scopeTasks) {
        const scope = Identifier.asScopeID(scopeID)

        // Batch read all session infos
        const keys = sessionIDs.map((id) => StoragePath.sessionInfo(scope, Identifier.asSessionID(id)))
        const sessions = await Storage.readMany<Info>(keys)

        // Build page index entries
        const entries: Array<{
          id: string
          updated: number
          created: number
          pinned: number
          archived: boolean
        }> = []

        for (let i = 0; i < sessions.length; i++) {
          const session = sessions[i]
          if (!session) continue

          entries.push({
            id: session.id,
            updated: session.time.updated,
            created: session.time.created,
            pinned: session.pinned ?? 0,
            archived: !!session.time.archived,
          })

          // Backfill lastExchange
          if (!session.lastExchange && !session.time.archived) {
            const lastExchange: NonNullable<Info["lastExchange"]> = {}
            const sID = Identifier.asSessionID(session.id)
            const msgIDs = await Storage.scan(StoragePath.sessionMessagesRoot(scope, sID)).catch(() => [])

            for (let mi = msgIDs.length - 1; mi >= 0; mi--) {
              const msgInfo = await Storage.read<MessageV2.Info>(
                StoragePath.messageInfo(scope, sID, Identifier.asMessageID(msgIDs[mi])),
              ).catch(() => undefined)
              if (!msgInfo) continue

              const partIDs = await Storage.scan(
                StoragePath.messageParts(scope, sID, Identifier.asMessageID(msgIDs[mi])),
              ).catch(() => [])
              const parts = (
                await Storage.readMany<MessageV2.Part>(
                  partIDs.map((pid) =>
                    StoragePath.messagePart(scope, sID, Identifier.asMessageID(msgIDs[mi]), Identifier.asPartID(pid)),
                  ),
                )
              ).filter((p): p is MessageV2.Part => p != null)

              if (!lastExchange.assistant && msgInfo.role === "assistant") {
                const text = MessageV2.extractText(parts, { maxLength: 200 })
                if (text) lastExchange.assistant = text
              }
              if (!lastExchange.user && msgInfo.role === "user") {
                const text = MessageV2.extractText(parts, { maxLength: 200 })
                if (text) lastExchange.user = text
              }
              if (lastExchange.user && lastExchange.assistant) break
            }

            if (lastExchange.user || lastExchange.assistant) {
              await Storage.write(StoragePath.sessionInfo(scope, sID), {
                ...session,
                lastExchange,
              })
            }
          }

          done++
          progress(done, totalSessions)
        }

        // Sort by updated desc and write page index
        entries.sort((a, b) => b.updated - a.updated)
        await Storage.write(StoragePath.sessionsPageIndex(scope), { entries })
      }

      log.info("session page index and lastExchange backfill complete", { totalSessions })
    },
  },
  {
    id: "20260423-session-page-index-parentid",
    description: "Add parentID to session page index entries",
    async up(progress) {
      const scopeIDs = await Storage.scan(["sessions"]).catch(() => [])
      let done = 0

      for (const scopeID of scopeIDs) {
        const scope = Identifier.asScopeID(scopeID)
        const indexPath = StoragePath.sessionsPageIndex(scope)
        const index = await Storage.read<{
          entries: Array<{
            id: string
            updated: number
            created: number
            pinned: number
            archived: boolean
            parentID?: string
          }>
        }>(indexPath).catch(() => null)
        if (!index?.entries?.length) {
          done++
          progress(done, scopeIDs.length)
          continue
        }

        let updated = false
        for (const entry of index.entries) {
          if (entry.parentID !== undefined) continue
          const info = await Storage.read<Info>(StoragePath.sessionInfo(scope, Identifier.asSessionID(entry.id))).catch(
            () => null,
          )
          if (info?.parentID) {
            entry.parentID = info.parentID
            updated = true
          }
        }

        if (updated) await Storage.write(indexPath, index)
        done++
        progress(done, scopeIDs.length)
      }
    },
  },
  {
    id: "20260617-session-nav-v2-category",
    description: "Build session navigation v2 indexes and backfill session categories",
    async up(progress) {
      const scopeIDs: string[] = await Storage.scan(["sessions"]).catch(() => [])
      const allScopeIDs = scopeIDs.includes("home") ? scopeIDs : ["home", ...scopeIDs]
      if (allScopeIDs.length === 0) return

      let done = 0
      for (const scopeID of allScopeIDs) {
        await SessionNav.buildNavIndex(scopeID).catch((error) => {
          log.warn("failed to build session nav v2 index during migration", { scopeID, error: String(error) })
        })
        done++
        progress(done, allScopeIDs.length)
      }
      log.info("session nav v2 index and category backfill complete", { scopes: allScopeIDs.length })
    },
  },
  {
    id: "20260617-dag-node-result-field",
    description: "Track DAG Node optional result field addition (schema-only, no data migration)",
    async up() {
      // Schema-only change: Node.result is optional and transparent to old data.
      // No data transformation needed.
    },
  },
  {
    id: "20260619-session-repair-stale-pending-reply",
    description: "Repair stale pendingReply flags on completed sessions",
    async up(progress) {
      await repairPendingReplyFlags(progress)
    },
  },
  {
    id: "20260619-snapshot-per-session",
    description:
      "Restructure snapshots from per-scope shared to per-session isolated repos with git alternates for backward hash resolution",
    async up(progress) {
      const { Global } = await import("../global")
      const snapshotRoot = Global.Path.snapshot
      const scopeIDs = await Storage.scan(["sessions"])
      if (scopeIDs.length === 0) return

      let done = 0
      for (const scopeID of scopeIDs) {
        const oldSharedPath = path.join(snapshotRoot, scopeID)
        const sharedPath = path.join(oldSharedPath, ".shared.old")

        // Detect old shared repo: bare-like git repo has HEAD at root (no .git/ wrapper)
        let sharedExists = false
        try {
          const stat = await fs.stat(path.join(oldSharedPath, "HEAD"))
          sharedExists = stat.isFile()
        } catch {
          sharedExists = false
        }

        // Two-step rename: move to sibling first, then into recreated scope dir
        if (sharedExists) {
          try {
            const tmpPath = path.join(snapshotRoot, `.tmp-${scopeID}`)
            await fs.rename(oldSharedPath, tmpPath)
            await fs.mkdir(oldSharedPath, { recursive: true })
            await fs.rename(tmpPath, sharedPath)
            log.info("renamed shared snapshot repo", { scopeID, to: sharedPath })
          } catch (err) {
            log.warn("failed to rename shared snapshot repo", { scopeID, error: String(err) })
          }
        }

        // Determine if shared old objects are reachable for alternates
        const hasSharedOld =
          sharedExists || ((await fs.stat(path.join(sharedPath, "HEAD")).catch(() => null))?.isFile() ?? false)

        const sessions = await Storage.scan(StoragePath.sessionsRoot(Identifier.asScopeID(scopeID)))

        for (const sessionID of sessions) {
          const sessionRepo = path.join(oldSharedPath, sessionID)

          // Idempotent: skip if repo already exists
          try {
            await fs.stat(path.join(sessionRepo, "HEAD"))
            continue
          } catch {
            // Repo does not exist, create it
          }

          await fs.mkdir(sessionRepo, { recursive: true })
          await $`git init`
            .env({ GIT_DIR: sessionRepo, ...process.env })
            .quiet()
            .nothrow()

          // Set git alternate to point to shared old objects for backward hash resolution
          if (hasSharedOld) {
            const objectsPath = path.join(sharedPath, "objects")
            const infoDir = path.join(sessionRepo, "objects", "info")
            await fs.mkdir(infoDir, { recursive: true })
            await fs.writeFile(path.join(infoDir, "alternates"), objectsPath + "\n")
          }
        }

        done++
        progress(done, scopeIDs.length)
      }

      log.info("snapshot per-session migration complete", { scopesHandled: scopeIDs.length })
    },
  },
  {
    id: "20260619-remove-home-endpoint",
    description: "Strip endpoint from home-scope app-channel sessions and rebuild home nav index",
    async up(progress) {
      const scope = Identifier.asScopeID("home")
      const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
      if (sessionIDs.length === 0) return

      let done = 0
      for (const sessionID of sessionIDs) {
        const sID = Identifier.asSessionID(sessionID)
        const info = await Storage.read<any>(StoragePath.sessionInfo(scope, sID)).catch(() => undefined)

        // Strip endpoint from app-channel sessions
        if (info?.endpoint?.channel?.type === "app") {
          const { endpoint, ...rest } = info
          await Storage.write(StoragePath.sessionInfo(scope, sID), rest)
        }

        done++
        progress(done, sessionIDs.length)
      }

      // Rebuild home nav index so categories are correct.
      await SessionNav.buildNavIndex("home").catch((error) => {
        // Log but don't fail — nav index rebuilds lazily
      })
    },
  },
  {
    id: "20260624-session-home-nav-rebuild",
    description: "Rebuild home session navigation after global scope rename",
    async up(progress) {
      await SessionNav.buildNavIndex("home").catch((error) => {
        log.warn("failed to rebuild home nav index after scope rename", { error: String(error) })
      })
      progress(1, 1)
    },
  },
  {
    id: "20260625-session-rollback-history",
    description: "Migrate active session revert state into history-only rollback events",
    async up(progress) {
      await migrateActiveRevertState(progress)
    },
  },
  {
    id: "20260630-session-attachment-parts",
    description: "Migrate session file parts and artifact-only media metadata to attachment parts",
    async up(progress) {
      await migrateSessionAttachmentParts(progress)
    },
  },
  {
    id: "20260630-session-tool-card-display",
    description: "Migrate media tool display visibility into explicit tool card display policy",
    async up(progress) {
      await migrateSessionToolDisplayMetadata(progress)
    },
  },
  {
    id: "20260701-attachment-presentation-v2",
    description: "Normalize attachment presentation controls and remove tool-level attachment promotion fields",
    async up(progress) {
      await migrateSessionAttachmentParts(progress)
    },
  },
]
MigrationRegistry.register("session", migrations)
