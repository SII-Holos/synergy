export function resolveTaskEnvironment(input: { id?: string | null; profile?: string | null }) {
  if (input.id !== undefined) return { environmentID: input.id, environmentProfile: undefined }
  if (input.profile === null) return { environmentID: null, environmentProfile: undefined }
  return { environmentID: undefined, environmentProfile: input.profile }
}
