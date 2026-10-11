# Anuvaad local application architecture

## What runs today

- Browser UI: `index.html`, responsive HTML/CSS and JavaScript, with the existing 15-screen workflow (including the dual-target patient/clinician view after audio guidance).
- API and session service: Node.js / Express in `server.js`. Sign-in uses salted scrypt password hashes and HTTP-only, SameSite cookies. Clinical routes require a valid server-side session.
- Structured clinical records: PostgreSQL 18 in the `anuvaad-postgres18` container. Profiles, users, sessions, prescription scans, safety analyses, and the configured rule catalog are written here. Existing SQLite records are retained as a compatibility copy and as the source for the legacy application screens and local audit chain.
- Clinical graph: Neo4j in `anuvaad-neo4j`. Startup loads the application's configured safety-rule catalog and therapeutic classes. Patient diagnoses, surgeries, allergies, alerts, medication context, prescriptions, and analysis findings are represented as graph nodes/relationships.
- Drug terminology and references: RxNorm/RxClass lookups support drug normalization and class resolution. DailyMed and openFDA provide matching product-label dosage, contraindication, interaction, and warning sections when a verified RxNorm concept has a matching label. Label content is evidence for human review, not a calculated dose check or a complete patient-specific interaction screen. openFDA matching may be unavailable for non-U.S. products or RxNorm concepts without a linked label.
- OCR: local Tesseract runs without a cloud key; Gemini Vision is optional when configured. When Gemini is used, the server now also runs an independent local Tesseract transcription and checks whether the extracted medicine name, strength, and directions are supported by that text. Disagreements (or an unavailable second read) add a visible review finding and prevent an otherwise clear result from being presented as SAFE. This is a conservative text-support heuristic, not calibrated OCR accuracy or clinical verification; every field still requires visual confirmation.
- Biomedical NLP: a separate Docker sidecar runs scispaCy `en_ner_bc5cdr_md` (BC5CDR biomedical chemical/disease NER) over OCR text and returns candidate spans with sentence/context cues. It does not normalize names, prove a diagnosis/allergy, or change the patient profile. The model was trained on biomedical literature, not this app's prescription images or Indian clinical records; mentions must be verified.
- Existing-record scanning: the profile intake accepts a clinical-record image. Gemini can extract candidate diagnoses, surgeries, medicine lists, allergies, reactions, alerts, and visible values into editable fields; local Tesseract provides raw transcription only. This step does not save the image or extracted fields. The user must review them, copy selected suggestions into the profile form, and save the profile.
- Drug interaction reference: the official DDInter 2.0 downloadable files for ATC groups A, B, D, H, L, P, R, and V are imported into PostgreSQL. Exact ingredient pairs are checked against new prescriptions and active home medicines/co-prescriptions. Dataset level, source, and attribution are shown in review findings; no mechanism or patient-specific severity is invented when the CSV does not supply it. This bundle is partial. The eight downloaded source files have 222,383 rows before pair deduplication and are distributed under CC BY-NC-SA 4.0. See `data/DDINTER-NOTICE.md`; noncommercial/share-alike terms apply.
- Safety analysis: deterministic five-vector checks apply the finite local rules in `server.js`. PostgreSQL stores the configured rule catalog; Neo4j context matches are surfaced in diagnostics. No configured-rule match is not proof a prescription is safe.
- Patient-language explanation: after explicit user confirmation, the optional Gemini endpoint rewrites the already-generated findings in English, Hindi, or Telugu. It receives selected medicine/condition warning text and actions, never the patient name or source image; it cannot change severity or the deterministic findings. This is explanatory wording, not an additional safety check.
- Audit: application events are mirrored into SQLite and a PostgreSQL SHA-256 hash chain. The UI verifies and displays both chains. The chain is tamper-evident, not immutable against a database administrator; no external signing service or write-once audit storage is configured.
- EHR interoperability: authenticated users can import/export FHIR R4 collection Bundles as review-only suggestions. SMART App Launch authorization-code flow with PKCE is implemented for a registered public EHR app; the access token is used in memory to read the authorized patient's FHIR resources and is not persisted. A live EHR requires that organization's FHIR base URL, registered client ID, and exact redirect URI in `.env` (see `.env.example`); this workspace has no organization credentials, so the live EHR path is not connected.
- Machine learning risk prediction: deliberately not enabled. DDInter labels selected interaction pairs but has no patient outcomes; FAERS/TWOSIDES spontaneous-report associations are not causal labels or individual risk probabilities. Training on these as if they were patient-level outcomes would create unsupported predictions. The existing five-vector findings remain rule/reference based; provide a pharmacist-governed, patient-level labeled dataset and evaluation protocol before enabling an ML clinical risk model.
- Security: the AES-GCM panel is an in-browser encryption demonstration with a temporary key. PostgreSQL/Neo4j storage is not configured for application-level encryption at rest, and this local prototype has no HIPAA/GDPR compliance attestation.

## Start locally

1. Install Node.js and Docker Desktop.
2. Run `npm install` once.
3. Run `npm start`; the start script brings up the application's PostgreSQL and Neo4j containers and launches Express with their private connection settings.
4. Open `http://localhost:3002`. On first startup, Docker builds and starts the scispaCy NLP sidecar; this downloads the model. `/api/health` reports NLP, FHIR-configuration, and clinical-store status without revealing credentials.
5. Create/sign in to an account, save its patient profile, scan or enter a prescription, review OCR, then run the five-vector analysis.

The start script does not remove containers or named volumes. Existing SQLite application data remains in `anuvaad_health.db`.

## Data flow

1. OCR emits literal candidate medicine rows with name, strength, directions, route, duration, and confidence. The UI preserves the scan and asks the user to correct or confirm it.
2. RxNorm/RxClass resolution adds identifiers, ingredients, forms, and classes only when a match is returned. A fuzzy or unknown name remains unresolved rather than being silently assigned an ingredient.
3. The authenticated profile is loaded from PostgreSQL. It includes conditions, surgeries, allergies, active/past medicines, reactions, alerts, demographics, weight, and eGFR when provided.
4. The server runs the five deterministic vectors against that saved profile and the confirmed prescription. It stores the prescription and result in PostgreSQL and Neo4j, and writes audit events to the local and PostgreSQL hash chains.
5. The UI renders vector statuses, warnings, missing-data review items, mechanisms, recommendations, and patient/clinician summaries. Unknown medicines or absent context must not be interpreted as a safe clearance.

## Clinical boundaries and deck gaps

The prototype combines its finite, hand-authored rule catalog with exact-name matches to a partial DDInter interaction export. Neither is an exhaustive interaction database or a clinical decision support system validated for patient care. Graph traversal organizes/matches configured rules and records DDInter pairs found in an analysis; the graph is not an independent source of clinical truth. DailyMed/openFDA text is not automatically interpreted as patient-specific contraindication logic. An absent pair is never a clean bill of safety. Gemini's optional wording feature runs only after user confirmation and does not establish or validate safety. The app must be used as a demo and its output reviewed by a pharmacist or prescriber.

The deck's proposed React/Next.js and FastAPI stack has not been migrated to: current screens are plain HTML/JavaScript and the API is Express. scispaCy biomedical NER and FHIR R4/SMART interoperability are implemented with the limits above. Biomedical NER is not a complete clinical NLP/normalization pipeline. A patient-level ML risk predictor and a labeled evaluation set are not available; therefore precision/recall claims cannot be supported. OCR cross-reading, rule expansion, and more reference sources can improve review coverage, but no finite dataset or software can guarantee detection of every possible patient-specific risk. Do not claim the prototype is production-ready for clinical decisions.

## Configuration and production needs

- `PORT` (default `3002`), optional `GEMINI_API_KEY`, optional `ANUVAAD_PROVIDER_ID`.
- The local launcher obtains database credentials from the containers at runtime and does not print them.
- Before real-patient deployment: use a security-reviewed hosting environment with HTTPS, managed identity, durable encryption/key management, least-privilege access, backups/retention and incident controls, and a clinically governed rule/reference update process. Validate sensitivity and false-alert rates with representative pharmacist-labeled cases before relying on alerts.
