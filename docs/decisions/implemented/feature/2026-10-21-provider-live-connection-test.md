# Decision Record: Test saved provider connections with a model request

Status: implemented

## Problem

Saving a credential does not establish that the credential, endpoint and model work together. Describing a saved key as connected encourages users to discover failures by creating a chat.

## Decision

Provider settings offer an explicit connection test using saved configuration and a short text request. The provider owner resolves the model and authentication through the existing SDK path. The probe has a twelve-second request timeout, no automatic request or credential-recovery retries, no tools and an independent validation recording. It creates no Session. Results identify the observed model, elapsed time and a bounded error category with an HTTP status when available. Provider error bodies and credentials do not enter the result.

Credential presence is labeled configured. Saving credentials reports that the request remains untested. Unsaved edits disable testing; account, connection and draft changes cancel pending presentation and invalidate previous results.

## Alternatives considered

**Treat credential persistence as success.** This cannot detect invalid credentials or endpoint errors.

**Check the models endpoint only.** Catalog availability does not establish that the selected model accepts a generation request.

**Create a chat for validation.** This adds conversation history and makes setup harder to verify.

## Consequences

Users get direct evidence of model reachability and authentication without an extra chat. Each explicit test may consume a small provider charge. A successful test establishes that particular model request; it does not certify every model or capability.
