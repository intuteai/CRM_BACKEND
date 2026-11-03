const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/manufacturing/partDrawings.controller');

// Admin and design edit drawings; production has a read-only page.
const canRead = requireRoles(ROLES.ADMIN, ROLES.DESIGN, ROLES.PRODUCTION);
const canWrite = requireRoles(ROLES.ADMIN, ROLES.DESIGN);

router.get('/', authenticateToken, canRead, controller.getAll);
router.post('/', authenticateToken, canWrite, controller.create);
router.put('/:srNo', authenticateToken, canWrite, controller.update);
router.delete('/:srNo', authenticateToken, canWrite, controller.delete);

module.exports = router;
