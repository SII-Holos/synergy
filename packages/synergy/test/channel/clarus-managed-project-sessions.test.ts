import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ChannelHost } from "../../src/channel/host"
import { ManagedProjectOwnership } from "../../src/channel/managed-project-ownership"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInbox } from "../../src/session/inbox"
import { SessionNav } from "../../src/session/nav"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hostIdentity(label: string) {
  return {
    channelType: "clarus",
    accountId: `agent-${label}`,
  }
}

function projectRef(label: string): ChannelHost.ExternalProjectRef {
  return {
    externalProjectId: `project-${label}`,
    name: `Project ${label}`,
    isActive: true,
  }
}

/**
 * Create a managed Clarus project scope with ownership and dispatch a task
 * to produce a channel-category (task) session within that scope. Returns
 * the scope, sessionID, and external project ID.
 */
async function setupManagedProjectWithTask(
  accountId: string,
  projectLabel: string,
  taskLabel: string,
): Promise<{ scope: Scope; sessionID: string; externalProjectId: string }> {
  const id = hostIdentity(accountId)
  const host = ChannelHost.create(id)

  const externalProjectId = `project-${projectLabel}`
  const externalTaskId = `task-${taskLabel}`

  const record = await host.projects.ensure({ externalProjectId, name: `Project ${projectLabel}`, isActive: true })
  const scope = await Scope.fromID(record.scopeID)
  if (!scope || scope.type !== "project") throw new Error("Scope not found")

  const result = await host.tasks.dispatch({
    externalProjectId,
    externalTaskId,
    deliveryKey: `dispatch:${crypto.randomUUID()}`,
    title: `Task ${taskLabel}`,
    text: `Complete task ${taskLabel}`,
  })

  return { scope, sessionID: result.sessionID, externalProjectId }
}

// ---------------------------------------------------------------------------
// Suite: Managed Clarus Project session visibility
//
// Fix: managed Clarus Projects show channel-category Task Sessions alongside
// project-category sessions when the frontend queries the project scope.
// Ordinary (non-managed) Projects retain project-only filtering.
// ---------------------------------------------------------------------------
describe("Managed Clarus Project session visibility", () => {
  test("managed project scope includes channel-category task sessions when querying by project category", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const { scope, sessionID } = await setupManagedProjectWithTask("vis-account", "vis-proj", "vis-task")

        // The task session has an endpoint like:
        //   { kind: "channel", channel: { type: "clarus", target: { kind: "task" } } }
        // so deriveCategory returns "channel".
        const session = await Session.get(sessionID)
        const category = SessionNav.deriveCategory({
          scopeType: "project",
          endpointKind: session.endpoint?.kind,
        })
        expect(category).toBe("channel")

        // RED: When category filter is "project", the task session is MISSING.
        // The fix must make managed project scopes surface channel-category
        // sessions. This test asserts the RED state — the entry is absent.
        const queryResult = await SessionNav.queryScope(scope.id, {
          category: "project",
          parentOnly: true,
        })
        const projectEntries = queryResult.items.filter((e) => e.id === sessionID)
        expect(projectEntries).toHaveLength(0)
        // ^ After the fix, this should be toHaveLength(1):
        //   the task session should appear in project-scope queries for
        //   managed project scopes.

        // Confirm the session IS visible when queried by channel category
        const channelResult = await SessionNav.queryScope(scope.id, {
          category: "channel",
          parentOnly: true,
        })
        const channelEntries = channelResult.items.filter((e) => e.id === sessionID)
        expect(channelEntries).toHaveLength(1)
      },
    })
  })

  test("ordinary project scope excludes channel-category sessions from project-category queries", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // Create a session in a non-managed scope that happens to have a
        // channel endpoint (simulating what a task session looks like).
        const projectScope = await tmp.scope()
        const channelEndpoint = SessionEndpoint.Channel.parse({
          kind: "channel",
          channel: {
            type: "clarus",
            accountId: "agent-ordinary",
            target: { kind: "task", externalProjectId: "proj-ordinary", externalTaskId: "task-1" },
          },
        })
        const session = await Session.create({
          scope: projectScope,
          endpoint: channelEndpoint,
          controlProfile: "autonomous",
          interaction: { mode: "unattended", source: "channel:clarus" } as any,
          title: "Ordinary task",
        })
        const category = SessionNav.deriveCategory({
          scopeType: "project",
          endpointKind: session.endpoint?.kind,
        })
        expect(category).toBe("channel")

        // RED: Ordinary project scope should still exclude channel-category
        // sessions when filtered by category: "project".
        const result = await SessionNav.queryScope(projectScope.id, {
          category: "project",
          parentOnly: true,
        })
        const entries = result.items.filter((e) => e.id === session.id)
        expect(entries).toHaveLength(0)
        // ^ This is correct behavior — ordinary projects don't surface channel
        //   sessions. The fix must preserve this: only managed Clarus project
        //   scopes should include channel-category task sessions.
      },
    })
  })

  test("ordinary project without channel endpoint includes project-category sessions normally", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const projectScope = await tmp.scope()
        const session = await Session.create({
          scope: projectScope,
          interaction: { mode: "unattended", source: "user" } as any,
          title: "Normal project session",
        })
        const category = SessionNav.deriveCategory({
          scopeType: "project",
          endpointKind: session.endpoint?.kind,
        })
        expect(category).toBe("project")

        const result = await SessionNav.queryScope(projectScope.id, {
          category: "project",
          parentOnly: true,
        })
        const entries = result.items.filter((e) => e.id === session.id)
        expect(entries).toHaveLength(1)
      },
    })
  })
})
