export type RegistryResource<T> = {
  data: T
  unavailable: boolean
}

export async function loadRegistryResource<T>(
  load: () => Promise<T>,
  fallback: T,
  options: { isMissing?: (error: unknown) => boolean } = {},
): Promise<RegistryResource<T>> {
  try {
    return { data: await load(), unavailable: false }
  } catch (error) {
    return { data: fallback, unavailable: !options.isMissing?.(error) }
  }
}
