const mockQuery = jest.fn();
const mockConnect = jest.fn();
jest.mock('../config/db', () => ({
  query: (...args) => mockQuery(...args),
  connect: (...args) => mockConnect(...args),
}));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const Enquiry = require('../models/sales/enquiry');

describe('Enquiry.getAll role scoping', () => {
  beforeEach(() => mockQuery.mockReset());

  it('scopes representative users to their own assigned enquiries, like design', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // data query
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // count query

    await Enquiry.getAll({
      user: { role_name: 'representative', user_id: 42 },
    });

    const [dataSql, dataValues] = mockQuery.mock.calls[0];
    expect(dataSql).toMatch(/e\.assigned_to = \$1::int/);
    expect(dataValues[0]).toBe(42);
  });

  it('returns an empty list for a representative with no numeric user_id, without querying', async () => {
    const result = await Enquiry.getAll({
      user: { role_name: 'representative', user_id: null },
    });

    expect(result).toEqual({ data: [], total: 0, cursor: null });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not scope sales users', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await Enquiry.getAll({
      user: { role_name: 'sales', user_id: 3 },
    });

    const [dataSql] = mockQuery.mock.calls[0];
    expect(dataSql).not.toMatch(/e\.assigned_to = \$1::int/);
  });
});

describe('Enquiry.getById role scoping', () => {
  beforeEach(() => mockQuery.mockReset());

  it('rejects a representative viewing an enquiry not assigned to them', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership check returns no rows

    await expect(
      Enquiry.getById('ENQ1', { role_name: 'representative', user_id: 42 })
    ).rejects.toThrow('Forbidden');
  });
});
