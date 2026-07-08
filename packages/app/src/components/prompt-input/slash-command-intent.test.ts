import { describe, expect, test } from "bun:test"
import {
  getPendingLightLoopSlashBlock,
  resolveSlashCommandIntent,
  type SlashBackendCommand,
  type SlashUiCommand,
} from "./slash-command-intent"

const backendCommands: SlashBackendCommand[] = [
  { name: "review", kind: "prompt" },
  { name: "worktree", kind: "action" },
  { name: "theme", kind: "prompt" },
]

const uiCommands: SlashUiCommand[] = [
  { id: "theme.scheme.cycle", title: "Cycle color scheme", slash: "theme" },
  { id: "session.list", title: "Search sessions", slash: "session" },
]

describe("slash command intent", () => {
  test("treats unknown slash text as ordinary text", () => {
    expect(resolveSlashCommandIntent({ text: "/unknown x", backendCommands, uiCommands })).toEqual({ kind: "none" })
  })

  test("resolves backend prompt commands with arguments", () => {
    expect(resolveSlashCommandIntent({ text: "/review uncommitted changes", backendCommands, uiCommands })).toEqual({
      kind: "backend-prompt",
      command: "review",
      arguments: "uncommitted changes",
      label: "review",
    })
  })

  test("resolves backend action commands", () => {
    expect(resolveSlashCommandIntent({ text: "/worktree status", backendCommands, uiCommands })).toEqual({
      kind: "backend-action",
      command: "worktree",
      arguments: "status",
      label: "worktree",
    })
  })

  test("resolves frontend UI commands", () => {
    expect(resolveSlashCommandIntent({ text: "/session", backendCommands, uiCommands })).toEqual({
      kind: "ui",
      command: "session",
      label: "Search sessions",
    })
  })

  test("prefers backend commands over UI commands with the same trigger", () => {
    expect(resolveSlashCommandIntent({ text: "/theme", backendCommands, uiCommands })).toEqual({
      kind: "backend-prompt",
      command: "theme",
      arguments: "",
      label: "theme",
    })
  })

  test("allows ordinary text and backend prompt commands to start pending Light Loop", () => {
    expect(
      getPendingLightLoopSlashBlock(
        resolveSlashCommandIntent({
          text: "implement the task",
          backendCommands,
          uiCommands,
        }),
      ),
    ).toBeUndefined()
    expect(
      getPendingLightLoopSlashBlock(
        resolveSlashCommandIntent({
          text: "/review uncommitted changes",
          backendCommands,
          uiCommands,
        }),
      ),
    ).toBeUndefined()
  })

  test("blocks backend action commands from starting pending Light Loop", () => {
    expect(
      getPendingLightLoopSlashBlock(
        resolveSlashCommandIntent({
          text: "/worktree status",
          backendCommands,
          uiCommands,
        }),
      ),
    ).toEqual({
      title: "Use a task message",
      description: "Light Loop can't start from an action command. Send a task or exit Light Loop.",
    })
  })

  test("blocks UI commands from starting pending Light Loop", () => {
    expect(
      getPendingLightLoopSlashBlock(
        resolveSlashCommandIntent({
          text: "/session",
          backendCommands,
          uiCommands,
        }),
      ),
    ).toEqual({
      title: "Use a task message",
      description: "Light Loop can't start from a UI command. Send a task or exit Light Loop.",
    })
  })
})
