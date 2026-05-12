const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/service/serviceRepair.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authenticateToken);
router.get('/',    checkPermission('ServiceRepair', 'can_read'),  controller.getAll);
router.get('/:id', checkPermission('ServiceRepair', 'can_read'),  controller.getById);
router.post('/',   checkPermission('ServiceRepair', 'can_write'), controller.create);
router.put('/:id',    checkPermission('ServiceRepair', 'can_write'),  controller.update);
router.delete('/:id', checkPermission('ServiceRepair', 'can_delete'), controller.remove);

router.post('/:id/photo',                   checkPermission('ServiceRepair', 'can_write'), upload.single('photo'), controller.uploadPhoto);
router.post('/:id/chalan-photo',            checkPermission('ServiceRepair', 'can_write'), upload.single('photo'), controller.uploadChalanPhoto);
router.post('/:id/delivery-challan-photo',  checkPermission('ServiceRepair', 'can_write'), upload.single('photo'), controller.uploadDeliveryChallanPhoto);
router.post('/:id/fault-photo',             checkPermission('ServiceRepair', 'can_write'), upload.single('photo'), controller.uploadFaultPhoto);
router.post('/:id/actual-issue-photo',      checkPermission('ServiceRepair', 'can_write'), upload.single('photo'), controller.uploadActualIssuePhoto);
router.post('/:id/repaired-photo',          checkPermission('ServiceRepair', 'can_write'), upload.single('photo'), controller.uploadRepairedPhoto);

module.exports = router;
