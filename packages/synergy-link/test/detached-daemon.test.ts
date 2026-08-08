import { describe, expect, test } from "bun:test"
import { detectDetachedDaemonRisk, detachedDaemonBlockMessage } from "../src/exec/detached-daemon"

describe("detectDetachedDaemonRisk", () => {
  test("blocks Windows launchers that can outlive the tracked shell", () => {
    const commands = [
      ['start "" /b long-running.exe', "windows_cmd_start"],
      ["START /MIN long-running.exe", "windows_cmd_start"],
      ['cmd.exe /d /s /c "start \"\" /b long-running.exe"', "windows_cmd_start"],
      ['cmd /k "start \"\" /b long-running.exe"', "windows_cmd_start"],
      ['st^art "" /b long-running.exe', "windows_dynamic_command"],
      ['cmd /c "st^art \"\" /b long-running.exe"', "windows_dynamic_command"],
      ['if 1==1 start "" /b long-running.exe', "windows_cmd_start"],
      ['cmd /c "if 1==1 start \"\" /b long-running.exe"', "windows_cmd_start"],
      ["if 1==2 (echo hi) else start /b long-running.exe", "windows_cmd_start"],
      ["if 1==1 (echo hi) else (start /b long-running.exe)", "windows_cmd_start"],
      ['cmd /c "call start \"\" /b long-running.exe"', "windows_cmd_start"],
      ["cmd /c cmd /c cmd /c cmd /c cmd /c cmd /c start /b long-running.exe", "windows_cmd_start"],
      ['cmd /c "for %i in (1) do start \"\" /b long-running.exe"', "windows_cmd_start"],
      [`for /f "delims=" %i in ('start "" /b long-running.exe') do echo hi`, "windows_cmd_start"],
      ['for /f "usebackq" %i in (`start /b long-running.exe`) do echo hi', "windows_cmd_start"],
      ["for %i in (start) do %i /b long-running.exe", "windows_dynamic_command"],
      ["for %i in (a;b;c) do start /b long-running.exe", "windows_cmd_start"],
      ['powershell -NoProfile -Command "Start-Process long-running.exe"', "powershell_start_process"],
      ["pwsh -Command 'Start-Process long-running.exe -WindowStyle Hidden'", "powershell_start_process"],
      ['powershell -Command "start long-running.exe"', "powershell_start_process"],
      ['pwsh -c "saps long-running.exe"', "powershell_start_process"],
      ['powershell -Command "cmd /c start \"\" /b long-running.exe"', "windows_cmd_start"],
      [`cmd /c "powershell -Command 'Start-Process long-running.exe'"`, "powershell_start_process"],
      ['pwsh -Command "& { Start-Process long-running.exe }"', "powershell_start_process"],
      ['powershell -Com "Start-Process long-running.exe"', "powershell_start_process"],
      [
        "powershell -EncodedCommand UwB0AGEAcgB0AC0AUAByAG8AYwBlAHMAcwAgAGwAbwBuAGcALQByAHUAbgBuAGkAbgBnAC4AZQB4AGUA",
        "powershell_encoded_command",
      ],
      [
        "pwsh -Enc UwB0AGEAcgB0AC0AUAByAG8AYwBlAHMAcwAgAGwAbwBuAGcALQByAHUAbgBuAGkAbgBnAC4AZQB4AGUA",
        "powershell_encoded_command",
      ],
      [String.raw`powershell -File C:\scripts\run.ps1`, "powershell_dynamic_command"],
      ["pwsh -F run.ps1", "powershell_dynamic_command"],
      [String.raw`powershell .\run.ps1`, "powershell_dynamic_command"],
      ["pwsh script.ps1 -Arg 1", "powershell_dynamic_command"],
      ["cmd /c setup.bat", "windows_dynamic_command"],
      ["call setup.cmd", "windows_dynamic_command"],
      [`powershell -Command "[System.Diagnostics.Process]::Start('long-running.exe')"`, "powershell_dynamic_command"],
      [`powershell -Command "iex 'Start-Process long-running.exe'"`, "powershell_dynamic_command"],
      [`powershell -Command "$p='start'; & $p long-running.exe"`, "powershell_dynamic_command"],
      [`powershell -Command "$t=[Diagnostics.Process]; $t::Start('long-running.exe')"`, "powershell_dynamic_command"],
      [`powershell -Command "& $env:ComSpec /c start /b long-running.exe"`, "powershell_dynamic_command"],
      [`powershell -Command "$p = 'start'; & $p long-running.exe"`, "powershell_dynamic_command"],
      [`${"cmd /c ".repeat(65)}echo ok`, "windows_command_too_complex"],
      ["x".repeat(32_768), "windows_command_too_complex"],
    ] as const

    for (const [command, expectedKind] of commands) {
      expect(detectDetachedDaemonRisk(command, "win32")?.kind).toBe(expectedKind)
    }
  })

  test("blocks extensionless commands that resolve to opaque cmd scripts", () => {
    const files = new Set([
      "c:\\work\\setup.cmd",
      "c:\\work\\setup.v1.cmd",
      "c:\\work\\shim.exe.cmd",
      "c:\\work\\echo.cmd",
      "c:\\bin\\build.bat",
      "c:\\bin\\node.exe",
      "c:\\bin\\node.cmd",
      "c:\\tools\\deploy.cmd",
      "c:\\windows\\system32\\system-setup.cmd",
      "c:\\next\\local.cmd",
      "c:\\path-next\\path-local.cmd",
      "c:\\scripts\\wrapped.cmd",
    ])
    const windowsResolution = {
      workdir: "C:\\work",
      env: {
        Path: "%SystemRoot%\\System32;C:\\bin;C:\\tools",
        PATHEXT: ".EXE;.CMD;.BAT",
        SystemRoot: "C:\\Windows",
      },
      isFile: (candidate: string) => files.has(candidate.toLowerCase()),
    }

    expect(detectDetachedDaemonRisk("setup --quiet", "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
    expect(detectDetachedDaemonRisk("build", "win32", { windowsResolution })?.kind).toBe("windows_dynamic_command")
    expect(detectDetachedDaemonRisk("node script.js", "win32", { windowsResolution })).toBeUndefined()
    expect(detectDetachedDaemonRisk("echo ok", "win32", { windowsResolution })).toBeUndefined()
    expect(detectDetachedDaemonRisk(String.raw`C:\tools\deploy --quiet`, "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
    expect(detectDetachedDaemonRisk("missing", "win32", { windowsResolution })).toBeUndefined()
    expect(detectDetachedDaemonRisk("setup.v1 --quiet", "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
    expect(detectDetachedDaemonRisk("shim.exe --quiet", "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
    expect(detectDetachedDaemonRisk("setup. --quiet", "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
    expect(detectDetachedDaemonRisk("system-setup", "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
    expect(detectDetachedDaemonRisk(String.raw`cd /d C:\next && local`, "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
    expect(
      detectDetachedDaemonRisk(String.raw`set PATH=C:\path-next && path-local`, "win32", { windowsResolution })?.kind,
    ).toBe("windows_dynamic_command")
    expect(detectDetachedDaemonRisk("call setup.txt", "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
    expect(
      detectDetachedDaemonRisk(String.raw`if exist marker (cd /d C:\scripts) && wrapped`, "win32", {
        windowsResolution,
      })?.kind,
    ).toBe("windows_dynamic_command")
    expect(
      detectDetachedDaemonRisk(String.raw`for %i in (1) do cd /d C:\scripts && wrapped`, "win32", {
        windowsResolution,
      })?.kind,
    ).toBe("windows_dynamic_command")
    expect(
      detectDetachedDaemonRisk(String.raw`(cd /d C:\scripts) && wrapped`, "win32", { windowsResolution })?.kind,
    ).toBe("windows_dynamic_command")
    expect(detectDetachedDaemonRisk("call :label && wrapped", "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
    expect(detectDetachedDaemonRisk("goto :skip && wrapped", "win32", { windowsResolution })?.kind).toBe(
      "windows_dynamic_command",
    )
  })

  test("bounds and caches Windows command resolution probes", () => {
    let repeatedProbeCount = 0
    const windowsResolution = {
      workdir: "C:\\work",
      env: {
        Path: "C:\\bin;C:\\tools",
        PATHEXT: ".EXE;.CMD;.BAT",
      },
      isFile: () => {
        repeatedProbeCount += 1
        return false
      },
    }

    expect(detectDetachedDaemonRisk("missing && missing", "win32", { windowsResolution })).toBeUndefined()
    expect(repeatedProbeCount).toBe(9)

    let boundedProbeCount = 0
    const boundedResolution = {
      ...windowsResolution,
      isFile: () => {
        boundedProbeCount += 1
        return false
      },
    }
    const command = Array.from({ length: 30 }, (_, index) => `missing${index}`).join(" && ")

    expect(detectDetachedDaemonRisk(command, "win32", { windowsResolution: boundedResolution })?.kind).toBe(
      "windows_command_too_complex",
    )
    expect(boundedProbeCount).toBe(256)
  })

  test("explains why Windows detached launchers are rejected", () => {
    const risk = detectDetachedDaemonRisk('start "" /b long-running.exe', "win32")
    if (!risk) throw new Error("Expected a Windows detached launcher risk")

    expect(detachedDaemonBlockMessage(risk)).toContain(
      "Windows Synergy Link cannot safely recover detached descendants after their launcher exits.",
    )
  })

  test("explains bounded Windows command inspection", () => {
    const risk = detectDetachedDaemonRisk("x".repeat(32_768), "win32")
    if (!risk) throw new Error("Expected a Windows command inspection risk")

    expect(detachedDaemonBlockMessage(risk)).toContain(
      "Windows Synergy Link inspects at most 16 KiB per command, 64 nested shell bodies, 128 KiB cumulatively, and 256 filesystem probes.",
    )
  })

  test("allows benign Windows output that only mentions detached launchers", () => {
    const commands = [
      'echo "start /b and Start-Process"',
      'cmd /c "echo start /b long-running.exe"',
      "powershell -NoProfile -Command \"Write-Output 'Start-Process'\"",
      'cmd /c "if 1==1 echo start /b long-running.exe"',
      'cmd /c "call echo start /b long-running.exe"',
      'cmd /c "for %i in (1) do echo start /b long-running.exe"',
      'cmd /c "echo (start)"',
      "powershell -NoProfile -Command \"Get-Date; ('start')\"",
      "if 1==1 (echo start) else echo ok",
      'cmd /c "echo a; echo b"',
      `for /f "delims=" %i in ('echo start') do echo hi`,
      `for /f "usebackq" %i in ('echo start') do echo hi`,
      'for /f "usebackq" %i in ("C:\\input file.txt") do echo start',
      "for /f %i in (`echo start`) do echo hi",
      "npm start",
      "net start",
      "sc start",
      'powershell -Command "Get-Process start*"',
      `powershell -Command "$name='start'; Write-Output $name"`,
      'powershell -Command "$env:Path"',
      "powershell -Command \"$env:Path = 'C:\\tools'\"",
      'powershell -Command "$x = 1"',
      `powershell -Command "$ErrorActionPreference = 'Stop'"`,
      'powershell -Command "$env:PORT = 8080"',
      'powershell -Command "for ($i = 0; $i -lt 5; $i++) { Write-Output $i }"',
      "node script.js",
    ]

    for (const command of commands) {
      expect(detectDetachedDaemonRisk(command, "win32")).toBeUndefined()
    }
  })
  test("allows POSIX detached daemon launch patterns on non-Windows platforms", () => {
    const commands = [
      "tmux new-session -d -s link-test",
      "screen -dmS link-test sleep 30",
      "nohup sleep 30",
      "setsid sleep 30",
      "sleep 30; disown",
      "daemonize sleep 30",
      "sleep 30 &",
      'start "" /b long-running.exe',
      "powershell -EncodedCommand ZQBjAGgAbwAgAG8AawA=",
    ]

    for (const command of commands) {
      expect(detectDetachedDaemonRisk(command, "linux")).toBeUndefined()
      expect(detectDetachedDaemonRisk(command, "darwin")).toBeUndefined()
    }
  })

  test("keeps the Windows-only guard on Windows while POSIX patterns pass", () => {
    expect(detectDetachedDaemonRisk('start "" /b long-running.exe', "win32")?.kind).toBe("windows_cmd_start")
    expect(detectDetachedDaemonRisk("nohup sleep 30", "win32")).toBeUndefined()
    expect(detectDetachedDaemonRisk("setsid sleep 30", "win32")).toBeUndefined()
    expect(detectDetachedDaemonRisk("sleep 30 &", "win32")).toBeUndefined()
  })
})
