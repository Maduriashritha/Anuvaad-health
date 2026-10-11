const clinicalStores = require('../clinical-stores');

(async () => {
    await clinicalStores.initializeClinicalStores();
    const result = await clinicalStores.importDDInterBundle();
    if (result.status !== 'READY') {
        console.error('DDInter import was not completed. Missing files:', (result.missing || []).join(', '));
        process.exitCode = 1;
        return;
    }
    console.log(`DDInter 2.0 is ${result.unchanged ? 'already current' : 'imported'}: ${Number(result.rows).toLocaleString()} unique pair records.`);
    console.log('The imported subset is noncommercial CC BY-NC-SA 4.0; see data/DDINTER-NOTICE.md.');
})().catch(error => {
    console.error('DDInter import failed:', error.message);
    process.exitCode = 1;
}).finally(async () => {
    await clinicalStores.closeClinicalStores().catch(() => {});
});
