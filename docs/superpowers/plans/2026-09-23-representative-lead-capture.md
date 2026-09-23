# Representative Lead Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `representative` role that can capture and work Enquiry leads from the field — reusing the existing `enquiries` table, `lead`/`last_discussion`/`assigned_at`/comment-thread fields — and add the two genuinely new pieces of data the client asked for: `city` and multiple `photos` per enquiry.

**Architecture:** Backend: two new nullable columns on `enquiries` (`city text`, `photos text[]`), a new `representative` role + `Enquiries` permission row, generalized role-scoping in the existing `Enquiry` model/controller (the same pattern already used for the `design` role), and two new photo endpoints modeled exactly on `ServiceRepair`'s existing append/remove-array photo pattern (multer → Google Drive → `array_append`/`array_remove`). Frontend: a new `RepresentativeEnquiryPage.jsx` cloned from `DesignEnquiryPage.jsx` (closest existing shape: restricted, single-assignee view) with a City field, a constrained Remark dropdown, and a photo gallery; City + the photo gallery are also retrofitted into the existing Sales/Design/Admin Enquiry pages so a rep-captured lead's full data is visible everywhere it already shows up.

**Tech Stack:** Node/Express/PostgreSQL (`pg`) backend, Jest for backend tests (mocked `pg` pool — this repo's DB is the live production database with no separate test DB, so tests must never hit it for real), React 19 + Vite frontend (no frontend test harness — verify via `npm run lint` and a manual browser pass).

**Reference:** Full spec at `docs/superpowers/specs/2026-09-23-representative-lead-capture-design.md`.

---

## Before you start

- This backend's `config/db.js` connects to the **live production PostgreSQL** (RDS) via `.env` — there is no separate dev/test database in this project. Every step below that touches the database for real (the migration script, the seed-user script) must be run deliberately, once, and confirmed with the user first — never automated, never re-run speculatively.
- All new Jest tests **mock** `../config/db` (`jest.mock('../config/db', ...)`), the same pattern already established in `tests/pdi_inspection_date.test.js`. Do not write a test that calls the real `pool` or hits `npm run dev`'s live server.

---

### Task 1: Database migration — `city`/`photos` columns, `representative` role, permissions

**Files:**
- Create: `scripts/migrations/2026-09-23-add-representative-role.js`

This follows the exact convention already used by `scripts/migrations/2026-09-08-add-pdi-templates.js` and `scripts/migrations/2026-09-04-add-pdi-report-content.js` — a standalone script run once with `node`, not a migration framework.

- [ ] **Step 1: Write the migration script**

```js
require('dotenv').config();
const pool = require('../../config/db');

async function migrate() {
  const statements = [
    `ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS city TEXT`,
    `ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS photos TEXT[] NOT NULL DEFAULT '{}'`,
  ];

  for (const sql of statements) {
    console.log('Running:', sql);
    await pool.query(sql);
  }

  console.log('Ensuring representative role exists...');
  const roleRes = await pool.query(
    `SELECT role_id FROM roles WHERE role_name = 'representative'`
  );
  let roleId;
  if (roleRes.rows.length > 0) {
    roleId = roleRes.rows[0].role_id;
    console.log('representative role already exists, role_id =', roleId);
  } else {
    const inserted = await pool.query(
      `INSERT INTO roles (role_name) VALUES ('representative') RETURNING role_id`
    );
    roleId = inserted.rows[0].role_id;
    console.log('Created representative role, role_id =', roleId);
  }

  console.log('Ensuring representative has Enquiries permissions (read+write, no delete)...');
  const permRes = await pool.query(
    `SELECT 1 FROM permissions WHERE role_id = $1 AND module = 'Enquiries'`,
    [roleId]
  );
  if (permRes.rows.length > 0) {
    console.log('Enquiries permission row already exists for representative, skipping insert.');
  } else {
    await pool.query(
      `INSERT INTO permissions (role_id, module, can_read, can_write, can_delete)
       VALUES ($1, 'Enquiries', true, true, false)`,
      [roleId]
    );
    console.log('Inserted Enquiries permission row for representative.');
  }

  console.log('Migration complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: STOP — do not run this yet**

This script writes to the live production database (new columns on `enquiries`, a new role, a new permissions row). Confirm with the user that they want this run now, then run it exactly once:

```bash
node scripts/migrations/2026-09-23-add-representative-role.js
```

Expected output ends with `Migration complete.` and no `Migration failed:` line. If it fails partway, the `ADD COLUMN IF NOT EXISTS` and existence-check statements are safe to re-run.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/2026-09-23-add-representative-role.js
git commit -m "feat: add representative role and enquiry city/photos columns"
```

---

### Task 2: Enquiry model — generalize Design-only scoping to also cover `representative`

**Files:**
- Modify: `models/sales/enquiry.js`
- Test: `tests/enquiry_model.test.js`

`getAll` and `getById` currently restrict visibility to "own assigned enquiries only" for any `role_name` containing `"design"`. Representatives need the identical restriction, so this generalizes the existing check rather than duplicating it.

- [ ] **Step 1: Write the failing tests**

Create `tests/enquiry_model.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/enquiry_model.test.js --verbose`
Expected: FAIL — the scoping check still only matches `role_name` containing `"design"`, so a `representative` user gets the unscoped query and the ownership-rejection test doesn't throw.

- [ ] **Step 3: Update `getAll` in `models/sales/enquiry.js`**

Replace:

```js
static async getAll({ limit = 15, offset = 0, cursor, user, search }) {
  const isDesign = String(user?.role_name || '').toLowerCase().includes('design');
  const userId = Number(user?.user_id);

  if (isDesign && (!userId || Number.isNaN(userId))) {
    logger.warn(
      'Design user with no numeric user_id attempted getAll, returning empty list'
    );
    return { data: [], total: 0, cursor: null };
  }
```

With:

```js
static async getAll({ limit = 15, offset = 0, cursor, user, search }) {
  const roleName = String(user?.role_name || '').toLowerCase();
  const isRestrictedRole = roleName.includes('design') || roleName.includes('representative');
  const userId = Number(user?.user_id);

  if (isRestrictedRole && (!userId || Number.isNaN(userId))) {
    logger.warn(
      'Restricted-view user with no numeric user_id attempted getAll, returning empty list'
    );
    return { data: [], total: 0, cursor: null };
  }
```

Then, still inside `getAll`, replace:

```js
  if (isDesign) {
    dataWhere.push(`e.assigned_to = $${dataValues.length + 1}::int`);
    dataValues.push(userId);
  }
```

With:

```js
  if (isRestrictedRole) {
    dataWhere.push(`e.assigned_to = $${dataValues.length + 1}::int`);
    dataValues.push(userId);
  }
```

Then replace:

```js
  logger.debug('getAll data query values', { isDesign, dataValues });
```

With:

```js
  logger.debug('getAll data query values', { isRestrictedRole, dataValues });
```

Then, in the count-query section, replace:

```js
  if (isDesign) {
    countWhere.push(`e.assigned_to = $${countValues.length + 1}::int`);
    countValues.push(userId);
  }
```

With:

```js
  if (isRestrictedRole) {
    countWhere.push(`e.assigned_to = $${countValues.length + 1}::int`);
    countValues.push(userId);
  }
```

- [ ] **Step 4: Update `getById` in `models/sales/enquiry.js`**

Replace:

```js
  static async getById(enquiryId, user) {
    const isDesign = String(user?.role_name || '').toLowerCase().includes('design');
    const userId = Number(user?.user_id);

    if (isDesign) {
      if (!userId || Number.isNaN(userId)) {
        logger.warn('Design user with invalid id attempted getById', { enquiryId, user });
        throw new Error('Forbidden');
      }
      const check = await pool.query(
        `SELECT 1 FROM enquiries WHERE enquiry_id = $1 AND assigned_to = $2::int`,
        [enquiryId, userId]
      );
      if (check.rows.length === 0) {
        logger.warn(`Design user ${userId} attempted to access unassigned enquiry ${enquiryId}`);
        throw new Error('Forbidden');
      }
    }
```

With:

```js
  static async getById(enquiryId, user) {
    const roleName = String(user?.role_name || '').toLowerCase();
    const isRestrictedRole = roleName.includes('design') || roleName.includes('representative');
    const userId = Number(user?.user_id);

    if (isRestrictedRole) {
      if (!userId || Number.isNaN(userId)) {
        logger.warn('Restricted-view user with invalid id attempted getById', { enquiryId, user });
        throw new Error('Forbidden');
      }
      const check = await pool.query(
        `SELECT 1 FROM enquiries WHERE enquiry_id = $1 AND assigned_to = $2::int`,
        [enquiryId, userId]
      );
      if (check.rows.length === 0) {
        logger.warn(`Restricted-view user ${userId} attempted to access unassigned enquiry ${enquiryId}`);
        throw new Error('Forbidden');
      }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest tests/enquiry_model.test.js --verbose`
Expected: PASS (3/3 in the `getAll` describe block, 1/1 in `getById`).

- [ ] **Step 6: Commit**

```bash
git add models/sales/enquiry.js tests/enquiry_model.test.js
git commit -m "feat: scope representative role to own assigned enquiries"
```

---

### Task 3: Enquiry model — `city` on create/update, `appendPhoto`/`removePhoto`

**Files:**
- Modify: `models/sales/enquiry.js`
- Test: `tests/enquiry_model.test.js` (extend)

- [ ] **Step 1: Add failing tests to `tests/enquiry_model.test.js`**

Append to the file:

```js
describe('Enquiry.update includes city', () => {
  beforeEach(() => mockQuery.mockReset());

  it('passes city through to the UPDATE statement', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ enquiry_id: 'ENQ1', lead: 'hotlead', created_by: null }],
    });

    await Enquiry.update('ENQ1', { city: 'Pune' }, null);

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/city\s*=\s*COALESCE\(\$14, city\)/);
    expect(values).toContain('Pune');
  });
});

describe('Enquiry.appendPhoto / removePhoto', () => {
  beforeEach(() => mockQuery.mockReset());

  it('appends a photo URL to the photos array', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ enquiry_id: 'ENQ1', lead: 'hotlead', photos: ['https://drive/x'] }],
    });

    const result = await Enquiry.appendPhoto('ENQ1', 'https://drive/x', null);

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/array_append/);
    expect(values).toEqual(['https://drive/x', 'ENQ1']);
    expect(result.photos).toEqual(['https://drive/x']);
  });

  it('throws "Enquiry not found" when appending to a missing enquiry', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(Enquiry.appendPhoto('MISSING', 'url', null)).rejects.toThrow('Enquiry not found');
  });

  it('removes a photo URL from the photos array', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ enquiry_id: 'ENQ1', lead: 'hotlead', photos: [] }],
    });

    const result = await Enquiry.removePhoto('ENQ1', 'https://drive/x', null);

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/array_remove/);
    expect(values).toEqual(['https://drive/x', 'ENQ1']);
    expect(result.photos).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/enquiry_model.test.js --verbose`
Expected: FAIL — `update` doesn't reference `city` yet, and `Enquiry.appendPhoto`/`removePhoto` don't exist (`TypeError: Enquiry.appendPhoto is not a function`).

- [ ] **Step 3: Add `city` to `update()`**

Replace the destructured parameter list:

```js
  static async update(
    enquiryId,
    {
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      status,
      last_discussion,
      next_interaction,
      lead,
      priority,
      source,
      application,
      tags,
      due_date,
    },
    io
  ) {
```

With:

```js
  static async update(
    enquiryId,
    {
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      status,
      last_discussion,
      next_interaction,
      lead,
      priority,
      source,
      application,
      tags,
      due_date,
      city,
    },
    io
  ) {
```

Replace the SQL + values in the same method:

```js
    const result = await pool.query(
      `
      UPDATE enquiries
      SET
        company_name    = COALESCE($1, company_name),
        contact_person  = COALESCE($2, contact_person),
        mail_id         = COALESCE($3, mail_id),
        phone_no        = COALESCE($4, phone_no),
        items_required  = COALESCE($5, items_required),
        status          = COALESCE($6, status),
        last_discussion = $7,
        next_interaction= $8,
        lead            = COALESCE($9, lead),
        application     = COALESCE($10, application),
        source          = COALESCE($11, source),
        tags            = COALESCE($12, tags),
        due_date        = $13,
        updated_at      = CURRENT_TIMESTAMP
      WHERE enquiry_id  = $14
      RETURNING *
    `,
      [
        company_name || null,
        contact_person || null,
        mail_id || null,
        phone_no || null,
        items_required || null,
        safeStatus,
        last_discussion ? new Date(last_discussion) : null,
        next_interaction ? new Date(next_interaction) : null,
        leadToUse,
        typeof application !== 'undefined' ? application : null,
        source || null,
        Array.isArray(tags) ? tags : null,
        due_date ? new Date(due_date) : null,
        enquiryId,
      ]
    );
```

With:

```js
    const result = await pool.query(
      `
      UPDATE enquiries
      SET
        company_name    = COALESCE($1, company_name),
        contact_person  = COALESCE($2, contact_person),
        mail_id         = COALESCE($3, mail_id),
        phone_no        = COALESCE($4, phone_no),
        items_required  = COALESCE($5, items_required),
        status          = COALESCE($6, status),
        last_discussion = $7,
        next_interaction= $8,
        lead            = COALESCE($9, lead),
        application     = COALESCE($10, application),
        source          = COALESCE($11, source),
        tags            = COALESCE($12, tags),
        due_date        = $13,
        city            = COALESCE($14, city),
        updated_at      = CURRENT_TIMESTAMP
      WHERE enquiry_id  = $15
      RETURNING *
    `,
      [
        company_name || null,
        contact_person || null,
        mail_id || null,
        phone_no || null,
        items_required || null,
        safeStatus,
        last_discussion ? new Date(last_discussion) : null,
        next_interaction ? new Date(next_interaction) : null,
        leadToUse,
        typeof application !== 'undefined' ? application : null,
        source || null,
        Array.isArray(tags) ? tags : null,
        due_date ? new Date(due_date) : null,
        city || null,
        enquiryId,
      ]
    );
```

- [ ] **Step 4: Add `city` to `create()`**

Replace the destructured parameter list:

```js
  static async create(data, io, user) {
    const {
      enquiry_id,
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      source = 'Website',
      application = null,
      lead,
      priority,
      tags = [],
      assigned_to = null,
      due_date = null,
      status = 'Pending',
      last_discussion = null,
      next_interaction = null,
    } = data;
```

With:

```js
  static async create(data, io, user) {
    const {
      enquiry_id,
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      source = 'Website',
      application = null,
      lead,
      priority,
      tags = [],
      assigned_to = null,
      due_date = null,
      status = 'Pending',
      last_discussion = null,
      next_interaction = null,
      city = null,
    } = data;
```

Replace the INSERT statement's column list and VALUES placeholders:

```js
      const enquiryResult = await client.query(
        `INSERT INTO enquiries (
          enquiry_id,
          company_name,
          contact_person,
          mail_id,
          phone_no,
          items_required,
          source,
          application,
          lead,
          tags,
          stage,
          assigned_to,
          assigned_by,
          assigned_at,
          due_date,
          status,
          last_discussion,
          next_interaction,
          created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17, $18, $19
        )
        RETURNING *`,
        [
          finalEnquiryId,
          company_name.trim(),
          contact_person?.trim() || null,
          mail_id?.trim() || null,
          phone_no?.trim() || null,
          items_required?.trim() || null,
          source,
          application || null,
          finalLead,
          tags,
          initialStage,
          assigned_to,
          user?.user_id || null, // assigned_by
          assigned_to ? new Date() : null, // assigned_at
          due_date ? new Date(due_date) : null,
          initialStatus,
          last_discussion ? new Date(last_discussion) : null,
          next_interaction ? new Date(next_interaction) : null,
          user?.user_id || null, // created_by (NEW)
        ]
      );
```

With:

```js
      const enquiryResult = await client.query(
        `INSERT INTO enquiries (
          enquiry_id,
          company_name,
          contact_person,
          mail_id,
          phone_no,
          items_required,
          source,
          application,
          lead,
          tags,
          stage,
          assigned_to,
          assigned_by,
          assigned_at,
          due_date,
          status,
          last_discussion,
          next_interaction,
          created_by,
          city
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17, $18, $19,
          $20
        )
        RETURNING *`,
        [
          finalEnquiryId,
          company_name.trim(),
          contact_person?.trim() || null,
          mail_id?.trim() || null,
          phone_no?.trim() || null,
          items_required?.trim() || null,
          source,
          application || null,
          finalLead,
          tags,
          initialStage,
          assigned_to,
          user?.user_id || null, // assigned_by
          assigned_to ? new Date() : null, // assigned_at
          due_date ? new Date(due_date) : null,
          initialStatus,
          last_discussion ? new Date(last_discussion) : null,
          next_interaction ? new Date(next_interaction) : null,
          user?.user_id || null, // created_by (NEW)
          city?.trim() || null,
        ]
      );
```

- [ ] **Step 5: Add `appendPhoto` and `removePhoto` methods**

Insert immediately before the closing `}` of the `Enquiry` class (right after the existing `static async delete(enquiryId, io) { ... }` method, before `}\n\nmodule.exports = Enquiry;`):

```js

  // =================================================================
  // PHOTOS (append/remove — same array-column pattern as ServiceRepair)
  // =================================================================
  static async appendPhoto(enquiryId, url, io) {
    const { rows } = await pool.query(
      `UPDATE enquiries
       SET photos = array_append(COALESCE(photos, '{}'), $1), updated_at = CURRENT_TIMESTAMP
       WHERE enquiry_id = $2
       RETURNING *`,
      [url, enquiryId]
    );
    if (rows.length === 0) throw new Error('Enquiry not found');

    const enquiry = rows[0];
    enquiry.priority = enquiry.lead;

    if (io) {
      io.emit('enquiryUpdate', { ...enquiry, type: 'updated' });
    }

    return enquiry;
  }

  static async removePhoto(enquiryId, url, io) {
    const { rows } = await pool.query(
      `UPDATE enquiries
       SET photos = array_remove(photos, $1), updated_at = CURRENT_TIMESTAMP
       WHERE enquiry_id = $2
       RETURNING *`,
      [url, enquiryId]
    );
    if (rows.length === 0) throw new Error('Enquiry not found');

    const enquiry = rows[0];
    enquiry.priority = enquiry.lead;

    if (io) {
      io.emit('enquiryUpdate', { ...enquiry, type: 'updated' });
    }

    return enquiry;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest tests/enquiry_model.test.js --verbose`
Expected: PASS (all tests in the file, including the two new `describe` blocks).

- [ ] **Step 7: Commit**

```bash
git add models/sales/enquiry.js tests/enquiry_model.test.js
git commit -m "feat: add city and multi-photo support to Enquiry model"
```

---

### Task 4: Enquiry controller — `city` passthrough, representative self-assignment default, photo endpoints

**Files:**
- Modify: `controllers/sales/enquiry.controller.js`
- Test: `tests/enquiry_controller.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/enquiry_controller.test.js`:

```js
jest.mock('../models/sales/enquiry');
jest.mock('../config/redis', () => ({
  keys: jest.fn(async () => []),
  del: jest.fn(async () => {}),
  get: jest.fn(async () => null),
  setEx: jest.fn(async () => {}),
}));
jest.mock('../config/db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/googleDrive', () => ({
  uploadBufferToDrive: jest.fn(async () => ({ directUrl: 'https://drive.google.com/uc?export=view&id=fake' })),
}));

const Enquiry = require('../models/sales/enquiry');
const { uploadBufferToDrive } = require('../services/googleDrive');
const controller = require('../controllers/sales/enquiry.controller');

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('enquiry.controller.create — representative self-assignment default', () => {
  beforeEach(() => {
    Enquiry.create.mockReset();
    Enquiry.create.mockResolvedValue({ enquiry_id: 'ENQ1' });
  });

  it('defaults assigned_to to the creating user when a representative omits it', async () => {
    const req = {
      body: { company_name: 'Acme' },
      user: { user_id: 42, role_name: 'representative' },
      io: null,
    };
    const res = makeRes();

    await controller.create(req, res);

    expect(Enquiry.create).toHaveBeenCalledTimes(1);
    const [payload] = Enquiry.create.mock.calls[0];
    expect(payload.assigned_to).toBe(42);
  });

  it('does not force assigned_to for a sales user', async () => {
    const req = {
      body: { company_name: 'Acme' },
      user: { user_id: 3, role_name: 'sales' },
      io: null,
    };
    const res = makeRes();

    await controller.create(req, res);

    const [payload] = Enquiry.create.mock.calls[0];
    expect(payload.assigned_to).toBeNull();
  });

  it('keeps an explicit assigned_to even for a representative', async () => {
    const req = {
      body: { company_name: 'Acme', assigned_to: 99 },
      user: { user_id: 42, role_name: 'representative' },
      io: null,
    };
    const res = makeRes();

    await controller.create(req, res);

    const [payload] = Enquiry.create.mock.calls[0];
    expect(payload.assigned_to).toBe(99);
  });
});

describe('enquiry.controller.uploadPhoto / deletePhoto', () => {
  beforeEach(() => {
    Enquiry.appendPhoto.mockReset();
    Enquiry.removePhoto.mockReset();
    uploadBufferToDrive.mockClear();
  });

  it('uploads the file buffer to Drive and appends the returned URL', async () => {
    Enquiry.appendPhoto.mockResolvedValue({ enquiry_id: 'ENQ1', photos: ['https://drive.google.com/uc?export=view&id=fake'] });
    const req = {
      params: { id: 'ENQ1' },
      file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg' },
      io: null,
    };
    const res = makeRes();

    await controller.uploadPhoto(req, res);

    expect(uploadBufferToDrive).toHaveBeenCalledTimes(1);
    expect(Enquiry.appendPhoto).toHaveBeenCalledWith('ENQ1', 'https://drive.google.com/uc?export=view&id=fake', null);
    expect(res.statusCode).toBe(200);
    expect(res.body.record.photos).toEqual(['https://drive.google.com/uc?export=view&id=fake']);
  });

  it('rejects a disallowed mime type without calling Drive', async () => {
    const req = {
      params: { id: 'ENQ1' },
      file: { buffer: Buffer.from('x'), mimetype: 'application/pdf' },
      io: null,
    };
    const res = makeRes();

    await controller.uploadPhoto(req, res);

    expect(uploadBufferToDrive).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('removes a photo url', async () => {
    Enquiry.removePhoto.mockResolvedValue({ enquiry_id: 'ENQ1', photos: [] });
    const req = { params: { id: 'ENQ1' }, body: { url: 'https://drive/x' }, io: null };
    const res = makeRes();

    await controller.deletePhoto(req, res);

    expect(Enquiry.removePhoto).toHaveBeenCalledWith('ENQ1', 'https://drive/x', null);
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/enquiry_controller.test.js --verbose`
Expected: FAIL — `controller.uploadPhoto`/`deletePhoto` don't exist yet, and `create` doesn't apply any representative default.

- [ ] **Step 3: Update `exports.create` in `controllers/sales/enquiry.controller.js`**

Replace:

```js
exports.create = async (req, res) => {
  try {
    const { enquiry_id, company_name, contact_person, mail_id, phone_no, items_required, status, last_discussion, next_interaction, source = 'Website', application = null, lead, priority, tags = [], assigned_to, due_date } = req.body;
    if (!company_name?.trim()) return res.status(400).json({ error: 'Company name is required', code: 'INVALID_INPUT' });
    const enquiry = await Enquiry.create({ enquiry_id, company_name: company_name.trim(), contact_person: contact_person?.trim() || null, mail_id: mail_id?.trim() || null, phone_no: phone_no?.trim() || null, items_required: items_required?.trim() || null, status, last_discussion, next_interaction, source, application, lead, priority, tags, assigned_to: assigned_to || null, due_date: due_date || null }, req.io, req.user);
    await deleteByPattern('enquiry_list_*');
    logger.info(`Enquiry created: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.status(201).json(enquiry);
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Enquiry ID already exists', code: 'DUPLICATE_ENQUIRY_ID' });
    logger.error(`Error creating enquiry: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
```

With:

```js
exports.create = async (req, res) => {
  try {
    const { enquiry_id, company_name, contact_person, mail_id, phone_no, items_required, status, last_discussion, next_interaction, source = 'Website', application = null, lead, priority, tags = [], assigned_to, due_date, city } = req.body;
    if (!company_name?.trim()) return res.status(400).json({ error: 'Company name is required', code: 'INVALID_INPUT' });
    // A representative capturing a lead in the field has no one to hand it to yet —
    // default it to themselves so it shows up in their own restricted view.
    const isRepresentative = String(req.user.role_name || '').toLowerCase().includes('representative');
    const finalAssignedTo = assigned_to || (isRepresentative ? req.user.user_id : null);
    const enquiry = await Enquiry.create({ enquiry_id, company_name: company_name.trim(), contact_person: contact_person?.trim() || null, mail_id: mail_id?.trim() || null, phone_no: phone_no?.trim() || null, items_required: items_required?.trim() || null, status, last_discussion, next_interaction, source, application, lead, priority, tags, assigned_to: finalAssignedTo, due_date: due_date || null, city: city?.trim() || null }, req.io, req.user);
    await deleteByPattern('enquiry_list_*');
    logger.info(`Enquiry created: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.status(201).json(enquiry);
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Enquiry ID already exists', code: 'DUPLICATE_ENQUIRY_ID' });
    logger.error(`Error creating enquiry: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
```

- [ ] **Step 4: Update `exports.update`**

Replace:

```js
exports.update = async (req, res) => {
  try {
    const { company_name, contact_person, mail_id, phone_no, items_required, status, last_discussion, next_interaction, lead, priority, source, application, tags, due_date } = req.body;
    const enquiry = await Enquiry.update(req.params.id, { company_name, contact_person, mail_id, phone_no, items_required, status, last_discussion, next_interaction, lead, priority, source, application, tags, due_date }, req.io);
```

With:

```js
exports.update = async (req, res) => {
  try {
    const { company_name, contact_person, mail_id, phone_no, items_required, status, last_discussion, next_interaction, lead, priority, source, application, tags, due_date, city } = req.body;
    const enquiry = await Enquiry.update(req.params.id, { company_name, contact_person, mail_id, phone_no, items_required, status, last_discussion, next_interaction, lead, priority, source, application, tags, due_date, city }, req.io);
```

- [ ] **Step 5: Add the photo require and handlers**

At the top of `controllers/sales/enquiry.controller.js`, replace:

```js
const Enquiry = require('../../models/sales/enquiry');
const redis = require('../../config/redis');
const pool = require('../../config/db');
const logger = require('../../utils/logger');
```

With:

```js
const Enquiry = require('../../models/sales/enquiry');
const redis = require('../../config/redis');
const pool = require('../../config/db');
const logger = require('../../utils/logger');
const { uploadBufferToDrive } = require('../../services/googleDrive');

const ALLOWED_PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const PHOTO_MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
```

At the end of the file, append:

```js

exports.uploadPhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided', code: 'VALIDATION_ERROR' });
    if (!ALLOWED_PHOTO_MIME.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Allowed: JPEG, PNG, WebP, GIF', code: 'VALIDATION_ERROR' });
    }
    const { id } = req.params;
    const ext = PHOTO_MIME_EXT[req.file.mimetype] || 'bin';
    const filename = `enquiry_${id}_${Date.now()}.${ext}`;
    const { directUrl } = await uploadBufferToDrive(req.file.buffer, req.file.mimetype, filename);
    const record = await Enquiry.appendPhoto(id, directUrl, req.io);
    await deleteByPattern(`enquiry_*_${id}`);
    await deleteByPattern('enquiry_list_*');
    logger.info(`Enquiry photo uploaded for ${id}`);
    res.json({ url: directUrl, record });
  } catch (err) {
    logger.error('Enquiry uploadPhoto error:', err);
    const status = err.message === 'Enquiry not found' ? 404 : 500;
    res.status(status).json({ error: err.message || 'Failed to upload photo', code: status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
};

exports.deletePhoto = async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required', code: 'VALIDATION_ERROR' });
  try {
    const record = await Enquiry.removePhoto(req.params.id, url, req.io);
    await deleteByPattern(`enquiry_*_${req.params.id}`);
    await deleteByPattern('enquiry_list_*');
    logger.info(`Enquiry photo removed for ${req.params.id}`);
    res.json(record);
  } catch (err) {
    logger.error('Enquiry deletePhoto error:', err);
    const status = err.message === 'Enquiry not found' ? 404 : 500;
    res.status(status).json({ error: err.message || 'Failed to remove photo', code: status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest tests/enquiry_controller.test.js --verbose`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add controllers/sales/enquiry.controller.js tests/enquiry_controller.test.js
git commit -m "feat: representative self-assignment default and enquiry photo endpoints"
```

---

### Task 5: Routes — multer + photo endpoints

**Files:**
- Modify: `routes/sales/enquiry.js`

- [ ] **Step 1: Add multer and the two new routes**

Replace:

```js
const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/sales/enquiry.controller');

router.get('/templates', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getTemplates);
router.post('/refresh', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.refreshCache);
router.post('/', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.create);
router.get('/', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getAll);
router.get('/:id', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getOne);
router.put('/:id', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.update);
router.delete('/:id', authenticateToken, checkPermission('Enquiries', 'can_delete'), controller.delete);
router.post('/:id/assign', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.assign);
router.post('/:id/mark-done', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.markDone);
router.post('/:id/comment', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.addComment);
router.patch('/:id/stage', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.changeStage);
router.post('/:id/follow', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.follow);
router.delete('/:id/follow', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.unfollow);
router.post('/:enquiryId/activity/:activityId/read', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.markActivityRead);

module.exports = router;
```

With:

```js
const express = require('express');
const multer = require('multer');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/sales/enquiry.controller');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/templates', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getTemplates);
router.post('/refresh', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.refreshCache);
router.post('/', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.create);
router.get('/', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getAll);
router.get('/:id', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.getOne);
router.put('/:id', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.update);
router.delete('/:id', authenticateToken, checkPermission('Enquiries', 'can_delete'), controller.delete);
router.post('/:id/assign', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.assign);
router.post('/:id/mark-done', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.markDone);
router.post('/:id/comment', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.addComment);
router.patch('/:id/stage', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.changeStage);
router.post('/:id/follow', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.follow);
router.delete('/:id/follow', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.unfollow);
router.post('/:enquiryId/activity/:activityId/read', authenticateToken, checkPermission('Enquiries', 'can_read'), controller.markActivityRead);
router.post('/:id/photo', authenticateToken, checkPermission('Enquiries', 'can_write'), upload.single('photo'), controller.uploadPhoto);
router.delete('/:id/photo', authenticateToken, checkPermission('Enquiries', 'can_write'), controller.deletePhoto);

module.exports = router;
```

- [ ] **Step 2: Verify the server still boots**

Run: `node -e "require('./server.js')"` and interrupt it (Ctrl+C) once you see `Connected to PostgreSQL` / the listen log, or run `npm run dev` briefly and stop it.
Expected: no `Cannot find module` or route-registration errors from Express (a route handler that's `undefined` throws immediately at boot).

- [ ] **Step 3: Commit**

```bash
git add routes/sales/enquiry.js
git commit -m "feat: wire enquiry photo upload/delete routes"
```

---

### Task 6: Seed script — `representative` test account

**Files:**
- Create: `scripts/migrations/2026-09-23-seed-representative-user.js`

- [ ] **Step 1: Write the seed script**

```js
require('dotenv').config();
const pool = require('../../config/db');
const User = require('../../models/core/user');

async function seed() {
  const roleRes = await pool.query(`SELECT role_id FROM roles WHERE role_name = 'representative'`);
  if (roleRes.rows.length === 0) {
    throw new Error('representative role does not exist yet — run 2026-09-23-add-representative-role.js first');
  }
  const roleId = roleRes.rows[0].role_id;

  try {
    const { user } = await User.create({
      name: 'Representative (test)',
      email: 'representative@compageauto.com',
      password: 'password123',
      role_id: roleId,
    });
    console.log('Created representative test user:', user);
  } catch (err) {
    if (err.code === 'DUPLICATE_EMAIL') {
      console.log('representative@compageauto.com already exists, nothing to do.');
    } else {
      throw err;
    }
  }

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: STOP — do not run this yet**

This creates a real login in the production `users` table. Confirm explicitly with the user immediately before running:

```bash
node scripts/migrations/2026-09-23-seed-representative-user.js
```

Run this only after Task 1's migration has been run (the `representative` role must already exist).

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/2026-09-23-seed-representative-user.js
git commit -m "chore: add representative test-user seed script"
```

---

### Task 7: Frontend — register the `representative` role

**Files:**
- Modify: `CRM/src/constants.js`

- [ ] **Step 1: Add the role, dashboard route, and allowed paths**

Replace:

```js
export const ROLES = {
  ADMIN: "admin",
  CUSTOMER: "customer",
  SALES: "sales",
  DESIGN: "design",
  PRODUCTION: "production",
  STORE: "store",
  DISPATCH: "dispatch",
  ACCOUNTS: "accounts",
  // Compage
  EMPLOYEE: "employee",
  HR: "hr",
  // Intute
  IA_EMPLOYEE: "ia_employee",
  IA_HR: "ia_hr",
  // Service & Repair
  SERVICE_REPAIR: "service_repair",
};
```

With:

```js
export const ROLES = {
  ADMIN: "admin",
  CUSTOMER: "customer",
  SALES: "sales",
  DESIGN: "design",
  PRODUCTION: "production",
  STORE: "store",
  DISPATCH: "dispatch",
  ACCOUNTS: "accounts",
  // Compage
  EMPLOYEE: "employee",
  HR: "hr",
  // Intute
  IA_EMPLOYEE: "ia_employee",
  IA_HR: "ia_hr",
  // Service & Repair
  SERVICE_REPAIR: "service_repair",
  // Field sales
  REPRESENTATIVE: "representative",
};
```

Replace:

```js
export const DASHBOARD_ROUTES = {
  [ROLES.ADMIN]: "/admin-dashboard",
  [ROLES.SALES]: "/sales-dashboard",
  [ROLES.DESIGN]: "/design-dashboard",
  [ROLES.PRODUCTION]: "/production-dashboard",
  [ROLES.STORE]: "/store-dashboard",
  [ROLES.DISPATCH]: "/dispatch-dashboard",
  [ROLES.ACCOUNTS]: "/accounts-dashboard",
  [ROLES.CUSTOMER]: "/customer-dashboard",
  // Compage
  [ROLES.EMPLOYEE]: "/employee-dashboard",
  [ROLES.HR]: "/hr-dashboard",
  // Intute
  [ROLES.IA_EMPLOYEE]: "/ia-employee-dashboard",
  [ROLES.IA_HR]: "/ia-hr-dashboard",
  // Service & Repair
  [ROLES.SERVICE_REPAIR]: "/service-repair-dashboard",
};
```

With:

```js
export const DASHBOARD_ROUTES = {
  [ROLES.ADMIN]: "/admin-dashboard",
  [ROLES.SALES]: "/sales-dashboard",
  [ROLES.DESIGN]: "/design-dashboard",
  [ROLES.PRODUCTION]: "/production-dashboard",
  [ROLES.STORE]: "/store-dashboard",
  [ROLES.DISPATCH]: "/dispatch-dashboard",
  [ROLES.ACCOUNTS]: "/accounts-dashboard",
  [ROLES.CUSTOMER]: "/customer-dashboard",
  // Compage
  [ROLES.EMPLOYEE]: "/employee-dashboard",
  [ROLES.HR]: "/hr-dashboard",
  // Intute
  [ROLES.IA_EMPLOYEE]: "/ia-employee-dashboard",
  [ROLES.IA_HR]: "/ia-hr-dashboard",
  // Service & Repair
  [ROLES.SERVICE_REPAIR]: "/service-repair-dashboard",
  // Field sales
  [ROLES.REPRESENTATIVE]: "/representative-dashboard",
};
```

Replace:

```js
  // ── Service & Repair ─────────────────────────────────────
  [ROLES.SERVICE_REPAIR]: [
    "/service-repair-dashboard",
    "/service-repair",
    "/edit-profile",
  ],
};
```

With:

```js
  // ── Service & Repair ─────────────────────────────────────
  [ROLES.SERVICE_REPAIR]: [
    "/service-repair-dashboard",
    "/service-repair",
    "/edit-profile",
  ],

  // ── Field sales ────────────────────────────────────────
  [ROLES.REPRESENTATIVE]: [
    "/representative-dashboard",
    "/representative/enquiries",
    "/edit-profile",
  ],
};
```

- [ ] **Step 2: Commit**

```bash
git add CRM/src/constants.js
git commit -m "feat: register representative role and its routes"
```

---

### Task 8: Frontend — nav sidebar for the `representative` role

**Files:**
- Modify: `CRM/src/config/roleNav.js`

- [ ] **Step 1: Add a nav section and register it**

Replace:

```js
const roleNav = {
  admin: { dashboardPath: '/admin-dashboard', sections: adminNavSections },
  sales: { dashboardPath: '/sales-dashboard', sections: salesNavSections },
  production: { dashboardPath: '/production-dashboard', sections: productionNavSections },
  design: { dashboardPath: '/design-dashboard', sections: designNavSections },
  accounts: { dashboardPath: '/accounts-dashboard', sections: accountsNavSections },
  service_repair: { dashboardPath: '/service-repair-dashboard', sections: serviceRepairNavSections },
  store: { dashboardPath: '/store-dashboard', sections: storeNavSections },
  dispatch: { dashboardPath: '/dispatch-dashboard', sections: dispatchNavSections },
  customer: {
    dashboardPath: '/customer-dashboard',
    sections: customerNavSections,
    // Toasts shown while the dashboard is open (carried over from the old CustomerDashboard).
    socketToasts: [
      { event: 'orderUpdate', message: (order) => `Your order #${order.id} updated` },
      { event: 'queryUpdate', message: (query) => `Your query #${query.queryId} updated` },
    ],
  },
};
```

With:

```js
const representativeNavSections = [
  {
    title: 'Leads',
    shortLabel: 'Leads',
    accent: { bg: 'bg-gold-50', text: 'text-gold-600' },
    items: [
      { to: '/representative/enquiries', icon: Mail, label: 'Enquiries', desc: 'Capture and follow up on leads' },
    ],
  },
];

const roleNav = {
  admin: { dashboardPath: '/admin-dashboard', sections: adminNavSections },
  sales: { dashboardPath: '/sales-dashboard', sections: salesNavSections },
  production: { dashboardPath: '/production-dashboard', sections: productionNavSections },
  design: { dashboardPath: '/design-dashboard', sections: designNavSections },
  accounts: { dashboardPath: '/accounts-dashboard', sections: accountsNavSections },
  service_repair: { dashboardPath: '/service-repair-dashboard', sections: serviceRepairNavSections },
  store: { dashboardPath: '/store-dashboard', sections: storeNavSections },
  dispatch: { dashboardPath: '/dispatch-dashboard', sections: dispatchNavSections },
  representative: { dashboardPath: '/representative-dashboard', sections: representativeNavSections },
  customer: {
    dashboardPath: '/customer-dashboard',
    sections: customerNavSections,
    // Toasts shown while the dashboard is open (carried over from the old CustomerDashboard).
    socketToasts: [
      { event: 'orderUpdate', message: (order) => `Your order #${order.id} updated` },
      { event: 'queryUpdate', message: (query) => `Your query #${query.queryId} updated` },
    ],
  },
};
```

`Mail` is already imported at the top of this file (used by `salesNavSections`/`designNavSections`), so no import changes are needed.

- [ ] **Step 2: Commit**

```bash
git add CRM/src/config/roleNav.js
git commit -m "feat: add representative sidebar nav"
```

---

### Task 9: Frontend — create `RepresentativeEnquiryPage.jsx`

**Files:**
- Create: `CRM/src/components/representative/RepresentativeEnquiryPage.jsx` (start as a copy of `CRM/src/components/design/DesignEnquiryPage.jsx`)

`DesignEnquiryPage.jsx` is the closest existing shape (restricted to own assigned enquiries, already has a create/edit modal and detail drawer). This task clones it, then strips Design-only actions the client's flowchart never asked for, restricts the Remark dropdown to the client's 3 values, and adds City + a photo gallery.

- [ ] **Step 1: Copy the file**

```bash
mkdir -p CRM/src/components/representative
cp CRM/src/components/design/DesignEnquiryPage.jsx CRM/src/components/representative/RepresentativeEnquiryPage.jsx
```

- [ ] **Step 2: Rename the component**

In `CRM/src/components/representative/RepresentativeEnquiryPage.jsx`, replace:

```js
function DesignEnquiryPage({ socket: providedSocket }) {
```

With:

```js
function RepresentativeEnquiryPage({ socket: providedSocket }) {
```

And replace:

```js
export default DesignEnquiryPage;
```

With:

```js
export default RepresentativeEnquiryPage;
```

- [ ] **Step 3: Widen the role check from "design" to "representative"**

Replace:

```js
        // Optional frontend guard: design can only see its own assigned enquiries
        const roleName = String(currentUser?.role_name || "").toLowerCase();
        if (
          roleName === "design" &&
          enqData.assigned_to != null &&
          Number(enqData.assigned_to) !== Number(currentUser.user_id)
        ) {
          notifyError("You are not allowed to view this enquiry");
```

With:

```js
        // Frontend guard mirroring the backend: reps only see their own assigned enquiries
        const roleName = String(currentUser?.role_name || "").toLowerCase();
        if (
          roleName === "representative" &&
          enqData.assigned_to != null &&
          Number(enqData.assigned_to) !== Number(currentUser.user_id)
        ) {
          notifyError("You are not allowed to view this enquiry");
```

Replace:

```js
    // More robust role check: case-insensitive and tolerant of small differences
    const roleName = String(currentUser?.role_name || "").toLowerCase();
    if (roleName.includes("design")) {
      if (currentUser.user_id != null) {
        visible = enquiries.filter((item) => {
          if (item.assigned_to == null) return false;
          return Number(item.assigned_to) === Number(currentUser.user_id);
        });
      } else {
        // if user_id missing, hide all to be safe
        visible = [];
      }
    }
```

With:

```js
    // More robust role check: case-insensitive and tolerant of small differences
    const roleName = String(currentUser?.role_name || "").toLowerCase();
    if (roleName.includes("representative")) {
      if (currentUser.user_id != null) {
        visible = enquiries.filter((item) => {
          if (item.assigned_to == null) return false;
          return Number(item.assigned_to) === Number(currentUser.user_id);
        });
      } else {
        // if user_id missing, hide all to be safe
        visible = [];
      }
    }
```

- [ ] **Step 4: Remove the Design-only actions (assign to Sales/Admin, Mark Done)**

Remove the two assign functions. Replace:

```js
  // ASSIGN TO SALES (simple action - assigns to default SALES_USER_ID)
  // const assignToSales = async (enquiryId) => {
  //   if (
  //     !window.confirm(
  //       `Assign enquiry #${enquiryId} to Sales (user ${SALES_USER_ID})?`,
  //     )
  //   )
  //     return;
  //   try {
  //     const token = localStorage.getItem("token");
  //     const res = await fetch(`${API_URL}/${enquiryId}/assign`, {
  //       method: "POST",
  //       headers: {
  //         Authorization: `Bearer ${token}`,
  //         "Content-Type": "application/json",
  //       },
  //       body: JSON.stringify({
  //         assigned_to: SALES_USER_ID,
  //         due_date: null,
  //         message: "Assigned to Sales via UI",
  //       }),
  //     });
  //     if (!res.ok) {
  //       const txt = await res.text();
  //       throw new Error(txt || "Failed to assign to Sales");
  //     }
  //     const updated = await res.json();
  //     // update locally
  //     setEnquiries((prev) =>
  //       prev.map((e) =>
  //         e.enquiry_id === updated.enquiry_id ? { ...e, ...updated } : e,
  //       ),
  //     );
  //     setDetailEnquiry((prev) =>
  //       prev && prev.enquiry_id === updated.enquiry_id
  //         ? { ...prev, ...updated }
  //         : prev,
  //     );
  //     notifySuccess(`Enquiry #${enquiryId} assigned to Sales`);
  //     fetchEnquiries(true);
  //   } catch (err) {
  //     console.error("Assign to Sales error:", err);
  //     notifyError(err.message || "Failed to assign to Sales");
  //   }
  // };
  // ASSIGN TO SALES (simple action - assigns to default SALES_USER_ID)
  const assignToSales = async (enquiryId) => {
    if (
      !window.confirm(
        `Assign enquiry #${enquiryId} to Sales (user ${SALES_USER_ID})?`,
      )
    )
      return;
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/${enquiryId}/assign`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assigned_to: SALES_USER_ID,
          due_date: null,
          message: "Assigned to Sales via UI",
        }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to assign to Sales");
      }
      const updated = await res.json();
      // update locally
      setEnquiries((prev) =>
        prev.map((e) =>
          e.enquiry_id === updated.enquiry_id ? { ...e, ...updated } : e,
        ),
      );
      setDetailEnquiry((prev) =>
        prev && prev.enquiry_id === updated.enquiry_id
          ? { ...prev, ...updated }
          : prev,
      );
      notifySuccess(`Enquiry #${enquiryId} assigned to Sales`);
      fetchEnquiries(true);
    } catch (err) {
      console.error("Assign to Sales error:", err);
      notifyError(err.message || "Failed to assign to Sales");
    }
  };

  // ASSIGN TO ADMIN (similar to Sales, but uses ADMIN_USER_ID)
  const assignToAdmin = async (enquiryId) => {
    if (
      !window.confirm(
        `Assign enquiry #${enquiryId} to Admin (user ${ADMIN_USER_ID})?`,
      )
    )
      return;
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/${enquiryId}/assign`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assigned_to: ADMIN_USER_ID,
          due_date: null,
          message: "Assigned to Admin via UI",
        }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to assign to Admin");
      }
      const updated = await res.json();
      // update locally
      setEnquiries((prev) =>
        prev.map((e) =>
          e.enquiry_id === updated.enquiry_id ? { ...e, ...updated } : e,
        ),
      );
      setDetailEnquiry((prev) =>
        prev && prev.enquiry_id === updated.enquiry_id
          ? { ...prev, ...updated }
          : prev,
      );
      notifySuccess(`Enquiry #${enquiryId} assigned to Admin`);
      fetchEnquiries(true);
    } catch (err) {
      console.error("Assign to Admin error:", err);
      notifyError(err.message || "Failed to assign to Admin");
    }
  };

  // MARK DONE — Design-only action that sends back to Sales
  const handleMarkDone = async (enquiryId) => {
    if (
      !window.confirm(`Mark enquiry #${enquiryId} as DONE and return to Sales?`)
    )
      return;

    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/${enquiryId}/mark-done`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to mark done");
      }

      const updated = await res.json();

      setEnquiries((prev) =>
        prev.map((e) =>
          e.enquiry_id === updated.enquiry_id ? { ...e, ...updated } : e,
        ),
      );
      setDetailEnquiry((prev) =>
        prev && prev.enquiry_id === updated.enquiry_id
          ? { ...prev, ...updated }
          : prev,
      );

      notifySuccess(
        `Enquiry #${updated.enquiry_id} marked done and returned to Sales`,
      );
      fetchEnquiries(true);
    } catch (err) {
      console.error("Mark done error:", err);
      notifyError(err.message || "Failed to mark done");
    }
  };
```

With nothing (delete this whole block — reps have no assign/mark-done step in the client's flow).

- [ ] **Step 5: Remove the now-unused `SALES_USER_ID`/`ADMIN_USER_ID` constants**

Replace:

```js
const API_URL = `${BASE_URL}/api/enquiry`;
// Default SALES user id (backend uses DEFAULT_SALES_USER_ID or 7)
const SALES_USER_ID = import.meta.env.VITE_DEFAULT_SALES_USER_ID
  ? parseInt(import.meta.env.VITE_DEFAULT_SALES_USER_ID, 10)
  : 7;
const ADMIN_USER_ID = import.meta.env.VITE_DEFAULT_ADMIN_USER_ID
  ? parseInt(import.meta.env.VITE_DEFAULT_ADMIN_USER_ID, 10)
  : 1;
```

With:

```js
const API_URL = `${BASE_URL}/api/enquiry`;
```

- [ ] **Step 6: Remove the Assign-to-Sales/Admin and Mark-Done menu items and button**

Replace:

```js
              {/* Assign to Sales - visible to non-design/admin-like roles (you can tweak the condition) */}
              {!String(currentUser.role_name || "")
                .toLowerCase()
                .includes("design") && (
                <>
                  <button
                    onClick={() => {
                      setActionsMenuState((prev) => ({
                        ...prev,
                        isOpen: false,
                      }));
                      assignToSales(actionsMenuState.enquiry.enquiry_id);
                    }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-navy-50 flex items-center gap-2"
                  >
                    📤 Assign to Sales
                  </button>

                  <button
                    onClick={() => {
                      setActionsMenuState((prev) => ({
                        ...prev,
                        isOpen: false,
                      }));
                      assignToAdmin(actionsMenuState.enquiry.enquiry_id);
                    }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-navy-50 flex items-center gap-2"
                  >
                    🧑‍💼 Assign to Admin
                  </button>
                </>
              )}

              {/* MARK DONE - only show if assigned to current Design user */}
              {Number(actionsMenuState.enquiry.assigned_to) ===
                Number(currentUser.user_id) &&
                String(currentUser.role_name || "")
                  .toLowerCase()
                  .includes("design") && (
                  <button
                    onClick={() => {
                      setActionsMenuState((prev) => ({
                        ...prev,
                        isOpen: false,
                      }));
                      handleMarkDone(actionsMenuState.enquiry.enquiry_id);
                    }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-navy-50 flex items-center gap-2"
                  >
                    ✅ Mark Done
                  </button>
                )}

              <button
```

With:

```js
              <button
```

Replace:

```js
                    <div className="flex justify-between items-center gap-3">
                      {Number(detailEnquiry.assigned_to) ===
                        Number(currentUser.user_id) &&
                        String(currentUser.role_name || "")
                          .toLowerCase()
                          .includes("design") && (
                          <button
                            onClick={() =>
                              handleMarkDone(detailEnquiry.enquiry_id)
                            }
                            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700"
                          >
                            ✅ Mark Done
                          </button>
                        )}

                      <div className="ml-auto">
```

With:

```js
                    <div className="flex justify-between items-center gap-3">
                      <div className="ml-auto">
```

- [ ] **Step 7: Remove Delete (reps don't have `can_delete` on the `Enquiries` module)**

Replace:

```js
              <button
                onClick={() => {
                  setActionsMenuState((prev) => ({
                    ...prev,
                    isOpen: false,
                  }));
                  toggleFollow(actionsMenuState.enquiry.enquiry_id);
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-navy-50 flex items-center gap-2"
              >
                {followed.has(actionsMenuState.enquiry.enquiry_id)
                  ? "⭐ Unfollow"
                  : "⭐ Follow"}
              </button>

              <button
                onClick={() => {
                  setActionsMenuState((prev) => ({
                    ...prev,
                    isOpen: false,
                  }));
                  handleDelete(actionsMenuState.enquiry.enquiry_id);
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-red-50 text-red-600 flex items-center gap-2 border-t border-gray-100"
              >
                🗑️ Delete
              </button>
            </div>
          </div>
        )}
```

With:

```js
              <button
                onClick={() => {
                  setActionsMenuState((prev) => ({
                    ...prev,
                    isOpen: false,
                  }));
                  toggleFollow(actionsMenuState.enquiry.enquiry_id);
                }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-navy-50 flex items-center gap-2"
              >
                {followed.has(actionsMenuState.enquiry.enquiry_id)
                  ? "⭐ Unfollow"
                  : "⭐ Follow"}
              </button>
            </div>
          </div>
        )}
```

`handleDelete` itself can stay unused-but-defined for now — it's dead code but harmless; removing it isn't worth the risk of an imprecise diff in this pass.

- [ ] **Step 8: Restrict the Remark ("Lead Status") dropdown to the client's 3 values**

Replace:

```js
                  {
                    label: "Lead Status",
                    key: "lead",
                    type: "select",
                    icon: "M12 8c-1.657 0-3 1.343-3 3 0 .795.312 1.515.82 2.05L9 17l3-1 3 1-1-3.95A2.99 2.99 0 0015 11c0-1.657-1.343-3-3-3z",
                    options: [
                      "hotlead",
                      "followup",
                      "lead",
                      "not_interested",
                      "closed",
                    ],
                  },
```

With:

```js
                  {
                    label: "Remark (next call to action)",
                    key: "lead",
                    type: "select",
                    icon: "M12 8c-1.657 0-3 1.343-3 3 0 .795.312 1.515.82 2.05L9 17l3-1 3 1-1-3.95A2.99 2.99 0 0015 11c0-1.657-1.343-3-3-3z",
                    options: ["hotlead", "followup", "not_interested"],
                  },
                  {
                    label: "City",
                    key: "city",
                    icon: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z",
                  },
```

- [ ] **Step 9: Add `city` to form state — initial state, `resetForm`, `handleEdit`, `handleSubmit` body**

Replace:

```js
  const [newEnquiry, setNewEnquiry] = useState({
    enquiry_id: "",
    company_name: "",
    contact_person: "",
    mail_id: "",
    phone_no: "",
    items_required: "",
    status: "Pending",
    last_discussion: "",
    next_interaction: "",
    lead: "lead",
    source: "Website",
    tagsInput: "",
    due_date: "",
  });
```

With:

```js
  const [newEnquiry, setNewEnquiry] = useState({
    enquiry_id: "",
    company_name: "",
    contact_person: "",
    mail_id: "",
    phone_no: "",
    items_required: "",
    status: "Pending",
    last_discussion: "",
    next_interaction: "",
    lead: "hotlead",
    source: "Website",
    tagsInput: "",
    due_date: "",
    city: "",
  });
```

(Default `lead` to `"hotlead"` instead of `"lead"` since `"lead"` is no longer one of the offered options.)

Replace:

```js
  const resetForm = () => {
    setNewEnquiry({
      enquiry_id: "",
      company_name: "",
      contact_person: "",
      mail_id: "",
      phone_no: "",
      items_required: "",
      status: "Pending",
      last_discussion: "",
      next_interaction: "",
      lead: "lead",
      source: "Website",
      tagsInput: "",
      due_date: "",
    });
    setErrors({});
  };
```

With:

```js
  const resetForm = () => {
    setNewEnquiry({
      enquiry_id: "",
      company_name: "",
      contact_person: "",
      mail_id: "",
      phone_no: "",
      items_required: "",
      status: "Pending",
      last_discussion: "",
      next_interaction: "",
      lead: "hotlead",
      source: "Website",
      tagsInput: "",
      due_date: "",
      city: "",
    });
    setErrors({});
  };
```

Replace:

```js
  const handleEdit = useCallback((enquiry) => {
    const effectiveLead = enquiry.lead || enquiry.priority || "lead";
    setIsEditing(true);
    setSelectedEnquiry(enquiry);
    setNewEnquiry({
      enquiry_id: enquiry.enquiry_id || "",
      company_name: enquiry.company_name || "",
      contact_person: enquiry.contact_person || "",
      mail_id: enquiry.mail_id || "",
      phone_no: enquiry.phone_no || "",
      items_required: enquiry.items_required || "",
      status: enquiry.status || "Pending",
      last_discussion: enquiry.last_discussion
        ? new Date(enquiry.last_discussion).toISOString().split("T")[0]
        : "",
      next_interaction: enquiry.next_interaction
        ? new Date(enquiry.next_interaction).toISOString().split("T")[0]
        : "",
      lead: effectiveLead,
      source: enquiry.source || "Website",
      tagsInput: Array.isArray(enquiry.tags) ? enquiry.tags.join(", ") : "",
      due_date: enquiry.due_date
        ? new Date(enquiry.due_date).toISOString().split("T")[0]
        : "",
    });
    setErrors({});
    setIsModalOpen(true);
  }, []);
```

With:

```js
  const handleEdit = useCallback((enquiry) => {
    const effectiveLead = enquiry.lead || enquiry.priority || "hotlead";
    setIsEditing(true);
    setSelectedEnquiry(enquiry);
    setNewEnquiry({
      enquiry_id: enquiry.enquiry_id || "",
      company_name: enquiry.company_name || "",
      contact_person: enquiry.contact_person || "",
      mail_id: enquiry.mail_id || "",
      phone_no: enquiry.phone_no || "",
      items_required: enquiry.items_required || "",
      status: enquiry.status || "Pending",
      last_discussion: enquiry.last_discussion
        ? new Date(enquiry.last_discussion).toISOString().split("T")[0]
        : "",
      next_interaction: enquiry.next_interaction
        ? new Date(enquiry.next_interaction).toISOString().split("T")[0]
        : "",
      lead: effectiveLead,
      source: enquiry.source || "Website",
      tagsInput: Array.isArray(enquiry.tags) ? enquiry.tags.join(", ") : "",
      due_date: enquiry.due_date
        ? new Date(enquiry.due_date).toISOString().split("T")[0]
        : "",
      city: enquiry.city || "",
    });
    setErrors({});
    setIsModalOpen(true);
  }, []);
```

Replace:

```js
      const body = {
        company_name: newEnquiry.company_name,
        contact_person: newEnquiry.contact_person || null,
        mail_id: newEnquiry.mail_id || null,
        phone_no: newEnquiry.phone_no || null,
        items_required: newEnquiry.items_required || null,
        status: newEnquiry.status,
        last_discussion: newEnquiry.last_discussion || null,
        next_interaction: newEnquiry.next_interaction || null,
        lead: newEnquiry.lead,
        source: newEnquiry.source,
        tags: tagsArray,
        due_date: newEnquiry.due_date || null,
      };
```

With:

```js
      const body = {
        company_name: newEnquiry.company_name,
        contact_person: newEnquiry.contact_person || null,
        mail_id: newEnquiry.mail_id || null,
        phone_no: newEnquiry.phone_no || null,
        items_required: newEnquiry.items_required || null,
        status: newEnquiry.status,
        last_discussion: newEnquiry.last_discussion || null,
        next_interaction: newEnquiry.next_interaction || null,
        lead: newEnquiry.lead,
        source: newEnquiry.source,
        tags: tagsArray,
        due_date: newEnquiry.due_date || null,
        city: newEnquiry.city || null,
      };
```

- [ ] **Step 10: Add City display and a photo gallery to the detail drawer**

Replace:

```js
                  {/* show application in detail */}
                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      Application
                    </h3>
                    <p className="text-sm text-gray-700">
                      {detailEnquiry.application || "N/A"}
                    </p>
                  </div>
```

With:

```js
                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      City
                    </h3>
                    <p className="text-sm text-gray-700">
                      {detailEnquiry.city || "N/A"}
                    </p>
                  </div>

                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Photos
                      </h3>
                      <label className="text-[11px] font-semibold text-gold-600 cursor-pointer hover:text-gold-700">
                        + Add photo
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleUploadPhoto(file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                    {Array.isArray(detailEnquiry.photos) &&
                    detailEnquiry.photos.length > 0 ? (
                      <div className="grid grid-cols-3 gap-2">
                        {detailEnquiry.photos.map((url) => (
                          <div key={url} className="relative group">
                            <img
                              src={url}
                              alt="Enquiry"
                              className="w-full h-20 object-cover rounded-lg border border-navy-100"
                            />
                            <button
                              type="button"
                              onClick={() => handleDeletePhoto(url)}
                              className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-navy-900/70 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400">No photos yet.</p>
                    )}
                  </div>
```

- [ ] **Step 11: Add the `handleUploadPhoto`/`handleDeletePhoto` handlers**

Insert immediately after `toggleFollow`'s closing `};` (right before the `// FILTERED (Design sees only own assigned enquiries if user info present)` comment):

```js

  const handleUploadPhoto = async (file) => {
    try {
      const token = localStorage.getItem("token");
      const formData = new FormData();
      formData.append("photo", file);
      const res = await fetch(`${API_URL}/${detailEnquiry.enquiry_id}/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to upload photo");
      }
      const { record } = await res.json();
      setDetailEnquiry((prev) =>
        prev ? { ...prev, photos: record.photos } : prev,
      );
      notifySuccess("Photo added");
    } catch (err) {
      console.error("Upload photo error:", err);
      notifyError(err.message || "Failed to upload photo");
    }
  };

  const handleDeletePhoto = async (url) => {
    if (!window.confirm("Remove this photo?")) return;
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/${detailEnquiry.enquiry_id}/photo`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to remove photo");
      }
      const record = await res.json();
      setDetailEnquiry((prev) =>
        prev ? { ...prev, photos: record.photos } : prev,
      );
      notifySuccess("Photo removed");
    } catch (err) {
      console.error("Delete photo error:", err);
      notifyError(err.message || "Failed to remove photo");
    }
  };
```

- [ ] **Step 12: Lint the new file**

Run: `cd CRM && npx eslint src/components/representative/RepresentativeEnquiryPage.jsx`
Expected: no errors (in particular, no `no-unused-vars` for anything left over from the removed Design-only code — if `handleDelete`, `ArrowDownUp`, etc. show as unused, that's expected and fine since they're still referenced elsewhere in the file; only fix genuinely new lint errors introduced by this task's edits).

- [ ] **Step 13: Commit**

```bash
cd CRM && git add src/components/representative/RepresentativeEnquiryPage.jsx
git commit -m "feat: add RepresentativeEnquiryPage with city and photo gallery"
```

---

### Task 10: Frontend — wire the route

**Files:**
- Modify: `CRM/src/routeConfig.jsx`

- [ ] **Step 1: Import the new page**

Replace:

```js
import DesignEnquiryPage from "./components/design/DesignEnquiryPage";
```

With:

```js
import DesignEnquiryPage from "./components/design/DesignEnquiryPage";
import RepresentativeEnquiryPage from "./components/representative/RepresentativeEnquiryPage";
```

- [ ] **Step 2: Add the dashboard + enquiries routes**

Replace:

```js
  // ── Design Routes ─────────────────────────────────────────────
  {
    path: "/design-dashboard",
    allowedRoles: ["design"],
    component: RoleDashboard,
  },
  {
    path: "/design/enquiries",
    allowedRoles: ["design"],
    component: DesignEnquiryPage,
  },
  {
    path: "/design/part-creation",
    allowedRoles: ["design"],
    component: DesignPartCreation,
  },
```

With:

```js
  // ── Design Routes ─────────────────────────────────────────────
  {
    path: "/design-dashboard",
    allowedRoles: ["design"],
    component: RoleDashboard,
  },
  {
    path: "/design/enquiries",
    allowedRoles: ["design"],
    component: DesignEnquiryPage,
  },
  {
    path: "/design/part-creation",
    allowedRoles: ["design"],
    component: DesignPartCreation,
  },

  // ── Representative Routes ────────────────────────────────────
  {
    path: "/representative-dashboard",
    allowedRoles: ["representative"],
    component: RoleDashboard,
  },
  {
    path: "/representative/enquiries",
    allowedRoles: ["representative"],
    component: RepresentativeEnquiryPage,
  },
```

- [ ] **Step 2: Lint**

Run: `cd CRM && npx eslint src/routeConfig.jsx`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd CRM && git add src/routeConfig.jsx
git commit -m "feat: route representative dashboard and enquiries page"
```

---

### Task 11: Frontend — retrofit City + Photos into `DesignEnquiryPage.jsx`

**Files:**
- Modify: `CRM/src/components/design/DesignEnquiryPage.jsx`

- [ ] **Step 1: Add City to the create/edit form fields**

Replace:

```js
                  {
                    label: "Contact Person",
                    key: "contact_person",
                    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
                  },
                  {
                    label: "Email",
                    key: "mail_id",
                    type: "email",
                    icon: "M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4",
                  },
```

With:

```js
                  {
                    label: "Contact Person",
                    key: "contact_person",
                    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
                  },
                  {
                    label: "City",
                    key: "city",
                    icon: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z",
                  },
                  {
                    label: "Email",
                    key: "mail_id",
                    type: "email",
                    icon: "M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4",
                  },
```

- [ ] **Step 2: Add `city` to form state — initial state, `resetForm`, `handleEdit`, `handleSubmit` body**

Replace:

```js
  const [newEnquiry, setNewEnquiry] = useState({
    enquiry_id: "",
    company_name: "",
    contact_person: "",
    mail_id: "",
    phone_no: "",
    items_required: "",
    status: "Pending",
    last_discussion: "",
    next_interaction: "",
    lead: "lead",
    source: "Website",
    tagsInput: "",
    due_date: "",
  });
  const [errors, setErrors] = useState({});
```

With:

```js
  const [newEnquiry, setNewEnquiry] = useState({
    enquiry_id: "",
    company_name: "",
    contact_person: "",
    mail_id: "",
    phone_no: "",
    items_required: "",
    status: "Pending",
    last_discussion: "",
    next_interaction: "",
    lead: "lead",
    source: "Website",
    tagsInput: "",
    due_date: "",
    city: "",
  });
  const [errors, setErrors] = useState({});
```

Replace:

```js
  const resetForm = () => {
    setNewEnquiry({
      enquiry_id: "",
      company_name: "",
      contact_person: "",
      mail_id: "",
      phone_no: "",
      items_required: "",
      status: "Pending",
      last_discussion: "",
      next_interaction: "",
      lead: "lead",
      source: "Website",
      tagsInput: "",
      due_date: "",
    });
    setErrors({});
  };
```

With:

```js
  const resetForm = () => {
    setNewEnquiry({
      enquiry_id: "",
      company_name: "",
      contact_person: "",
      mail_id: "",
      phone_no: "",
      items_required: "",
      status: "Pending",
      last_discussion: "",
      next_interaction: "",
      lead: "lead",
      source: "Website",
      tagsInput: "",
      due_date: "",
      city: "",
    });
    setErrors({});
  };
```

Replace:

```js
      lead: effectiveLead,
      source: enquiry.source || "Website",
      tagsInput: Array.isArray(enquiry.tags) ? enquiry.tags.join(", ") : "",
      due_date: enquiry.due_date
        ? new Date(enquiry.due_date).toISOString().split("T")[0]
        : "",
    });
    setErrors({});
    setIsModalOpen(true);
  }, []);
```

With:

```js
      lead: effectiveLead,
      source: enquiry.source || "Website",
      tagsInput: Array.isArray(enquiry.tags) ? enquiry.tags.join(", ") : "",
      due_date: enquiry.due_date
        ? new Date(enquiry.due_date).toISOString().split("T")[0]
        : "",
      city: enquiry.city || "",
    });
    setErrors({});
    setIsModalOpen(true);
  }, []);
```

Replace:

```js
      const body = {
        company_name: newEnquiry.company_name,
        contact_person: newEnquiry.contact_person || null,
        mail_id: newEnquiry.mail_id || null,
        phone_no: newEnquiry.phone_no || null,
        items_required: newEnquiry.items_required || null,
        status: newEnquiry.status,
        last_discussion: newEnquiry.last_discussion || null,
        next_interaction: newEnquiry.next_interaction || null,
        lead: newEnquiry.lead,
        source: newEnquiry.source,
        tags: tagsArray,
        due_date: newEnquiry.due_date || null,
      };
      if (newEnquiry.enquiry_id) body.enquiry_id = newEnquiry.enquiry_id;
```

With:

```js
      const body = {
        company_name: newEnquiry.company_name,
        contact_person: newEnquiry.contact_person || null,
        mail_id: newEnquiry.mail_id || null,
        phone_no: newEnquiry.phone_no || null,
        items_required: newEnquiry.items_required || null,
        status: newEnquiry.status,
        last_discussion: newEnquiry.last_discussion || null,
        next_interaction: newEnquiry.next_interaction || null,
        lead: newEnquiry.lead,
        source: newEnquiry.source,
        tags: tagsArray,
        due_date: newEnquiry.due_date || null,
        city: newEnquiry.city || null,
      };
      if (newEnquiry.enquiry_id) body.enquiry_id = newEnquiry.enquiry_id;
```

- [ ] **Step 3: Add City display + photo gallery to the detail drawer**

Replace:

```js
                  {/* show application in detail */}
                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      Application
                    </h3>
                    <p className="text-sm text-gray-700">
                      {detailEnquiry.application || "N/A"}
                    </p>
                  </div>
```

With:

```js
                  {/* show application in detail */}
                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      Application
                    </h3>
                    <p className="text-sm text-gray-700">
                      {detailEnquiry.application || "N/A"}
                    </p>
                  </div>

                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      City
                    </h3>
                    <p className="text-sm text-gray-700">
                      {detailEnquiry.city || "N/A"}
                    </p>
                  </div>

                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Photos
                      </h3>
                      <label className="text-[11px] font-semibold text-gold-600 cursor-pointer hover:text-gold-700">
                        + Add photo
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleUploadPhoto(file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                    {Array.isArray(detailEnquiry.photos) &&
                    detailEnquiry.photos.length > 0 ? (
                      <div className="grid grid-cols-3 gap-2">
                        {detailEnquiry.photos.map((url) => (
                          <div key={url} className="relative group">
                            <img
                              src={url}
                              alt="Enquiry"
                              className="w-full h-20 object-cover rounded-lg border border-navy-100"
                            />
                            <button
                              type="button"
                              onClick={() => handleDeletePhoto(url)}
                              className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-navy-900/70 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400">No photos yet.</p>
                    )}
                  </div>
```

- [ ] **Step 4: Add the `handleUploadPhoto`/`handleDeletePhoto` handlers**

Insert immediately after `toggleFollow`'s closing `};` (right before the `// ASSIGN TO SALES` comment):

```js

  const handleUploadPhoto = async (file) => {
    try {
      const token = localStorage.getItem("token");
      const formData = new FormData();
      formData.append("photo", file);
      const res = await fetch(`${API_URL}/${detailEnquiry.enquiry_id}/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to upload photo");
      }
      const { record } = await res.json();
      setDetailEnquiry((prev) =>
        prev ? { ...prev, photos: record.photos } : prev,
      );
      notifySuccess("Photo added");
    } catch (err) {
      console.error("Upload photo error:", err);
      notifyError(err.message || "Failed to upload photo");
    }
  };

  const handleDeletePhoto = async (url) => {
    if (!window.confirm("Remove this photo?")) return;
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/${detailEnquiry.enquiry_id}/photo`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to remove photo");
      }
      const record = await res.json();
      setDetailEnquiry((prev) =>
        prev ? { ...prev, photos: record.photos } : prev,
      );
      notifySuccess("Photo removed");
    } catch (err) {
      console.error("Delete photo error:", err);
      notifyError(err.message || "Failed to remove photo");
    }
  };
```

- [ ] **Step 5: Lint and commit**

```bash
cd CRM && npx eslint src/components/design/DesignEnquiryPage.jsx
git add src/components/design/DesignEnquiryPage.jsx
git commit -m "feat: show city and photo gallery on the Design enquiry page"
```

---

### Task 12: Frontend — retrofit City + Photos into `SalesEnquiryPage.jsx`

**Files:**
- Modify: `CRM/src/components/sales/SalesEnquiryPage.jsx`

- [ ] **Step 1: Add City to the create/edit form fields**

Replace:

```js
                  {
                    label: "Contact Person",
                    key: "contact_person",
                    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
                  },
                  {
                    label: "Email",
                    key: "mail_id",
                    type: "email",
                    icon: "M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4",
                  },
```

With:

```js
                  {
                    label: "Contact Person",
                    key: "contact_person",
                    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
                  },
                  {
                    label: "City",
                    key: "city",
                    icon: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z",
                  },
                  {
                    label: "Email",
                    key: "mail_id",
                    type: "email",
                    icon: "M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4",
                  },
```

- [ ] **Step 2: Add `city` to form state — initial state, `resetForm`, `handleEdit`, `handleSubmit` body**

Replace:

```js
  const [newEnquiry, setNewEnquiry] = useState({
    enquiry_id: "",
    company_name: "",
    contact_person: "",
    mail_id: "",
    phone_no: "",
    items_required: "",
    status: "Pending",
    last_discussion: "",
    next_interaction: "",
    lead: "lead", // 🔥 main field
    source: "Website",
    application: "", // <-- NEW application field
    tagsInput: "",
    due_date: "",
  });
```

With:

```js
  const [newEnquiry, setNewEnquiry] = useState({
    enquiry_id: "",
    company_name: "",
    contact_person: "",
    mail_id: "",
    phone_no: "",
    items_required: "",
    status: "Pending",
    last_discussion: "",
    next_interaction: "",
    lead: "lead", // 🔥 main field
    source: "Website",
    application: "", // <-- NEW application field
    tagsInput: "",
    due_date: "",
    city: "",
  });
```

Replace:

```js
  const resetForm = () => {
    setNewEnquiry({
      enquiry_id: "",
      company_name: "",
      contact_person: "",
      mail_id: "",
      phone_no: "",
      items_required: "",
      status: "Pending",
      last_discussion: "",
      next_interaction: "",
      lead: "lead",
      source: "Website",
      application: "",
      tagsInput: "",
      due_date: "",
    });
    setErrors({});
  };
```

With:

```js
  const resetForm = () => {
    setNewEnquiry({
      enquiry_id: "",
      company_name: "",
      contact_person: "",
      mail_id: "",
      phone_no: "",
      items_required: "",
      status: "Pending",
      last_discussion: "",
      next_interaction: "",
      lead: "lead",
      source: "Website",
      application: "",
      tagsInput: "",
      due_date: "",
      city: "",
    });
    setErrors({});
  };
```

Replace:

```js
      lead: effectiveLead,
      source: enquiry.source || "Website",
      application: enquiry.application || "",
      tagsInput: Array.isArray(enquiry.tags) ? enquiry.tags.join(", ") : "",
      due_date: enquiry.due_date
        ? new Date(enquiry.due_date).toISOString().split("T")[0]
        : "",
    });
```

With:

```js
      lead: effectiveLead,
      source: enquiry.source || "Website",
      application: enquiry.application || "",
      tagsInput: Array.isArray(enquiry.tags) ? enquiry.tags.join(", ") : "",
      due_date: enquiry.due_date
        ? new Date(enquiry.due_date).toISOString().split("T")[0]
        : "",
      city: enquiry.city || "",
    });
```

Replace:

```js
      const body = {
        company_name: newEnquiry.company_name,
        contact_person: newEnquiry.contact_person || null,
        mail_id: newEnquiry.mail_id || null,
        phone_no: newEnquiry.phone_no || null,
        items_required: newEnquiry.items_required || null,
        status: newEnquiry.status,
        last_discussion: newEnquiry.last_discussion || null,
        next_interaction: newEnquiry.next_interaction || null,
        lead: newEnquiry.lead,
        source: newEnquiry.source,
        application: newEnquiry.application || null, // <-- include application
        tags: tagsArray,
        due_date: newEnquiry.due_date || null,
      };
```

With:

```js
      const body = {
        company_name: newEnquiry.company_name,
        contact_person: newEnquiry.contact_person || null,
        mail_id: newEnquiry.mail_id || null,
        phone_no: newEnquiry.phone_no || null,
        items_required: newEnquiry.items_required || null,
        status: newEnquiry.status,
        last_discussion: newEnquiry.last_discussion || null,
        next_interaction: newEnquiry.next_interaction || null,
        lead: newEnquiry.lead,
        source: newEnquiry.source,
        application: newEnquiry.application || null, // <-- include application
        tags: tagsArray,
        due_date: newEnquiry.due_date || null,
        city: newEnquiry.city || null,
      };
```

- [ ] **Step 3: Add City display + photo gallery to the detail drawer**

Replace:

```js
                  {/* Items Required */}
                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      Items Required
                    </h3>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">
                      {detailEnquiry.items_required || "No items specified."}
                    </p>
                  </div>
```

With:

```js
                  {/* Items Required */}
                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      Items Required
                    </h3>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">
                      {detailEnquiry.items_required || "No items specified."}
                    </p>
                  </div>

                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      City
                    </h3>
                    <p className="text-sm text-gray-700">
                      {detailEnquiry.city || "N/A"}
                    </p>
                  </div>

                  <div className="mb-4 rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Photos
                      </h3>
                      <label className="text-[11px] font-semibold text-gold-600 cursor-pointer hover:text-gold-700">
                        + Add photo
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleUploadPhoto(file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                    {Array.isArray(detailEnquiry.photos) &&
                    detailEnquiry.photos.length > 0 ? (
                      <div className="grid grid-cols-3 gap-2">
                        {detailEnquiry.photos.map((url) => (
                          <div key={url} className="relative group">
                            <img
                              src={url}
                              alt="Enquiry"
                              className="w-full h-20 object-cover rounded-lg border border-navy-100"
                            />
                            <button
                              type="button"
                              onClick={() => handleDeletePhoto(url)}
                              className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-navy-900/70 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400">No photos yet.</p>
                    )}
                  </div>
```

- [ ] **Step 4: Add the `handleUploadPhoto`/`handleDeletePhoto` handlers**

This file's `toggleFollow` ends differently from Design's (it passes a second options argument to `notifySuccess`) and is followed by `openAssignModal`, not an assign-to-Sales block. Replace:

```js
      notifySuccess(
        isCurrentlyFollowed
          ? `Unfollowed enquiry #${enquiryId}`
          : `Following enquiry #${enquiryId}`,
        { className: "bg-gold-400/20 border-gold-400/50" },
      );
    } catch (err) {
      console.error("Follow toggle error:", err);
      notifyError(err.message || "Failed to update follow state");
    }
  };

  // OPEN ASSIGN MODAL
  const openAssignModal = (enquiry) => {
```

With:

```js
      notifySuccess(
        isCurrentlyFollowed
          ? `Unfollowed enquiry #${enquiryId}`
          : `Following enquiry #${enquiryId}`,
        { className: "bg-gold-400/20 border-gold-400/50" },
      );
    } catch (err) {
      console.error("Follow toggle error:", err);
      notifyError(err.message || "Failed to update follow state");
    }
  };

  const handleUploadPhoto = async (file) => {
    try {
      const token = localStorage.getItem("token");
      const formData = new FormData();
      formData.append("photo", file);
      const res = await fetch(`${API_URL}/${detailEnquiry.enquiry_id}/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to upload photo");
      }
      const { record } = await res.json();
      setDetailEnquiry((prev) =>
        prev ? { ...prev, photos: record.photos } : prev,
      );
      notifySuccess("Photo added");
    } catch (err) {
      console.error("Upload photo error:", err);
      notifyError(err.message || "Failed to upload photo");
    }
  };

  const handleDeletePhoto = async (url) => {
    if (!window.confirm("Remove this photo?")) return;
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/${detailEnquiry.enquiry_id}/photo`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to remove photo");
      }
      const record = await res.json();
      setDetailEnquiry((prev) =>
        prev ? { ...prev, photos: record.photos } : prev,
      );
      notifySuccess("Photo removed");
    } catch (err) {
      console.error("Delete photo error:", err);
      notifyError(err.message || "Failed to remove photo");
    }
  };

  // OPEN ASSIGN MODAL
  const openAssignModal = (enquiry) => {
```

- [ ] **Step 5: Lint and commit**

```bash
cd CRM && npx eslint src/components/sales/SalesEnquiryPage.jsx
git add src/components/sales/SalesEnquiryPage.jsx
git commit -m "feat: show city and photo gallery on the Sales enquiry page"
```

---

### Task 13: Frontend — retrofit City + Photos into `admin/EnquiryPage.jsx`

**Files:**
- Modify: `CRM/src/components/admin/EnquiryPage.jsx`

- [ ] **Step 1: Add City to the create/edit form fields**

Replace:

```js
                  {
                    label: "Contact Person",
                    key: "contact_person",
                    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
                  },
```

With:

```js
                  {
                    label: "Contact Person",
                    key: "contact_person",
                    icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z",
                  },
                  {
                    label: "City",
                    key: "city",
                    icon: "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z",
                  },
```

- [ ] **Step 2: Add `city` to form state — initial state, `resetForm`, `handleEdit`, `handleSubmit` body**

Replace:

```js
  const resetForm = () => {
    setNewEnquiry({
      enquiry_id: "",
      company_name: "",
      contact_person: "",
      mail_id: "",
      phone_no: "",
      items_required: "",
      status: "Pending",
      last_discussion: "",
      next_interaction: "",
      lead: "lead",
      source: "Website",
      tagsInput: "",
      due_date: "",
      application: "",
    });
    setErrors({});
  };
```

With:

```js
  const resetForm = () => {
    setNewEnquiry({
      enquiry_id: "",
      company_name: "",
      contact_person: "",
      mail_id: "",
      phone_no: "",
      items_required: "",
      status: "Pending",
      last_discussion: "",
      next_interaction: "",
      lead: "lead",
      source: "Website",
      tagsInput: "",
      due_date: "",
      application: "",
      city: "",
    });
    setErrors({});
  };
```

Also replace the matching initial `useState(...)` call for `newEnquiry`:

```js
  const [newEnquiry, setNewEnquiry] = useState({
    enquiry_id: "",
    company_name: "",
    contact_person: "",
    mail_id: "",
    phone_no: "",
    items_required: "",
    status: "Pending",
    last_discussion: "",
    next_interaction: "",
    lead: "lead",
    source: "Website",
    tagsInput: "",
    due_date: "",
    application: "", // <-- NEW field
  });

  const [errors, setErrors] = useState({});
```

With:

```js
  const [newEnquiry, setNewEnquiry] = useState({
    enquiry_id: "",
    company_name: "",
    contact_person: "",
    mail_id: "",
    phone_no: "",
    items_required: "",
    status: "Pending",
    last_discussion: "",
    next_interaction: "",
    lead: "lead",
    source: "Website",
    tagsInput: "",
    due_date: "",
    application: "", // <-- NEW field
    city: "",
  });

  const [errors, setErrors] = useState({});
```

Replace:

```js
      lead: effectiveLead,
      source: enquiry.source || "Website",
      tagsInput: Array.isArray(enquiry.tags) ? enquiry.tags.join(", ") : "",
      due_date: enquiry.due_date
        ? new Date(enquiry.due_date).toISOString().split("T")[0]
        : "",
      application: enquiry.application || "",
    });
```

With:

```js
      lead: effectiveLead,
      source: enquiry.source || "Website",
      tagsInput: Array.isArray(enquiry.tags) ? enquiry.tags.join(", ") : "",
      due_date: enquiry.due_date
        ? new Date(enquiry.due_date).toISOString().split("T")[0]
        : "",
      application: enquiry.application || "",
      city: enquiry.city || "",
    });
```

Replace:

```js
      const body = {
        company_name: newEnquiry.company_name,
        contact_person: newEnquiry.contact_person || null,
        mail_id: newEnquiry.mail_id || null,
        phone_no: newEnquiry.phone_no || null,
        items_required: newEnquiry.items_required || null,
        status: newEnquiry.status,
        last_discussion: newEnquiry.last_discussion || null,
        next_interaction: newEnquiry.next_interaction || null,
        lead: newEnquiry.lead,
        source: newEnquiry.source,
        tags: tagsArray,
        due_date: newEnquiry.due_date || null,
        application: newEnquiry.application || null, // <-- include application
      };
```

With:

```js
      const body = {
        company_name: newEnquiry.company_name,
        contact_person: newEnquiry.contact_person || null,
        mail_id: newEnquiry.mail_id || null,
        phone_no: newEnquiry.phone_no || null,
        items_required: newEnquiry.items_required || null,
        status: newEnquiry.status,
        last_discussion: newEnquiry.last_discussion || null,
        next_interaction: newEnquiry.next_interaction || null,
        lead: newEnquiry.lead,
        source: newEnquiry.source,
        tags: tagsArray,
        due_date: newEnquiry.due_date || null,
        application: newEnquiry.application || null, // <-- include application
        city: newEnquiry.city || null,
      };
```

- [ ] **Step 3: Add City display + photo gallery to the detail drawer**

Replace:

```js
                  {/* Items Required */}
                  <div className="mb-4 rounded-lg border border-navy-100 bg-white px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      Items Required
                    </h3>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">
                      {detailEnquiry.items_required || "No items specified."}
                    </p>
                  </div>
```

With:

```js
                  {/* Items Required */}
                  <div className="mb-4 rounded-lg border border-navy-100 bg-white px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      Items Required
                    </h3>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">
                      {detailEnquiry.items_required || "No items specified."}
                    </p>
                  </div>

                  <div className="mb-4 rounded-lg border border-navy-100 bg-white px-3 py-3">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
                      City
                    </h3>
                    <p className="text-sm text-gray-700">
                      {detailEnquiry.city || "N/A"}
                    </p>
                  </div>

                  <div className="mb-4 rounded-lg border border-navy-100 bg-white px-3 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
                        Photos
                      </h3>
                      <label className="text-[11px] font-semibold text-gold-600 cursor-pointer hover:text-gold-700">
                        + Add photo
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleUploadPhoto(file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                    {Array.isArray(detailEnquiry.photos) &&
                    detailEnquiry.photos.length > 0 ? (
                      <div className="grid grid-cols-3 gap-2">
                        {detailEnquiry.photos.map((url) => (
                          <div key={url} className="relative group">
                            <img
                              src={url}
                              alt="Enquiry"
                              className="w-full h-20 object-cover rounded-lg border border-navy-100"
                            />
                            <button
                              type="button"
                              onClick={() => handleDeletePhoto(url)}
                              className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-navy-900/70 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400">No photos yet.</p>
                    )}
                  </div>
```

(If this file's "Items Required" block also uses `bg-navy-50/50` rather than `bg-white` — check the surrounding lines before applying — match whichever background class is actually there instead of assuming.)

- [ ] **Step 4: Add the `handleUploadPhoto`/`handleDeletePhoto` handlers**

Find this file's equivalent of `toggleFollow` (`grep -n "const toggleFollow" CRM/src/components/admin/EnquiryPage.jsx`) and insert the same two handlers used in Tasks 11 and 12 immediately after its closing `};`:

```js

  const handleUploadPhoto = async (file) => {
    try {
      const token = localStorage.getItem("token");
      const formData = new FormData();
      formData.append("photo", file);
      const res = await fetch(`${API_URL}/${detailEnquiry.enquiry_id}/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to upload photo");
      }
      const { record } = await res.json();
      setDetailEnquiry((prev) =>
        prev ? { ...prev, photos: record.photos } : prev,
      );
      notifySuccess("Photo added");
    } catch (err) {
      console.error("Upload photo error:", err);
      notifyError(err.message || "Failed to upload photo");
    }
  };

  const handleDeletePhoto = async (url) => {
    if (!window.confirm("Remove this photo?")) return;
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`${API_URL}/${detailEnquiry.enquiry_id}/photo`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || "Failed to remove photo");
      }
      const record = await res.json();
      setDetailEnquiry((prev) =>
        prev ? { ...prev, photos: record.photos } : prev,
      );
      notifySuccess("Photo removed");
    } catch (err) {
      console.error("Delete photo error:", err);
      notifyError(err.message || "Failed to remove photo");
    }
  };
```

- [ ] **Step 5: Lint and commit**

```bash
cd CRM && npx eslint src/components/admin/EnquiryPage.jsx
git add src/components/admin/EnquiryPage.jsx
git commit -m "feat: show city and photo gallery on the Admin enquiry page"
```

---

### Task 14: Full backend test suite + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `npx jest`
Expected: all suites pass, including the pre-existing PDI suites (unaffected by this work) and the new `tests/enquiry_model.test.js` / `tests/enquiry_controller.test.js`. `tests/auth.test.js` and `tests/pdi_admin.test.js` hit the real app/DB and were already like that before this plan — if either was already failing/skipped in this environment, that's pre-existing and not this plan's concern; don't try to fix them here.

- [ ] **Step 2: Confirm `git add -f` for the new gitignored test files**

This repo's `.gitignore` excludes `*.test.js` (per prior project notes), so `git add` on `tests/enquiry_model.test.js` and `tests/enquiry_controller.test.js` needs `-f`:

```bash
git status
```

If either new test file shows as untracked-and-ignored rather than staged from Tasks 2–4's commits, re-add explicitly:

```bash
git add -f tests/enquiry_model.test.js tests/enquiry_controller.test.js
git commit -m "test: track enquiry representative tests despite .gitignore"
```

(Skip this step entirely if `git status` shows both files already committed.)

- [ ] **Step 3: Manual browser walkthrough (after Task 1's migration and Task 6's seed script have been run and confirmed with the user)**

Start both dev servers:

```bash
npm run dev            # from CRM_BACKEND
```

```bash
npm run dev            # from CRM
```

Then in the browser:
1. Log in as `representative@compageauto.com` / `password123`.
2. Confirm the sidebar shows a "Leads" section → "Enquiries", and the dashboard lands on `/representative-dashboard`.
3. Create a new lead with a City filled in and a Remark of "Hot Lead" — confirm it appears in the list immediately (it should, since `create` now self-assigns it).
4. Open its detail drawer, add a comment (Description/Comments), set Last Call Conversation via Edit, and upload a photo — confirm the thumbnail appears.
5. Delete the photo — confirm it disappears.
6. Log in as `sales` (or `admin`) and open the same enquiry — confirm City and the uploaded/remaining photos are visible there too.
7. Confirm the representative account cannot see any enquiry not assigned to it (create a second enquiry as Sales without assigning it, confirm it does not show up for the representative).

Report the outcome of this walkthrough back before considering the feature done — this is real end-to-end behavior no automated test in this plan covers (no frontend test harness exists in this repo).

---

### Task 4.5: Ownership checks on enquiry mutations (added mid-execution)

**Why this task exists:** a background security review of Task 4's diff found that `getAll`/`getById` correctly restrict `design`/`representative` roles to their own assigned enquiries (Task 2), but every *mutating* endpoint — `update`, `delete`, `assign`, `addComment`, `changeStage`, and this plan's own new `uploadPhoto`/`deletePhoto` — only checks role-level `can_write` permission, not row-level ownership. A restricted-role user could edit, delete, comment on, reassign, or attach/remove photos on **any** enquiry ID, not just ones assigned to them. This predates this plan (it affects the pre-existing `design` role today), but the user asked for a comprehensive fix covering both roles before continuing.

**Files:**
- Modify: `models/sales/enquiry.js`
- Modify: `controllers/sales/enquiry.controller.js`
- Modify: `tests/enquiry_model.test.js`
- Modify: `tests/enquiry_controller.test.js`

- [ ] **Step 1: Add a shared ownership-check helper to `models/sales/enquiry.js`**

Insert immediately after the existing `fetchUserName` function (before `class Enquiry {`):

```js
async function assertMutationAllowed(enquiryId, user) {
  const roleName = String(user?.role_name || '').toLowerCase();
  const isRestrictedRole = roleName.includes('design') || roleName.includes('representative');
  if (!isRestrictedRole) return;

  const userId = Number(user?.user_id);
  if (!userId || Number.isNaN(userId)) {
    throw new Error('Forbidden');
  }
  const check = await pool.query(
    `SELECT 1 FROM enquiries WHERE enquiry_id = $1 AND assigned_to = $2::int`,
    [enquiryId, userId]
  );
  if (check.rows.length === 0) {
    throw new Error('Forbidden');
  }
}
```

This deliberately mirrors `getById`'s existing inline ownership check exactly (same role-substring test, same "no numeric user_id → Forbidden" guard, same SQL). `getById` itself is NOT touched by this task — it's already correct and already has passing, reviewed tests; leave it as its own inline implementation rather than risk refactoring approved code.

- [ ] **Step 2: Add the check to `update()`**

Change the signature from `static async update(enquiryId, {...}, io) {` to `static async update(enquiryId, {...}, io, user) {` (add `user` as a 4th parameter, after `io`), and add `await assertMutationAllowed(enquiryId, user);` as the very first line inside the method body, before the `let safeStatus = null;` line.

- [ ] **Step 3: Add the check to `delete()`**

Change the signature from `static async delete(enquiryId, io) {` to `static async delete(enquiryId, io, user) {`, and add `await assertMutationAllowed(enquiryId, user);` as the first line inside the method, before `const client = await pool.connect();`.

- [ ] **Step 4: Add the check to `assign()`, `addComment()`, `changeStage()`**

These three already receive `user` as a parameter — no signature change needed. Add `await assertMutationAllowed(enquiryId, user);` as the first line inside each method body:
- `assign(enquiryId, { assigned_to, due_date, message }, io, user)` — before `const client = await pool.connect();`.
- `addComment(enquiryId, { message, mentions = [], expected_by, is_internal }, io, user)` — before `const res = await pool.query(...)`.
- `changeStage(enquiryId, { stage, note }, io, user)` — before the `const validStages = [...]` line (ownership is checked before stage validation, so an unauthorized caller doesn't even learn what stages are valid).

- [ ] **Step 5: Add the check to `appendPhoto()`/`removePhoto()`**

Change both signatures from `(enquiryId, url, io)` to `(enquiryId, url, io, user)`, and add `await assertMutationAllowed(enquiryId, user);` as the first line inside each method body, before the `pool.query(...)` call.

- [ ] **Step 6: Update `controllers/sales/enquiry.controller.js` call sites and error handling**

`exports.update` — pass `req.user` as the 4th argument to `Enquiry.update(...)`, and add a `Forbidden` branch to the catch block (mirroring the exact pattern already used in `exports.getOne` in this same file):

```js
  } catch (error) {
    logger.error(`Error updating enquiry ${req.params.id}: ${error.message}`, error.stack);
    if (error.message === 'Forbidden') return res.status(403).json({ error: 'You do not have access to this enquiry', code: 'FORBIDDEN' });
    const status = error.message === 'Enquiry not found' ? 404 : 500;
    res.status(status).json({ error: error.message, code: status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
```

`exports.delete` — pass `req.user` as the 3rd argument to `Enquiry.delete(...)`, same catch-block addition (same `if (error.message === 'Forbidden') return res.status(403)...` line, adapted to this handler's existing variable names).

`exports.assign` — no call-site change (already passes `req.user`); add to the catch block:

```js
  } catch (err) {
    logger.error('Assign enquiry error:', err);
    if (err.message === 'Forbidden') return res.status(403).json({ error: 'You do not have access to this enquiry', code: 'FORBIDDEN' });
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
```

`exports.addComment` — no call-site change; add to the catch block:

```js
  } catch (err) {
    logger.error('Add comment error:', err);
    if (err.message === 'Forbidden') return res.status(403).json({ error: 'You do not have access to this enquiry', code: 'FORBIDDEN' });
    res.status(400).json({ error: err.message });
  }
```

`exports.changeStage` — no call-site change; add to the catch block:

```js
  } catch (err) {
    logger.error('Change stage error:', err);
    if (err.message === 'Forbidden') return res.status(403).json({ error: 'You do not have access to this enquiry', code: 'FORBIDDEN' });
    res.status(400).json({ error: err.message });
  }
```

`exports.uploadPhoto` — change `const record = await Enquiry.appendPhoto(id, directUrl, req.io);` to `const record = await Enquiry.appendPhoto(id, directUrl, req.io, req.user);`, and change the catch block:

```js
  } catch (err) {
    logger.error('Enquiry uploadPhoto error:', err);
    if (err.message === 'Forbidden') return res.status(403).json({ error: 'You do not have access to this enquiry', code: 'FORBIDDEN' });
    const status = err.message === 'Enquiry not found' ? 404 : 500;
    res.status(status).json({ error: err.message || 'Failed to upload photo', code: status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
```

`exports.deletePhoto` — change `const record = await Enquiry.removePhoto(req.params.id, url, req.io);` to `const record = await Enquiry.removePhoto(req.params.id, url, req.io, req.user);`, and the equivalent catch-block addition.

- [ ] **Step 7: Update existing tests broken by the new 4th parameter**

In `tests/enquiry_controller.test.js`, the `uploadPhoto`/`deletePhoto` tests currently build `req` objects with no `user` field and assert `Enquiry.appendPhoto`/`removePhoto` were called with exactly 3 arguments. Since these methods now take a 4th `user` argument, add `user: { user_id: 1, role_name: 'admin' }` to each of those 3 test's `req` objects, and update the `toHaveBeenCalledWith(...)` assertions to include that same object as the 4th argument. (The `assertMutationAllowed` check no-ops for an `admin` role, so behavior is otherwise unchanged — this is purely updating the tests to match the new call signature.)

The tests in `tests/enquiry_model.test.js` that already call `Enquiry.update(...)`/`Enquiry.appendPhoto(...)`/`Enquiry.removePhoto(...)` with no `user` argument (from Tasks 2/3) do NOT need to change — `assertMutationAllowed` treats a missing/undefined `user` as an unrestricted role (empty `role_name` → `isRestrictedRole` false) and no-ops, so those tests keep passing unmodified.

- [ ] **Step 8: Add new tests proving the fix actually works**

Append to `tests/enquiry_model.test.js`:

```js
describe('Enquiry mutation ownership checks (assertMutationAllowed)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('rejects a representative updating an enquiry not assigned to them', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership check: no match

    await expect(
      Enquiry.update('ENQ1', { city: 'Pune' }, null, { role_name: 'representative', user_id: 42 })
    ).rejects.toThrow('Forbidden');

    expect(mockQuery).toHaveBeenCalledTimes(1); // only the ownership check ran, not the UPDATE
  });

  it('allows a representative to update an enquiry assigned to them', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ x: 1 }] }) // ownership check: match
      .mockResolvedValueOnce({ rows: [{ enquiry_id: 'ENQ1', lead: 'hotlead', created_by: null }] }); // UPDATE

    await Enquiry.update('ENQ1', { city: 'Pune' }, null, { role_name: 'representative', user_id: 42 });

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('does not run an ownership check for unrestricted roles', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ enquiry_id: 'ENQ1', lead: 'hotlead', created_by: null }] });

    await Enquiry.update('ENQ1', { city: 'Pune' }, null, { role_name: 'sales', user_id: 3 });

    expect(mockQuery).toHaveBeenCalledTimes(1); // straight to the UPDATE, no ownership check
  });

  it('rejects a representative appending a photo to an enquiry not assigned to them', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(
      Enquiry.appendPhoto('ENQ1', 'https://drive/x', null, { role_name: 'representative', user_id: 42 })
    ).rejects.toThrow('Forbidden');
  });
});
```

Append to `tests/enquiry_controller.test.js`:

```js
describe('enquiry.controller.uploadPhoto — ownership enforcement', () => {
  it('returns 403 when the model rejects the mutation as Forbidden', async () => {
    Enquiry.appendPhoto.mockReset();
    Enquiry.appendPhoto.mockRejectedValue(new Error('Forbidden'));
    const req = {
      params: { id: 'ENQ1' },
      file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg' },
      user: { user_id: 42, role_name: 'representative' },
      io: null,
    };
    const res = makeRes();

    await controller.uploadPhoto(req, res);

    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 9: Run the full backend test suite for this module**

Run: `npx jest tests/enquiry_model.test.js tests/enquiry_controller.test.js --verbose`
Expected: PASS — all tests from Tasks 2, 3, 4 plus the new ones from this task.

- [ ] **Step 10: Commit**

```bash
git add models/sales/enquiry.js controllers/sales/enquiry.controller.js tests/enquiry_model.test.js tests/enquiry_controller.test.js
git commit -m "fix: enforce assignee ownership on enquiry mutations for restricted roles"
```
