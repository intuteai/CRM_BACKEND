# IPT Kit Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a traceability log ("IPT Kit Assembly") so Compage Automation's Admin and Production dashboards can record which Motor/Controller/Gearbox/Harness/Cluster/VCU/DC-DC serial went into each IPT Kit, and look a kit up by any of those serials.

**Architecture:** One new Postgres table (`ipt_kits`, flat — one row per kit with 7 component-serial columns) plus a dedicated `ipt_kit_serial_seq` sequence for auto-generating `kit_serial` (IPT001, IPT002, ...). Backend follows the existing `models/manufacturing/`, `controllers/manufacturing/`, `routes/manufacturing/` file layout, but borrows its request-handling conventions (cursor pagination, `checkPermission`, `req.io`, snake_case JSON, catching Postgres `23505` for friendly duplicate errors) from the more recently-built `models/dispatch/iaOrders.js`. Frontend is a single list+modal page (`CRM/src/components/production/IPTKitAssembly.jsx`) shared by both `admin` and `production` roles, following the `IAOrdersPage.jsx` pattern.

**Tech Stack:** Express, `pg` (raw SQL, no ORM), Socket.io, Jest + Supertest (backend), React + react-router + axios, Playwright (manual end-to-end verification — this repo has no frontend unit-test framework).

**Spec:** `docs/superpowers/specs/2026-08-26-ipt-kit-assembly-design.md`

---

## Task 1: Database schema

**Files:**
- Create (run once, not checked in as a migration — this repo has no migration framework, matching `docs/superpowers/specs/2026-07-09-unique-part-number-design.md`'s precedent of direct SQL): none, run via a one-off Node script.

- [ ] **Step 1: Run the schema-creation script**

Run this via the Bash tool from `CRM_BACKEND/`:

```bash
node -e "
require('dotenv').config();
const pool = require('./config/db');
(async () => {
  await pool.query(\`CREATE SEQUENCE IF NOT EXISTS ipt_kit_serial_seq START 1\`);
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS ipt_kits (
      kit_id            SERIAL PRIMARY KEY,
      kit_serial        VARCHAR(20) UNIQUE NOT NULL,
      motor_serial      VARCHAR(50) UNIQUE NOT NULL,
      controller_serial VARCHAR(50) UNIQUE NOT NULL,
      gearbox_serial    VARCHAR(50) UNIQUE NOT NULL,
      harness_serial    VARCHAR(50) UNIQUE NOT NULL,
      cluster_serial    VARCHAR(50) UNIQUE NOT NULL,
      vcu_serial        VARCHAR(50) UNIQUE NOT NULL,
      dcdc_serial       VARCHAR(50) UNIQUE NOT NULL,
      created_by        INTEGER REFERENCES users(user_id),
      updated_by        INTEGER REFERENCES users(user_id),
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  \`);
  await pool.query(\`
    INSERT INTO permissions (role_id, module, can_read, can_write, can_delete)
    VALUES (1, 'ipt_kits', true, true, true), (5, 'ipt_kits', true, true, true)
    ON CONFLICT DO NOTHING
  \`);
  console.log('done');
  process.exit(0);
})();
"
```

Expected output: `done`, no errors.

- [ ] **Step 2: Verify the schema**

```bash
node -e "
require('dotenv').config();
const pool = require('./config/db');
(async () => {
  const t = await pool.query(\"SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ipt_kits' ORDER BY ordinal_position\");
  console.log('columns:', JSON.stringify(t.rows));
  const p = await pool.query(\"SELECT role_id, module, can_read, can_write, can_delete FROM permissions WHERE module = 'ipt_kits'\");
  console.log('permissions:', JSON.stringify(p.rows));
  process.exit(0);
})();
"
```

Expected: 12 columns listed (`kit_id` through `updated_at`), and two permission rows for `role_id` 1 and 5, both with all three flags `true`.

- [ ] **Step 3: Commit note**

No files change in this task (schema lives in the live DB, not in git) — nothing to commit. Proceed to Task 2.

---

## Task 2: Model — `create()` with serial generation and duplicate detection

**Files:**
- Create: `models/manufacturing/iptKits.js`
- Test: `tests/iptKits.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/iptKits.test.js`:

```javascript
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const pool = require('../config/db');

describe('IPT Kit Assembly API', () => {
  let adminToken, adminUserId, productionToken, productionUserId;
  const createdKitIds = [];

  beforeAll(async () => {
    const admin = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 1) RETURNING user_id`,
      ['IPT Test Admin', `ipt-test-admin-${Date.now()}@example.com`]
    );
    adminUserId = admin.rows[0].user_id;
    adminToken = jwt.sign({ user_id: adminUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const production = await pool.query(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ($1, $2, 'x', 5) RETURNING user_id`,
      ['IPT Test Production', `ipt-test-production-${Date.now()}@example.com`]
    );
    productionUserId = production.rows[0].user_id;
    productionToken = jwt.sign({ user_id: productionUserId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    if (createdKitIds.length) {
      await pool.query('DELETE FROM ipt_kits WHERE kit_id = ANY($1::int[])', [createdKitIds]);
    }
    await pool.query('DELETE FROM users WHERE user_id = ANY($1::int[])', [adminUserId, productionUserId]);
    await pool.end();
  });

  it('creates a kit with an auto-generated kit_serial and normalized component serials', async () => {
    const res = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: ' m9001 ',
        controller_serial: 'c9001',
        gearbox_serial: 'g9001',
        harness_serial: 'h9001',
        cluster_serial: 'cl9001',
        vcu_serial: 'vcl9001',
        dcdc_serial: 'd9001',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.kit_serial).toMatch(/^IPT\d+$/);
    expect(res.body.motor_serial).toBe('M9001');
    createdKitIds.push(res.body.kit_id);
  });

  it('rejects a component serial that is already used in another kit, with a field-specific error', async () => {
    const first = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${productionToken}`)
      .send({
        motor_serial: 'M9002', controller_serial: 'C9002', gearbox_serial: 'G9002',
        harness_serial: 'H9002', cluster_serial: 'CL9002', vcu_serial: 'VCL9002', dcdc_serial: 'D9002',
      });
    expect(first.statusCode).toBe(201);
    createdKitIds.push(first.body.kit_id);

    const dup = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${productionToken}`)
      .send({
        motor_serial: 'M9003', controller_serial: 'C9002', gearbox_serial: 'G9003',
        harness_serial: 'H9003', cluster_serial: 'CL9003', vcu_serial: 'VCL9003', dcdc_serial: 'D9003',
      });
    expect(dup.statusCode).toBe(400);
    expect(dup.body.field).toBe('controller_serial');
    expect(dup.body.error).toMatch(/C9002/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest tests/iptKits.test.js -v --forceExit
```

Expected: FAIL — `Cannot find module '../../models/manufacturing/iptKits'` (or a 404/500 on `POST /api/ipt-kits`, since the route doesn't exist yet).

- [ ] **Step 3: Write the model**

Create `models/manufacturing/iptKits.js`:

```javascript
const pool = require('../../config/db');
const logger = require('../../utils/logger');

const COMPONENT_FIELDS = [
  'motor_serial', 'controller_serial', 'gearbox_serial',
  'harness_serial', 'cluster_serial', 'vcu_serial', 'dcdc_serial',
];

class IPTKits {
  static #safeEmit(io, event, payload) {
    if (!io || typeof io.emit !== 'function') return;
    try { io.emit(event, payload); } catch (e) {
      logger.warn('Socket emit failed:', e.message);
    }
  }

  static #toPayload(row) {
    const payload = {
      kit_id: row.kit_id,
      kit_serial: row.kit_serial,
      created_by: row.created_by,
      created_by_name: row.created_by_name || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    for (const field of COMPONENT_FIELDS) payload[field] = row[field];
    return payload;
  }

  static #validate(data) {
    for (const field of COMPONENT_FIELDS) {
      if (!data[field] || !String(data[field]).trim()) {
        throw Object.assign(new Error(`${field} is required`), { field });
      }
    }
  }

  static #normalized(data) {
    const out = {};
    for (const field of COMPONENT_FIELDS) out[field] = String(data[field]).trim().toUpperCase();
    return out;
  }

  // ==================== CREATE ====================
  static async create(data, io) {
    this.#validate(data);
    const normalized = this.#normalized(data);
    const createdBy = io?.user?.user_id ?? null;

    try {
      const res = await pool.query(`
        INSERT INTO ipt_kits (
          kit_serial,
          motor_serial, controller_serial, gearbox_serial,
          harness_serial, cluster_serial, vcu_serial, dcdc_serial,
          created_by, updated_by
        )
        VALUES (
          'IPT' || lpad(nextval('ipt_kit_serial_seq')::text, 3, '0'),
          $1, $2, $3, $4, $5, $6, $7, $8, $8
        )
        RETURNING *
      `, [
        normalized.motor_serial, normalized.controller_serial, normalized.gearbox_serial,
        normalized.harness_serial, normalized.cluster_serial, normalized.vcu_serial, normalized.dcdc_serial,
        createdBy,
      ]);

      let row = res.rows[0];
      if (createdBy) {
        const u = await pool.query('SELECT name FROM users WHERE user_id = $1', [createdBy]);
        row = { ...row, created_by_name: u.rows[0]?.name || null };
      }

      const payload = this.#toPayload(row);
      this.#safeEmit(io, 'ipt_kits:created', payload);
      return payload;
    } catch (err) {
      if (err.code === '23505') {
        const field = COMPONENT_FIELDS.find((f) => err.constraint?.includes(f));
        if (field) {
          throw Object.assign(
            new Error(`${field.replace('_serial', '')} serial "${normalized[field]}" is already used in another kit`),
            { field }
          );
        }
        throw Object.assign(new Error('Duplicate serial detected'), { field: null });
      }
      throw err;
    }
  }
}

module.exports = IPTKits;
```

- [ ] **Step 4: Wire up a minimal route so the test can hit the endpoint**

Create `controllers/manufacturing/iptKits.controller.js`:

```javascript
const IPTKits = require('../../models/manufacturing/iptKits');
const logger = require('../../utils/logger');

exports.create = async (req, res) => {
  try {
    const kit = await IPTKits.create(req.body, req.io);
    logger.info(`ipt_kit created: ${kit.kit_id} by user ${req.user.user_id}`);
    return res.status(201).json(kit);
  } catch (err) {
    logger.error(`POST ipt-kits error: ${err.message}`);
    return res.status(400).json({ error: err.message, field: err.field ?? null });
  }
};
```

Create `routes/manufacturing/iptKits.js`:

```javascript
const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/manufacturing/iptKits.controller');

router.use(authenticateToken, (req, res, next) => {
  req.io = req.app?.get?.('io') || { emit: () => {} };
  req.io.user = req.user;
  next();
});

router.post('/', checkPermission('ipt_kits', 'can_write'), controller.create);

module.exports = router;
```

Add to `server.js` — find this block:

```javascript
const bomRoutes              = require('./routes/manufacturing/bom');
```

Add immediately after it:

```javascript
const iptKitsRoutes          = require('./routes/manufacturing/iptKits');
```

Then find:

```javascript
app.use('/api/bom',               bomRoutes);
```

Add immediately after it:

```javascript
app.use('/api/ipt-kits',          iptKitsRoutes);
```

- [ ] **Step 5: Run the test to verify it passes**

Stop any running dev server first (this repo's `server.js` binds a real port as a side effect of being required — running the dev server and jest at the same time causes `EADDRINUSE`):

```bash
npx jest tests/iptKits.test.js -v --forceExit
```

Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add models/manufacturing/iptKits.js controllers/manufacturing/iptKits.controller.js routes/manufacturing/iptKits.js server.js tests/iptKits.test.js
git commit -m "feat: add IPT Kit Assembly create endpoint with duplicate-serial detection"
```

---

## Task 3: Model — `getAll()` (cursor pagination + reverse-serial search) and `getById()`

**Files:**
- Modify: `models/manufacturing/iptKits.js`
- Modify: `controllers/manufacturing/iptKits.controller.js`
- Modify: `routes/manufacturing/iptKits.js`
- Modify: `tests/iptKits.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/iptKits.test.js`, inside the existing `describe` block, after the duplicate-serial test:

```javascript
  it('lists kits and finds a kit by searching any component serial (reverse lookup)', async () => {
    const created = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9010', controller_serial: 'C9010', gearbox_serial: 'G9010',
        harness_serial: 'H9010', cluster_serial: 'CL9010', vcu_serial: 'VCL9010', dcdc_serial: 'D9010',
      });
    createdKitIds.push(created.body.kit_id);

    const list = await request(app)
      .get('/api/ipt-kits?limit=50')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.data.some((k) => k.kit_id === created.body.kit_id)).toBe(true);

    const search = await request(app)
      .get('/api/ipt-kits?search=G9010')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(search.statusCode).toBe(200);
    expect(search.body.data).toHaveLength(1);
    expect(search.body.data[0].kit_id).toBe(created.body.kit_id);
  });

  it('gets a single kit by id', async () => {
    const created = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9011', controller_serial: 'C9011', gearbox_serial: 'G9011',
        harness_serial: 'H9011', cluster_serial: 'CL9011', vcu_serial: 'VCL9011', dcdc_serial: 'D9011',
      });
    createdKitIds.push(created.body.kit_id);

    const res = await request(app)
      .get(`/api/ipt-kits/${created.body.kit_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.kit_serial).toBe(created.body.kit_serial);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest tests/iptKits.test.js -v --forceExit
```

Expected: FAIL — `GET /api/ipt-kits` and `GET /api/ipt-kits/:id` return 404 (routes don't exist yet).

- [ ] **Step 3: Add `getAll` and `getById` to the model**

In `models/manufacturing/iptKits.js`, add these methods inside the `IPTKits` class, after `create`:

```javascript
  // ==================== GET ALL ====================
  static async getAll({ limit = 20, cursor = null, search = '' } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    let cursorId = null;
    let cursorCreatedAt = null;
    if (cursor) {
      const sepIdx = cursor.indexOf(':');
      if (sepIdx > 0) {
        cursorId = parseInt(cursor.slice(0, sepIdx), 10);
        cursorCreatedAt = cursor.slice(sepIdx + 1);
      }
    }

    const searchTerm = search?.trim() ? `%${search.trim().toUpperCase()}%` : null;
    const searchClause = COMPONENT_FIELDS
      .map((f) => `k.${f} ILIKE $4`)
      .concat(['k.kit_serial ILIKE $4'])
      .join(' OR ');

    const query = `
      SELECT k.*, u.name AS created_by_name,
        to_char(k.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS created_at_cursor
      FROM ipt_kits k
      LEFT JOIN users u ON k.created_by = u.user_id
      WHERE (
        $1::text IS NULL
        OR to_char(k.created_at, 'YYYY-MM-DD HH24:MI:SS.US') < $1::text
        OR (to_char(k.created_at, 'YYYY-MM-DD HH24:MI:SS.US') = $1::text AND k.kit_id < $2)
      )
      AND ($4::text IS NULL OR ${searchClause})
      ORDER BY k.created_at DESC, k.kit_id DESC
      LIMIT $3
    `;

    const countQuery = `
      SELECT COUNT(*)::int FROM ipt_kits k
      WHERE ($1::text IS NULL OR ${searchClause.replace(/\$4/g, '$1')})
    `;

    const [result, totalRes] = await Promise.all([
      pool.query(query, [cursorCreatedAt, cursorId, _limit, searchTerm]),
      pool.query(countQuery, [searchTerm]),
    ]);

    const data = result.rows.map((row) => this.#toPayload(row));
    const nextCursor = data.length === _limit && data.length > 0
      ? `${result.rows[data.length - 1].kit_id}:${result.rows[data.length - 1].created_at_cursor}`
      : null;

    return { data, total: totalRes.rows[0].count, cursor: nextCursor };
  }

  // ==================== GET BY ID ====================
  static async getById(id) {
    const res = await pool.query(`
      SELECT k.*, u.name AS created_by_name
      FROM ipt_kits k
      LEFT JOIN users u ON k.created_by = u.user_id
      WHERE k.kit_id = $1
    `, [id]);
    if (res.rows.length === 0) throw new Error('Kit not found');
    return this.#toPayload(res.rows[0]);
  }
```

- [ ] **Step 4: Add controller handlers**

In `controllers/manufacturing/iptKits.controller.js`, add:

```javascript
exports.getAll = async (req, res) => {
  try {
    const { limit, cursor, search } = req.query;
    const result = await IPTKits.getAll({ limit, cursor, search });
    return res.json(result);
  } catch (err) {
    logger.error(`GET ipt-kits error: ${err.message}`);
    return res.status(500).json({ error: 'Server error' });
  }
};

exports.getOne = async (req, res) => {
  try {
    const kit = await IPTKits.getById(req.params.id);
    return res.json(kit);
  } catch (err) {
    return res.status(err.message === 'Kit not found' ? 404 : 500).json({ error: err.message });
  }
};
```

- [ ] **Step 5: Add routes**

In `routes/manufacturing/iptKits.js`, replace the single `router.post(...)` line with:

```javascript
router.get('/', checkPermission('ipt_kits', 'can_read'), controller.getAll);
router.get('/:id', checkPermission('ipt_kits', 'can_read'), controller.getOne);
router.post('/', checkPermission('ipt_kits', 'can_write'), controller.create);
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx jest tests/iptKits.test.js -v --forceExit
```

Expected: all 4 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add models/manufacturing/iptKits.js controllers/manufacturing/iptKits.controller.js routes/manufacturing/iptKits.js tests/iptKits.test.js
git commit -m "feat: add list (cursor+search) and get-by-id endpoints for IPT Kit Assembly"
```

---

## Task 4: Model — `update()` and `delete()`

**Files:**
- Modify: `models/manufacturing/iptKits.js`
- Modify: `controllers/manufacturing/iptKits.controller.js`
- Modify: `routes/manufacturing/iptKits.js`
- Modify: `tests/iptKits.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/iptKits.test.js`:

```javascript
  it('updates a kit\'s component serials', async () => {
    const created = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9020', controller_serial: 'C9020', gearbox_serial: 'G9020',
        harness_serial: 'H9020', cluster_serial: 'CL9020', vcu_serial: 'VCL9020', dcdc_serial: 'D9020',
      });
    createdKitIds.push(created.body.kit_id);

    const updated = await request(app)
      .put(`/api/ipt-kits/${created.body.kit_id}`)
      .set('Authorization', `Bearer ${productionToken}`)
      .send({
        motor_serial: 'M9021', controller_serial: 'C9020', gearbox_serial: 'G9020',
        harness_serial: 'H9020', cluster_serial: 'CL9020', vcu_serial: 'VCL9020', dcdc_serial: 'D9020',
      });
    expect(updated.statusCode).toBe(200);
    expect(updated.body.motor_serial).toBe('M9021');
    expect(updated.body.kit_serial).toBe(created.body.kit_serial);
  });

  it('deletes a kit and frees its component serials for reuse', async () => {
    const created = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9030', controller_serial: 'C9030', gearbox_serial: 'G9030',
        harness_serial: 'H9030', cluster_serial: 'CL9030', vcu_serial: 'VCL9030', dcdc_serial: 'D9030',
      });

    const del = await request(app)
      .delete(`/api/ipt-kits/${created.body.kit_id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.statusCode).toBe(200);

    const reused = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9030', controller_serial: 'C9031', gearbox_serial: 'G9031',
        harness_serial: 'H9031', cluster_serial: 'CL9031', vcu_serial: 'VCL9031', dcdc_serial: 'D9031',
      });
    expect(reused.statusCode).toBe(201);
    createdKitIds.push(reused.body.kit_id);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest tests/iptKits.test.js -v --forceExit
```

Expected: FAIL — `PUT`/`DELETE /api/ipt-kits/:id` return 404.

- [ ] **Step 3: Add `update` and `delete` to the model**

In `models/manufacturing/iptKits.js`, add after `getById`:

```javascript
  // ==================== UPDATE ====================
  static async update(id, data, io) {
    this.#validate(data);
    const normalized = this.#normalized(data);
    const updatedBy = io?.user?.user_id ?? null;

    try {
      const res = await pool.query(`
        UPDATE ipt_kits SET
          motor_serial = $1, controller_serial = $2, gearbox_serial = $3,
          harness_serial = $4, cluster_serial = $5, vcu_serial = $6, dcdc_serial = $7,
          updated_by = $8, updated_at = NOW()
        WHERE kit_id = $9
        RETURNING *
      `, [
        normalized.motor_serial, normalized.controller_serial, normalized.gearbox_serial,
        normalized.harness_serial, normalized.cluster_serial, normalized.vcu_serial, normalized.dcdc_serial,
        updatedBy, id,
      ]);

      if (res.rows.length === 0) throw new Error('Kit not found');

      let row = res.rows[0];
      if (row.created_by) {
        const u = await pool.query('SELECT name FROM users WHERE user_id = $1', [row.created_by]);
        row = { ...row, created_by_name: u.rows[0]?.name || null };
      }

      const payload = this.#toPayload(row);
      this.#safeEmit(io, 'ipt_kits:updated', payload);
      return payload;
    } catch (err) {
      if (err.code === '23505') {
        const field = COMPONENT_FIELDS.find((f) => err.constraint?.includes(f));
        if (field) {
          throw Object.assign(
            new Error(`${field.replace('_serial', '')} serial "${normalized[field]}" is already used in another kit`),
            { field }
          );
        }
        throw Object.assign(new Error('Duplicate serial detected'), { field: null });
      }
      throw err;
    }
  }

  // ==================== DELETE ====================
  static async delete(id, io) {
    const res = await pool.query('DELETE FROM ipt_kits WHERE kit_id = $1 RETURNING kit_id', [id]);
    if (res.rows.length === 0) throw new Error('Kit not found');
    const payload = { kit_id: res.rows[0].kit_id };
    this.#safeEmit(io, 'ipt_kits:deleted', payload);
    return payload;
  }
```

- [ ] **Step 4: Add controller handlers**

In `controllers/manufacturing/iptKits.controller.js`, add:

```javascript
exports.update = async (req, res) => {
  try {
    const kit = await IPTKits.update(req.params.id, req.body, req.io);
    logger.info(`ipt_kit updated: ${kit.kit_id} by user ${req.user.user_id}`);
    return res.json(kit);
  } catch (err) {
    logger.error(`PUT ipt-kits/${req.params.id} error: ${err.message}`);
    return res.status(err.message === 'Kit not found' ? 404 : 400).json({ error: err.message, field: err.field ?? null });
  }
};

exports.delete = async (req, res) => {
  try {
    const result = await IPTKits.delete(req.params.id, req.io);
    logger.info(`ipt_kit deleted: ${result.kit_id} by user ${req.user.user_id}`);
    return res.json({ message: 'Kit deleted', kit_id: result.kit_id });
  } catch (err) {
    return res.status(err.message === 'Kit not found' ? 404 : 500).json({ error: err.message });
  }
};
```

- [ ] **Step 5: Add routes**

In `routes/manufacturing/iptKits.js`, add after the existing `router.post('/', ...)` line:

```javascript
router.put('/:id', checkPermission('ipt_kits', 'can_write'), controller.update);
router.delete('/:id', checkPermission('ipt_kits', 'can_delete'), controller.delete);
```

- [ ] **Step 6: Run the full test file to verify everything passes**

```bash
npx jest tests/iptKits.test.js -v --forceExit
```

Expected: all 6 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add models/manufacturing/iptKits.js controllers/manufacturing/iptKits.controller.js routes/manufacturing/iptKits.js tests/iptKits.test.js
git commit -m "feat: add update and delete endpoints for IPT Kit Assembly"
```

---

## Task 5: Model — `previewNextSerial()`

**Files:**
- Modify: `models/manufacturing/iptKits.js`
- Modify: `controllers/manufacturing/iptKits.controller.js`
- Modify: `routes/manufacturing/iptKits.js`
- Modify: `tests/iptKits.test.js`

This is a read-only preview of what the next `kit_serial` will be, shown in the create form before submission. It must NOT call `nextval()` (that would consume a sequence value and create a permanent gap every time someone opens the form without submitting) — it reads the sequence's current state instead.

- [ ] **Step 1: Write the failing test**

Add to `tests/iptKits.test.js`:

```javascript
  it('previews the next kit_serial without consuming it', async () => {
    const preview1 = await request(app)
      .get('/api/ipt-kits/next-serial')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(preview1.statusCode).toBe(200);
    expect(preview1.body.kit_serial).toMatch(/^IPT\d+$/);

    const preview2 = await request(app)
      .get('/api/ipt-kits/next-serial')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(preview2.body.kit_serial).toBe(preview1.body.kit_serial);

    const created = await request(app)
      .post('/api/ipt-kits')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        motor_serial: 'M9040', controller_serial: 'C9040', gearbox_serial: 'G9040',
        harness_serial: 'H9040', cluster_serial: 'CL9040', vcu_serial: 'VCL9040', dcdc_serial: 'D9040',
      });
    createdKitIds.push(created.body.kit_id);
    expect(created.body.kit_serial).toBe(preview1.body.kit_serial);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest tests/iptKits.test.js -v --forceExit
```

Expected: FAIL — `GET /api/ipt-kits/next-serial` returns 404.

- [ ] **Step 3: Add `previewNextSerial` to the model**

In `models/manufacturing/iptKits.js`, add after `create`:

```javascript
  // ==================== PREVIEW NEXT SERIAL ====================
  static async previewNextSerial() {
    const res = await pool.query(`SELECT last_value, is_called FROM ipt_kit_serial_seq`);
    const { last_value, is_called } = res.rows[0];
    const next = is_called ? Number(last_value) + 1 : Number(last_value);
    return `IPT${String(next).padStart(3, '0')}`;
  }
```

- [ ] **Step 4: Add controller handler**

In `controllers/manufacturing/iptKits.controller.js`, add:

```javascript
exports.nextSerial = async (req, res) => {
  try {
    const kit_serial = await IPTKits.previewNextSerial();
    return res.json({ kit_serial });
  } catch (err) {
    logger.error(`GET ipt-kits/next-serial error: ${err.message}`);
    return res.status(500).json({ error: 'Server error' });
  }
};
```

- [ ] **Step 5: Add route**

In `routes/manufacturing/iptKits.js`, add this line **before** `router.get('/:id', ...)` (so `/next-serial` isn't swallowed by the `/:id` param route):

```javascript
router.get('/next-serial', checkPermission('ipt_kits', 'can_read'), controller.nextSerial);
```

- [ ] **Step 6: Run the full test file to verify everything passes**

```bash
npx jest tests/iptKits.test.js -v --forceExit
```

Expected: all 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add models/manufacturing/iptKits.js controllers/manufacturing/iptKits.controller.js routes/manufacturing/iptKits.js tests/iptKits.test.js
git commit -m "feat: add next-serial preview endpoint for IPT Kit Assembly"
```

---

## Task 6: Frontend — list page with search and create modal

**Files:**
- Create: `CRM/src/components/production/IPTKitAssembly.jsx`

- [ ] **Step 1: Write the component**

Create `CRM/src/components/production/IPTKitAssembly.jsx`:

```jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { Boxes, Search, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { useNotify } from '../../hooks/useNotify';

const API_URL = import.meta.env.VITE_BACKEND_URL;

const COMPONENT_FIELDS = [
  { key: 'motor_serial', label: 'Motor' },
  { key: 'controller_serial', label: 'Controller' },
  { key: 'gearbox_serial', label: 'Gearbox' },
  { key: 'harness_serial', label: 'Harness' },
  { key: 'cluster_serial', label: 'Cluster' },
  { key: 'vcu_serial', label: 'VCU' },
  { key: 'dcdc_serial', label: 'DC/DC' },
];

const emptyForm = () => {
  const f = {};
  COMPONENT_FIELDS.forEach((c) => { f[c.key] = ''; });
  return f;
};

function IPTKitAssembly({ socket }) {
  const { notifySuccess, notifyError } = useNotify();
  const [kits, setKits] = useState([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [previewSerial, setPreviewSerial] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [fieldError, setFieldError] = useState({ field: null, message: '' });
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);

  const token = localStorage.getItem('token');
  const authHeaders = { headers: { Authorization: `Bearer ${token}` } };

  const fetchKits = useCallback(async (reset = true) => {
    setLoading(true);
    try {
      const params = { limit: 20 };
      if (search.trim()) params.search = search.trim();
      if (!reset && cursor) params.cursor = cursor;
      const res = await axios.get(`${API_URL}/api/ipt-kits`, { ...authHeaders, params });
      setKits((prev) => (reset ? res.data.data : [...prev, ...res.data.data]));
      setTotal(res.data.total);
      setCursor(res.data.cursor);
    } catch (err) {
      notifyError(err.response?.data?.error || 'Failed to load IPT kits');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    mountedRef.current = true;
    fetchKits(true);
    return () => { mountedRef.current = false; };
  }, [fetchKits]);

  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchKits(true);
    socket.on('ipt_kits:created', refresh);
    socket.on('ipt_kits:updated', refresh);
    socket.on('ipt_kits:deleted', refresh);
    return () => {
      socket.off('ipt_kits:created', refresh);
      socket.off('ipt_kits:updated', refresh);
      socket.off('ipt_kits:deleted', refresh);
    };
  }, [socket, fetchKits]);

  const openCreateModal = async () => {
    setEditingId(null);
    setForm(emptyForm());
    setFieldError({ field: null, message: '' });
    setIsModalOpen(true);
    try {
      const res = await axios.get(`${API_URL}/api/ipt-kits/next-serial`, authHeaders);
      setPreviewSerial(res.data.kit_serial);
    } catch {
      setPreviewSerial('');
    }
  };

  const openEditModal = (kit) => {
    setEditingId(kit.kit_id);
    const f = emptyForm();
    COMPONENT_FIELDS.forEach((c) => { f[c.key] = kit[c.key]; });
    setForm(f);
    setPreviewSerial(kit.kit_serial);
    setFieldError({ field: null, message: '' });
    setIsModalOpen(true);
  };

  const closeModal = () => setIsModalOpen(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFieldError({ field: null, message: '' });
    try {
      if (editingId) {
        await axios.put(`${API_URL}/api/ipt-kits/${editingId}`, form, authHeaders);
        notifySuccess('Kit updated');
      } else {
        await axios.post(`${API_URL}/api/ipt-kits`, form, authHeaders);
        notifySuccess('Kit created');
      }
      setIsModalOpen(false);
      fetchKits(true);
    } catch (err) {
      const data = err.response?.data;
      if (data?.field) {
        setFieldError({ field: data.field, message: data.error });
      } else {
        notifyError(data?.error || 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (kit) => {
    if (!window.confirm(`Delete kit ${kit.kit_serial}? This cannot be undone.`)) return;
    try {
      await axios.delete(`${API_URL}/api/ipt-kits/${kit.kit_id}`, authHeaders);
      notifySuccess('Kit deleted');
      fetchKits(true);
    } catch (err) {
      notifyError(err.response?.data?.error || 'Delete failed');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-white mb-3">
            <Boxes className="w-8 h-8" />
          </div>
          <h1 className="text-3xl font-bold text-gray-800">IPT Kit Assembly</h1>
          <p className="text-sm text-gray-500 mt-2">Record which component serials went into each IPT Kit</p>
        </div>

        <div className="bg-white rounded-2xl shadow p-4 mb-4 flex items-center gap-3">
          <div className="text-sm text-gray-600"><strong>{total}</strong> total kits</div>
        </div>

        <div className="bg-white rounded-2xl shadow p-4 mb-4 flex flex-col sm:flex-row gap-3 items-center">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by kit serial or any component serial..."
              className="w-full pl-9 pr-4 py-2 rounded-xl border border-gray-200 focus:ring-2 focus:ring-amber-300"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={openCreateModal}
            className="px-5 py-2 bg-gradient-to-r from-amber-400 to-orange-500 text-white rounded-xl shadow flex items-center gap-2 font-medium whitespace-nowrap"
          >
            <Plus className="w-4 h-4" /> New Kit
          </button>
        </div>

        <div className="bg-white rounded-2xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-amber-50 text-amber-900">
              <tr>
                <th className="px-4 py-3 text-left">Kit Serial</th>
                {COMPONENT_FIELDS.map((c) => (
                  <th key={c.key} className="px-4 py-3 text-left">{c.label}</th>
                ))}
                <th className="px-4 py-3 text-left">Created By</th>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {kits.map((kit) => (
                <tr key={kit.kit_id} className="border-t border-gray-100">
                  <td className="px-4 py-3 font-mono font-semibold">{kit.kit_serial}</td>
                  {COMPONENT_FIELDS.map((c) => (
                    <td key={c.key} className="px-4 py-3 font-mono">{kit[c.key]}</td>
                  ))}
                  <td className="px-4 py-3">{kit.created_by_name || '—'}</td>
                  <td className="px-4 py-3">{String(kit.created_at).slice(0, 10)}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => openEditModal(kit)} title="Edit" className="p-2 text-amber-600 hover:bg-amber-50 rounded-lg">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(kit)} title="Delete" className="p-2 text-red-500 hover:bg-red-50 rounded-lg">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && kits.length === 0 && (
                <tr><td colSpan={COMPONENT_FIELDS.length + 4} className="px-4 py-12 text-center text-gray-400">No kits found</td></tr>
              )}
            </tbody>
          </table>
          {cursor && (
            <div className="p-4 text-center">
              <button onClick={() => fetchKits(false)} disabled={loading} className="px-4 py-2 text-amber-700 hover:bg-amber-50 rounded-lg text-sm font-medium">
                {loading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Load more'}
              </button>
            </div>
          )}
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-8">
            <h2 className="text-2xl font-bold text-gray-800 mb-1 text-center">
              {editingId ? 'Edit Kit' : 'New Kit'}
            </h2>
            <p className="text-center text-sm text-gray-500 mb-6 font-mono">
              {previewSerial ? `Kit Serial: ${previewSerial}` : ''}
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              {COMPONENT_FIELDS.map((c) => (
                <div key={c.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{c.label} Serial *</label>
                  <input
                    type="text"
                    required
                    className={`w-full px-4 py-2 rounded-xl border font-mono focus:ring-2 ${
                      fieldError.field === c.key ? 'border-red-400 focus:ring-red-200' : 'border-gray-200 focus:ring-amber-300'
                    }`}
                    value={form[c.key]}
                    onChange={(e) => setForm({ ...form, [c.key]: e.target.value })}
                  />
                  {fieldError.field === c.key && (
                    <p className="text-xs text-red-500 mt-1">{fieldError.message}</p>
                  )}
                </div>
              ))}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={closeModal} className="px-6 py-3 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 text-sm font-medium">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-6 py-3 bg-gradient-to-r from-amber-400 to-orange-500 text-white rounded-xl shadow flex items-center gap-2 text-sm font-medium disabled:opacity-70"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (editingId ? 'Save Changes' : 'Create Kit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default IPTKitAssembly;
```

- [ ] **Step 2: Verify it builds**

```bash
cd CRM && npx eslint src/components/production/IPTKitAssembly.jsx
```

Expected: no errors (warnings about the `react-hooks/exhaustive-deps` disable comment are expected and fine — it mirrors the existing `IAInvoiceForm.jsx` pattern of intentionally excluding `cursor`/`fetchKits` itself from the dependency array to avoid a fetch loop).

- [ ] **Step 3: Commit**

```bash
git add src/components/production/IPTKitAssembly.jsx
git commit -m "feat: add IPT Kit Assembly list, search, create and edit UI"
```

---

## Task 7: Frontend — routing and permissions

**Files:**
- Modify: `CRM/src/routeConfig.jsx`
- Modify: `CRM/src/constants.js`

- [ ] **Step 1: Add the import**

In `CRM/src/routeConfig.jsx`, find:

```jsx
import ProductionInventoryPage from "./components/production/ProductionInventoryPage";
```

Add immediately after it:

```jsx
import IPTKitAssembly from "./components/production/IPTKitAssembly";
```

- [ ] **Step 2: Add the route entry**

Find the `// ── Production Routes ─────` section and its last entry (`/production-inventory`, around line 337). Add a new route object immediately after that block, before the closing of the Production section:

```jsx
  {
    path: "/ipt-kits",
    allowedRoles: ["admin", "production"],
    component: IPTKitAssembly,
  },
```

- [ ] **Step 3: Add to both role allowlists in `constants.js`**

In `CRM/src/constants.js`, in the `[ROLES.ADMIN]` array, find `"/bom",` and add `"/ipt-kits",` immediately after it:

```javascript
    "/bom",
    "/ipt-kits",
```

In the `[ROLES.PRODUCTION]` array, find the second `"/bom",` entry (inside the Production block) and add `"/ipt-kits",` immediately after it:

```javascript
    "/bom",
    "/ipt-kits",
```

- [ ] **Step 4: Verify it builds**

```bash
cd CRM && npx eslint src/routeConfig.jsx src/constants.js
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/routeConfig.jsx src/constants.js
git commit -m "feat: register /ipt-kits route for admin and production roles"
```

---

## Task 8: Frontend — dashboard cards

**Files:**
- Modify: `CRM/src/components/dashboards/ProductionDashboard.jsx`
- Modify: `CRM/src/components/dashboards/AdminDashboard.jsx`

- [ ] **Step 1: Add the card to `ProductionDashboard.jsx`**

Add `Boxes` to the `lucide-react` import list at the top of the file (change):

```jsx
import {
  Truck,
  Package,
  PenTool,
  CheckSquare,
  BarChart,
  MessageSquare,
  Wrench
} from "lucide-react";
```

to:

```jsx
import {
  Truck,
  Package,
  PenTool,
  CheckSquare,
  BarChart,
  MessageSquare,
  Wrench,
  Boxes
} from "lucide-react";
```

Then add this line immediately after the `/motor-recipes` card:

```jsx
          <DashboardCard to="/ipt-kits" icon={<Boxes />} title="IPT Kit Assembly" desc="Record component serials for each IPT Kit" />
```

- [ ] **Step 2: Add the card to `AdminDashboard.jsx`**

Add `Boxes` to the `lucide-react` import list (change):

```jsx
import {
  Package, MessageSquare, Truck, Users, FileText, BarChart,
  PenTool, DollarSign, CheckSquare, Mail, MapPin, AlertTriangle, Wrench
} from 'lucide-react';
```

to:

```jsx
import {
  Package, MessageSquare, Truck, Users, FileText, BarChart,
  PenTool, DollarSign, CheckSquare, Mail, MapPin, AlertTriangle, Wrench, Boxes
} from 'lucide-react';
```

Then add this line immediately after the `/motor-recipes` card:

```jsx
          <DashboardCard to="/ipt-kits" icon={<Boxes />} title="IPT Kit Assembly" desc="Record component serials for each IPT Kit" />
```

- [ ] **Step 3: Verify it builds**

```bash
cd CRM && npx eslint src/components/dashboards/ProductionDashboard.jsx src/components/dashboards/AdminDashboard.jsx
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboards/ProductionDashboard.jsx src/components/dashboards/AdminDashboard.jsx
git commit -m "feat: add IPT Kit Assembly dashboard card to Production and Admin dashboards"
```

---

## Task 9: End-to-end verification (real browser, both roles)

This repo has no frontend unit-test framework — UI correctness is verified by actually driving the running app in a real browser, the same way the Invoice Generator feature was verified earlier in this project's history (see the `CRM_BACKEND/.superpowers` session notes if present, or just follow the steps below fresh).

**Files:** none (verification only, no code changes)

- [ ] **Step 1: Start both dev servers**

```bash
cd CRM_BACKEND && FRONTEND_URL="http://localhost:5173" npm run dev
```

(in a second terminal / background task)

```bash
cd CRM && npm run dev
```

- [ ] **Step 2: Get real Admin and Production user IDs from the DB**

```bash
cd CRM_BACKEND && node -e "
const pool = require('./config/db');
(async () => {
  const r = await pool.query(\"SELECT u.user_id, u.name, r.role_name FROM users u JOIN roles r ON u.role_id = r.role_id WHERE r.role_name IN ('Admin','Production') LIMIT 5\");
  console.log(JSON.stringify(r.rows, null, 2));
  process.exit(0);
})();
"
```

- [ ] **Step 3: Mint JWTs for one Admin and one Production user**

```bash
cd CRM_BACKEND && node -e "
require('dotenv').config();
const jwt = require('jsonwebtoken');
console.log('admin:', jwt.sign({ user_id: <ADMIN_USER_ID> }, process.env.JWT_SECRET, { expiresIn: '2h' }));
console.log('production:', jwt.sign({ user_id: <PRODUCTION_USER_ID> }, process.env.JWT_SECRET, { expiresIn: '2h' }));
"
```

- [ ] **Step 4: Drive the real UI with Playwright**

Using a Playwright script (install `playwright` into an isolated scratch directory if not already available — do not add it to `CRM`'s own `package.json`), for **each** of the Admin and Production tokens:

1. `localStorage.setItem('token', <token>)`, `localStorage.setItem('role', 'admin')` (or `'production'`), `localStorage.setItem('name', ...)`, then navigate to the role's dashboard and reload.
2. Click the "IPT Kit Assembly" card. Confirm the URL becomes `/ipt-kits` and the empty-state list renders.
3. Click "New Kit". Confirm the modal shows a `Kit Serial: IPT0xx` preview. Fill all 7 component fields with unique values and submit. Confirm the new row appears in the table with the correct `kit_serial`.
4. Create a second kit re-using one of the first kit's component serials (e.g. the same Motor serial). Confirm the request is rejected and the specific offending input shows an inline red error — not just a generic toast.
5. Search using one of the *non-Motor* component serials from step 3 (e.g. the Gearbox serial). Confirm the search returns exactly the one kit that contains it (the reverse-lookup requirement).
6. Click "Edit" on a kit, change one serial, save. Confirm the table reflects the change and `kit_serial` did not change.
7. Click "Delete" on a kit, confirm the browser `confirm()` dialog, confirm the row disappears.

- [ ] **Step 5: Clean up test data**

```bash
cd CRM_BACKEND && node -e "
const pool = require('./config/db');
(async () => {
  const r = await pool.query(\"DELETE FROM ipt_kits WHERE motor_serial LIKE 'M9%' OR motor_serial LIKE 'PW%' RETURNING kit_id\");
  console.log('cleaned up', r.rowCount, 'test rows');
  const remaining = await pool.query('SELECT COUNT(*) FROM ipt_kits');
  console.log('remaining rows:', remaining.rows[0].count);
  process.exit(0);
})();
"
```

Adjust the `LIKE` patterns to match whatever test-serial prefix was actually used during the manual Playwright pass (e.g. if step 4 used `PW-M001` style serials, match on `'PW-%'`). Confirm the remaining row count matches what existed before this task started (0, if this is a fresh feature).

- [ ] **Step 6: Stop the dev servers**

Stop both background dev-server processes. On Windows, `nodemon`'s child `node server.js` process can survive a task-stop — verify with `netstat -ano | grep ":8000 "` / `":5173 "` and kill any leftover PID directly if the port is still bound.

---

## Self-Review Notes

- **Spec coverage:** Traceability purpose (no stock deduction) → satisfied, no inventory/raw_materials writes anywhere in the model. Fixed 7-required-fields → `COMPONENT_FIELDS` + `#validate` in the model, `required` on all 7 frontend inputs. Kit serial auto-generated, components typed → `create()` computes `kit_serial` via `nextval()`, never accepts it from the request body. Per-column uniqueness with friendly field-specific errors → `23505` handling in `create`/`update`, surfaced via `{ error, field }` and rendered inline in the modal. Trim+uppercase normalization → `#normalized`. Both roles full CRUD → both `checkPermission` seed rows have all three flags, no role-specific restriction anywhere in the routes. Reverse-serial search → `getAll`'s `searchClause` ORs across all 7 columns plus `kit_serial`. Hard delete, no reissue of deleted numbers → plain `DELETE`, sequence-based (not `COUNT`-based) serial generation. `/ipt-kits` in both dashboards and both `allowedPathsByRole` arrays → Tasks 7–8.
- **Placeholder scan:** none found in the final plan text.
- **Type consistency:** `kit_id` used consistently as the identifier across model, controller, routes (`/:id` → `req.params.id` → `IPTKits.getById(id)`/`update(id, ...)`/`delete(id, ...)`), and frontend (`kit.kit_id`, `editingId`). `COMPONENT_FIELDS` key names (`motor_serial`, `controller_serial`, `gearbox_serial`, `harness_serial`, `cluster_serial`, `vcu_serial`, `dcdc_serial`) are identical across the SQL schema (Task 1), the backend `COMPONENT_FIELDS` array (Task 2), and the frontend `COMPONENT_FIELDS` array (Task 6) — no renaming drift.
