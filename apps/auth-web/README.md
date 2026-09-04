# AgentWorld auth portal

A framework-free Vite application for GitHub sign-in, email magic links, and OAuth device
approval. The production server should serve the built SPA for `/`, `/device`, and `/authorized`,
and mount Better Auth at `/api/auth`.

The device page accepts Better Auth's standard `?user_code=...` link. It claims the request through
`GET /api/auth/device`, shows its requesting client and scopes when authenticated, and requires the
operator to retype the exact code before calling the approve endpoint. The page uses only
same-origin requests and a restrictive CSP/referrer policy.

On load the portal reads `GET /.well-known/agentworld`. When `registration` is `invite`, it explains
that a first-time sign-in must use the email link with an invitation code and that GitHub sign-in
works once the account exists; when `closed`, it states that no new accounts are created and hides
the invite field. Sign-in requests pass this page as the error return URL, so a server-side
rejection (for example `INVITATION_REQUIRED` or `REGISTRATION_CLOSED`) comes back as `?error=<code>`
and is rendered as plain-text guidance; unknown codes are shown only as a sanitized identifier.
