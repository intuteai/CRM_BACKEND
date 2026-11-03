const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/manufacturing/iptKits.controller');

// IPT kit assembly page: admin and production.
router.use(authenticateToken, requireRoles(ROLES.ADMIN, ROLES.PRODUCTION));

router.get('/', checkPermission('ipt_kits', 'can_read'), controller.getAll);
router.get('/next-serial', checkPermission('ipt_kits', 'can_read'), controller.nextSerial);
router.get('/:id', checkPermission('ipt_kits', 'can_read'), controller.getOne);
router.post('/', checkPermission('ipt_kits', 'can_write'), controller.create);
router.put('/next-serial', checkPermission('ipt_kits', 'can_write'), controller.setNextSerial);
router.put('/:id', checkPermission('ipt_kits', 'can_write'), controller.update);
router.delete('/:id', checkPermission('ipt_kits', 'can_delete'), controller.delete);

module.exports = router;
