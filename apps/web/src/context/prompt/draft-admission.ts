export type DraftAdmission = { fingerprint: string; messageID: string }

export function draftAdmission(
  previous: DraftAdmission | undefined,
  fingerprint: string,
  createID: () => string,
): DraftAdmission {
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, messageID: createID() }
}
