import path from "path"
import z from "zod"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Agent } from "../agent/agent"
import { ScopeContext } from "../scope/context"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { SessionManager } from "./manager"
import { Shell } from "../util/shell"
import { lastModel } from "./input"
import { SessionUserMessageMaterialization } from "./user-message-materialization"
import { ChildProcessClose } from "../process/child-process-close"
import { WindowsProcessJob } from "../process/windows-process-job"

function deriveShellAbortReason(reason: unknown): string {
  if (reason instanceof DOMException) {
    if (reason.name === "TimeoutError") return "The command was interrupted: tool execution timed out."
    if (typeof reason.message === "string" && reason.message.includes("Assistant step timed out")) {
      return "The command was interrupted: assistant step timed out."
    }
    return "The command was interrupted: " + (reason.message || reason.name)
  }
  if (typeof reason === "string" && reason.length > 0) return "The command was interrupted: " + reason
  return "The command was interrupted."
}

export const ShellInput = z.object({
  sessionID: Identifier.schema("session"),
  agent: z.string(),
  model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional(),
  command: z.string(),
})
export type ShellInput = z.infer<typeof ShellInput>

export async function shell(input: ShellInput) {
  return SessionManager.run(input.sessionID, (lease) => shellInSession(input, lease))
}

async function shellInSession(input: ShellInput, lease: SessionManager.LoopLease) {
  const directory = ScopeContext.current.directory
  const abort = lease.signal

  const agent = await Agent.get(input.agent)
  const model = input.model ?? (await Agent.getAvailableModel(agent)) ?? (await lastModel(input.sessionID))
  const userMsgID = Identifier.ascending("message")
  const userMsg: MessageV2.User = {
    id: userMsgID,
    sessionID: input.sessionID,
    time: {
      created: Date.now(),
    },
    role: "user",
    agent: input.agent,
    model: {
      providerID: model.providerID,
      modelID: model.modelID,
    },
    origin: { type: "user" },
    isRoot: true,
    rootID: userMsgID,
    visible: true,
  }
  const userPart: MessageV2.Part = {
    type: "text",
    id: Identifier.ascending("part"),
    messageID: userMsg.id,
    sessionID: input.sessionID,
    text: "The following tool was executed by the user",
    synthetic: true,
    origin: "system",
  }
  await SessionUserMessageMaterialization.write({ info: userMsg, parts: [userPart] })

  const msg: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    parentID: userMsg.id,
    rootID: userMsg.id,
    visible: true,
    mode: input.agent,
    agent: input.agent,
    cost: 0,
    path: {
      cwd: directory,
      root: directory,
    },
    time: {
      created: Date.now(),
    },
    role: "assistant",
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: model.modelID,
    providerID: model.providerID,
  }
  await Session.updateMessage(msg)
  const part: MessageV2.Part = {
    type: "tool",
    id: Identifier.ascending("part"),
    messageID: msg.id,
    sessionID: input.sessionID,
    tool: "bash",
    callID: ulid(),
    state: {
      status: "running",
      time: {
        start: Date.now(),
      },
      input: {
        command: input.command,
      },
    },
  }
  await Session.updatePart(part)
  const sh = Shell.preferred()
  const shellName = (process.platform === "win32" ? path.win32.basename(sh, ".exe") : path.basename(sh)).toLowerCase()

  const invocations: Record<string, { args: string[] }> = {
    nu: {
      args: ["-c", input.command],
    },
    fish: {
      args: ["-c", input.command],
    },
    zsh: {
      args: [
        "-c",
        "-l",
        `
          [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
          [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
          eval ${JSON.stringify(input.command)}
        `,
      ],
    },
    bash: {
      args: [
        "-c",
        "-l",
        `
          shopt -s expand_aliases
          [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
          eval ${JSON.stringify(input.command)}
        `,
      ],
    },
    // Windows cmd
    cmd: {
      args: ["/c", input.command],
    },
    // Windows PowerShell
    powershell: {
      args: ["-NoProfile", "-Command", input.command],
    },
    pwsh: {
      args: ["-NoProfile", "-Command", input.command],
    },
    // Fallback: any shell that doesn't match those above
    //  - No -l, for max compatibility
    "": {
      args: ["-c", `${input.command}`],
    },
  }

  const matchingInvocation = invocations[shellName] ?? invocations[""]
  const args = matchingInvocation?.args

  const processEnv = {
    ...process.env,
    TERM: "dumb",
  }
  const windowsProcessJob = WindowsProcessJob.prepare({ command: sh, args, env: processEnv })
  let proc: ReturnType<typeof spawn>
  let windowsProcessOwner: WindowsProcessJob.Owner | undefined
  try {
    proc = spawn(windowsProcessJob?.command ?? sh, windowsProcessJob?.args ?? args, {
      cwd: ScopeContext.current.directory,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: windowsProcessJob?.env ?? processEnv,
    })
    if (windowsProcessJob) windowsProcessOwner = await windowsProcessJob.activate(proc)
  } catch (error) {
    windowsProcessJob?.cleanup()
    throw error
  }

  let output = ""

  const appendOutput = (chunk: Buffer) => {
    output += chunk.toString()
    if (part.state.status === "running") {
      part.state.metadata = {
        ...part.state.metadata,
        output: output,
        description: "",
      }
      Session.updatePart(part)
    }
  }

  proc.stdout?.on("data", appendOutput)
  proc.stderr?.on("data", appendOutput)

  let aborted = false
  const terminate = async (allowExitedParent = false) => {
    if (windowsProcessOwner) {
      try {
        windowsProcessOwner.terminate()
      } catch {
        windowsProcessOwner.release()
      }
      windowsProcessOwner = undefined
      return
    }
    await Shell.killTree(proc, { exited: () => exited, allowExitedParent })
  }
  let exited = false
  const closed = ChildProcessClose.wait(proc, {
    onExit() {
      exited = true
    },
    onDrainTimeout() {
      return terminate(true)
    },
  })

  const kill = () => terminate()

  if (abort.aborted) {
    aborted = true
    await kill()
  }

  const abortHandler = () => {
    aborted = true
    void kill()
  }

  abort.addEventListener("abort", abortHandler, { once: true })

  try {
    await closed
  } finally {
    abort.removeEventListener("abort", abortHandler)
    proc.stdout?.off("data", appendOutput)
    proc.stderr?.off("data", appendOutput)
    windowsProcessOwner?.release()
    windowsProcessOwner = undefined
    windowsProcessJob?.cleanup()
  }

  if (aborted) {
    output += "\n\n" + ["<metadata>", deriveShellAbortReason(abort.reason), "</metadata>"].join("\n")
  }
  msg.time.completed = Date.now()
  msg.finish = "stop"
  await Session.updateMessage(msg)
  if (part.state.status === "running") {
    part.state = {
      status: "completed",
      time: {
        ...part.state.time,
        end: Date.now(),
      },
      input: part.state.input,
      title: "",
      metadata: {
        ...part.state.metadata,
        output,
        description: "",
      },
      output,
    }
    await Session.updatePart(part)
  }
  return { info: msg, parts: [part] }
}
