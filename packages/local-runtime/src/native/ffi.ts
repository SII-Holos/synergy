import { cc, dlopen, FFIType, ptr, type FFIFunction, type Library } from "bun:ffi"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const types = new Map<number | string, string>([
  [FFIType.void, "void"],
  [FFIType.bool, "_Bool"],
  [FFIType.i32, "signed int"],
  [FFIType.u16, "unsigned short"],
  [FFIType.u32, "unsigned int"],
  [FFIType.u64, "unsigned long long"],
  [FFIType.i64, "signed long long"],
  [FFIType.ptr, "void*"],
  ["void", "void"],
  ["bool", "_Bool"],
  ["i32", "signed int"],
  ["int", "signed int"],
  ["u16", "unsigned short"],
  ["u32", "unsigned int"],
  ["u64", "unsigned long long"],
  ["i64", "signed long long"],
  ["ptr", "void*"],
])

export function openNativeLibrary<const Fns extends Record<string, FFIFunction>>(
  filename: string,
  functions: Fns,
): Library<Fns> {
  if (!["0", "false"].includes(process.env.BUN_JSC_useJIT ?? "")) return dlopen(filename, functions)
  // Provenance: https://github.com/oven-sh/bun/issues/28792
  // Bun 1.4's engine FFI requires JavaScript JIT; its bundled C compiler still supports explicit JITless runs.
  const entries = Object.entries(functions)
  if (!entries.length || filename.includes("\0")) throw new Error("Invalid native library binding")
  const loaderSymbols = {
    synergy_ffi_open: { args: ["ptr"], returns: "i32" },
    synergy_ffi_close: { args: [], returns: "void" },
  } as const satisfies Record<string, FFIFunction>
  const symbols: Record<string, FFIFunction> & typeof loaderSymbols = { ...loaderSymbols }
  function type(value: NonNullable<FFIFunction["returns"]>) {
    const result = types.get(value)
    if (!result) throw new Error("Unsupported native binding type")
    return result
  }
  const declarations = entries.map(([name, fn], index) => {
    if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name) || fn.ptr || fn.threadsafe)
      throw new Error("Unsupported native binding definition")
    const result = type(fn.returns ?? "void")
    const args = (fn.args ?? []).map((value, index) => `${type(value)} arg${index}`)
    if ((fn.args ?? []).some((value) => type(value) === "void")) throw new Error("Invalid native argument type")
    const signature = args.join(",") || "void"
    const called = args.map((_value, index) => `arg${index}`).join(",")
    const wrapper = `synergy_ffi_call_${index}`
    symbols[wrapper] = fn
    return `static ${result} (*target_${index})(${signature});
${result} ${wrapper}(${signature}) { ${result === "void" ? "" : "return "}target_${index}(${called}); }`
  })
  const loader =
    process.platform === "win32"
      ? "extern void* LoadLibraryW(const void*); extern void* GetProcAddress(void*,const char*); extern int FreeLibrary(void*);\n#define OPEN(name) LoadLibraryW(name)\n#define SYMBOL(lib,name) GetProcAddress(lib,name)\n#define CLOSE(lib) FreeLibrary(lib)"
      : "extern void* dlopen(const char*,int); extern void* dlsym(void*,const char*); extern int dlclose(void*);\n#define OPEN(name) dlopen(name,2)\n#define SYMBOL(lib,name) dlsym(lib,name)\n#define CLOSE(lib) dlclose(lib)"
  const source = `${loader}
static void* library;
${declarations.join("\n")}
void synergy_ffi_close(void) { if(library) CLOSE(library); library=0; }
int synergy_ffi_open(const char* filename) {
  library=OPEN(filename); if(!library) return -1;
  ${entries.map(([name], index) => `target_${index}=SYMBOL(library,"${name}"); if(!target_${index}) return ${index + 1};`).join("\n")}
  return 0;
}`
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synergy-native-ffi-"))
  let compiled: Library<typeof symbols> | undefined
  try {
    const file = path.join(directory, "bindings.c")
    fs.writeFileSync(file, source, { mode: 0o600 })
    compiled = cc({
      source: file,
      symbols,
      flags: ["-nostdlib"],
      library: process.platform === "win32" ? ["kernel32"] : [],
    })
    const name = Buffer.from(`${filename}\0`, process.platform === "win32" ? "utf16le" : "utf8")
    const code = compiled.symbols.synergy_ffi_open!(ptr(name))
    if (code !== 0)
      throw new Error(code < 0 ? "Cannot open native library" : `Native library is missing ${entries[code - 1]?.[0]}`)
    const library = compiled
    let closed = false
    const result = Object.fromEntries(
      entries.map(([name], index) => [name, library.symbols[`synergy_ffi_call_${index}`]]),
    ) as Library<Fns>["symbols"]
    return {
      symbols: result,
      close() {
        if (closed) return
        closed = true
        library.symbols.synergy_ffi_close!()
        library.close()
      },
    }
  } catch (error) {
    compiled?.symbols.synergy_ffi_close!()
    compiled?.close()
    throw error
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
