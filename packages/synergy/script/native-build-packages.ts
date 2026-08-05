export function nativePlatformPackageNames(dependencies: Record<string, string>): string[] {
  return Object.entries(dependencies)
    .filter(
      ([name]) =>
        name.startsWith("@parcel/watcher-") || name.startsWith("sqlite-vec-") || name.startsWith("@ast-grep/cli-"),
    )
    .map(([name]) => name)
}
