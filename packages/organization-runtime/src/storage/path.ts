import { createHash } from "node:crypto"

export namespace OrganizationIntakePath {
  const root = (orgID: string) => ["organization-command", orgID]
  export const request = (orgID: string, subjectID: string, requestID: string) => [
    ...root(orgID),
    "requests",
    subjectID,
    requestID,
  ]
  export const intake = (orgID: string, runtimeID: string) => [...root(orgID), "runtimes", runtimeID, "intake"]
  const session = (orgID: string, sessionID: string) => [...root(orgID), "sessions", sessionID]
  export const state = (orgID: string, sessionID: string) => [...session(orgID, sessionID), "state"]
  export const control = (orgID: string, sessionID: string) => [...session(orgID, sessionID), "control"]
  export const attempt = (orgID: string, sessionID: string, attemptID: string) => [
    ...session(orgID, sessionID),
    "attempts",
    attemptID,
  ]
  export const skip = (orgID: string, sessionID: string, attemptID: string) => [
    ...session(orgID, sessionID),
    "skips",
    attemptID,
  ]
  export const slot = (orgID: string, sessionID: string, commandSeq: number) => [
    ...session(orgID, sessionID),
    "commands",
    String(commandSeq).padStart(16, "0"),
  ]
  export const sessionRequest = (orgID: string, sessionID: string, subjectID: string, requestID: string) => [
    ...session(orgID, sessionID),
    "requests",
    subjectID,
    requestID,
  ]
  export const release = (orgID: string, subjectID: string, requestID: string) => [
    ...root(orgID),
    "releases",
    createHash("sha256").update(`${subjectID}\0${requestID}`).digest("hex"),
  ]
  export const releases = (orgID: string) => [...root(orgID), "releases"]
}

export namespace OrganizationSyncPath {
  const root = (orgID: string, sessionID: string) => ["organization-sync", orgID, "sessions", sessionID]
  export const state = (orgID: string, sessionID: string) => [...root(orgID, sessionID), "state"]
  export const drafts = (orgID: string, sessionID: string) => [...root(orgID, sessionID), "drafts"]
  export const draft = (orgID: string, sessionID: string, draftID: string) => [...drafts(orgID, sessionID), draftID]
  export const projections = (orgID: string, sessionID: string) => [...root(orgID, sessionID), "projections"]
  export const projection = (orgID: string, sessionID: string, draftID: string) => [
    ...projections(orgID, sessionID),
    draftID,
  ]
  export const attachments = (orgID: string, sessionID: string) => [...root(orgID, sessionID), "attachments"]
  export const attachment = (orgID: string, sessionID: string, attachmentID: string) => [
    ...attachments(orgID, sessionID),
    attachmentID,
  ]
  export const blobs = (orgID: string, sessionID: string) => [...root(orgID, sessionID), "blobs"]
  export const blob = (orgID: string, sessionID: string, blobID: string) => [...blobs(orgID, sessionID), blobID]
  export const batch = (orgID: string, sessionID: string) => [...root(orgID, sessionID), "batch"]
  export const sessions = (orgID: string) => ["organization-sync", orgID, "sessions"]
}
