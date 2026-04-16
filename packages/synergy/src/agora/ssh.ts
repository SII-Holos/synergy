import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { AgoraClient } from "./client"
import { AgoraTypes } from "./types"

const log = Log.create({ service: "agora.ssh" })

export namespace AgoraSSH {
  const KEY_NAME = "agora_ed25519"
  const HOST_ALIAS = "agora-gitea"

  export interface LocalKeyPair {
    privateKeyPath: string
    publicKeyPath: string
    publicKey: string
  }

  export interface HostAliasInfo {
    alias: string
    hostName: string
    configPath: string
  }

  export async function ensureLocalKey(): Promise<LocalKeyPair> {
    const sshDir = path.join(Global.Path.root, "ssh")
    const privateKeyPath = path.join(sshDir, KEY_NAME)
    const publicKeyPath = `${privateKeyPath}.pub`

    await fs.mkdir(sshDir, { recursive: true })
    await ensureMode(sshDir, 0o700)

    const privateExists = await Bun.file(privateKeyPath).exists()
    const publicExists = await Bun.file(publicKeyPath).exists()

    if (!privateExists || !publicExists) {
      await generateEd25519Key(privateKeyPath)
    }

    await ensureMode(privateKeyPath, 0o600)
    await ensureMode(publicKeyPath, 0o644)

    const publicKey = (await Bun.file(publicKeyPath).text()).trim()
    if (!publicKey) {
      throw new Error(`Agora SSH public key is empty: ${publicKeyPath}`)
    }

    return {
      privateKeyPath,
      publicKeyPath,
      publicKey,
    }
  }

  export async function listRemoteKeys(options?: { abort?: AbortSignal }) {
    return AgoraClient.request<AgoraTypes.SSHKeyList>("GET", "/api/actors/me/ssh-keys", {
      abort: options?.abort,
    })
  }

  export async function addRemoteKey(
    input: {
      title?: string
      key?: string
      read_only?: boolean
    },
    options?: { abort?: AbortSignal },
  ) {
    const localKey = input.key ? undefined : await ensureLocalKey()
    const key = input.key ?? localKey?.publicKey
    if (!key) throw new Error("Agora SSH key is required")

    return AgoraClient.request<AgoraTypes.SSHKeyRecord>("POST", "/api/actors/me/ssh-keys", {
      body: {
        title: input.title ?? defaultKeyTitle(),
        key,
      },
      abort: options?.abort,
    })
  }

  export async function ensureRemoteKey(options?: { abort?: AbortSignal }) {
    const localKey = await ensureLocalKey()
    const remoteKeys = await listRemoteKeys(options)
    const existing = remoteKeys.items.find(
      (item) => normalizeAuthorizedKey(item.key) === normalizeAuthorizedKey(localKey.publicKey),
    )
    if (existing) return existing
    try {
      return await addRemoteKey({ key: localKey.publicKey }, options)
    } catch (err) {
      if (err instanceof Error && /\(409\)/.test(err.message)) {
        log.warn("ssh key already registered in gitea under a different actor, treating as available")
        return { id: 0, key: localKey.publicKey, title: defaultKeyTitle() } as AgoraTypes.SSHKeyRecord
      }
      throw err
    }
  }

  export async function resolveGiteaSSHHost(url?: string) {
    const config = await Config.get()
    const configuredHost = config.agora?.giteaSSHHost?.trim()
    if (configuredHost) return configuredHost

    if (url) {
      const parsedClone = parseCloneUrl(url)
      if (parsedClone?.host) return parsedClone.host
    }

    const target = (await AgoraClient.getConfig())?.url
    if (!target) throw new Error("Unable to resolve Agora Gitea SSH host")

    const parsed = new URL(target)
    return parsed.hostname
  }

  export async function ensureHostAlias(input?: {
    host?: string
    alias?: string
    user?: string
    identityFile?: string
  }): Promise<HostAliasInfo> {
    const localKey = await ensureLocalKey()
    const hostName = input?.host ?? (await resolveGiteaSSHHost())
    const alias = input?.alias ?? HOST_ALIAS
    const user = input?.user ?? "git"
    const identityFile = input?.identityFile ?? localKey.privateKeyPath
    const configPath = path.join(os.homedir(), ".ssh", "config")
    const nextBlock = renderHostBlock({ alias, hostName, user, identityFile })

    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await ensureMode(path.dirname(configPath), 0o700)

    const current = await Bun.file(configPath)
      .text()
      .catch(() => "")

    const updated = upsertHostBlock(current, alias, nextBlock)
    if (updated !== current) {
      await Bun.write(configPath, updated)
      log.info("updated ssh config for agora gitea host", { alias, hostName })
    }

    await ensureMode(configPath, 0o600)

    return {
      alias,
      hostName,
      configPath,
    }
  }

  export function parseCloneUrl(cloneUrl: string) {
    const trimmed = cloneUrl.trim()

    const sshScheme = trimmed.match(/^ssh:\/\/(?:(?<user>[^@/]+)@)?(?<host>[^/:]+)(?::(?<port>\d+))?\/(?<path>.+)$/)
    if (sshScheme?.groups) {
      return {
        scheme: "ssh" as const,
        user: sshScheme.groups.user ?? "git",
        host: sshScheme.groups.host,
        port: sshScheme.groups.port,
        repoPath: sshScheme.groups.path,
      }
    }

    const scpLike = trimmed.match(/^(?<user>[^@/]+)@(?<host>[^:/]+):(?<path>.+)$/)
    if (scpLike?.groups) {
      return {
        scheme: "scp" as const,
        user: scpLike.groups.user,
        host: scpLike.groups.host,
        repoPath: scpLike.groups.path,
      }
    }

    const https = trimmed.match(/^(https?):\/\/(?<host>[^/]+)\/(?<path>.+)$/)
    if (https?.groups) {
      return {
        scheme: https[1] as "http" | "https",
        host: https.groups.host,
        repoPath: https.groups.path,
      }
    }

    return undefined
  }

  export function rewriteCloneUrl(cloneUrl: string, alias: string) {
    const parsed = parseCloneUrl(cloneUrl)
    if (!parsed) return cloneUrl

    if (parsed.scheme === "ssh") {
      const prefix = `${parsed.user}@${alias}`
      return parsed.port ? `ssh://${prefix}:${parsed.port}/${parsed.repoPath}` : `ssh://${prefix}/${parsed.repoPath}`
    }

    if (parsed.scheme === "scp") {
      return `${parsed.user}@${alias}:${parsed.repoPath}`
    }

    return cloneUrl
  }

  export async function ensureAccess(options?: { cloneUrl?: string; abort?: AbortSignal }) {
    const [key, remoteKey] = await Promise.all([ensureLocalKey(), ensureRemoteKey(options)])
    const host = await resolveGiteaSSHHost(options?.cloneUrl)
    const aliasInfo = await ensureHostAlias({ host, identityFile: key.privateKeyPath })
    return {
      key,
      remoteKey,
      host: aliasInfo,
      cloneUrl: options?.cloneUrl ? rewriteCloneUrl(options.cloneUrl, aliasInfo.alias) : undefined,
    }
  }

  async function generateEd25519Key(privateKeyPath: string) {
    const proc = Bun.spawn(["ssh-keygen", "-t", "ed25519", "-f", privateKeyPath, "-N", "", "-C", defaultKeyTitle()], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })

    const code = await proc.exited
    if (code !== 0) {
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : ""
      throw new Error(`Failed to generate Agora SSH key: ${stderr || `exit code ${code}`}`)
    }
  }

  async function ensureMode(target: string, mode: number) {
    await fs.chmod(target, mode).catch(() => {})
  }

  function defaultKeyTitle() {
    return `synergy@${os.hostname()}`
  }

  function normalizeAuthorizedKey(value: string) {
    return value.trim().replace(/\s+/g, " ")
  }

  function renderHostBlock(input: { alias: string; hostName: string; user: string; identityFile: string }) {
    return [
      `Host ${input.alias}`,
      `  HostName ${input.hostName}`,
      `  User ${input.user}`,
      `  IdentityFile ${input.identityFile}`,
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking accept-new",
    ].join("\n")
  }

  function upsertHostBlock(content: string, alias: string, block: string) {
    const normalized = content.replace(/\s+$/, "")
    const lines = normalized ? normalized.split("\n") : []
    const output: string[] = []
    let index = 0
    let replaced = false

    while (index < lines.length) {
      const line = lines[index]
      if (!line.startsWith("Host ")) {
        output.push(line)
        index += 1
        continue
      }

      const names = line.slice(5).trim().split(/\s+/).filter(Boolean)
      const start = index
      index += 1
      while (index < lines.length && /^[ \t]/.test(lines[index])) {
        index += 1
      }

      if (names.includes(alias)) {
        output.push(block)
        replaced = true
      } else {
        output.push(lines.slice(start, index).join("\n"))
      }
    }

    if (!replaced) {
      output.push(block)
    }

    return `${output.filter(Boolean).join("\n\n").replace(/\s+$/, "")}\n`
  }
}
