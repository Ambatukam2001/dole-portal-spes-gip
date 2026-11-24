# Portal cookie sessions and SSO deployment

## Required Vercel environment variables

Configure the server-only variables in `src/backend/config/.env.example` in Vercel Project Settings for Development, Preview, and Production. Do not add the service-role key or either client secret to `VITE_*` variables.

## Database migration

Run `supabase/migrations/20260806130000_portal_cookie_sessions_and_sso.sql` in the Portal Supabase SQL Editor before deployment.

## Target callback contract

The Portal redirects a signed-in Portal user to the configured callback with `code` and `state` query parameters. The target browser must immediately send both values to its own backend. The target backend then calls the Portal:

```http
POST https://YOUR-PORTAL-DOMAIN/api/sso/consume
Content-Type: application/json
X-SSO-Client-Secret: target-server-only-secret

{"system_key":"SPES","code":"...","state":"..."}
```

A successful response identifies the target-local account to sign in as. The target must create its own authenticated session for `external_user_id`; it must never send its client secret to the browser.

## Local testing

`npm run dev` starts the local Node + Vite server (`scripts/local-dev-server.js`) and serves both the Vite application and `/api/*` routes at `http://localhost:5173`. `npm run dev:vite` starts Vite directly (with local `/api/*` middleware), and `npm run dev:vercel` starts Vercel Dev. Copy `src/backend/config/.env.example` to `src/backend/config/.env` (or root `.env.local`) and fill in your Supabase, SSO, CREAO, and SMSAPI keys before starting the server.