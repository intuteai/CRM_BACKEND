const express = require('express');
const multer = require('multer');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/sales/enquiry.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/templates', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getTemplates);
router.get('/representatives', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getRepresentatives);
router.post('/refresh', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.refreshCache);
router.post('/', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.create);
router.get('/', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getAll);
router.get('/:id', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getOne);
router.put('/:id', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.update);
router.delete('/:id', authenticateToken, checkPermission('Enquiries', 'can_delete'), controller.delete);
router.post('/:id/assign', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.assign);
router.post('/:id/mark-done', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.markDone);
router.post('/:id/comment', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.addComment);
router.patch('/:id/stage', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.changeStage);
router.post('/:id/follow', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.follow);
router.delete('/:id/follow', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.unfollow);
router.post('/:enquiryId/activity/:activityId/read', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.markActivityRead);
router.post('/:id/photo', authenticateToken, checkPermission('Enquiries', 'can_write'), upload.single('photo'), controller.uploadPhoto);
router.delete('/:id/photo', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.deletePhoto);

module.exports = router;
