# Anuvaad app guide

This guide explains what is in the current Anuvaad prototype, what each part does, and what a user should understand from its output. It is written for a hackathon presentation and for people exploring the code.

## 1. What Anuvaad does

Anuvaad takes a prescription image or manually entered medicine list, lets the user review the extracted details, compares the reviewed medicines with a saved patient profile, and presents configured safety findings in a visual and spoken summary. It is a **prototype clinical review aid**, not an autonomous prescriber or a guarantee that a prescription is safe.

The basic path is:

```text
Sign in → enter patient context → scan prescription → review/correct medicines
→ resolve medicine identity → run five safety vectors → inspect explanations
→ hear a patient summary → review profile/EHR/security views
```

The user should correct OCR errors and confirm each ingredient, strength, route, and direction before relying on analysis. A missing alert means only that no currently configured check matched the entered data.

## 2. Screens and their purpose

| Screen | What the user does or sees | Why it is there |
|---|---|---|
| Splash / start | Enters the Anuvaad experience. | Introduces the product. |
| Onboarding | Reviews the purpose and workflow. | Sets expectations before patient information is entered. |
| Language | Chooses English, Hindi, or Telugu. | Selects interface and speech language. Browser voices determine which spoken voices are available. |
| Login | Creates an account or signs in. | Associates saved profiles and scan history with an account. Passwords are stored as salted scrypt hashes; a session cookie is HTTP-only and SameSite=Strict. |
| Patient profile | Enters demographics, diagnoses, surgery history, allergies, current and past medicines, prior reactions, clinical alerts, weight, and eGFR when known. | Gives the checker context; missing or unconfirmed information is surfaced as a data-quality gap. |
| Prescription scanner | Uploads/captures a prescription or adds medicines manually. OCR cards show the text, regimen fields, confidence/review status, and available RxNorm resolution. | Turns a picture into editable candidate data. The user confirms/corrects the candidate before analysis. |
| Context cross-check matrix | Views prescribed medicines alongside profile context and flagged intersections. | Helps inspect which patient factors were involved in a finding. It only visualizes rules and data the engine actually has. |
| Five-vector engine | Runs and displays the five check groups, cumulative heuristic score, status, data gaps, and diagnostic log. | Shows how the cross-check was assembled and which inputs were missing. |
| Explanation cards | Reads individual findings, severity, rationale, and suggested next steps where configured. | Makes warnings easier to inspect. The rule/reference result is the source of the alert. Optional Gemini wording cannot change the result. |
| Voice briefing | Uses browser speech synthesis to read a patient-facing summary. | Improves accessibility and supports spoken English, Hindi, or Telugu where a compatible browser voice exists. |
| Dual-target brief | Switches between a patient/caregiver briefing and a clinician-focused review. | Presents the same reviewed findings at different levels of detail. |
| Settings | Shows application/service readiness and language/audio options. | Helps identify unavailable services and configuration. |
| Patient/EHR view | Summarizes the patient profile/history and provides FHIR import/export and SMART connection entry points. | Keeps profile context and interoperability actions in one view. Imported EHR data is a suggestion for review; it is not silently saved as verified profile truth. |
| Architecture view | Shows a simplified view of the application components. | Explains the pipeline for a demo or presentation. |
| Privacy/audit view | Displays an encryption preview and audit-chain status. | Demonstrates browser-side encryption and tamper-evident audit records, with their limits stated below. |

Screen labels in the HTML are implementation comments and are not perfectly sequential; use the visible user journey above when presenting the app.

## 3. Prescription scanning and medicine identity

### OCR means optical character recognition

OCR converts pixels in the uploaded image into candidate text. Anuvaad has two paths:

1. **Local Tesseract.js:** runs English OCR on the app server. Without a Gemini key, local text and simple line heuristics propose medicine rows. This path is useful offline from a cloud AI provider, but it is not a handwriting-specific prescription model.
2. **Optional Gemini Vision:** when a key is configured or entered, the image is sent to Google's Gemini Vision service to propose literal medicine rows and visible regimen fields. This is an external image-processing request.

When Gemini is used, Anuvaad also gets a Tesseract transcription and checks whether extracted name, strength, and directions have textual support in that second read. Disagreements are marked for visual review and lower a high OCR confidence label. This agreement check is a simple support heuristic, not a calibrated confidence score or proof that either transcription is right.

The interface keeps OCR values editable. Unclear values remain unclear instead of being safely guessed. Confirm the medicine name, strength, dose, frequency, duration, and route from the image. The phrase “confidence” describes the extraction output; it is not a measured probability of correctness.

### Medicine normalization

The user may resolve the reviewed name against the U.S. National Library of Medicine's RxNorm terminology and RxClass class data. A selected RxNorm concept can provide an RxCUI (a medicine concept identifier), possible ingredient names, dosage form, and therapeutic class. Close or approximate matches are shown for confirmation; they must not silently replace the prescription text. RxNorm is a terminology service, not a complete Indian-brand catalog or a clinical safety verdict. See the [RxNorm/RxClass API documentation](https://lhncbc-portal.lhcaws-prod-pub.nlm.nih.gov/RxNav/APIs/index.html).

## 4. Biomedical text extraction

The separate Python FastAPI service runs scispaCy `en_ner_bc5cdr_md`, a named-entity recognition model that proposes spans tagged as chemical or disease terms. It can help point out relevant words in OCR text. Its source corpus is biomedical literature; it does not determine whether a condition is current, whether a medicine is active, or whether a mention is a confirmed allergy. It does not replace RxNorm identity resolution or the rule engine. Every mention is a review suggestion. See [scispaCy model documentation](https://github.com/allenai/scispacy/blob/main/docs/index.md).

## 5. The five safety vectors

The analysis is deterministic: the same accepted profile, medicine records, configured rules, and reference data produce the same kind of rule-driven result. The five vectors are not five independently trained AI models.

| Vector | What it checks | Important boundary |
|---|---|---|
| **1. Drug–drug interactions** | New prescription medicines against one another and recorded active medicines. Uses configured rules and exact ingredient-pair matches from the locally imported DDInter 2.0 data. | DDInter in this app contains selected downloadable ATC groups only. A non-match does not mean no interaction. DDInter's imported pair rows provide names and a severity level, not a patient-specific outcome or a mechanism for every pair. |
| **2. Disease, surgery, and patient-factor contraindications** | Prescribed medicines against the conditions, clinical alerts, surgical history, and selected other profile factors covered by configured rules. | Only configured terms/rules are checked. Free text, missing history, and uncommon risks may not match. |
| **3. Duplicate/class overlap** | Exact/repeated medicines and configured therapeutic-class overlap using resolved identity/class information where available. | A class match is a review signal; it does not establish that two drugs are clinically inappropriate together. Unresolved identities reduce coverage. |
| **4. Dose, age, and organ-risk screening** | Age, weight, eGFR, entered strength/directions, and configured age/organ risk rules. Also identifies missing dose/regimen details. | The app does **not** calculate an individualized dose range. Product-label dosage text is displayed as source material, not automatically compared into a dose verdict. Route, indication, current renal function, and other factors can matter. |
| **5. Allergy and prior-reaction screening** | Direct medicine/allergy matches, selected configured cross-allergy rules, and linked prior medicine reactions. | The app does not infer all chemical cross-reactivity from a broad allergy label and does not estimate anaphylaxis probability. Allergy history and reaction details must be verified. |

### Score and status

The 0–100 number is a rule-weighted priority score derived from severity points for detected conflicts. Higher vector contributions are weighted more heavily and the score is capped at 100. It is **not** a probability of harm, a validated clinical score, or an ML model output. If the analysis has important data gaps, the app can set a review-needed status even when no configured conflict matched; a “SAFE” display is not a guarantee of safety.

The diagnostic log records which vectors ran, the configured matches, reference-data status, and where data or a comparison was unavailable. The log is for transparency about this run, not a complete audit of every clinical fact in the world.

## 6. Drug references

- **DDInter 2.0:** a locally imported interaction-pair dataset with 130,422 deduplicated pair records from eight downloaded ATC groups. It is partial and licensed CC BY-NC-SA 4.0; preserve attribution in public copies. Details and terms are in [`data/DDINTER-NOTICE.md`](data/DDINTER-NOTICE.md).
- **DailyMed:** for a verified RxNorm concept, the app requests label sections when available, including dosage, contraindications, interactions, and warnings/precautions.
- **openFDA Drug Label API:** performs an additional RxNorm-linked label lookup for dosage, contraindication, interaction, warning, and boxed-warning sections where a linked U.S. product label exists. These sections are displayed as supporting source excerpts. The API may have no match for some products; its own documentation warns against using its data to make medical-care decisions. See [openFDA drug-label documentation](https://open.fda.gov/apis/drug/label/) and [searchable fields](https://open.fda.gov/apis/drug/label/searchable-fields/).
- **Configured clinical knowledge rules:** a finite local catalog covers selected interactions, disease/organ risks, duplicates, age flags, and allergy patterns. PostgreSQL stores rule catalog data; Neo4j stores/traverses corresponding context relationships. Neither database makes the rule catalog exhaustive.

## 7. Explanations, translation, and speech

Explanation cards are rendered from the deterministic findings and any available evidence. Safer alternatives appear only when a configured finding supplies one; the app does not search or rank every possible alternative. If the user chooses the optional Gemini plain-language feature, it receives selected finding text and rewrites the explanation in English, Hindi, or Telugu. It is explicitly restricted from changing the alert, severity, or recommendation. The browser's built-in SpeechSynthesis reads the summary; voice availability and pronunciation vary by browser, operating system, and installed language voices.

## 8. EHR and FHIR

FHIR is a standard format for exchanging healthcare records. Anuvaad maps FHIR R4 Bundles to review suggestions and can export a Bundle from the saved profile. SMART on FHIR is the OAuth-based authorization flow used to connect an app to an EHR. Anuvaad's connector uses authorization code with PKCE and needs a FHIR server URL, a registered public client ID, and a matching HTTPS callback for a real deployment. No hospital EHR is connected by default. See the [HL7 SMART App Launch guide](https://hl7.org/fhir/smart-app-launch/).

FHIR data is shown for human review before it is applied to the profile. Patient identity, active status, units, and resource meaning can vary by source.

## 9. Storage, authentication, and audit

- **Browser UI:** `index.html` stores the current workflow state in JavaScript. Tailwind CSS, Font Awesome icons, and Inter/Devanagari/Telugu fonts load from public CDNs, so those visual assets need internet access. Calls to the API include the signed-in session cookie.
- **Node.js/Express:** serves the UI and authenticated API endpoints. Passwords use salted scrypt hashes. Clinical routes require a valid session.
- **PostgreSQL:** main structured store for user/profile, prescription, safety-analysis, configured-rule, reference, and audit records.
- **Neo4j:** graph representation of configured clinical rules and relationships. It is a way to organize/query the app's configured knowledge, not a separate verified medical source.
- **SQLite:** local compatibility and audit store. `ANUVAAD_SQLITE_PATH` can place its file on a persistent deployment volume. Do not publish a populated SQLite file.
- **Audit chain:** event records include SHA-256-linked hashes so edits can be detected when the chain is checked. This is tamper-evident, not immutable: an administrator with database access can alter the database and chain.

## 10. Privacy and encryption screen

The AES-256-GCM control encrypts a **temporary browser preview** using a transient in-memory key. It does not encrypt the existing PostgreSQL, Neo4j, or SQLite clinical records at rest. The hash-chain view shows tamper evidence, not an external digital signature or write-once archive. The app has no HIPAA/GDPR compliance attestation and should not receive real patient data as a public hackathon demo.

Prescription images are sent to the app server for OCR. If Gemini Vision is enabled, the image is also sent to Google's service. The prescription scan path stores extracted medicine data and only a truncated image-data prefix in SQLite (not a complete recoverable image); users should still treat the scan and extracted text as sensitive data. A Gemini key typed into the browser is kept in that browser tab's session storage for the current session.

For a public GitHub repository, keep `.env`, `anuvaad_health.db`, patient images, logs, and `node_modules` out of Git. Keep `data/DDINTER-NOTICE.md` beside the DDInter files. See [`DEPLOY-RAILWAY.md`](DEPLOY-RAILWAY.md) for deployment setup.

## 11. Current feature status at a glance

| Feature | Current state |
|---|---|
| OCR | Local English Tesseract; optional Gemini Vision; independent local text-support cross-check when Gemini is used; manual confirmation expected. |
| Drug name/class resolution | RxNorm/RxClass API lookup; approximate matches need user confirmation. |
| Biomedical NLP | scispaCy FastAPI sidecar; chemical/disease candidate mentions only. |
| Five-vector safety | Deterministic rules plus partial DDInter exact-pair lookup; no patient-level ML output. |
| Drug labels | DailyMed and openFDA excerpts when RxNorm-linked labels are found. |
| FHIR | Bundle import/export and SMART connector code; no real EHR configured by default. |
| ML risk predictor | Not enabled; no patient-outcome risk model is included. |
| Frontend/backend framework | Plain HTML/CSS/JavaScript frontend and Express backend; not migrated to React/Next.js or FastAPI. |
| Encryption/compliance | Browser preview encryption and hash-chain demo; no full database-at-rest encryption or compliance attestation. |

## 12. Suggested hackathon explanation

“Anuvaad digitizes a prescription, asks the user to verify the medicine details, resolves medicine concepts where possible, and compares the prescription with the saved patient profile using five transparent rule-based safety vectors. It shows source label text and configured interaction evidence, explains the matched findings, and can read the summary aloud. It is a prototype: it does not calculate all doses, guarantee absence of risk, or generate a validated patient-specific ML risk probability.”
