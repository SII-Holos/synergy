import { randomBytes } from "node:crypto"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ChildProcess } from "node:child_process"
import type { Pointer } from "bun:ffi"

export namespace WindowsProcessJob {
  const PROCESS_TERMINATE = 0x0001
  const PROCESS_SET_QUOTA = 0x0100
  const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
  const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
  const BASIC_LIMIT_FLAGS_OFFSET = 16

  const BOOTSTRAP = [
    "$gate = $env:SYNERGY_WINDOWS_JOB_GATE",
    "while (-not [System.IO.File]::Exists($gate)) { Start-Sleep -Milliseconds 5 }",
    "$configPath = $env:SYNERGY_WINDOWS_JOB_CONFIG",
    "$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json",
    "Remove-Item -LiteralPath $gate,$configPath -Force -ErrorAction SilentlyContinue",
    "Remove-Item Env:SYNERGY_WINDOWS_JOB_GATE -ErrorAction SilentlyContinue",
    "Remove-Item Env:SYNERGY_WINDOWS_JOB_CONFIG -ErrorAction SilentlyContinue",
    "$target = [string]$config.command",
    "$arguments = @($config.args)",
    "& $target @arguments",
    "exit $LASTEXITCODE",
  ].join("; ")

  type Handle = number | Pointer

  export interface Owner {
    terminate(): void
    terminateOrRelease(): void
    release(): void
  }

  export interface Prepared {
    command: string
    args: string[]
    env: Record<string, string>
    activate(child: ChildProcess): Promise<Owner>
    cleanup(): void
  }

  export interface RuntimeForTest {
    createJob(): Handle | null
    configureJob(job: Handle, information: Uint8Array): boolean
    openProcess(pid: number): Handle | null
    assignProcess(job: Handle, process: Handle): boolean
    terminateJob(job: Handle): boolean
    closeHandle(handle: Handle): boolean
    lastError(): number
  }

  let runtimePromise: Promise<RuntimeForTest> | undefined

  export function prepare(input: {
    command: string
    args: string[]
    env: Record<string, string>
  }): Prepared | undefined {
    if (process.platform !== "win32") return
    const token = `${process.pid}-${randomBytes(8).toString("hex")}`
    const gatePath = path.join(tmpdir(), `synergy-process-job-${token}.gate`)
    const configPath = path.join(tmpdir(), `synergy-process-job-${token}.json`)
    writeFileSync(configPath, JSON.stringify({ command: input.command, args: input.args }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    const cleanup = () => {
      for (const target of [gatePath, configPath]) {
        if (!existsSync(target)) continue
        try {
          unlinkSync(target)
        } catch {}
      }
    }
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", BOOTSTRAP],
      env: {
        ...input.env,
        SYNERGY_WINDOWS_JOB_GATE: gatePath,
        SYNERGY_WINDOWS_JOB_CONFIG: configPath,
      },
      activate(child) {
        return activate({
          child,
          cleanup,
          jobRuntime: runtime(),
          openGate: () => Bun.write(gatePath, "ready"),
        })
      },
      cleanup,
    }
  }

  export function activateForTest(input: {
    child: ChildProcess
    jobRuntime: RuntimeForTest | Promise<RuntimeForTest>
    openGate(): Promise<unknown>
    cleanup?(): void
  }): Promise<Owner> {
    return activate({
      ...input,
      cleanup: input.cleanup ?? (() => {}),
    })
  }

  async function activate(input: {
    child: ChildProcess
    cleanup(): void
    jobRuntime: RuntimeForTest | Promise<RuntimeForTest>
    openGate(): Promise<unknown>
  }): Promise<Owner> {
    if (!input.child.pid) {
      input.cleanup()
      throw new Error("Windows process job child did not receive a PID")
    }
    let owner: Owner
    try {
      owner = attach(input.child.pid, await input.jobRuntime)
    } catch (error) {
      try {
        input.child.kill()
      } catch {}
      input.cleanup()
      throw error
    }
    try {
      await input.openGate()
      return owner
    } catch (activationError) {
      try {
        input.child.kill()
      } catch {}
      try {
        owner.terminateOrRelease()
      } catch (cleanupError) {
        try {
          owner.release()
        } catch (releaseError) {
          input.cleanup()
          throw new AggregateError(
            [activationError, cleanupError, releaseError],
            "Windows process job activation and cleanup failed",
          )
        }
      }
      input.cleanup()
      throw activationError
    }
  }

  export function prepareShell(input: { shell: string; command: string; env: Record<string, string> }) {
    const name = path.win32.basename(input.shell).toLowerCase()
    const args =
      name === "cmd" || name === "cmd.exe"
        ? ["/d", "/s", "/c", input.command]
        : name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe"
          ? ["-NoProfile", "-Command", input.command]
          : ["-c", input.command]
    return prepare({ command: input.shell, args, env: input.env })
  }

  export function attachForTest(pid: number, runtime: RuntimeForTest): Owner {
    return attach(pid, runtime)
  }

  function attach(pid: number, runtime: RuntimeForTest): Owner {
    const job = runtime.createJob()
    if (job === null) throw new Error(`CreateJobObjectW failed: ${runtime.lastError()}`)

    let processHandle: Handle | null = null
    try {
      if (!runtime.configureJob(job, killOnCloseInformation())) {
        throw new Error(`SetInformationJobObject failed: ${runtime.lastError()}`)
      }
      processHandle = runtime.openProcess(pid)
      if (processHandle === null) throw new Error(`OpenProcess failed: ${runtime.lastError()}`)
      if (!runtime.assignProcess(job, processHandle)) {
        throw new Error(`AssignProcessToJobObject failed: ${runtime.lastError()}`)
      }
    } catch (error) {
      if (processHandle !== null) runtime.closeHandle(processHandle)
      runtime.closeHandle(job)
      throw error
    }
    runtime.closeHandle(processHandle)

    let released = false
    const release = () => {
      if (released) return
      if (!runtime.closeHandle(job)) {
        throw new Error(`CloseHandle failed: ${runtime.lastError()}`)
      }
      released = true
    }
    const terminate = () => {
      if (released) return
      if (!runtime.terminateJob(job)) {
        throw new Error(`TerminateJobObject failed: ${runtime.lastError()}`)
      }
      release()
    }
    return {
      terminate,
      terminateOrRelease() {
        if (released) return
        try {
          terminate()
        } catch (terminateError) {
          try {
            release()
          } catch {
            throw new Error(`CloseHandle failed after ${(terminateError as Error).message}`)
          }
        }
      },
      release,
    }
  }

  async function runtime(): Promise<RuntimeForTest> {
    if (runtimePromise) return runtimePromise
    runtimePromise = loadRuntime()
    return runtimePromise
  }

  async function loadRuntime(): Promise<RuntimeForTest> {
    const { dlopen, FFIType, ptr } = await import("bun:ffi")
    const library = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
        returns: FFIType.bool,
      },
      OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
      GetLastError: { args: [], returns: FFIType.u32 },
    })
    const symbols = library.symbols
    return {
      createJob: () => symbols.CreateJobObjectW(null, null),
      configureJob: (job, information) =>
        Boolean(
          symbols.SetInformationJobObject(
            job as Pointer,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ptr(information),
            information.byteLength,
          ),
        ),
      openProcess: (pid) => symbols.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid),
      assignProcess: (job, processHandle) =>
        Boolean(symbols.AssignProcessToJobObject(job as Pointer, processHandle as Pointer)),
      terminateJob: (job) => Boolean(symbols.TerminateJobObject(job as Pointer, 1)),
      closeHandle: (handle) => Boolean(symbols.CloseHandle(handle as Pointer)),
      lastError: () => symbols.GetLastError(),
    }
  }

  function killOnCloseInformation() {
    const pointerBytes = process.arch === "ia32" ? 4 : 8
    const basicLimitInformationBytes = pointerBytes === 4 ? 48 : 64
    const ioCountersBytes = 48
    const trailingSizeTBytes = pointerBytes * 4
    const information = new Uint8Array(basicLimitInformationBytes + ioCountersBytes + trailingSizeTBytes)
    new DataView(information.buffer).setUint32(BASIC_LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
    return information
  }
}
