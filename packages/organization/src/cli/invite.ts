import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { cmd } from "@ericsanchezok/synergy-util/cli-command"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { FileRename } from "@ericsanchezok/synergy-local-runtime/file/rename"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import {
  OrganizationIdentity as Identity,
  OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { readOrganizationPrivateFile } from "../private-file"
import { cookie } from "../routes/shared"

const InvitationError = NamedError.create(
  "OrganizationInvitationCommandError",
  z.object({
    message: z.string(),
    outcome: Protocol.Error.shape.outcome,
    code: Protocol.ErrorCode.optional(),
    requestID: z.string().optional(),
    retryable: z.boolean().optional(),
    invitationIssued: z.boolean().optional(),
  }),
)

export const OrganizationInviteCommand = cmd({
  command: "invite",
  describe: "create one invitation over HTTPS and retain its token in a new private file",
  builder: (yargs) =>
    yargs
      .option("origin", { type: "string", demandOption: true, describe: "exact public HTTPS organization origin" })
      .option("login-name", { type: "string", demandOption: true, describe: "current administrator login name" })
      .option("password-file", {
        type: "string",
        demandOption: true,
        describe: "absolute private password file; one final newline is ignored",
      })
      .option("ca-file", { type: "string", describe: "absolute private file containing an additional trusted CA" })
      .option("role", {
        choices: ["member", "admin"] as const,
        default: "member" as const,
        describe: "role granted when the invitation is consumed",
      })
      .option("output", {
        type: "string",
        demandOption: true,
        describe: "absolute new private token file; existing files are never reused",
      })
      .check((args) => {
        const origin = new URL(args.origin)
        if (origin.protocol !== "https:" || origin.origin !== args.origin)
          throw new Error("Organization origin must be an exact HTTPS origin")
        Identity.Login.shape.loginName.parse(args["login-name"])
        for (const file of [args["password-file"], args["ca-file"], args.output])
          if (file && !path.isAbsolute(file)) throw new Error("Invitation file paths must be absolute")
        return true
      }),
  async handler(args) {
    const { origin, output, role } = args
    const loginName = args["login-name"]
    const passwordFile = args["password-file"]
    const caFile = args["ca-file"]
    const temporary = path.join(path.dirname(output), ".synergy-invitation-" + crypto.randomUUID())
    let published = false
    const raw = await readOrganizationPrivateFile(passwordFile)
    const password = raw.replace(/\r?\n$/, "")
    const input = Identity.Login.parse({ loginName: loginName, password })
    const ca = caFile ? await readOrganizationPrivateFile(caFile) : undefined
    const file = await fs.open(temporary, "wx", 0o600).catch(() => {
      throw new InvitationError({ message: "Invitation output must be a new writable file", outcome: "not_dispatched" })
    })
    const initial = await file.stat()
    const startedAt = Date.now()
    const client = createOrganizationClient({
      baseUrl: origin,
      headers: { origin: origin },
      fetch: Object.assign(
        (request: Request | string | URL, init?: RequestInit) =>
          fetch(request, { ...init, redirect: "error", ...(ca ? { tls: { ca } } : {}) }),
        { preconnect: fetch.preconnect },
      ),
    })
    let credentials: { origin: string; cookie: string; "x-csrf-token": string } | undefined
    let dispatched = false
    let result: z.infer<typeof Identity.TokenResult> | undefined
    let loginRevoked = false
    async function assertOutput() {
      const [actual, retained] = await Promise.all([file.stat(), fs.lstat(published ? output : temporary)])
      if (
        !actual.isFile() ||
        !retained.isFile() ||
        retained.isSymbolicLink() ||
        actual.ino !== initial.ino ||
        actual.dev !== initial.dev ||
        retained.ino !== initial.ino ||
        retained.dev !== initial.dev ||
        (process.platform !== "win32" && ((actual.mode | retained.mode) & 0o077) !== 0)
      )
        throw new Error("Invitation output is no longer the original private file")
    }
    async function save(value: unknown) {
      await assertOutput()
      const bytes = Buffer.from(JSON.stringify(value) + "\n")
      let offset = 0
      while (offset < bytes.byteLength) {
        const write = await file.write(bytes, offset, bytes.byteLength - offset, offset)
        if (!write.bytesWritten) throw new Error("Invitation output write made no progress")
        offset += write.bytesWritten
      }
      await file.truncate(bytes.byteLength)
      await file.sync()
      await assertOutput()
    }
    try {
      await save({ version: 1, state: "preparing", role, startedAt })
      FileRename.exclusive(temporary, output)
      published = true
      await AtomicFile.syncDirectories(path.dirname(output))
      await assertOutput()
      const login = await client.orgAuth.login(
        { orgLoginInput: input },
        { throwOnError: true, signal: AbortSignal.timeout(15_000) },
      )
      const session = login.response.headers
        .getSetCookie()
        .find((value) => value.startsWith(cookie + "="))
        ?.split(";")[0]
      if (!session) throw new Error("Organization login returned no session")
      credentials = { origin: origin, cookie: session, "x-csrf-token": login.data.csrfToken }
      dispatched = true
      const issued = await client.orgInvites.create(
        { orgInviteCreate: { role: role } },
        { throwOnError: true, headers: credentials, signal: AbortSignal.timeout(15_000) },
      )
      result = Identity.TokenResult.parse(issued.data)
      await save({ version: 1, state: "complete", origin, role, ...result })
    } catch (error) {
      const reported = Protocol.Error.safeParse(error)
      const outcome = reported.success ? reported.data.outcome : dispatched ? "unknown" : "not_dispatched"
      if (!result)
        await save({
          version: 1,
          state: outcome === "unknown" ? "unknown" : "failed",
          outcome,
          role: role,
          startedAt,
        }).catch(() => {})
      throw new InvitationError({
        message: result
          ? "Invitation was issued but its private output is unavailable; inspect before issuing another"
          : outcome === "unknown"
            ? "Invitation outcome requires inspection; the saved output is retained and no request was retried"
            : "Invitation was not issued; check current authorization, credentials and HTTPS trust",
        outcome,
        ...(result ? { invitationIssued: true } : {}),
        ...(reported.success
          ? { code: reported.data.code, requestID: reported.data.requestID, retryable: reported.data.retryable }
          : {}),
      })
    } finally {
      try {
        if (credentials) {
          loginRevoked = await client.orgAuth
            .logout(
              { orgEmptyInput: {} },
              { throwOnError: true, headers: credentials, signal: AbortSignal.timeout(3_000) },
            )
            .then(
              () => true,
              () => false,
            )
        }
      } finally {
        await file.close()
        if (!published) await fs.rm(temporary, { force: true })
      }
    }
    console.log(
      JSON.stringify({ created: true, role: role, expiresAt: result.expiresAt, output: output, loginRevoked }),
    )
  },
})
