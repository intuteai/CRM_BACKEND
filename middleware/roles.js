// Role ids (roles table) and which organization each belongs to.
// Compage, Intute AI and Innopack share this server and database; their data
// must never cross. Every route guard and socket room is derived from this file.

const ROLES = Object.freeze({
  // Compage
  ADMIN: 1,
  CUSTOMER: 2,
  SALES: 3,
  DESIGN: 4,
  PRODUCTION: 5,
  STORE: 6,
  DISPATCH: 7,
  ACCOUNTS: 8,
  EMPLOYEE: 9,
  HR: 10,
  SERVICE_REPAIR: 13,
  REPRESENTATIVE: 15,
  // Intute AI
  IA_EMPLOYEE: 11,
  IA_HR: 12,
  // Innopack
  INNOPACK_DESIGN: 16,
});

const IA_ROLE_IDS = Object.freeze([ROLES.IA_EMPLOYEE, ROLES.IA_HR]);
const INNOPACK_ROLE_IDS = Object.freeze([ROLES.INNOPACK_DESIGN]);
const VALID_ROLE_IDS = new Set(Object.values(ROLES));

// 'compage' | 'ia' | 'innopack' | null (unknown role: callers must refuse).
// A role is Compage only if it is neither Intute AI nor Innopack, so a new
// organization's roles must be listed above before they get any access.
function orgOf(roleId) {
  const id = Number(roleId);
  if (!VALID_ROLE_IDS.has(id)) return null;
  if (IA_ROLE_IDS.includes(id)) return 'ia';
  if (INNOPACK_ROLE_IDS.includes(id)) return 'innopack';
  return 'compage';
}

// Compage's own people (every Compage role except customers).
const COMPAGE_STAFF_ROLE_IDS = Object.freeze(
  [...VALID_ROLE_IDS].filter((id) => orgOf(id) === 'compage' && id !== ROLES.CUSTOMER)
);

// Route guard: only the listed role ids get through. Runs after
// authenticateToken, which sets req.user.role_id.
function requireRoles(...roleIds) {
  if (roleIds.length === 0 || roleIds.some((id) => !VALID_ROLE_IDS.has(id))) {
    throw new Error(`requireRoles: invalid role list ${JSON.stringify(roleIds)}`);
  }
  const allowed = new Set(roleIds);
  return (req, res, next) => {
    if (req.user && allowed.has(Number(req.user.role_id))) return next();
    return res.status(403).json({ error: 'Permission denied', code: 'PERM_DENIED' });
  };
}

module.exports = { ROLES, IA_ROLE_IDS, INNOPACK_ROLE_IDS, COMPAGE_STAFF_ROLE_IDS, orgOf, requireRoles };
