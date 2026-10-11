const clinicalStores = require('../clinical-stores');

(async () => {
    await clinicalStores.initializeClinicalStores();
    const indexedPair = await clinicalStores.queryDDInterInteractions({
        newMedicationTerms: [{ label: 'Abacavir', terms: ['abacavir'] }],
        activeMedicationTerms: [{ label: 'Naltrexone', terms: ['naltrexone'] }]
    });
    if (!indexedPair.some(match => match.severity === 'Moderate')) {
        throw new Error('The known Abacavir + Naltrexone DDInter reference row was not returned at its source level.');
    }
    console.log('DDInter index query is working: Abacavir + Naltrexone returned at source level Moderate.');
})().catch(error => {
    console.error('DDInter index query failed:', error.message);
    process.exitCode = 1;
}).finally(async () => {
    await clinicalStores.closeClinicalStores().catch(() => {});
});
