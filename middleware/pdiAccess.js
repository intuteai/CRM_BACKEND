// Role-name allow-list for every PDI report, lot and template-fill route.
// Mirrors the allowedRoles on CRM/src/routeConfig.jsx's /pdi-generator* routes
// (admin, production) and /pdi (admin, design, dispatch). The mobile PDI app
// calls these same endpoints with the same logins.
// Deliberately not the permissions table: its PDI rows have known gaps.
// 'employee' is here because the shop-floor technicians who use the mobile
// app (checked against production users, 2026-10-06) log in with that role.
const PDI_ROLE_NAMES = new Set(['admin', 'production', 'design', 'dispatch', 'employee']);

// The web gets its role names from auth.controller.js's ROLE_MAP (keyed by
// role_id), which may not match roles.role_name, so either one is accepted.
// Mirrors ROLE_MAP for the roles above.
const PDI_ROLE_NAME_BY_ID = { 1: 'admin', 4: 'design', 5: 'production', 7: 'dispatch', 9: 'employee' };

function requirePdiAccess(req, res, next) {
  const roleName = String(req.user?.role_name || '').toLowerCase();
  const mappedName = PDI_ROLE_NAME_BY_ID[req.user?.role_id];
  if (PDI_ROLE_NAMES.has(roleName) || (mappedName && PDI_ROLE_NAMES.has(mappedName))) return next();
  return res.status(403).json({ error: "You don't have access to PDI reports.", code: 'PDI_FORBIDDEN' });
}

module.exports = { requirePdiAccess, PDI_ROLE_NAMES };
