#!/usr/bin/env bun

import { $ } from "bun"
import { currentRepo } from "../shared/current-repo"
import { releaseEnv } from "./shared/runtime"

const WINDOWS_INSTALLER_PREFIX = "Synergy-win32-x64-"
const PE_HEADER_PEEK_BYTES = 4096

/**
 * Reports whether a PE binary carries an Authenticode certificate table.
 * Only the certificate table size from the data directory is inspected, so a
 * small prefix of the file is sufficient and the full installer is not read.
 */
export function hasAuthenticodeSignature(buffer: Uint8Array): boolean {
  if (buffer.byteLength < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return false
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const eLfanew = view.getUint32(0x3c, true)
  if (eLfanew + 0x18 + 2 > buffer.byteLength) return false
  if (
    buffer[eLfanew] !== 0x50 ||
    buffer[eLfanew + 1] !== 0x45 ||
    buffer[eLfanew + 2] !== 0 ||
    buffer[eLfanew + 3] !== 0
  ) {
    return false
  }
  const coffEnd = eLfanew + 0x18
  const magic = view.getUint16(coffEnd, true)
  const dataDirectoryBase = magic === 0x20b ? coffEnd + 112 : magic === 0x10b ? coffEnd + 96 : -1
  if (dataDirectoryBase < 0) return false
  const certificateTableOffset = dataDirectoryBase + 4 * 8
  if (certificateTableOffset + 8 > buffer.byteLength) return false
  return view.getUint32(certificateTableOffset + 4, true) > 0
}

async function peekInstallerPrefix(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`failed to fetch Windows installer prefix: ${response.status} ${response.statusText}`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < PE_HEADER_PEEK_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    await reader.cancel()
  }
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

async function latestWindowsInstallerWasSigned(repo: string): Promise<boolean> {
  const result =
    await $`gh api /repos/${repo}/releases --paginate --jq '.[] | select(.draft == false) | .assets[] | select(.name | startswith(${WINDOWS_INSTALLER_PREFIX}) and endswith(".exe")) | .browser_download_url'`
      .env(releaseEnv())
      .nothrow()
      .quiet()
  const urls = result.stdout.toString().trim().split("\n").filter(Boolean)
  if (result.exitCode !== 0 || urls.length === 0) return false
  const prefix = await peekInstallerPrefix(urls[0]!)
  return hasAuthenticodeSignature(prefix)
}

export async function assertWindowsSigningContinuity(
  env: Record<string, string | undefined>,
  options: { previousWindowsInstallerWasSigned?: () => Promise<boolean> } = {},
): Promise<void> {
  if (env.WINDOWS_CERTIFICATE?.trim()) {
    console.log("Windows signing material configured; continuity is satisfied")
    return
  }
  const previouslySigned = options.previousWindowsInstallerWasSigned
    ? await options.previousWindowsInstallerWasSigned()
    : await latestWindowsInstallerWasSigned(await currentRepo())
  if (previouslySigned) {
    throw new Error(
      "A previously published Windows release is code-signed, but WINDOWS_CERTIFICATE / WINDOWS_CERTIFICATE_PASSWORD are not configured. Existing signed installations verify updates against that publisher, so an unsigned installer would be rejected by automatic updates. Configure the Windows signing secrets or restore signing before publishing.",
    )
  }
  console.log("No previously signed Windows release found; unsigned Windows packaging is allowed")
}

if (import.meta.main) {
  await assertWindowsSigningContinuity(process.env)
}
