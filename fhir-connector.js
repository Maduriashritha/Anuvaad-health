'use strict';

function entriesOf(bundle) {
    if (!bundle || bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) {
        throw new TypeError('Expected a FHIR R4 Bundle with an entry array.');
    }
    return bundle.entry.map(entry => entry?.resource).filter(resource => resource && typeof resource.resourceType === 'string');
}

function conceptText(concept) {
    if (!concept) return '';
    return String(concept.text || concept.coding?.find(item => item.display)?.display || concept.coding?.[0]?.code || '').trim();
}

function medicationText(resource, resources) {
    let concept = resource.medicationCodeableConcept;
    if (!concept && resource.medicationReference?.reference) {
        const reference = resource.medicationReference.reference;
        const found = resources.find(item => reference.endsWith(`/${item.id}`) || reference === `#${item.id}`);
        concept = found?.code || found?.medicationCodeableConcept;
    }
    const name = conceptText(concept);
    const instructions = (resource.dosageInstruction || []).map(item => {
        const dose = item.doseAndRate?.map(value => value.doseQuantity ? `${value.doseQuantity.value ?? ''} ${value.doseQuantity.unit || ''}`.trim() : '').filter(Boolean).join('; ');
        return [item.text, dose, conceptText(item.route), item.timing?.code?.text].filter(Boolean).join(' · ');
    }).filter(Boolean).join(' | ');
    return [name, instructions].filter(Boolean).join(' — ');
}

function getLoinc(observation) {
    return (observation.code?.coding || []).some(coding => coding.system === 'http://loinc.org')
        ? observation.code.coding.filter(coding => coding.system === 'http://loinc.org').map(coding => coding.code)
        : [];
}

function mapFhirBundleToSuggestions(bundle) {
    const resources = entriesOf(bundle);
    const first = resources.find(resource => resource.resourceType === 'Patient');
    if (!first) throw new TypeError('The FHIR Bundle does not contain a Patient resource.');
    const today = new Date();
    let age = '';
    if (first.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(first.birthDate)) {
        const birth = new Date(`${first.birthDate}T00:00:00Z`);
        if (!Number.isNaN(birth.getTime()) && birth <= today) {
            age = today.getUTCFullYear() - birth.getUTCFullYear();
            if (today.getUTCMonth() < birth.getUTCMonth() || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate())) age--;
            age = String(age);
        }
    }
    const name = (first.name || []).find(item => item.use === 'official') || first.name?.[0];
    const fullName = name ? [name.text, [...(name.given || []), name.family].filter(Boolean).join(' ')].find(Boolean) || '' : '';
    const statusOf = resource => resource.status || resource.clinicalStatus?.coding?.[0]?.code || 'status not supplied';
    const conditions = resources.filter(item => item.resourceType === 'Condition')
        .map(item => ({ text: conceptText(item.code), status: statusOf(item), verification: item.verificationStatus?.coding?.[0]?.code || 'not supplied' }))
        .filter(item => item.text && !['entered-in-error'].includes(item.status));
    const surgeries = resources.filter(item => item.resourceType === 'Procedure' && item.status !== 'entered-in-error')
        .map(item => ({ text: [conceptText(item.code), item.status || 'status not supplied'].filter(Boolean).join(' · '), status: item.status || 'unknown' })).filter(item => item.text);
    const allergies = resources.filter(item => item.resourceType === 'AllergyIntolerance' && item.verificationStatus?.coding?.[0]?.code !== 'entered-in-error')
        .map(item => {
            const substance = conceptText(item.code) || 'Unspecified substance';
            const reaction = (item.reaction || []).flatMap(entry => (entry.manifestation || []).map(conceptText)).filter(Boolean);
            return { text: substance, status: item.clinicalStatus?.coding?.[0]?.code || 'status not supplied', reaction };
        });
    const activeMeds = resources.filter(item => item.resourceType === 'MedicationRequest' && item.status === 'active')
        .map(item => medicationText(item, resources)).filter(Boolean);
    const medicationStatements = resources.filter(item => item.resourceType === 'MedicationStatement')
        .map(item => ({ text: medicationText(item, resources), status: statusOf(item) })).filter(item => item.text);
    const pastMeds = medicationStatements.filter(item => ['stopped', 'completed', 'not-taken', 'on-hold'].includes(item.status)).map(item => `${item.text} (${item.status})`);
    const currentStatements = medicationStatements.filter(item => ['active', 'intended'].includes(item.status)).map(item => item.text);
    const weightObservation = resources.find(item => item.resourceType === 'Observation' && getLoinc(item).includes('2947-0') && item.status === 'final');
    const egfrObservation = resources.find(item => item.resourceType === 'Observation' && getLoinc(item).some(code => ['33914-3', '48642-3', '62238-1', '98979-8'].includes(code)) && item.status === 'final');
    const weightKg = weightObservation?.valueQuantity?.value ? String(weightObservation.valueQuantity.code === 'lb' ? Number(weightObservation.valueQuantity.value) * 0.45359237 : weightObservation.valueQuantity.value) : '';
    const egfr = egfrObservation?.valueQuantity?.value != null ? String(egfrObservation.valueQuantity.value) : '';
    const pregnancy = resources.filter(item => item.resourceType === 'Condition').map(item => conceptText(item.code)).filter(value => /pregnan/i.test(value));
    const clinicalAlerts = [...pregnancy, ...(egfr && Number(egfr) < 60 ? [`Low eGFR in imported Observation (${egfr})`] : [])];
    const priorReactions = allergies.flatMap(item => item.reaction.map(reaction => `${item.text}: ${reaction}`));
    return {
        fullName, age, gender: ({ male: 'Male', female: 'Female', other: 'Other', unknown: 'Prefer not to say' })[first.gender] || 'Prefer not to say',
        medicalConditions: conditions.map(item => `${item.text} (FHIR status: ${item.status}; verification: ${item.verification})`),
        surgeries: surgeries.map(item => item.text), allergies: allergies.map(item => `${item.text} (FHIR status: ${item.status})`),
        currentMedicines: [...new Set([...activeMeds, ...currentStatements])], pastMedicines: pastMeds,
        priorReactions, clinicalAlerts, weightKg, egfr,
        source: { resourceType: 'Bundle', fhirVersion: 'R4', patientId: first.id || '', resourceCount: resources.length }
    };
}

function toFhirBundle(profile, patientId) {
    const id = String(patientId || 'anuvaad-patient').replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 64);
    const gender = ({ male: 'male', female: 'female', other: 'other' })[String(profile.gender || '').toLowerCase()] || 'unknown';
    const names = String(profile.fullName || '').trim().split(/\s+/).filter(Boolean);
    const resources = [{
        resourceType: 'Patient', id,
        name: names.length ? [{ text: names.join(' '), family: names.length > 1 ? names.at(-1) : undefined, given: names.length > 1 ? names.slice(0, -1) : names }] : undefined,
        gender
    }];
    (profile.medicalHistory || []).forEach((text, index) => resources.push({ resourceType: 'Condition', id: `condition-${index + 1}`, subject: { reference: `Patient/${id}` }, code: { text: String(text) } }));
    (profile.surgicalHistory || []).forEach((text, index) => resources.push({ resourceType: 'Procedure', id: `procedure-${index + 1}`, subject: { reference: `Patient/${id}` }, status: 'completed', code: { text: String(text) } }));
    (profile.allergies || []).forEach((text, index) => resources.push({ resourceType: 'AllergyIntolerance', id: `allergy-${index + 1}`, patient: { reference: `Patient/${id}` }, code: { text: String(text) }, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'unconfirmed' }] } }));
    (profile.currentMedications || []).forEach((text, index) => resources.push({ resourceType: 'MedicationStatement', id: `current-medication-${index + 1}`, subject: { reference: `Patient/${id}` }, status: 'active', medicationCodeableConcept: { text: String(text) } }));
    (profile.pastMedications || []).forEach((text, index) => resources.push({ resourceType: 'MedicationStatement', id: `past-medication-${index + 1}`, subject: { reference: `Patient/${id}` }, status: 'stopped', medicationCodeableConcept: { text: String(text) } }));
    (profile.clinicalAlerts || []).forEach((text, index) => resources.push({ resourceType: 'Flag', id: `clinical-alert-${index + 1}`, subject: { reference: `Patient/${id}` }, status: 'active', code: { text: String(text) } }));
    return { resourceType: 'Bundle', type: 'collection', meta: { profile: ['http://hl7.org/fhir/StructureDefinition/Bundle'] }, entry: resources.map(resource => ({ resource })) };
}

module.exports = { mapFhirBundleToSuggestions, toFhirBundle };
