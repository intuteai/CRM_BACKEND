// Motor-test API, mounted at /api/testing. Every route needs a valid ERP login and a testing role
// from mt_user_role (ERP Admins count as testing_admin), except /me which reports the caller's roles.
// HMI contract: docs/motor-test/contract/openapi.yaml. Web/admin contract: docs/motor-test/admin-api.md.
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { requireTestingRole } = require('../../middleware/testingRoles');
const c = require('../../controllers/testing/testing.controller');
const a = require('../../controllers/testing/admin.controller');

const CONFIG_READERS = ['operator', 'testing_head', 'viewer', 'testing_admin'];
// Operators read results so they can find a run to correct (Saatwik: operators add corrections).
const RESULT_READERS = ['operator', 'viewer', 'testing_head', 'testing_admin'];
const EXPORTERS = ['viewer', 'testing_head', 'testing_admin'];
const EDITORS = ['testing_head', 'testing_admin'];

router.use(authenticateToken);

// ---- HMI API
router.get('/me', c.me);
router.get('/operators', requireTestingRole(...CONFIG_READERS), c.listOperators);
router.get('/variants', requireTestingRole(...CONFIG_READERS), c.listVariants);
router.get('/variants/:id', requireTestingRole(...CONFIG_READERS), c.getVariant);
router.get('/criteria/:id', requireTestingRole(...CONFIG_READERS), c.getCriteria);
router.post('/results', requireTestingRole('operator'), c.postResult);
router.get('/results', requireTestingRole(...RESULT_READERS), c.listResults);
router.get('/results/:testId', requireTestingRole(...RESULT_READERS), c.getResult);

// ---- results: export and corrections
router.get('/results/:testId/export.csv', requireTestingRole(...EXPORTERS), a.exportCsv);
router.get('/results/:testId/corrections', requireTestingRole(...RESULT_READERS), a.listCorrectionsForRun);
router.post('/results/:testId/corrections', requireTestingRole('operator'), a.addCorrection);
router.post('/corrections/:id/decide', requireTestingRole(...EDITORS), a.decideCorrection);

// ---- governance (web screens)
router.get('/admin/products', requireTestingRole(...EDITORS), a.listProducts);
router.get('/admin/variants', requireTestingRole(...CONFIG_READERS), a.listVariants); // read-only views for viewers/operators
router.post('/admin/variants', requireTestingRole(...EDITORS), a.createVariant);
router.get('/admin/variants/:id', requireTestingRole(...CONFIG_READERS), a.getVariant);
router.patch('/admin/variants/:id', requireTestingRole(...EDITORS), a.updateVariant);
for (const kind of ['profiles', 'criteria']) {
  router.get(`/admin/variants/:id/${kind}`, requireTestingRole(...CONFIG_READERS), a.listVersions(kind));
  router.post(`/admin/variants/:id/${kind}`, requireTestingRole(...EDITORS), a.createVersion(kind));
  router.get(`/admin/${kind}/:id`, requireTestingRole(...CONFIG_READERS), a.getVersion(kind));
  router.patch(`/admin/${kind}/:id`, requireTestingRole(...EDITORS), a.updateDraft(kind));
  router.delete(`/admin/${kind}/:id`, requireTestingRole(...EDITORS), a.deleteDraft(kind));
  for (const action of ['submit', 'return', 'approve', 'withdraw']) {
    router.post(`/admin/${kind}/:id/${action}`, requireTestingRole(...EDITORS), a.transition(kind, action));
  }
}
router.get('/admin/operators', requireTestingRole(...EDITORS), a.listOperatorsAdmin);
router.post('/admin/operators', requireTestingRole(...EDITORS), a.createOperator);
router.patch('/admin/operators/:ref', requireTestingRole(...EDITORS), a.updateOperator);
router.get('/admin/users', requireTestingRole('testing_admin'), a.listUsers);
router.put('/admin/users/:userId/testing-roles', requireTestingRole('testing_admin'), a.setUserRoles);
router.get('/admin/corrections', requireTestingRole(...EDITORS), a.listCorrectionsAdmin);
router.get('/admin/audit', requireTestingRole(...EDITORS), a.listAudit);

module.exports = router;
module.exports.errorHandler = c.errorHandler;
