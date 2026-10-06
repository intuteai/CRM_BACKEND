const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { requirePdiAccess } = require('../../middleware/pdiAccess');
const controller = require('../../controllers/operations/pdiReports.controller');

router.use(authenticateToken, requirePdiAccess);

router.post('/', controller.createReport);
router.get('/', controller.listReports);
router.get('/:id', controller.getReport);
router.patch('/:id', controller.patchReport);
router.get('/:id/revisions', controller.getRevisions);
router.post('/:id/duplicate', controller.duplicateReport);
router.post('/:id/finalize', controller.finalizeReport);
router.get('/:id/pdf', controller.downloadPdf);
router.delete('/:id', controller.deleteReport);

module.exports = router;
