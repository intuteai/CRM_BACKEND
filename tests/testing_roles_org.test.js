// Motor testing is a Compage module: users from another organization (Intute
// AI, Innopack) and customers never get a testing role, even if a row for
// them exists in mt_user_role. Database is mocked.
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a) }));

const { loadTestingRoles } = require('../middleware/testingRoles');

beforeEach(() => mockQuery.mockReset());

describe('loadTestingRoles: Compage staff only', () => {
  it('Compage staff get the roles granted to them', async () => {
    mockQuery.mockResolvedValue({ rows: [{ testing_role: 'viewer' }] });
    await expect(loadTestingRoles(5, 4)).resolves.toEqual(['viewer']);
  });

  it.each([[2, 'customer'], [11, 'ia_employee'], [12, 'ia_hr'], [16, 'innopack_design'], [99, 'unknown']])(
    'role %i (%s) gets no testing roles and the database is not asked',
    async (roleId) => {
      mockQuery.mockResolvedValue({ rows: [{ testing_role: 'testing_admin' }] });
      await expect(loadTestingRoles(5, roleId)).resolves.toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    }
  );

  it('ERP admin still counts as testing_admin', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(loadTestingRoles(1, 1)).resolves.toEqual(['testing_admin']);
  });
});
