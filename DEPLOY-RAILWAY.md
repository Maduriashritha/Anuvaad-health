# Deploy Anuvaad for a hackathon demo

This guide deploys the current Node/Express app and its services. It does not convert the UI to React/Next.js or enable a clinical ML predictor. Use synthetic/demo patient data only.

For the full screen-by-screen and component explanation, see [`APP-GUIDE.md`](APP-GUIDE.md).

## 1. Prepare the GitHub repository

1. Create a **public** repository on GitHub for the hackathon.
2. Upload the project files, including `README.md`, `APP-GUIDE.md`, `DEPLOY-RAILWAY.md`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.gitignore`, `.env.example`, `package.json`, `package-lock.json`, `server.js`, `clinical-stores.js`, `fhir-connector.js`, `index.html`, `clinical-nlp/`, `scripts/`, and `data/ddinter/`.
3. Keep `data/DDINTER-NOTICE.md` with the DDInter files. That data has noncommercial/share-alike terms.
4. Do **not** upload `.env`, `anuvaad_health.db`, `.runlogs/`, patient images, or `node_modules/`. The `.gitignore` file excludes the local database, logs, environment files, and dependency folder.

Before making the repository public, confirm that the GitHub file list does not contain `.env`, `anuvaad_health.db`, patient images, or logs. `.gitignore` excludes these for new commits, but does not remove files already tracked in Git. If any real secret or patient record was committed, remove it from Git history and rotate the credential; deleting it in a later commit is not enough. Keep `data/DDINTER-NOTICE.md` alongside DDInter files when publishing them.

To run the complete stack locally from a fresh clone before deploying, copy `.env.example` to `.env`, set the two database passwords, and run `docker compose up --build -d`. Open `http://localhost:3002` and wait for `/api/health` to report services ready. The same Compose setup can self-host on a Docker-capable Linux server.

## 2. Create the Railway project

1. Sign in to Railway with GitHub and create a project from the public repository.
2. The root `Dockerfile` builds the web app. Railway should use that Dockerfile and its default command, `node server.js`; do not use the Windows-only `npm start` script on Linux.
3. Add a PostgreSQL service from Railway's **New → Database → PostgreSQL** menu.
4. Add a Neo4j service from the official `neo4j:5-community` Docker image. Give it a persistent volume mounted at `/data`, and set `NEO4J_AUTH` to `neo4j/<your-long-random-password>`. Do not add public networking for either database.
5. Add another service from the same GitHub repository for the NLP sidecar. Set its root directory to `/clinical-nlp` so it builds `clinical-nlp/Dockerfile`. Name the service `nlp`; it does not need a public domain.

Railway's private network connects services in the same project using `<service-name>.railway.internal`. Its PostgreSQL service exposes `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` variables for other services.

## 3. Set web-service variables

In the web app service's **Variables** tab, add these values. In the dashboard, use **Add Reference Variable** for PostgreSQL values so Railway fills the right-hand references.

| Variable | Value |
|---|---|
| `PGHOST` | `${{Postgres.PGHOST}}` (replace `Postgres` with the database service's displayed name) |
| `PGPORT` | `${{Postgres.PGPORT}}` |
| `PGDATABASE` | `${{Postgres.PGDATABASE}}` |
| `PGUSER` | `${{Postgres.PGUSER}}` |
| `PGPASSWORD` | `${{Postgres.PGPASSWORD}}` |
| `NEO4J_URI` | `bolt://neo4j.railway.internal:7687` |
| `NEO4J_USER` | `neo4j` |
| `NEO4J_PASSWORD` | The same password used in `NEO4J_AUTH` |
| `CLINICAL_NLP_URL` | `http://nlp.railway.internal:8000` |
| `ANUVAAD_SQLITE_PATH` | `/data/anuvaad_health.db` |

Then attach a persistent volume to the web app service mounted at `/data`. This preserves SQLite's local audit-chain and compatibility records between redeploys. Do not copy the development database into it.

Optional variables:

- `GEMINI_API_KEY` enables cloud vision OCR and the optional explanation rewrite. Keep it in Railway Variables, never in GitHub or browser source.
- `OPENFDA_API_KEY` is optional; the app can query openFDA without one, subject to public service limits.
- Leave `FHIR_BASE_URL` and `FHIR_CLIENT_ID` unset unless an EHR or a test SMART server has actually registered the app. For a real server, set `ANUVAAD_PUBLIC_URL` to the exact Railway HTTPS domain and register `/api/fhir/smart/callback` as its redirect URI.

Railway supplies `PORT` automatically. Do not hard-code it in the Variables tab.

## 4. Publish and verify

1. Wait for PostgreSQL, Neo4j, NLP, and web app deployments to finish.
2. In the **web app** service, open **Settings → Networking → Generate Domain**. Only the web app needs a public domain.
3. Open `https://<your-domain>/api/health`.
4. For the full setup, expect `status: online`, PostgreSQL and Neo4j connected, `clinicalNlp.status: ready`, and DDInter `status: READY`. `ehrConnector.configured: false` is expected until you register an EHR client. `predictiveRiskModel.status: NOT_ENABLED` is also expected; this repo does not contain an ML predictor.
5. Open the domain and test the workflow using a synthetic patient account and a synthetic prescription. Do not upload real patient records to this hackathon deployment.

## Notes

- The app calls RxNorm, RxClass, DailyMed, and openFDA over the network. The host must allow outbound HTTPS.
- The first NLP build downloads its biomedical model, so the build may take several minutes and needs more than a minimal memory allocation. If Railway reports out-of-memory, increase that service's resources.
- The local SQLite path can now be set with `ANUVAAD_SQLITE_PATH`; locally it still defaults to `anuvaad_health.db` in the project folder.
- Railway's free trial and paid usage terms can change; check the current [Railway pricing page](https://railway.com/pricing) before deploying. A multi-service app can use more resources than a static site.
