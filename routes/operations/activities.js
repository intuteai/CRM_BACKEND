const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const controller = require('../../controllers/operations/activities.controller');

// Compage employee/HR and Intute AI employee/HR. The controller keeps each
// organization to its own activities.
router.use(authenticateToken, requireRoles(ROLES.EMPLOYEE, ROLES.HR, ROLES.IA_EMPLOYEE, ROLES.IA_HR));

router.post('/', controller.create);
router.get('/', controller.getAll);
router.get('/:id', controller.getOne);
router.put('/:id', controller.update);
router.delete('/:id', controller.delete);

module.exports = router;
