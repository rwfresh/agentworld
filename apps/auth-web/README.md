# AgentWorld auth portal

A framework-free Vite application for GitHub sign-in, email magic links, and OAuth device
approval. The production server should serve the built SPA for `/`, `/device`, and `/authorized`,
and mount Better Auth at `/api/auth`.

The device page accepts Better Auth's standard `?user_code=...` link. It claims the request through
`GET /api/auth/device`, shows its requesting client and scopes when authenticated, and requires the
operator to retype the exact code before calling the approve endpoint. The page uses only
same-origin requests and a restrictive CSP/referrer policy.
