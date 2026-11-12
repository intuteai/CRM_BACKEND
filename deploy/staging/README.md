# Motor-test staging backend (T049)

A second copy of the backend for the tablet HMI to test against, on the production EC2 host.
It uses the `erp_staging` database through the `erp_staging_app` login (no access to production data,
cannot bypass the evidence triggers), is capped at ~150 MB, has its own Redis, sends no scheduled emails
(`DISABLE_CRON=true`) and is reachable only through nginx at **https://api.intute.biz/staging/**.

Tablet base URL: `https://api.intute.biz/staging` → e.g. `POST https://api.intute.biz/staging/api/auth/login`.

## One-time setup on the EC2 host

1. **Folder and compose file**
   ```
   mkdir -p ~/erp-staging
   # copy deploy/staging/docker-compose.staging.yml from this repo to ~/erp-staging/ (scp)
   ```
2. **Environment file** — `~/erp-staging/.env.staging`, from `deploy/staging/env.staging.example`:
   `DB_USER=erp_staging_app`, its password, `DB_NAME=erp_staging`, and a **new** `JWT_SECRET`
   (both handed over separately; never commit them). `chmod 600 ~/erp-staging/.env.staging`.
3. **nginx** — inside the existing `server { ... }` block for `api.intute.biz` (port 443), add:
   ```nginx
   location /staging/ {
       proxy_pass http://127.0.0.1:8001/;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       client_max_body_size 6m;
   }
   ```
   then `sudo nginx -t && sudo systemctl reload nginx`.

## Deploy / update

GitHub → Actions → **Deploy CRM Backend STAGING to EC2** → Run workflow (any branch). It builds
`intuteai/erp-backend:staging` and restarts only the staging containers. Production (`:latest`) is untouched.

## Check

```
curl -s https://api.intute.biz/staging/api/testing/me      # expect 401 {"code":"AUTH_NO_TOKEN"}
docker stats --no-stream erp-staging_erp-backend-staging_1 # memory well under 150 MiB
docker logs --tail 20 erp-staging_erp-backend-staging_1    # "DISABLE_CRON=true" warning, "Connected to PostgreSQL"
```

## Stop when idle (agreed with Saatwik)

```
cd ~/erp-staging && docker-compose -p erp-staging -f docker-compose.staging.yml down
```
Start again with `up -d`. The staging database keeps its data while the containers are down.

## Staging data

`erp_staging` holds the production structure, users, roles and products (copied 2026-11-05) plus test
data for the HMI: `testing@compageauto.com` has the `operator` testing role; operators "Test Operator A/B";
motor type `STAGING-TEST-B125` with published profile and criteria v1 (limits deliberately empty);
designated run `3a7c1e9b-5d2f-4b8a-9c6e-1f0a2b3c4d5e` (serial `STG-TEST-0001`) for correction tests.
Migrations: `node scripts/migrations/motor-test/run.js --db erp_staging`.
