export function nativeSdkEntry(url: string) {
  // Rust dlopen cannot read ASAR; resolving from the physical SDK also fixes its sibling platform package lookup.
  return url.replace("/app.asar/", "/app.asar.unpacked/")
}
