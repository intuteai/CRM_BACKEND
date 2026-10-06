const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { requirePdiAccess } = require('../../middleware/pdiAccess');
const controller = require('../../controllers/operations/pdiReportBatches.controller');

router.use(authenticateToken, requirePdiAccess);

router.get('/', controller.listBatches);
router.post('/', controller.createBatch);
router.get('/:batchId', controller.getBatch);
router.patch('/:batchId', controller.updateBatch);
router.delete('/:batchId', controller.deleteBatch);
router.post('/:batchId/finalize', controller.finalizeBatch);
router.get('/:batchId/pdf', controller.downloadBatchPdf);

module.exports = router;
