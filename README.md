# Anuvaad Health

An AI-assisted prescription digitization and five-vector medication safety review prototype. Use synthetic patient and prescription data for demos; this is not a clinical decision system.

## Run the complete app locally

Requirements: Docker Desktop with the Docker engine running and Git.

1. Clone this public repository and open a terminal in its folder.
2. In PowerShell, run `Copy-Item .env.example .env; notepad .env`. Replace `POSTGRES_PASSWORD` and `NEO4J_PASSWORD` with different random values using letters and numbers only. Save and close the file. Keep `.env` private; it is ignored by Git.
3. Start the app and its databases/NLP service:

   ```powershell
   docker compose up --build -d
   ```

   The first NLP image build downloads a large biomedical model and may take several minutes.

4. Open [http://localhost:3002](http://localhost:3002). Check [http://localhost:3002/api/health](http://localhost:3002/api/health) for service readiness.
5. To stop the containers but keep saved data, run:

   ```powershell
   docker compose down
   ```

Do not run `docker compose down -v` unless you intentionally want to delete the named database and app-data volumes.

Without `GEMINI_API_KEY`, OCR uses local English Tesseract. Add a key to `.env` only if you want Gemini Vision OCR; the prescription image is then sent to Google for processing. FHIR settings are optional and should stay blank until an EHR/SMART app is registered.

## Public internet deployment

Pushing code to GitHub stores the repository; it does not run the backend. For a public demo URL, deploy the services on a host that supports Docker, persistent volumes, and private service networking. Follow [`DEPLOY-RAILWAY.md`](DEPLOY-RAILWAY.md) for a Railway setup, or use `docker compose` on a Linux server with HTTPS configured in front of the app.

Before publishing, confirm that `.env`, `anuvaad_health.db`, patient images, logs, and `node_modules` are not in Git. Keep [`data/DDINTER-NOTICE.md`](data/DDINTER-NOTICE.md) with the included DDInter files.

## Learn the application

See [`APP-GUIDE.md`](APP-GUIDE.md) for screen explanations, the data path, the five safety vectors, service roles, and limitations.
