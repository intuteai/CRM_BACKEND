const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/sales/enquiry.controller');

router.get('/templates', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getTemplates);
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

module.exports = router;
