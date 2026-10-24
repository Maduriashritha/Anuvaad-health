# Anuvaad Health

Anuvaad Health is a prototype for prescription digitization and five-vector medication safety review. It helps people review prescription text against a patient profile and configured safety checks. It is not a clinically validated medical device or a guarantee that a prescription is safe.

## Try the hosted website

**Open the app:** [https://anuvaad-health.up.railway.app/](https://anuvaad-health.up.railway.app/)

Visitors can use the website without installing Docker, Neo4j, or other local services. Create an account in the app, add or review a patient profile, then scan a prescription or enter medicines manually. Confirm every extracted medicine and instruction against the prescription image.

The hosted app uses the site-managed **Gemini 3.5 Flash-Lite** model for cloud prescription reading. Its API key is kept in Railway's private service settings; visitors do not need to enter a key. The service also uses local English OCR to check for text support when available.

For current service readiness, see the [health endpoint](https://anuvaad-health.up.railway.app/api/health).

## Safety, privacy, and limitations

- Use synthetic/demo patient information and sample prescriptions. Do not upload real patient records to this public demo.
- OCR can misread a medicine name, strength, or direction. Review and correct every field before analysis.
- A missing alert means only that no configured check matched. It does not prove a medicine is safe.
- The five safety vectors are rule-based checks, not five trained AI models. The app does not provide individualized dosage calculations or a validated risk score.
- The DDInter interaction reference is a partial dataset, not a complete interaction catalog. Results require review by a qualified clinician or pharmacist.
- Prescription images are sent to the app server for OCR and, when cloud OCR is used, to Google's Gemini service. Treat the image and extracted information as sensitive.
- The app has no HIPAA/GDPR compliance attestation and is not intended for clinical use.

See [APP-GUIDE.md](APP-GUIDE.md) for the workflow, data handling, and detailed feature limitations.

## Run the complete app locally

Requirements: Git and Docker Desktop with the Docker engine running.

1. Clone this repository and open a terminal in its folder.
2. In PowerShell, run `Copy-Item .env.example .env; notepad .env`. Set `POSTGRES_PASSWORD` and `NEO4J_PASSWORD` to different random values using letters and numbers only. Save and close the file. Keep `.env` private; it is ignored by Git.
3. Start the app and its databases/services:

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

For local Gemini OCR, set `GEMINI_API_KEY` only in your private `.env` file. The app sends prescription images to Google's Gemini API when cloud OCR is enabled. The model is pinned to Gemini 3.5 Flash-Lite; do not put API keys in source code or browser inputs. Without a key, local English OCR may be available, but it is not a handwriting-specific model.

## Deployment and source

The hosted demo currently runs on Railway and is connected to this repository's `main` branch. Changes pushed to `main` can trigger a Railway deployment. The repository contains the source code; people who only want to try the app should use the hosted website link above.

See [DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md) for the deployment setup. Before publishing, make sure `.env`, `anuvaad_health.db`, patient images, logs, and `node_modules` are not committed. Keep [data/DDINTER-NOTICE.md](data/DDINTER-NOTICE.md) with the included DDInter files.
