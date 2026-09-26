# Decision Record: Isolate standalone Plugin Kit compilation

Status: implemented

## Problem

Plugin Kit tests compile standalone executables after exercising plugin builds in the same Bun process. On Linux with Bun 1.3.14, that sequence can fail while reading Babel and Solid dependencies even though standalone compilation succeeds in a fresh process. The combined suite must validate the executable without depending on compiler state retained by unrelated builds.

## Decision

The standalone dependency and compiled CLI tests invoke `bun build --compile` through a fresh child process using the running Bun executable. Each test drains stdout and stderr and checks compilation success before executing the generated artifact. The tests retain Solid rendering compilation, generated declaration, and scoped CSS assertions.

## Alternatives considered

**Repeat the in-process build.** A retry retains the same process state and makes acceptance depend on execution order. A fresh compiler process matches ordinary standalone CLI compilation.

**Remove compiled artifact checks.** Source-only checks cannot detect missing dependencies in standalone executables. The artifact assertions remain required.

## Consequences

Each standalone fixture starts an additional Bun process. Compilation diagnostics identify a failed compiler invocation separately from a failed generated executable. Child compilation does not add parent-process coverage; direct source behavior suites continue to measure Plugin Kit logic, and the complete package coverage suite remains required.
