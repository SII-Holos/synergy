import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { InstructionRegistry } from "@ericsanchezok/synergy-harness/instruction/registry"
import { InstructionEngine } from "@ericsanchezok/synergy-harness/instruction/engine"
import { SkillSourceProfile } from "@ericsanchezok/synergy-harness/instruction/source-profile"
import { SessionContextContributions } from "@ericsanchezok/synergy-harness/session/context-contributions"
import { Skill } from "@ericsanchezok/synergy-local-runtime/skill/skill"
import { skillEntry } from "@ericsanchezok/synergy-local-runtime/skill/register"
import type { RuntimeIdentity } from "./home"
import { denied, withMemberExecution, type MemberExecutionResolution } from "./execution-source"
import {
  syncKnowledgeSelection,
  knowledgeSkills,
  selectedKnowledge,
  knowledgePage,
  type ActiveKnowledge,
  type KnowledgeTransport,
} from "./knowledge"

export function knowledgeTransport(
  resolution: MemberExecutionResolution,
  activatedManifestHash?: string,
): KnowledgeTransport {
  const { source, accepted } = resolution
  const proof = () => source.intake.descriptionProof(accepted.actor)
  let desired: { manifestHash: string; revision: number } | undefined
  return {
    selection: async (query, signal) => {
      const result = activatedManifestHash
        ? await source.resources.activatedKnowledge(
            await proof(),
            { cursor: query?.cursor, manifestHash: activatedManifestHash },
            signal,
          )
        : await source.resources.knowledge(await proof(), query, signal)
      if (!activatedManifestHash)
        desired = { manifestHash: result.selection.manifestHash, revision: result.selection.revision }
      return result
    },
    files: async (reference, query, signal) =>
      source.resources.knowledgeFiles(await proof(), reference, { ...query, activatedManifestHash }, signal),
    content: async (reference, fileID, offset, length, signal) =>
      source.resources.knowledgeContent(
        await proof(),
        reference,
        fileID,
        offset,
        length,
        signal,
        activatedManifestHash,
      ),
    ...(!activatedManifestHash
      ? {
          activate: async (selection: { manifestHash: string; revision: number }, signal?: AbortSignal) =>
            source.resources.activateKnowledge(await proof(), selection, signal),
          retained: (manifestHash: string) => knowledgeTransport(resolution, manifestHash),
          failed: async (signal?: AbortSignal) => {
            if (desired)
              await source.resources.activateKnowledge(await proof(), { ...desired, outcome: "failed" }, signal)
          },
        }
      : {}),
  }
}

export function loadOrganizationKnowledge(identity: RuntimeIdentity, sessionID: string, signal?: AbortSignal) {
  return withMemberExecution(identity, { sessionID, signal }, async (resolution, signal) =>
    syncKnowledgeSelection({
      root: RuntimeContext.current().host.root,
      orgID: identity.orgID,
      projectID: resolution.session.organization!.projectID,
      sessionID,
      sourceSessionID: resolution.accepted.sessionID,
      transport: knowledgeTransport(resolution),
      signal,
    }),
  )
}

async function memberSkillRoots(identity: RuntimeIdentity): Promise<SkillSourceProfile.ResolvedRoot[]> {
  if (!("accountID" in identity)) return []
  const roots: SkillSourceProfile.ResolvedRoot[] = []
  const selected = ScopeContext.tryWorkspace()?.path
  const config = path.join(RuntimeContext.current().host.root, "config")
  for (const [base, scope, scopeRank] of [
    [config, "global", 25],
    ...(selected ? [[selected, "project", 40] as const] : []),
  ] as const) {
    const canonicalBase = await fs.realpath(base).catch(() => undefined)
    if (!canonicalBase) continue
    const definitions = SkillSourceProfile.profiles.flatMap((profile) =>
      profile.roots.flatMap((definition, index) =>
        (scope === "global" ? definition.anchor === "config" : definition.anchor === "ancestor")
          ? [{ profile, definition, rootRank: profile.roots.length - index }]
          : [],
      ),
    )
    for (const { profile, definition, rootRank } of definitions) {
      if (profile.enabled && !profile.enabled()) continue
      const candidate = path.join(canonicalBase, definition.path)
      const canonical = await fs.realpath(candidate).catch(() => undefined)
      if (!canonical) continue
      const escaped = path.relative(canonicalBase, canonical)
      if (!escaped || escaped.startsWith("..") || path.isAbsolute(escaped))
        throw denied("Member Skills cannot escape their selected source root")
      roots.push({
        source: profile.id,
        scope,
        scopeRank,
        sourceRank: profile.sourceRank,
        rootRank,
        path: canonical,
        acceptedEntryNames: [
          ...new Set([...profile.acceptedEntryNames, ...(profile.normalizationShim?.acceptedEntryNames ?? [])]),
        ],
        validation: profile.validation,
        normalizationShim: profile.normalizationShim,
      })
    }
  }
  return roots
}

export function registerOrganizationKnowledge(
  identity: RuntimeIdentity,
  options: {
    load?: (sessionID: string, signal?: AbortSignal) => Promise<ActiveKnowledge>
  } = {},
) {
  const load = options.load ?? ((sessionID, signal) => loadOrganizationKnowledge(identity, sessionID, signal))
  const original = InstructionRegistry.get("skill")
  async function catalog(sessionID?: string, signal?: AbortSignal) {
    const active = sessionID ? await load(sessionID, signal) : undefined
    const published = active ? await knowledgeSkills(active) : []
    const snapshot = await Skill.snapshot({
      roots: await memberSkillRoots(identity),
      entries: published.map(({ info, release }) => ({
        info,
        rank: [release.scope.kind === "project" ? 30 : 20, 100, 0, release.itemID],
      })),
    })
    const entries = Object.values(snapshot.skills).map((info): InstructionRegistry.Entry => {
      const current = published.find((candidate) => candidate.info === info)
      const entry = skillEntry(info)
      if (!current || !active || !sessionID) return entry
      const reference = {
        itemID: current.release.itemID,
        version: current.release.version,
        manifestHash: current.release.manifestHash,
      }
      const guard = async () => {
        const latest = await load(sessionID, signal)
        const selected = await selectedKnowledge(latest, reference.itemID)
        if (
          latest.orgID !== active.orgID ||
          latest.projectID !== active.projectID ||
          !selected ||
          selected.release.version !== reference.version ||
          selected.release.manifestHash !== reference.manifestHash
        )
          throw denied("Skill version is no longer selected for this Session")
      }
      return {
        ...entry,
        source: "organization",
        scope: current.release.scope.kind,
        directory: `organization://${active.orgID}/${reference.itemID}/v${reference.version}`,
        provenance: reference,
        content: async () => {
          await guard()
          return entry.content()
        },
        references: async () => {
          await guard()
          return entry.references()
        },
        reference: async (name) => {
          await guard()
          return entry.reference(name)
        },
      }
    })
    return { entries, diagnostics: snapshot.diagnostics, active }
  }
  InstructionRegistry.register({
    kind: "skill",
    render:
      original?.render ?? (async (input) => InstructionEngine.render(input, { appendArgsWhenNoPlaceholder: true })),
    hints: original?.hints ?? (() => ["$ARGUMENTS", "$ARGUMENTS[N]", "$N (one-based)"]),
    entries: async (query) => (await catalog(query?.sessionID)).entries,
    entry: async (name, query) => (await catalog(query?.sessionID)).entries.find((entry) => entry.name === name),
    diagnostics: async (query) => (await catalog(query?.sessionID)).diagnostics,
  })
  SessionContextContributions.register("organization-knowledge", {
    refresh: "model",
    async contribute(input) {
      const current = await catalog(input.sessionID, input.signal)
      const active = current.active!
      const visible = await knowledgePage(active, { limit: 25 })
      const skills = current.entries.filter((entry) => entry.model)
      return {
        context: [
          "Current organization knowledge selection (explicit immutable versions):",
          ...(active.updateError ? [active.updateError] : []),
          `${active.selection.releaseCount} immutable releases selected.`,
          ...visible.items.map(
            ({ release }) =>
              `${release.kind}: ${release.title} itemID=${release.itemID} version=${release.version} manifestHash=${release.manifestHash}`,
          ),
          ...(visible.cursor
            ? [
                "This context shows the first release window. Use organization_knowledge list with its returned cursor for all selected releases.",
              ]
            : []),
          "Use organization_knowledge to list files, search selected materials or read a bounded file range. Cite the exact itemID, version and manifestHash.",
          "Available Skills (load through skill):",
          ...skills
            .slice(0, 25)
            .map(
              (entry) =>
                `${entry.name}: ${entry.description.replace(/\s+/g, " ")}${entry.provenance ? ` [v${entry.provenance.version}]` : ""}`,
            ),
          ...(skills.length > 25
            ? [
                "More selected Skills are available through organization_knowledge list; load their exact declared names through skill.",
              ]
            : []),
          ...current.diagnostics
            .filter((entry) => entry.code === "skill.candidate_shadowed")
            .slice(0, 25)
            .map((entry) => entry.message),
        ].join("\n"),
        injection: { organizationKnowledge: active.selection.manifestHash },
      }
    },
  })
}
