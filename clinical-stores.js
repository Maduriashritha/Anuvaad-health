const { Pool } = require('pg');
const neo4j = require('neo4j-driver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pgConfig = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 15432),
    database: process.env.PGDATABASE || 'anuvaad',
    user: process.env.PGUSER || 'anuvaad',
    password: process.env.PGPASSWORD || ''
};
const neo4jUri = process.env.NEO4J_URI || 'bolt://127.0.0.1:17687';
const neo4jUser = process.env.NEO4J_USER || 'neo4j';
const neo4jPassword = process.env.NEO4J_PASSWORD || '';
let therapeuticClassMembers = new Map();

const pool = new Pool({ ...pgConfig, max: 8, connectionTimeoutMillis: 5000 });
const graphDriver = neo4jPassword
    ? neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword), { connectionTimeout: 5000 })
    : null;

let schemaReady;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeReferenceDrug(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function parseCsvLine(line) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (char === '"') {
            if (quoted && line[index + 1] === '"') { field += '"'; index++; }
            else quoted = !quoted;
        } else if (char === ',' && !quoted) { fields.push(field); field = ''; }
        else field += char;
    }
    fields.push(field);
    return fields;
}

async function importDDInterBundle(directory = path.join(__dirname, 'data', 'ddinter')) {
    await initializeClinicalStores();
    const codes = ['A','B','D','H','L','P','R','V'];
    const files = codes.map(code => ({ name: `ddinter_downloads_code_${code}.csv`, path: path.join(directory, `ddinter_downloads_code_${code}.csv`) }));
    const missing = files.filter(file => !fs.existsSync(file.path)).map(file => file.name);
    if (missing.length) return { status: 'NOT_CONFIGURED', missing, rows: 0 };

    const digest = crypto.createHash('sha256');
    const deduped = new Map();
    const rank = { minor: 1, moderate: 2, major: 3 };
    for (const file of files) {
        const buffer = fs.readFileSync(file.path);
        digest.update(file.name); digest.update(buffer);
        const lines = buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
        if (!lines.length) throw new Error(`DDInter file is empty: ${file.name}`);
        const header = parseCsvLine(lines[0]).map(value => value.trim());
        const indexes = ['DDInterID_A','Drug_A','DDInterID_B','Drug_B','Level'].map(name => header.indexOf(name));
        if (indexes.some(index => index < 0)) throw new Error(`Unexpected DDInter CSV columns in ${file.name}.`);
        for (const line of lines.slice(1)) {
            const values = parseCsvLine(line);
            const [idA, drugA, idB, drugB, levelRaw] = indexes.map(index => String(values[index] || '').trim());
            const level = levelRaw.toLowerCase();
            if (!drugA || !drugB || !rank[level]) continue;
            const normA = normalizeReferenceDrug(drugA);
            const normB = normalizeReferenceDrug(drugB);
            if (!normA || !normB || normA === normB) continue;
            const [first, second] = normA < normB
                ? [{ name: drugA, norm: normA, id: idA }, { name: drugB, norm: normB, id: idB }]
                : [{ name: drugB, norm: normB, id: idB }, { name: drugA, norm: normA, id: idA }];
            const key = `${first.norm}|${second.norm}`;
            const existing = deduped.get(key);
            if (!existing || rank[level] > rank[existing.severity.toLowerCase()]) deduped.set(key, {
                pairKey: key, drugA: first.name, drugANormalized: first.norm, drugB: second.name, drugBNormalized: second.norm,
                severity: levelRaw, ddinterIdA: first.id, ddinterIdB: second.id, sourceFile: file.name
            });
        }
    }
    const versionHash = digest.digest('hex');
    const current = await pool.query('SELECT version_hash, row_count FROM clinical_reference_datasets WHERE dataset_key = $1', ['DDInter 2.0']);
    if (current.rows[0]?.version_hash === versionHash) return { status: 'READY', version: versionHash, rows: current.rows[0].row_count, unchanged: true };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM ddinter_interactions');
        const values = [...deduped.values()];
        const batchSize = 800;
        for (let offset = 0; offset < values.length; offset += batchSize) {
            const batch = values.slice(offset, offset + batchSize);
            const params = [];
            const tuples = batch.map((row, index) => {
                const base = index * 9;
                params.push(row.pairKey, row.drugA, row.drugANormalized, row.drugB, row.drugBNormalized,
                    row.severity, row.ddinterIdA, row.ddinterIdB, row.sourceFile);
                return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`;
            });
            await client.query(`INSERT INTO ddinter_interactions
                (pair_key, drug_a, drug_a_normalized, drug_b, drug_b_normalized, severity, ddinter_id_a, ddinter_id_b, source_file)
                VALUES ${tuples.join(',')}`, params);
        }
        await client.query(`INSERT INTO clinical_reference_datasets (dataset_key, version_hash, row_count, license, source_url)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dataset_key) DO UPDATE SET version_hash = EXCLUDED.version_hash,
                row_count = EXCLUDED.row_count, imported_at = NOW(), license = EXCLUDED.license, source_url = EXCLUDED.source_url`,
        ['DDInter 2.0', versionHash, deduped.size, 'CC BY-NC-SA 4.0', 'https://ddinter2.scbdd.com/']);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
    return { status: 'READY', version: versionHash, rows: deduped.size, unchanged: false };
}

async function queryDDInterInteractions({ newMedicationTerms = [], activeMedicationTerms = [] }) {
    await initializeClinicalStores();
    const normalizeGroups = groups => (Array.isArray(groups) ? groups : []).map(group => ({
        label: String(group?.label || '').trim(),
        terms: [...new Set((Array.isArray(group?.terms) ? group.terms : []).map(normalizeReferenceDrug).filter(Boolean))]
    })).filter(group => group.label && group.terms.length);
    const prescribed = normalizeGroups(newMedicationTerms);
    const active = normalizeGroups(activeMedicationTerms);
    if (!prescribed.length || (!active.length && prescribed.length < 2)) return [];
    const result = await pool.query(`
        WITH new_terms AS (
            SELECT m.value->>'label' AS label, item.term
            FROM jsonb_array_elements($1::jsonb) AS m(value)
            CROSS JOIN LATERAL jsonb_array_elements_text(m.value->'terms') AS item(term)
        ), active_terms AS (
            SELECT m.value->>'label' AS label, item.term
            FROM jsonb_array_elements($2::jsonb) AS m(value)
            CROSS JOIN LATERAL jsonb_array_elements_text(m.value->'terms') AS item(term)
        ), candidates AS (
            SELECT n.label AS prescribed_a, a.label AS prescribed_b, i.*
            FROM new_terms n JOIN new_terms a ON n.label < a.label
            JOIN ddinter_interactions i ON
                (i.drug_a_normalized = n.term AND i.drug_b_normalized = a.term)
                OR (i.drug_b_normalized = n.term AND i.drug_a_normalized = a.term)
            UNION ALL
            SELECT n.label AS prescribed_a, a.label AS prescribed_b, i.*
            FROM new_terms n CROSS JOIN active_terms a
            JOIN ddinter_interactions i ON
                (i.drug_a_normalized = n.term AND i.drug_b_normalized = a.term)
                OR (i.drug_b_normalized = n.term AND i.drug_a_normalized = a.term)
        )
        SELECT DISTINCT ON (pair_key, prescribed_a, prescribed_b)
            pair_key, drug_a, drug_b, severity, ddinter_id_a, ddinter_id_b,
            source_file, prescribed_a, prescribed_b
        FROM candidates
        ORDER BY pair_key, prescribed_a, prescribed_b,
            CASE lower(severity) WHEN 'major' THEN 3 WHEN 'moderate' THEN 2 ELSE 1 END DESC`,
    [JSON.stringify(prescribed), JSON.stringify(active)]);
    const matches = result.rows.map(row => ({
        pairKey: row.pair_key, drugA: row.drug_a, drugB: row.drug_b,
        severity: row.severity, ddinterIdA: row.ddinter_id_a, ddinterIdB: row.ddinter_id_b,
        sourceFile: row.source_file, prescribedA: row.prescribed_a, prescribedB: row.prescribed_b,
        source: 'DDInter 2.0', sourceUrl: 'https://ddinter2.scbdd.com/'
    }));
    if (matches.length) {
        const session = graphDriver.session();
        try {
            await session.executeWrite(tx => tx.run(`UNWIND $matches AS match
                MERGE (a:DrugConcept {key: match.drugAKey}) SET a.name = match.drugA
                MERGE (b:DrugConcept {key: match.drugBKey}) SET b.name = match.drugB
                MERGE (a)-[r:DDI_REFERENCE {pairKey: match.pairKey}]->(b)
                SET r.source = 'DDInter 2.0', r.level = match.severity, r.sourceFile = match.sourceFile,
                    r.ddinterIdA = match.ddinterIdA, r.ddinterIdB = match.ddinterIdB,
                    r.sourceUrl = 'https://ddinter2.scbdd.com/', r.updatedAt = datetime()`, {
                matches: matches.map(match => ({ ...match, drugAKey: normalizeReferenceDrug(match.drugA), drugBKey: normalizeReferenceDrug(match.drugB) }))
            }));
        } finally { await session.close(); }
    }
    return matches;
}

async function getReferenceDataHealth() {
    await initializeClinicalStores();
    const result = await pool.query(`SELECT d.dataset_key, d.version_hash, d.row_count, d.imported_at, d.license, d.source_url
        FROM clinical_reference_datasets d WHERE d.dataset_key = 'DDInter 2.0'`);
    const row = result.rows[0];
    return row ? { status: 'READY', name: row.dataset_key, version: row.version_hash, rowCount: row.row_count,
        importedAt: row.imported_at, license: row.license, sourceUrl: row.source_url } : { status: 'NOT_CONFIGURED', name: 'DDInter 2.0', rowCount: 0 };
}

async function initializeClinicalStores() {
    if (!schemaReady) {
        schemaReady = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS clinical_profiles (
                    patient_id TEXT PRIMARY KEY,
                    profile JSONB NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS app_users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
                    expires_at TIMESTAMPTZ NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS prescription_scans (
                    scan_id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL,
                    model_used TEXT,
                    ocr_source TEXT,
                    medications JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS prescription_scans_patient_created_idx
                    ON prescription_scans (patient_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS safety_analyses (
                    analysis_id TEXT PRIMARY KEY,
                    scan_id TEXT,
                    patient_id TEXT NOT NULL,
                    risk_score INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    result JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS safety_analyses_patient_created_idx
                    ON safety_analyses (patient_id, created_at DESC)
                ;CREATE TABLE IF NOT EXISTS clinical_rule_catalog (
                    rule_key TEXT PRIMARY KEY,
                    vector TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    rule JSONB NOT NULL,
                    catalog_version TEXT NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS clinical_audit_chain (
                    sequence BIGSERIAL PRIMARY KEY,
                    timestamp TIMESTAMPTZ NOT NULL,
                    provider_id TEXT NOT NULL,
                    patient_id TEXT,
                    action TEXT NOT NULL,
                    record_id TEXT,
                    payload_hash TEXT NOT NULL,
                    previous_hash TEXT NOT NULL,
                    entry_hash TEXT NOT NULL UNIQUE
                );
                CREATE TABLE IF NOT EXISTS ddinter_interactions (
                    pair_key TEXT PRIMARY KEY,
                    drug_a TEXT NOT NULL,
                    drug_a_normalized TEXT NOT NULL,
                    drug_b TEXT NOT NULL,
                    drug_b_normalized TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    ddinter_id_a TEXT,
                    ddinter_id_b TEXT,
                    source_file TEXT NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS ddinter_drug_a_idx ON ddinter_interactions (drug_a_normalized);
                CREATE INDEX IF NOT EXISTS ddinter_drug_b_idx ON ddinter_interactions (drug_b_normalized);
                CREATE TABLE IF NOT EXISTS clinical_reference_datasets (
                    dataset_key TEXT PRIMARY KEY,
                    version_hash TEXT NOT NULL,
                    row_count INTEGER NOT NULL,
                    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    license TEXT NOT NULL,
                    source_url TEXT NOT NULL
                )
            `);
            if (!graphDriver) return; // Keep PostgreSQL-backed accounts available while Neo4j is offline.
            const session = graphDriver.session();
            try {
                await session.run('CREATE CONSTRAINT anuvaad_patient_id IF NOT EXISTS FOR (p:Patient) REQUIRE p.patientId IS UNIQUE');
                await session.run('CREATE CONSTRAINT anuvaad_concept_key IF NOT EXISTS FOR (c:ClinicalConcept) REQUIRE c.key IS UNIQUE');
                await session.run('CREATE CONSTRAINT anuvaad_medication_key IF NOT EXISTS FOR (m:Medication) REQUIRE m.key IS UNIQUE');
                await session.run('CREATE CONSTRAINT anuvaad_scan_id IF NOT EXISTS FOR (s:PrescriptionScan) REQUIRE s.scanId IS UNIQUE');
                await session.run('CREATE CONSTRAINT anuvaad_finding_id IF NOT EXISTS FOR (f:SafetyFinding) REQUIRE f.findingId IS UNIQUE');
                await session.run('CREATE CONSTRAINT anuvaad_rule_key IF NOT EXISTS FOR (r:ClinicalRule) REQUIRE r.key IS UNIQUE');
                await session.run('CREATE CONSTRAINT anuvaad_drug_concept_key IF NOT EXISTS FOR (d:DrugConcept) REQUIRE d.key IS UNIQUE');
            } finally {
                await session.close();
            }
        })().catch(error => {
            schemaReady = null;
            throw error;
        });
    }
    return schemaReady;
}

async function getClinicalStoreHealth() {
    const health = { postgresql: 'unavailable', neo4j: 'unavailable' };
    try {
        await pool.query('SELECT 1');
        health.postgresql = 'connected';
    } catch (_) { }
    if (graphDriver) {
        try {
            const session = graphDriver.session();
            try {
                await session.run('RETURN 1 AS ok');
                health.neo4j = 'connected';
            } finally { await session.close(); }
        } catch (_) { }
    }
    return health;
}

function list(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') return String(item.name || item.display || item.label || '').trim();
        return '';
    }).filter(Boolean);
}

function medicationRows(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        const med = typeof item === 'string' ? { name: item } : item || {};
        const name = String(med.name || med.brandName || med.display || '').trim();
        if (!name) return null;
        const resolution = med.medicineResolution?.status === 'verified' ? med.medicineResolution : null;
        const rxcui = String(med.rxNormCui || med.rxcui || resolution?.selected?.rxcui || '').trim();
        const ingredient = String(med.ingredient || med.activeIngredient || med.genericName || (resolution ? (med.ingredients || []).join(', ') : '')).trim();
        const therapeuticClass = String(med.therapeuticClass || med.className || med.drugClass || (resolution ? resolution.therapeuticClass : '') || '').trim();
        const key = rxcui ? `rxcui:${rxcui}` : `name:${(ingredient || name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        const terms = [...new Set([name, ...ingredient.split(/[,;+]/).map(term => term.trim())].filter(Boolean))];
        const inferredClasses = [];
        for (const [classKey, members] of therapeuticClassMembers) {
            if (members.some(member => terms.some(term => term.toLowerCase().includes(member) || member.includes(term.toLowerCase())))) inferredClasses.push(classKey);
        }
        const classes = [...new Set([...inferredClasses, ...(therapeuticClass ? [therapeuticClass.toLowerCase().replace(/[^a-z0-9]+/g, '_')] : [])])];
        return { key, name, rxcui, ingredient, therapeuticClass, terms, classes };
    }).filter(Boolean);
}

async function persistProfile(profile) {
    await initializeClinicalStores();
    await pool.query(
        `INSERT INTO clinical_profiles (patient_id, profile, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (patient_id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = NOW()`,
        [String(profile.id), JSON.stringify(profile)]
    );
    await syncPatientGraph(profile);
}

async function createUser({ id, email, passwordHash, displayName, createdAt }) {
    await initializeClinicalStores();
    return pool.query(`INSERT INTO app_users (id, email, password_hash, display_name, created_at)
        VALUES ($1, $2, $3, $4, $5)`, [id, email, passwordHash, displayName, createdAt]);
}

async function syncRuleCatalog(catalog) {
    await initializeClinicalStores();
    const version = String(catalog.version || 'local-rules-1');
    const rows = [
        ...(Array.isArray(catalog.drugInteractions) ? catalog.drugInteractions.map((rule, index) => ({ key: `interaction:${index}`, vector: 'drug_drug', rule })) : []),
        ...(Array.isArray(catalog.contraindications) ? catalog.contraindications.map((rule, index) => ({ key: `contraindication:${index}`, vector: rule.condition ? 'condition_surgery_organ' : 'patient_factor', rule })) : []),
        ...(Array.isArray(catalog.ageRules) ? catalog.ageRules.map((rule, index) => ({ key: `age:${index}`, vector: 'dose_age', rule })) : []),
        ...Object.entries(catalog.allergies || {}).map(([allergy, rule]) => ({ key: `allergy:${allergy}`, vector: 'allergy', rule: { allergy, ...rule } }))
    ];
    const classEntries = Object.entries(catalog.therapeuticClasses || {});
    therapeuticClassMembers = new Map(classEntries.map(([key, members]) => [key, (members || []).map(member => String(member).toLowerCase())]));
    const transaction = await pool.connect();
    try {
        await transaction.query('BEGIN');
        await transaction.query('DELETE FROM clinical_rule_catalog WHERE catalog_version <> $1', [version]);
        for (const item of rows) {
            await transaction.query(`INSERT INTO clinical_rule_catalog (rule_key, vector, severity, rule, catalog_version)
                VALUES ($1, $2, $3, $4::jsonb, $5)
                ON CONFLICT (rule_key) DO UPDATE SET vector = EXCLUDED.vector,
                    severity = EXCLUDED.severity, rule = EXCLUDED.rule,
                    catalog_version = EXCLUDED.catalog_version, updated_at = NOW()`,
            [item.key, item.vector, String(item.rule.severity || 'REVIEW'), JSON.stringify(item.rule), version]);
        }
        await transaction.query('COMMIT');
    } catch (error) {
        await transaction.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { transaction.release(); }

    const session = graphDriver.session();
    try {
        await session.executeWrite(async tx => {
            await tx.run(`MATCH (r:ClinicalRule) WHERE r.catalogVersion <> $version DETACH DELETE r`, { version });
            await tx.run(`UNWIND $rows AS item
                MERGE (r:ClinicalRule {key: item.key})
                SET r.vector = item.vector, r.severity = item.severity,
                    r.rule = item.rule, r.allergy = item.allergy,
                    r.condition = item.condition, r.surgery = item.surgery,
                    r.catalogVersion = $version, r.updatedAt = datetime()
                WITH r, item
                UNWIND item.terms AS term
                WITH r, term, toLower(trim(term)) AS key
                MERGE (d:DrugConcept {key: key}) SET d.name = trim(term)
                MERGE (r)-[:INVOLVES_DRUG]->(d)`, {
                version,
                rows: rows.map(item => ({
                    ...item,
                    severity: String(item.rule.severity || 'REVIEW'),
                    rule: JSON.stringify(item.rule),
                    allergy: item.rule.allergy || '', condition: item.rule.condition || '', surgery: item.rule.surgery || '',
                    classes: [...(item.rule.drugs || []), ...(item.rule.contraindicatedDrugs || [])].map(String).filter(term => catalog.therapeuticClasses?.[term]),
                    terms: [item.rule.drug, item.rule.allergy, ...(item.rule.drugs || []), ...(item.rule.contraindicatedDrugs || []), ...(item.rule.relatedDrugs || []), ...(item.rule.crossAllergies || [])].filter(Boolean).map(String)
                }))
            });
            await tx.run(`MATCH (rule:ClinicalRule {catalogVersion: $version}) UNWIND $classKeys AS classKey
                MERGE (c:TherapeuticClass {key: classKey}) SET c.name = classKey
                MERGE (rule)-[:INVOLVES_CLASS]->(c)`, { version, classKeys: [...new Set(rows.flatMap(item => [...(item.rule.drugs || []), ...(item.rule.contraindicatedDrugs || [])]).filter(term => catalog.therapeuticClasses?.[term]))] });
            await tx.run(`MATCH (:DrugConcept)-[membership:IN_CLASS]->(:TherapeuticClass) DELETE membership`);
            await tx.run(`UNWIND $classes AS classRow
                MERGE (c:TherapeuticClass {key: classRow.key}) SET c.name = classRow.name
                WITH c, classRow
                UNWIND classRow.drugs AS drugName
                WITH c, drugName, toLower(trim(drugName)) AS key
                MERGE (d:DrugConcept {key: key}) SET d.name = trim(drugName)
                MERGE (d)-[:IN_CLASS]->(c)`, {
                classes: classEntries.map(([name, drugs]) => ({ key: name, name, drugs: Array.isArray(drugs) ? drugs : [] }))
            });
            await tx.run(`MATCH (r:ClinicalRule {catalogVersion: $version})
                UNWIND CASE WHEN r.condition IS NULL OR r.condition = '' THEN [] ELSE [r.condition] END AS condition
                WITH r, condition, toLower(trim(condition)) AS key
                MERGE (c:ClinicalConcept {key: key}) SET c.name = condition
                MERGE (r)-[:WHEN_CONDITION]->(c)`, { version });
            await tx.run(`MATCH (r:ClinicalRule {catalogVersion: $version})
                UNWIND CASE WHEN r.surgery IS NULL OR r.surgery = '' THEN [] ELSE [r.surgery] END AS surgery
                WITH r, surgery, toLower(trim(surgery)) AS key
                MERGE (c:ClinicalConcept {key: key}) SET c.name = surgery
                MERGE (r)-[:WHEN_SURGERY]->(c)`, { version });
        });
    } finally { await session.close(); }
    return { version, rules: rows.length, therapeuticClasses: classEntries.length };
}

async function queryGraphFindings({ patientId, scanId, medications }) {
    await initializeClinicalStores();
    const terms = medicationRows(medications).map(med => [med.name, med.ingredient].filter(Boolean).join(' ').toLowerCase());
    if (!terms.length) return [];
    const session = graphDriver.session();
    try {
        const result = await session.run(`
            MATCH (p:Patient {patientId: $patientId})-[contextRel]->(context)
            WHERE type(contextRel) IN ['HAS_CONDITION','HAS_SURGERY','HAS_ALLERGY','TAKES']
            WITH p, collect({type: type(contextRel), name: toLower(coalesce(context.name, ''))}) AS contextTerms
            UNWIND $terms AS enteredTerm
            MATCH (rule:ClinicalRule)-[:INVOLVES_DRUG]->(target:DrugConcept)
            WHERE any(term IN $terms WHERE term CONTAINS target.key OR target.key CONTAINS term)
            AND (
                EXISTS { MATCH (rule)-[:WHEN_CONDITION]->(condition:ClinicalConcept) WHERE any(context IN contextTerms WHERE context.type = 'HAS_CONDITION' AND (context.name CONTAINS condition.key OR condition.key CONTAINS context.name)) }
                OR EXISTS { MATCH (rule)-[:WHEN_SURGERY]->(surgery:ClinicalConcept) WHERE any(context IN contextTerms WHERE context.type = 'HAS_SURGERY' AND (context.name CONTAINS surgery.key OR surgery.key CONTAINS context.name)) }
                OR rule.vector = 'allergy' AND any(context IN contextTerms WHERE context.type = 'HAS_ALLERGY' AND (context.name CONTAINS toLower(rule.allergy) OR toLower(rule.allergy) CONTAINS context.name))
            )
            RETURN DISTINCT rule.key AS key, rule.vector AS vector, rule.severity AS severity,
                rule.rule AS rule, target.name AS matchedDrug
            LIMIT 100`, { patientId: String(patientId), terms });
        const findings = result.records.map(record => ({
            ruleKey: record.get('key'), vector: record.get('vector'), severity: record.get('severity'),
            rule: JSON.parse(record.get('rule')), matchedDrug: record.get('matchedDrug')
        }));
        if (scanId) {
            const interactions = await session.run(`
                MATCH (p:Patient {patientId: $patientId})-[:TAKES]->(home:Medication)
                MATCH (s:PrescriptionScan {scanId: $scanId})-[:PRESCRIBES]->(prescribed:Medication)
                MATCH (rule:ClinicalRule {vector: 'drug_drug'})-[:INVOLVES_CLASS]->(classA:TherapeuticClass)
                MATCH (rule)-[:INVOLVES_CLASS]->(classB:TherapeuticClass)
                WHERE classA.key <> classB.key
                  AND ((home)-[:HAS_CLASS]->(classA) AND (prescribed)-[:HAS_CLASS]->(classB)
                    OR (home)-[:HAS_CLASS]->(classB) AND (prescribed)-[:HAS_CLASS]->(classA))
                RETURN DISTINCT rule.key AS key, rule.vector AS vector, rule.severity AS severity,
                    rule.rule AS rule, home.name AS homeMedicine, prescribed.name AS prescribedMedicine
                LIMIT 100`, { patientId: String(patientId), scanId: String(scanId) });
            interactions.records.forEach(record => findings.push({
                ruleKey: record.get('key'), vector: record.get('vector'), severity: record.get('severity'),
                rule: JSON.parse(record.get('rule')),
                matchedDrug: `${record.get('homeMedicine')} + ${record.get('prescribedMedicine')}`
            }));
        }
        return [...new Map(findings.map(item => [`${item.ruleKey}:${item.matchedDrug}`, item])).values()];
    } finally { await session.close(); }
}

async function getUserByEmail(email) {
    await initializeClinicalStores();
    const result = await pool.query(`SELECT id, email, password_hash AS "passwordHash", display_name AS "displayName"
        FROM app_users WHERE email = $1`, [email]);
    return result.rows[0] || null;
}

async function storeSession({ tokenHash, userId, expiresAt, createdAt }) {
    await initializeClinicalStores();
    await pool.query(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
        VALUES ($1, $2, $3, $4) ON CONFLICT (token_hash) DO UPDATE
        SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`, [tokenHash, userId, expiresAt, createdAt]);
}

async function findUserBySession(tokenHash, currentTime) {
    await initializeClinicalStores();
    const result = await pool.query(`SELECT u.id, u.email, u.display_name AS "displayName", s.expires_at AS "expiresAt", s.created_at AS "createdAt"
        FROM auth_sessions s JOIN app_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2`, [tokenHash, currentTime]);
    return result.rows[0] || null;
}

async function removeSession(tokenHash) {
    await initializeClinicalStores();
    await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash]);
}

async function appendAuditRecord({ patientId = null, providerId, action, recordId = null, details = {} }) {
    await initializeClinicalStores();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [687431902]);
        const prior = await client.query('SELECT entry_hash FROM clinical_audit_chain ORDER BY sequence DESC LIMIT 1');
        const timestamp = new Date().toISOString();
        const previousHash = prior.rows[0]?.entry_hash || 'GENESIS';
        const payloadHash = sha256(JSON.stringify(details || {}));
        const canonical = JSON.stringify({ timestamp, providerId, patientId, action, recordId, payloadHash, previousHash });
        const entryHash = sha256(canonical);
        const inserted = await client.query(`INSERT INTO clinical_audit_chain
            (timestamp, provider_id, patient_id, action, record_id, payload_hash, previous_hash, entry_hash)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING sequence`,
        [timestamp, providerId, patientId, action, recordId, payloadHash, previousHash, entryHash]);
        await client.query('COMMIT');
        return { sequence: Number(inserted.rows[0].sequence), timestamp, providerId, patientId, action, recordId, payloadHash, previousHash, entryHash };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
}

async function verifyAuditRecords(limit = 100) {
    await initializeClinicalStores();
    const result = await pool.query(`SELECT sequence, timestamp, provider_id, patient_id, action, record_id,
        payload_hash, previous_hash, entry_hash FROM clinical_audit_chain ORDER BY sequence ASC`);
    let previousHash = 'GENESIS';
    let valid = true;
    const entries = result.rows.map(row => {
        const timestamp = new Date(row.timestamp).toISOString();
        const entry = { sequence: Number(row.sequence), timestamp, providerId: row.provider_id, patientId: row.patient_id,
            action: row.action, recordId: row.record_id, payloadHash: row.payload_hash,
            previousHash: row.previous_hash, entryHash: row.entry_hash };
        const expected = sha256(JSON.stringify({ timestamp, providerId: entry.providerId, patientId: entry.patientId,
            action: entry.action, recordId: entry.recordId, payloadHash: entry.payloadHash, previousHash: entry.previousHash }));
        entry.verified = entry.previousHash === previousHash && entry.entryHash === expected;
        if (!entry.verified) valid = false;
        previousHash = entry.entryHash;
        return entry;
    });
    const capped = Math.max(1, Math.min(1000, Number(limit) || 100));
    return { valid, count: entries.length, entries: entries.slice(-capped).reverse() };
}

async function loadProfile(patientId) {
    await initializeClinicalStores();
    const result = await pool.query('SELECT profile FROM clinical_profiles WHERE patient_id = $1', [String(patientId)]);
    return result.rows[0]?.profile || null;
}

async function syncPatientGraph(profile) {
    await initializeClinicalStores();
    const patientId = String(profile.id);
    const conditions = list(profile.medicalHistory);
    const surgeries = list(profile.surgicalHistory);
    const allergies = list(profile.allergies);
    const alerts = list(profile.clinicalAlerts);
    const activeMeds = medicationRows(profile.currentMedications);
    const session = graphDriver.session();
    try {
        await session.executeWrite(async tx => {
            await tx.run('MERGE (p:Patient {patientId: $patientId}) SET p.name = $name, p.age = $age, p.gender = $gender, p.updatedAt = datetime()', {
                patientId, name: String(profile.fullName || ''), age: Number.isFinite(Number(profile.age)) ? Number(profile.age) : null, gender: String(profile.gender || '')
            });
            await tx.run(`MATCH (p:Patient {patientId: $patientId})-[r]->(n)
                          WHERE type(r) IN ['HAS_CONDITION','HAS_SURGERY','HAS_ALLERGY','HAS_ALERT','TAKES']
                          DELETE r`, { patientId });
            for (const [relationship, values] of [['HAS_CONDITION', conditions], ['HAS_SURGERY', surgeries], ['HAS_ALLERGY', allergies], ['HAS_ALERT', alerts]]) {
                if (!values.length) continue;
                await tx.run(`MATCH (p:Patient {patientId: $patientId})
                              UNWIND $values AS value
                              WITH p, value, toLower(trim(value)) AS key
                              MERGE (c:ClinicalConcept {key: key}) SET c.name = value
                              MERGE (p)-[:${relationship}]->(c)`, { patientId, values });
            }
            if (activeMeds.length) {
                await tx.run(`MATCH (p:Patient {patientId: $patientId})
                              UNWIND $meds AS med
                              MERGE (m:Medication {key: med.key})
                              SET m.name = med.name, m.rxcui = med.rxcui,
                                  m.ingredient = med.ingredient, m.therapeuticClass = med.therapeuticClass
                              MERGE (p)-[:TAKES]->(m)
                              FOREACH (term IN med.terms |
                                  MERGE (d:DrugConcept {key: toLower(trim(term))}) SET d.name = trim(term)
                                  MERGE (m)-[:IS_DRUG]->(d))
                              FOREACH (classKey IN med.classes |
                                  MERGE (c:TherapeuticClass {key: classKey}) SET c.name = classKey
                                  MERGE (m)-[:HAS_CLASS]->(c))
                              FOREACH (ingredientName IN CASE WHEN med.ingredient = '' THEN [] ELSE split(med.ingredient, ', ') END |
                                  MERGE (i:Ingredient {key: toLower(trim(ingredientName))}) SET i.name = trim(ingredientName)
                                  MERGE (m)-[:HAS_INGREDIENT]->(i))
                              FOREACH (className IN CASE WHEN med.therapeuticClass = '' THEN [] ELSE [med.therapeuticClass] END |
                                  MERGE (c:TherapeuticClass {key: toLower(trim(className))}) SET c.name = trim(className)
                                  MERGE (m)-[:IN_CLASS]->(c))`, { patientId, meds: activeMeds });
            }
        });
    } finally { await session.close(); }
}

async function loadGraphContext(patientId) {
    await initializeClinicalStores();
    const session = graphDriver.session();
    try {
        const result = await session.run(`MATCH (p:Patient {patientId: $patientId})
            OPTIONAL MATCH (p)-[:HAS_CONDITION]->(condition:ClinicalConcept)
            WITH p, collect(DISTINCT condition.name) AS conditions
            OPTIONAL MATCH (p)-[:HAS_SURGERY]->(surgery:ClinicalConcept)
            WITH p, conditions, collect(DISTINCT surgery.name) AS surgeries
            OPTIONAL MATCH (p)-[:HAS_ALLERGY]->(allergy:ClinicalConcept)
            WITH p, conditions, surgeries, collect(DISTINCT allergy.name) AS allergies
            OPTIONAL MATCH (p)-[:HAS_ALERT]->(alert:ClinicalConcept)
            WITH p, conditions, surgeries, allergies, collect(DISTINCT alert.name) AS alerts
            OPTIONAL MATCH (p)-[:TAKES]->(medication:Medication)
            RETURN conditions, surgeries, allergies, alerts,
                   collect(DISTINCT CASE WHEN medication IS NULL THEN null ELSE {name: medication.name, rxNormCui: medication.rxcui, ingredient: medication.ingredient, therapeuticClass: medication.therapeuticClass} END) AS medications`,
        { patientId: String(patientId) });
        const row = result.records[0];
        if (!row) return null;
        const asList = key => row.get(key).filter(Boolean);
        return {
            medicalHistory: asList('conditions'), surgicalHistory: asList('surgeries'),
            allergies: asList('allergies'), clinicalAlerts: asList('alerts'), currentMedications: asList('medications')
        };
    } finally { await session.close(); }
}

async function persistPrescription({ scanId, patientId, modelUsed, ocrSource, medications }) {
    await initializeClinicalStores();
    await pool.query(`INSERT INTO prescription_scans (scan_id, patient_id, model_used, ocr_source, medications)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (scan_id) DO UPDATE SET model_used = EXCLUDED.model_used,
            ocr_source = EXCLUDED.ocr_source, medications = EXCLUDED.medications`,
    [scanId, String(patientId), modelUsed || null, ocrSource || null, JSON.stringify(medications || [])]);

    const session = graphDriver.session();
    try {
        await session.executeWrite(async tx => {
            await tx.run('MERGE (p:Patient {patientId: $patientId}) MERGE (s:PrescriptionScan {scanId: $scanId}) SET s.modelUsed = $modelUsed, s.createdAt = datetime() MERGE (s)-[:FOR_PATIENT]->(p)',
                { patientId: String(patientId), scanId, modelUsed: modelUsed || '' });
            const meds = medicationRows(medications);
            if (meds.length) await tx.run(`MATCH (s:PrescriptionScan {scanId: $scanId})
                UNWIND $meds AS med
                MERGE (m:Medication {key: med.key})
                SET m.name = med.name, m.rxcui = med.rxcui, m.ingredient = med.ingredient, m.therapeuticClass = med.therapeuticClass
                MERGE (s)-[:PRESCRIBES]->(m)
                FOREACH (term IN med.terms |
                    MERGE (d:DrugConcept {key: toLower(trim(term))}) SET d.name = trim(term)
                    MERGE (m)-[:IS_DRUG]->(d))
                FOREACH (classKey IN med.classes |
                    MERGE (c:TherapeuticClass {key: classKey}) SET c.name = classKey
                    MERGE (m)-[:HAS_CLASS]->(c))
                FOREACH (ingredientName IN CASE WHEN med.ingredient = '' THEN [] ELSE split(med.ingredient, ', ') END |
                    MERGE (i:Ingredient {key: toLower(trim(ingredientName))}) SET i.name = trim(ingredientName)
                    MERGE (m)-[:HAS_INGREDIENT]->(i))
                FOREACH (className IN CASE WHEN med.therapeuticClass = '' THEN [] ELSE [med.therapeuticClass] END |
                    MERGE (c:TherapeuticClass {key: toLower(trim(className))}) SET c.name = trim(className)
                    MERGE (m)-[:IN_CLASS]->(c))`, { scanId, meds });
        });
    } finally { await session.close(); }
}

async function persistAnalysis({ analysisId, scanId, patientId, evaluation }) {
    await initializeClinicalStores();
    await pool.query(`INSERT INTO safety_analyses (analysis_id, scan_id, patient_id, risk_score, status, result)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (analysis_id) DO NOTHING`,
    [analysisId, scanId || null, String(patientId), Number(evaluation.riskScore) || 0, String(evaluation.overallStatus || 'REVIEW'), JSON.stringify(evaluation)]);
    const session = graphDriver.session();
    try {
        await session.executeWrite(async tx => {
            await tx.run('MERGE (p:Patient {patientId: $patientId}) MERGE (a:SafetyAnalysis {analysisId: $analysisId}) SET a.riskScore = $riskScore, a.status = $status, a.createdAt = datetime() MERGE (a)-[:FOR_PATIENT]->(p)',
                { patientId: String(patientId), analysisId, riskScore: Number(evaluation.riskScore) || 0, status: String(evaluation.overallStatus || 'REVIEW') });
            const warnings = Array.isArray(evaluation.warnings) ? evaluation.warnings : [];
            if (warnings.length) await tx.run(`MATCH (a:SafetyAnalysis {analysisId: $analysisId})
                UNWIND $warnings AS warning
                MERGE (f:SafetyFinding {findingId: warning.findingId})
                SET f.vector = warning.vector, f.severity = warning.severity, f.title = warning.title,
                    f.description = warning.description, f.recommendation = warning.recommendation
                MERGE (a)-[:CONTAINS_FINDING]->(f)`, {
                analysisId,
                warnings: warnings.map((warning, index) => ({
                    findingId: `${analysisId}:${index}`,
                    vector: String(warning.vector || ''), severity: String(warning.severity || 'REVIEW'),
                    title: String(warning.title || warning.drug || 'Clinical finding'),
                    description: String(warning.description || warning.risk || '').slice(0, 5000),
                    recommendation: String(warning.recommendation || warning.action || '').slice(0, 2000)
                }))
            });
        });
    } finally { await session.close(); }
}

async function getStoreStats(patientId) {
    await initializeClinicalStores();
    const [scans, analyses] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS count FROM prescription_scans WHERE patient_id = $1', [String(patientId)]),
        pool.query('SELECT COUNT(*)::int AS count FROM safety_analyses WHERE patient_id = $1', [String(patientId)])
    ]);
    return { scans: scans.rows[0].count, analyses: analyses.rows[0].count };
}

async function loadPatientHistory(patientId, limit = 20) {
    await initializeClinicalStores();
    const cappedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const [scans, analyses] = await Promise.all([
        pool.query(`SELECT scan_id, model_used, medications, created_at FROM prescription_scans
                    WHERE patient_id = $1 ORDER BY created_at DESC LIMIT $2`, [String(patientId), cappedLimit]),
        pool.query(`SELECT analysis_id, risk_score, status, result, created_at FROM safety_analyses
                    WHERE patient_id = $1 ORDER BY created_at DESC LIMIT $2`, [String(patientId), cappedLimit])
    ]);
    return {
        prescriptions: scans.rows.map(row => ({ id: row.scan_id, modelUsed: row.model_used, medications: row.medications, timestamp: row.created_at })),
        safetyScans: analyses.rows.map(row => ({ id: row.analysis_id, riskScore: row.risk_score, status: row.status, warnings: row.result?.warnings || [], timestamp: row.created_at }))
    };
}

module.exports = {
    initializeClinicalStores, getClinicalStoreHealth, syncRuleCatalog, queryGraphFindings,
    importDDInterBundle, queryDDInterInteractions, getReferenceDataHealth,
    createUser, getUserByEmail, storeSession, findUserBySession, removeSession, appendAuditRecord, verifyAuditRecords,
    persistProfile, loadProfile, syncPatientGraph,
    loadGraphContext, persistPrescription, persistAnalysis, getStoreStats, loadPatientHistory,
    closeClinicalStores: async () => { await pool.end(); if (graphDriver) await graphDriver.close(); }
};
