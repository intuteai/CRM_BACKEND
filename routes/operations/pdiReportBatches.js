const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdiReportBatches.controller');

router.post('/', authenticateToken, controller.createBatch);
router.get('/:batchId', authenticateToken, controller.getBatch);
router.post('/:batchId/finalize', authenticateToken, controller.finalizeBatch);
router.get('/:batchId/pdf', authenticateToken, controller.downloadBatchPdf);

module.exports = router;
