const pool = require('../config/db');
const AuthoredTemplates = require('../models/operations/pdi/authoredTemplates');

const TEST_ID = 'test-template-' + Date.now();

describe('AuthoredTemplates', () => {
  afterAll(async () => {
    await pool.query('DELETE FROM pdi_templates WHERE id = $1', [TEST_ID]);
    await pool.end();
  });

  it('creates version 1 as a draft', async () => {
    const row = await AuthoredTemplates.create({ id: TEST_ID, name: 'Test Template', definition: { pages: [] } });
    expect(row.version).toBe(1);
    expect(row.status).toBe('draft');
    expect(row.name).toBe('Test Template');
  });

  it('idExists is true after creation, false for an unrelated id', async () => {
    expect(await AuthoredTemplates.idExists(TEST_ID)).toBe(true);
    expect(await AuthoredTemplates.idExists('definitely-not-a-real-id')).toBe(false);
  });

  it('saveNewVersion appends a new row rather than mutating the existing one', async () => {
    const v2 = await AuthoredTemplates.saveNewVersion(TEST_ID, { definition: { pages: [{ sections: [] }] } });
    expect(v2.version).toBe(2);
    const v1 = await AuthoredTemplates.getByVersion(TEST_ID, 1);
    expect(v1.definition).toEqual({ pages: [] });
    expect(v1.version).toBe(1);
  });

  it('getLatest returns the highest version', async () => {
    const latest = await AuthoredTemplates.getLatest(TEST_ID);
    expect(latest.version).toBe(2);
  });

  it('publishing (status only) still creates a new version, preserving the definition', async () => {
    const published = await AuthoredTemplates.saveNewVersion(TEST_ID, { status: 'active' });
    expect(published.version).toBe(3);
    expect(published.status).toBe('active');
    expect(published.definition).toEqual({ pages: [{ sections: [] }] });
  });

  it('getActive finds the published version', async () => {
    const active = await AuthoredTemplates.getActive(TEST_ID);
    expect(active.version).toBe(3);
  });

  it('archiving hides it from listActive but old versions stay resolvable by exact version', async () => {
    await AuthoredTemplates.saveNewVersion(TEST_ID, { status: 'archived' });
    const activeList = await AuthoredTemplates.listActive();
    expect(activeList.find((t) => t.id === TEST_ID)).toBeUndefined();
    const stillThere = await AuthoredTemplates.getByVersion(TEST_ID, 3);
    expect(stillThere.status).toBe('active'); // the exact historical row, unaffected by the later archive
  });

  it('listAll shows the latest version regardless of status', async () => {
    const all = await AuthoredTemplates.listAll();
    const mine = all.find((t) => t.id === TEST_ID);
    expect(mine.version).toBe(4);
    expect(mine.status).toBe('archived');
  });

  it('getByVersion returns null when version is null/undefined (defensive — never guesses "latest")', async () => {
    expect(await AuthoredTemplates.getByVersion(TEST_ID, null)).toBeNull();
    expect(await AuthoredTemplates.getByVersion(TEST_ID, undefined)).toBeNull();
  });

  it('saveNewVersion throws a clear error for an unknown id', async () => {
    await expect(AuthoredTemplates.saveNewVersion('no-such-template-id')).rejects.toThrow('Template not found');
  });
});
