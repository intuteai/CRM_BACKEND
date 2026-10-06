// Role-name allow-list for every PDI report, lot and template-fill route:
// admin and production only, matching CRM/src/routeConfig.jsx's PDI routes.
// The mobile PDI app calls these same endpoints, so its users need one of
// these roles too.
// Deliberately not the permissions table: its PDI rows have known gaps.
const PDI_ROLE_NAMES = new Set(['admin', 'production']);

// The web gets its role names from auth.controller.js's ROLE_MAP (keyed by
// role_id), which may not match roles.role_name, so either one is accepted.
// Mirrors ROLE_MAP for the roles above.
const PDI_ROLE_NAME_BY_ID = { 1: 'admin', 5: 'production' };

function requirePdiAccess(req, res, next) {
  const roleName = String(req.user?.role_name || '').toLowerCase();
  const mappedName = PDI_ROLE_NAME_BY_ID[req.user?.role_id];
  if (PDI_ROLE_NAMES.has(roleName) || (mappedName && PDI_ROLE_NAMES.has(mappedName))) return next();
  return res.status(403).json({ error: "You don't have access to PDI reports.", code: 'PDI_FORBIDDEN' });
}

module.exports = { requirePdiAccess, PDI_ROLE_NAMES };
