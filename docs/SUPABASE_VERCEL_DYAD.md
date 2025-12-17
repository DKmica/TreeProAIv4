# TreePro AI: Supabase + Vercel + Dyad Playbook

This playbook explains how to run the existing TreePro AI stack end-to-end using Supabase for PostgreSQL, Vercel for hosting, and Dyad for preview builds. It is built around the current consolidated schema in [`backend/init.sql`](../backend/init.sql), which already includes all CRM, sales pipeline, job management, job forms, scheduling, automation, Stripe, and AI logging tables.

## 1) Database: Supabase

### Create the project
1. Create a Supabase project and copy the **connection string** (Settings → Database → Connection pool). Use the pooled connection string for production and set `sslmode=require`.
2. Add these environment variables to both backend and frontend builds:
   - `DATABASE_URL` – Supabase connection string (pooling, `sslmode=require`).
   - `SUPABASE_SERVICE_ROLE_KEY` – optional; only needed if you later add RLS and need server-side bypass.

### Apply the schema (all workflows and forms)
The repo ships with a consolidated schema so you do not have to juggle incremental migrations:
```bash
psql "$DATABASE_URL" -f backend/init.sql
```
This single command creates the full set of CRM tables (clients → properties → contacts → contact_channels), sales pipeline tables (leads, quotes, quote_versions, quote_followups), job execution (jobs, job_state_transitions, crew assignments, recurring jobs), digital forms (job_forms and templates), invoicing, Stripe links, automation, telemetry, and AI estimate logs.

### Seed starter data
If you want sample forms/templates that mirror the workflows, run the seed script against Supabase:
```bash
cd backend
DATABASE_URL="$DATABASE_URL" node seedDatabase.js
cd ..
```
This populates form templates and demo records so the UI workflows and forms render immediately.

### Operational notes for Supabase
- The backend already uses TLS when `NODE_ENV=production`; Supabase requires TLS, so keep that setting.
- Use Supabase connection pooling; the pool size in `backend/src/modules/core/db/config.js` is limited to 10 connections, which aligns with Supabase limits.
- If you later enable Row Level Security, run API calls with `SUPABASE_SERVICE_ROLE_KEY` on the backend or wire RLS policies to your auth provider. No code changes are required for the basic (no-RLS) setup.

## 2) Hosting: Vercel

TreePro AI ships as a Vite React SPA plus an Express API. The recommended deployment is **frontend on Vercel** and **API on Vercel Serverless Functions** using the existing Express server.

### Project layout for Vercel
- The repo now includes `vercel.json` and `backend/vercel.js`, which route `/api/*` to the Express app as a serverless function and serve the built Vite assets statically from `dist/`.
- Keep the monorepo as-is. Vercel can build the frontend from the root and expose the backend via a serverless function entry point that imports `backend/server.js`.
- If you customize routing, keep the SPA catch-all so client-side routes (e.g., `/admin-setup`) resolve to `dist/index.html`.

### Quick auth checklist for Vercel + Supabase
- Set `DATABASE_URL` to your Supabase Postgres connection string (use the non-pooled string with `sslmode=require` so schema/bootstrap can run).
- Set `SESSION_SECRET` to a strong random string so login cookies remain valid across serverless invocations.
- Set `CORS_ORIGINS` to your Vercel domain if you serve the API cross-origin; for same-origin `/api` calls you can omit it.

Example `vercel.json`:
```json
{
  "builds": [
    { "src": "backend/server.js", "use": "@vercel/node" },
    { "src": "dist/**/*", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/backend/server.js" },
    { "src": "/(.*)", "dest": "/dist/$1" }
  ]
}
```

### Build & deploy steps
1. **Install dependencies**: `pnpm install` and `cd backend && pnpm install`.
2. **Build frontend**: `pnpm run build` (outputs to `dist/`).
3. **Configure Vercel project** with environment variables: `DATABASE_URL`, `GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY`, `AUTH_TOKEN`, Stripe keys (optional), and any Supabase-specific keys.
4. **Deploy**: `vercel --prod` from the repo root. Vercel will build the frontend and package `backend/server.js` as a serverless function that proxies `/api/*` calls.

### Preview/production parity
- Use Vercel preview deployments with a separate Supabase database (create a second project or branch-specific schema) by pointing `DATABASE_URL` to the preview DB.
- Because the schema is consolidated, re-running `backend/init.sql` in preview guarantees schema parity with production.

## 3) Dyad preview builds

Dyad previews work by running the dev server on a fixed port. The repo is already configured for Vite dev on port 5000 with API proxying to `backend:3001`.

### Run in Dyad
```bash
pnpm install
cd backend && pnpm install && cd ..
pnpm dev -- --host 0.0.0.0 --port 5000
```
- Ensure `DATABASE_URL` points to your Supabase instance.
- The dev proxy in `vite.config.ts` routes `/api` to `http://localhost:3001`; start the API separately with `node backend/server.js` (or `pnpm --filter backend start` if you add an npm script).

### Tips for smooth previews
- Preload the Supabase database with `backend/seedDatabase.js` so Dyad reviewers see full workflows and forms.
- Set `VITE_API_BASE_URL` in `.env.local` if Dyad needs explicit API routing; otherwise the default proxy works for local previews.

## 4) End-to-end validation

After deploying (or spinning up a Dyad preview) validate the critical flows against Supabase:
1. **CRM** – create a client, property, contact, and contact channels; verify rows land in `clients`, `properties`, `contacts`, `contact_channels`.
2. **Sales** – create a lead and quote; approve a quote and confirm `quote_versions` and `quote_followups` capture the history.
3. **Jobs** – convert the quote to a job, move it through the 10-state workflow, and confirm `job_state_transitions` records the path.
4. **Scheduling & crews** – assign crews and schedule dates; verify `crew_assignments` and recurring series tables update.
5. **Forms** – complete a job form; check `job_forms` JSONB payloads store correctly and templates are available.
6. **Billing** – generate an invoice and (optionally) Stripe customer linkage; confirm `invoices` and Stripe ID fields populate.
7. **AI** – trigger AI estimation; ensure logs appear in `ai_estimate_logs`.

Because the schema and seeds live in the repo, every environment (local, Dyad, Vercel preview, production) can be rebuilt deterministically by re-applying `backend/init.sql` and re-running the seed script against the target Supabase database.
