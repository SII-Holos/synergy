# Decision Record: Explicit member Runtime composition

Status: implemented

## Problem

An enrolled machine identity does not isolate model configuration, instruction discovery or worker startup. Reusing personal bootstrap defaults can bring private sources into an organization Home, while a bridge connection alone cannot authorize Session execution.

## Decision

`openMemberRuntime` validates the prepared Home and enrollment, then uses the shared Agent Runtime bootstrap with explicit features and a Local Runtime component without an execution Environment. It selects no HTTP listener, resident services, Memory, Library, plugins or Desktop capabilities. An exclusive execution source denies work until trusted organization command admission supplies authority.

The host selects an exclusive configuration source, empty provider catalogs, project-only instructions and no filesystem or bundled Skills. Its environment permits executable lookup and locale variables and binds user directories to the member Home. Agent and policy workers receive only public member identity metadata and repeat the source registrations; generic worker startup verifies the persisted Home owner before readiness. Source workers disable automatic dotenv and Bun configuration loading and use their owning Runtime directory.

Local project configuration contributes only instruction discovery limits and fallback filenames. The public Harness project reader selects registered fields from canonical domain files before configuration validation, without expanding references or scanning other sources. This retains project instruction preferences without allowing a local file to choose model credentials or execution policy. File identity, containment and bounded descriptor reads reject unsafe or changing sources, and failures do not fall back to cached personal settings.

SQLite drivers capture the owning host when they open and retain that environment for lazy maintenance readers and reader replacement. PostgreSQL connection variables resolve within the current host; only detached storage utilities use the process environment. SQLite and telemetry source workers also disable Bun's automatic loader inputs. Telemetry ignores callbacks from retired workers before reentering Runtime context, including callbacks delivered after shutdown has disposed that context.

Native supervisors also capture their owning launcher and explicit bootstrap environment, keeping command credentials out of the supervisor. OS and locale variables, Runtime paths and installation pins are selected independently of the command's declared environment. Private working and temporary directories plus replacement environments prevent launchd or parent-process settings from supplying another source. Windows uses an explicit Unicode environment block; source Bun entrypoints disable implicit configuration loading. Detached host tools retain their own process as the selection source.

Project instruction traversal resolves both the Scope root and Workspace path physically before comparing its stopping point. File aliases cannot make an otherwise bounded upward walk pass its root. The registration and bridge APIs retain independent lifecycles and confer no execution authority.

## Alternatives considered

**Clone personal Runtime bootstrap.** This would duplicate storage, process ownership and cleanup while retaining implicit personal source discovery.

**Trust an isolated Home plus a filtered environment object.** Model and instruction discovery have independent sources. Bun startup can also load files after the parent constructs the environment, so source choices and process-loader controls are both required.

**Enable native execution after enrollment.** Enrollment establishes a machine identity. It does not establish command receipts, Session binding epochs or resource grants, so execution remains denied until those owners are present.

## Consequences

Real personal/A/B Runtime tests establish source and storage separation, and real worker processes establish readiness under the selected owner. Project configuration, organization catalogs, published Skills, native execution and Desktop capabilities require explicit owner integration; no private fallback fills an absent organization source. The composition is an internal foundation, not a completed collaboration surface.
