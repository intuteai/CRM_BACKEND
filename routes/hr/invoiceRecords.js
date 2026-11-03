const express = require('express');
const router = express.Router({ mergeParams: true });
const multer = require('multer');
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/hr/invoiceRecords.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Intute AI invoices (/ia-invoices): Intute AI roles only.
router.use(authenticateToken, requireRoles(ROLES.IA_EMPLOYEE, ROLES.IA_HR));

router.get('/', controller.getAll);
router.post('/', controller.create);
router.post('/upload', upload.single('file'), controller.uploadOld);
router.get('/:id/pdf', controller.downloadPdf);
router.get('/:id', controller.getOne);
router.delete('/:id', controller.delete);

module.exports = router;
