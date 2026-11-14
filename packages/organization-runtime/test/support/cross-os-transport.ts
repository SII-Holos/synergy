import fs from "node:fs/promises"
import path from "node:path"
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto"
import { z } from "zod"

const pem = z.string().min(32).max(8192)
const hash = z.string().regex(/^[a-f0-9]{40}$/)
export const Run = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  id: z.string().regex(/^\d+$/),
  attempt: z.string().regex(/^\d+$/),
  sha: hash,
})
export type Run = z.infer<typeof Run>
export const PublicPeer = z.strictObject({
  version: z.literal(1),
  run: Run,
  role: z.enum(["darwin", "linux"]),
  signing: pem,
  encryption: pem,
})
export type PublicPeer = z.infer<typeof PublicPeer>
export const Bootstrap = PublicPeer.extend({
  role: z.literal("darwin"),
  origin: z.url().refine((value) => {
    const url = new URL(value)
    return url.protocol === "https:" && url.origin === value && url.hostname.endsWith(".trycloudflare.com")
  }),
  identity: z.strictObject({ orgID: z.string(), accountID: z.string() }),
})
export type Bootstrap = z.infer<typeof Bootstrap>
const Secret = z.strictObject({
  public: PublicPeer,
  signing: pem,
  encryption: pem,
})
type Secret = z.infer<typeof Secret>
const Box = z.strictObject({
  key: pem,
  iv: z.string(),
  body: z.string(),
  tag: z.string(),
})
const Payload = z.strictObject({
  run: Run,
  nonce: z.string().uuid(),
  action: z.string().max(64),
  value: z.json(),
})
const Envelope = z.strictObject({
  body: z.string().max(1024 * 1024),
  signature: z.string().max(256),
})
const domain = "synergy.synthetic-cross-os-test.v1\n"

export function run(): Run {
  return Run.parse({
    repository: process.env.GITHUB_REPOSITORY,
    id: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    sha: process.env.SYNERGY_CROSS_OS_SHA ?? process.env.GITHUB_SHA,
  })
}
export function state() {
  const value = process.env.SYNERGY_CROSS_OS_STATE
  if (!value || !path.isAbsolute(value)) throw new Error("Cross-OS acceptance requires its task-owned state directory")
  return value
}
export function equalRun(left: Run, right = run()) {
  if (JSON.stringify(left) !== JSON.stringify(right))
    throw new Error("Cross-OS transport belongs to another run or head")
}
export async function identity() {
  const value = Secret.parse(await Bun.file(path.join(state(), "private.json")).json())
  equalRun(value.public.run)
  return value
}
export async function prepareIdentity(role: PublicPeer["role"]) {
  if (process.platform !== role) throw new Error("The fixture role must match the actual operating system")
  await fs.mkdir(state(), { recursive: true, mode: 0o700 })
  const signing = generateKeyPairSync("ed25519")
  const encryption = generateKeyPairSync("x25519")
  const publicPeer = PublicPeer.parse({
    version: 1,
    run: run(),
    role,
    signing: signing.publicKey.export({ type: "spki", format: "pem" }),
    encryption: encryption.publicKey.export({ type: "spki", format: "pem" }),
  })
  const value = Secret.parse({
    public: publicPeer,
    signing: signing.privateKey.export({ type: "pkcs8", format: "pem" }),
    encryption: encryption.privateKey.export({ type: "pkcs8", format: "pem" }),
  })
  await fs.writeFile(path.join(state(), "private.json"), JSON.stringify(value), { mode: 0o600, flag: "wx" })
  await fs.writeFile(path.join(state(), "public.json"), JSON.stringify(publicPeer), { mode: 0o600, flag: "wx" })
}
function seal(value: z.core.util.JSONType, recipient: PublicPeer) {
  const ephemeral = generateKeyPairSync("x25519")
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey(recipient.encryption),
  })
  const key = Buffer.from(hkdfSync("sha256", shared, JSON.stringify(recipient.run), domain, 32))
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(
    Buffer.from(
      JSON.stringify({
        version: recipient.version,
        run: recipient.run,
        role: recipient.role,
        signing: recipient.signing,
        encryption: recipient.encryption,
      }),
    ),
  )
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return Box.parse({
    key: ephemeral.publicKey.export({ type: "spki", format: "pem" }),
    iv: iv.toString("base64"),
    body: body.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  })
}
function unseal(value: z.infer<typeof Box>, recipient: Secret) {
  const shared = diffieHellman({
    privateKey: createPrivateKey(recipient.encryption),
    publicKey: createPublicKey(value.key),
  })
  const key = Buffer.from(hkdfSync("sha256", shared, JSON.stringify(recipient.public.run), domain, 32))
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"))
  decipher.setAAD(Buffer.from(JSON.stringify(recipient.public)))
  decipher.setAuthTag(Buffer.from(value.tag, "base64"))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.body, "base64")), decipher.final()]).toString())
}
export function encode(secret: Secret, target: PublicPeer, action: string, value: z.core.util.JSONType) {
  equalRun(target.run, secret.public.run)
  const payload = Payload.parse({
    run: secret.public.run,
    nonce: crypto.randomUUID(),
    action,
    value,
  })
  const body = JSON.stringify(seal(payload, target))
  return Envelope.parse({
    body,
    signature: sign(null, Buffer.from(domain + body), secret.signing).toString("base64"),
  })
}
export function decode(secret: Secret, peer: PublicPeer, value: unknown, nonces: Set<string>) {
  const envelope = Envelope.parse(value)
  equalRun(peer.run, secret.public.run)
  if (!verify(null, Buffer.from(domain + envelope.body), peer.signing, Buffer.from(envelope.signature, "base64")))
    throw new Error("Cross-OS control signature did not match its run-bound runner")
  const payload = Payload.parse(unseal(Box.parse(JSON.parse(envelope.body)), secret))
  equalRun(payload.run, secret.public.run)
  if (nonces.has(payload.nonce)) throw new Error("Cross-OS control cannot replay an accepted request")
  if (nonces.size >= 20000) throw new Error("Cross-OS fixture exceeded its finite control budget")
  nonces.add(payload.nonce)
  return payload
}
export async function readControlJSON(message: Request | Response): Promise<unknown> {
  if (!message.body) throw new Error("Cross-OS control requires a JSON body")
  const reader = message.body.getReader()
  const maximum = 1024 * 1024
  let bytes = Buffer.alloc(0),
    size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value.byteLength > maximum - size) throw new Error("Cross-OS control exceeded its bounded JSON body")
      const end = size + next.value.byteLength
      if (end > bytes.byteLength) {
        const grown = Buffer.allocUnsafe(Math.min(maximum, Math.max(end, bytes.byteLength * 2, 4096)))
        grown.set(bytes.subarray(0, size))
        bytes = grown
      }
      bytes.set(next.value, size)
      size = end
    }
    return JSON.parse(bytes.toString("utf8", 0, size))
  } catch (error) {
    try {
      await reader.cancel(error)
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Cross-OS control parsing and body cancellation failed")
    }
    throw error
  } finally {
    reader.releaseLock()
  }
}

export async function exchange(
  secret: Secret,
  peer: PublicPeer,
  origin: string,
  action: string,
  value: z.core.util.JSONType,
  nonces: Set<string>,
) {
  const response = await fetch(origin + "/__cross-os-control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encode(secret, peer, action, value)),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error("The signed cross-OS test control returned HTTP " + response.status)
  const answer = decode(secret, peer, await readControlJSON(response), nonces)
  if (answer.action !== action) throw new Error("Cross-OS response belongs to another control action")
  return answer.value
}

async function github(url: string) {
  if (!url.startsWith("https://api.github.com/")) throw new Error("Artifact discovery requires the GitHub API")
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error("Cross-OS artifact discovery requires this workflow's read-only token")
  const response = await fetch(url, {
    headers: {
      authorization: "Bearer " + token,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error("Run-bound GitHub artifact query failed with HTTP " + response.status)
  return response
}
const Artifact = z.object({
  id: z.number().int(),
  name: z.string(),
  expired: z.boolean(),
  size_in_bytes: z.number(),
  digest: z.string(),
  workflow_run: z.object({ id: z.number(), head_sha: hash }),
})
export function artifactName(role: PublicPeer["role"], bootstrap = false) {
  const current = run()
  return `cross-os-${role}-${bootstrap ? "bootstrap" : "public"}-${current.id}-${current.attempt}`
}
// Provenance: https://github.com/actions/upload-artifact/blob/v4/README.md#improvements — finalized public-key artifacts are available before either live peer job exits.
export async function waitArtifact(role: PublicPeer["role"], bootstrap = false) {
  const current = run(),
    name = artifactName(role, bootstrap),
    deadline = Date.now() + 120000
  const directory = path.join(state(), "rendezvous")
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  while (Date.now() < deadline) {
    const listing = z
      .object({ artifacts: z.array(Artifact) })
      .parse(
        await (
          await github(
            `https://api.github.com/repos/${current.repository}/actions/runs/${current.id}/artifacts?per_page=100&name=${name}`,
          )
        ).json(),
      )
    const found = listing.artifacts.filter((item) => item.name === name)
    if (found.length > 1) throw new Error("Run-bound cross-OS artifact name is ambiguous")
    if (!found.length) {
      await Bun.sleep(250)
      continue
    }
    const artifact = found[0]!
    if (
      artifact.expired ||
      artifact.size_in_bytes > 65536 ||
      artifact.workflow_run.id !== Number(current.id) ||
      artifact.workflow_run.head_sha !== current.sha
    )
      throw new Error("Cross-OS artifact has another producing run/head")
    const bytes = new Uint8Array(
      await (
        await github(`https://api.github.com/repos/${current.repository}/actions/artifacts/${artifact.id}/zip`)
      ).arrayBuffer(),
    )
    if ("sha256:" + createHash("sha256").update(bytes).digest("hex") !== artifact.digest)
      throw new Error("Cross-OS public artifact digest changed")
    const filename = path.join(directory, name + ".zip")
    await fs.writeFile(filename, bytes, { mode: 0o600, flag: "wx" })
    const wanted = bootstrap ? "bootstrap.json" : "public.json"
    const listingProcess = Bun.spawn(["unzip", "-Z1", filename], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const names = (await new Response(listingProcess.stdout).text()).trim().split("\n")
    if ((await listingProcess.exited) || JSON.stringify(names) !== JSON.stringify([wanted]))
      throw new Error("Cross-OS public artifact contains unexpected files")
    const read = Bun.spawn(["unzip", "-p", filename, wanted], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = await new Response(read.stdout).text()
    if ((await read.exited) || text.length > 32768) throw new Error("Cross-OS public metadata is unavailable")
    const value = (bootstrap ? Bootstrap : PublicPeer).parse(JSON.parse(text))
    equalRun(value.run)
    if (value.role !== role) throw new Error("The actual peer role differs from its public artifact")
    return value
  }
  throw new Error("Cross-OS infrastructure rendezvous did not produce the peer's public artifact within 120 seconds")
}
export async function verifyNativeRun() {
  const id = process.env.SYNERGY_CROSS_OS_NATIVE_RUN
  if (!id || !/^\d+$/.test(id)) throw new Error("An exact-head Native Assets run is required")
  const current = run()
  const value = z
    .object({
      id: z.number(),
      head_sha: hash,
      conclusion: z.literal("success"),
      path: z.literal(".github/workflows/build-helpers.yml"),
    })
    .parse(await (await github(`https://api.github.com/repos/${current.repository}/actions/runs/${id}`)).json())
  if (value.id !== Number(id) || value.head_sha !== current.sha)
    throw new Error("Native Assets must have succeeded at this exact cross-OS checkout head")
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command === "identity") await prepareIdentity(z.enum(["darwin", "linux"]).parse(process.argv[3]))
  else if (command === "native-run") await verifyNativeRun()
  else throw new Error("Unknown cross-OS preparation command")
}
