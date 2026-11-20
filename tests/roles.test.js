// requireRoles route guard and the role -> organization mapping that keeps
// Compage and Intute AI data apart. Pure functions, no database.
const { ROLES, COMPAGE_STAFF_ROLE_IDS, orgOf, requireRoles } = require('../middleware/roles');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('orgOf', () => {
  it('puts the two Intute AI roles in the ia organization', () => {
    expect(orgOf(ROLES.IA_EMPLOYEE)).toBe('ia');
    expect(orgOf(ROLES.IA_HR)).toBe('ia');
  });

  it('puts every Compage role, admin included, in the compage organization', () => {
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 15]) expect(orgOf(id)).toBe('compage');
  });

  it('puts Innopack design in the innopack organization', () => {
    expect(ROLES.INNOPACK_DESIGN).toBe(16);
    expect(orgOf(ROLES.INNOPACK_DESIGN)).toBe('innopack');
  });

  it('lists Compage staff as every Compage role except customer, and nothing from other organizations', () => {
    expect([...COMPAGE_STAFF_ROLE_IDS].sort((a, b) => a - b)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 13, 15]);
  });

  it('returns null for an unknown role so callers fail closed', () => {
    expect(orgOf(99)).toBeNull();
    expect(orgOf(undefined)).toBeNull();
  });
});

describe('requireRoles', () => {
  it('calls next() for an allowed role', () => {
    const next = jest.fn();
    requireRoles(ROLES.ADMIN, ROLES.ACCOUNTS)({ user: { role_id: 8 } }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('answers 403 PERM_DENIED for a role that is not listed', () => {
    const res = mockRes();
    const next = jest.fn();
    requireRoles(ROLES.ADMIN)({ user: { role_id: ROLES.IA_HR } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Permission denied', code: 'PERM_DENIED' });
  });

  it('answers 403 when there is no user on the request', () => {
    const res = mockRes();
    const next = jest.fn();
    requireRoles(ROLES.ADMIN)({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refuses to be built with no roles, so a typo cannot open a route to nobody-or-everybody', () => {
    expect(() => requireRoles()).toThrow();
    expect(() => requireRoles(ROLES.NOT_A_ROLE)).toThrow();
  });
});
