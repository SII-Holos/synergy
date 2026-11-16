# Cloud catalog routes forwarded resource selectors into strict pages

## Executive summary

Workspace and Environment catalog queries contained a required `resourceID` alongside `limit` and `cursor`. Each HTTP validator accepted that complete query, but its handler forwarded the same object to a domain reader whose page schema accepts only `limit` and `cursor`. Strict domain parsing rejected the extra selector, so valid catalog reads returned HTTP 400 before current resource lookup.

## Summary

The defect was encountered while checking a restored cloud resource catalog. An initial limit of 128 exceeded the existing maximum of 100 and is not evidence of this defect. A subsequent legal catalog query was still rejected. Static tracing identified the same projection error in both original list routes. Direct domain catalog controls had not exercised the HTTP handler.

## Timeline

- The standalone regression called both original generated list methods with a legal limit of 1. Their actual request paths, resource selectors and numeric query serialization matched the intended original route, and the real provider allocation counter remained zero.
- Both catalog cases then received HTTP 400 where 200 was required. The original focused run failed both cases after 38 assertions in 2.428 seconds. Import, fixture preparation, authentication and the generated request all reached the intended route; the mounted-metadata case was deliberately filtered out of this RED.
- The two route handlers were corrected to separate the validated resource selector from the page input. The complete focused file then passed three cases and 102 assertions, including current grant revocation and mounted metadata. The metadata observer normalizes an omitted optional `required` field to false rather than demanding an explicit property. Official contract generation completed with no tracked SDK or OpenAPI differences, and SDK plus both owning TypeScript checks passed.

## Root cause

`Identity.Page.extend({ resourceID })` correctly describes the HTTP request, while `Identity.Page` correctly describes the domain pagination argument. Structural TypeScript compatibility allowed the route object to reach the narrower argument; the domain's runtime strict parser then rejected `resourceID`. The correction destructures that one selector at each handler and forwards only the remaining page fields. It does not relax either schema, change resource authorization, allocate compute or alter public metadata.

## Guardrails

- [x] Machine check: legal generated Workspace and Environment requests reproduced HTTP 400 after exact path/resource/limit serialization and zero-compute assertions; two semantic failures and 38 assertions qualify the original regression.
- [x] Machine check: both original generated list methods reach the real Service with the original browser login and serialize actual project/resource selectors and a legal string limit of 1; both must return the expected original identities and continuation without allocating compute.
- [x] Machine check: the same real catalog cases retain the maximum legal limit of 100, reject 0, 101 and unknown query fields, reject an unauthenticated reader and recheck a committed project resource-grant revocation.
- [x] Machine check: mounted OpenAPI retains both operation IDs, required project/resource selectors, optional page parameters and original response schemas; regenerate contracts and inspect the resulting diff.
- [x] Machine check: Organization, Organization Runtime and SDK TypeScript checks passed after the test port helper retained its required path import.
- [ ] Machine check: complete final-candidate canonical quality and CI verification remain required.

These route checks do not accept cloud-selected Session recovery, changed H1 resource reconciliation, complete CI or deployment. Those original chains retain their own evidence and refusal controls.

## Lessons

Validate the transport-to-domain projection through a valid generated HTTP request. An object accepted by a broader route schema need not be a valid strict domain input. Keep selectors separate instead of making the domain parser permissive. The [cloud catalog decision](../decisions/implemented/architecture/2026-11-11-own-cloud-catalogs-in-organization-storage.md) owns the resulting rule.
