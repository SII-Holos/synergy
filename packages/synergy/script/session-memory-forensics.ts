#!/usr/bin/env bun

import fs from "fs/promises"
import path from "path"
import os from "os"

type SessionMetric = {
  scopeID: string
  sessionID: string
  messageInfoCount: number
  messagePartCount: number
  messageInfoBytes: number
  messagePartBytes: number
  totalBytes: number
  readRssPeakBytes?: number
}

type ScopeMetric = {
  scopeID: string
  sessionCount: number
  listInputBytes: number
  listRssPeakBytes: number
  sessions: SessionMetric[]
}

const args = new Map<string, string | true>()
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (!arg.startsWith("--")) continue
  const next = process.argv[i + 1]
  if (next && !next.startsWith("--")) {
    args.set(arg, next)
    i++
  } else {
    args.set(arg, true)
  }
}

const top = Number(args.get("--top") ?? 10)
const scopeFilter = typeof args.get("--scope") === "string" ? String(args.get("--scope")) : undefined
const includeMessageRead = args.has("--include-message-read")

function homeDir() {
  return process.env.SYNERGY_HOME || process.env.SYNERGY_TEST_HOME || os.homedir()
}

function dataDir() {
  return path.join(homeDir(), ".synergy", "data")
}

async function exists(filepath: string) {
  return fs.stat(filepath).then(
    () => true,
    () => false,
  )
}

async function dirs(filepath: string) {
  const entries = await fs.readdir(filepath, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

async function jsonFiles(filepath: string): Promise<string[]> {
  const entries = await fs.readdir(filepath, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.includes(".tmp-"))
    .map((entry) => path.join(filepath, entry.name))
}

async function fileSize(filepath: string) {
  return fs.stat(filepath).then(
    (stat) => stat.size,
    () => 0,
  )
}

async function measureRead(files: string[]) {
  let peak = process.memoryUsage().rss
  for (const file of files) {
    await Bun.file(file)
      .json()
      .catch(() => undefined)
    peak = Math.max(peak, process.memoryUsage().rss)
  }
  return peak
}

async function sessionMetric(scopeID: string, sessionID: string, root: string): Promise<SessionMetric> {
  const messages = path.join(root, "sessions", scopeID, sessionID, "messages")
  const messageIDs = await dirs(messages)
  let messageInfoCount = 0
  let messagePartCount = 0
  let messageInfoBytes = 0
  let messagePartBytes = 0
  const readFiles: string[] = []

  for (const messageID of messageIDs) {
    const messageRoot = path.join(messages, messageID)
    const info = path.join(messageRoot, "info.json")
    if (await exists(info)) {
      messageInfoCount++
      messageInfoBytes += await fileSize(info)
      readFiles.push(info)
    }

    const parts = await jsonFiles(path.join(messageRoot, "parts"))
    messagePartCount += parts.length
    for (const part of parts) {
      messagePartBytes += await fileSize(part)
      readFiles.push(part)
    }
  }

  return {
    scopeID,
    sessionID,
    messageInfoCount,
    messagePartCount,
    messageInfoBytes,
    messagePartBytes,
    totalBytes: messageInfoBytes + messagePartBytes,
    ...(includeMessageRead ? { readRssPeakBytes: await measureRead(readFiles) } : {}),
  }
}

async function scopeMetric(scopeID: string, root: string): Promise<ScopeMetric> {
  const scopeRoot = path.join(root, "sessions", scopeID)
  const sessionIDs = await dirs(scopeRoot)
  const sessionInfos = sessionIDs.map((sessionID) => path.join(scopeRoot, sessionID, "info.json"))
  const listInputBytes = (await Promise.all(sessionInfos.map(fileSize))).reduce((sum, bytes) => sum + bytes, 0)
  const listRssPeakBytes = await measureRead(sessionInfos)
  const sessions = await Promise.all(sessionIDs.map((sessionID) => sessionMetric(scopeID, sessionID, root)))
  sessions.sort((a, b) => b.totalBytes - a.totalBytes)
  return {
    scopeID,
    sessionCount: sessionIDs.length,
    listInputBytes,
    listRssPeakBytes,
    sessions: sessions.slice(0, Number.isFinite(top) ? top : 10),
  }
}

const root = dataDir()
const scopes = scopeFilter ? [scopeFilter] : await dirs(path.join(root, "sessions"))
const result = {
  generatedAt: new Date().toISOString(),
  dataRoot: "SYNERGY_DATA",
  includeMessageRead,
  scopes: await Promise.all(scopes.map((scopeID) => scopeMetric(scopeID, root))),
}

console.log(JSON.stringify(result, null, 2))
