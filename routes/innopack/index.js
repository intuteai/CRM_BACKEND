// Innopack API, mounted at /api/innopack. Innopack is a separate organization:
// every route here is for its roles only, and nothing outside this router
// lets Innopack roles in.
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const { ROLES, requireRoles } = require('../../middleware/roles');
const parts = require('../../controllers/innopack/parts.controller');

router.use(authenticateToken, requireRoles(ROLES.INNOPACK_DESIGN));

// Parts Roster (the design engineer's machine parts list)
router.get('/parts', parts.list);
router.get('/parts/options', parts.options);
router.post('/parts', parts.create);
router.put('/parts/:id', parts.update);
router.delete('/parts/:id', parts.remove);

module.exports = router;
