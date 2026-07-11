# Testing Stage Primary/Final Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-date "Testing" stage on work orders with two independent sub-items — Primary testing and Final testing — each capturing Qty, Date, and Controller type, for both Motor and Non-Motor work orders.

**Architecture:** New `work_order_testing_results` table (decoupled from the existing `work_order_stages` mechanism), two new REST endpoints (`GET`/`PUT` `.../work-orders/:workOrderId/testing`), the results embedded into the existing work-order list response the same way `stages` already is, and a new shared `TestingEditor` React component used by both `CreateMotorProcess.jsx` and `CreateNonMotorProcess.jsx`.

**Tech Stack:** Node/Express/PostgreSQL (`CRM_BACKEND`), React (`CRM`).

**Spec:** `docs/superpowers/specs/2026-07-07-testing-stage-breakdown-design.md`

**Note on git:** Per explicit instruction from the project owner, do **not** run `git commit` or `git push` at any point while executing this plan. Every task below ends with a manual verification step instead of a commit step — leave all changes uncommitted in the working tree for the owner to commit themselves.

**Note on testing approach:** This backend has no test database — `.env` points at the live production RDS instance, and the one existing test file (`tests/auth.test.js`) runs against it directly. To avoid writing fabricated data (fake Qty/Controller type values) into real customer work orders, this plan uses one-off Node verification scripts (run manually, deleted after use) instead of a permanent Jest suite for the DB/API layer — mirroring how the `component_processes` data was migrated earlier in this project. This is a deliberate deviation from strict TDD, justified by the lack of an isolated test environment.

---

### Task 1: Create the `work_order_testing_results` table

**Files:**
- Create (temporary, delete after running): `<scratchpad>/create_testing_table.js`

- [ ] **Step 1: Write the verification query (expect: table does not exist yet)**

Create `<scratchpad>/verify_testing_table.js`:

```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 8000,
});

(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'work_order_testing_results' ORDER BY ordinal_position`
    );
    console.table(rows);
    console.log(rows.length ? 'TABLE EXISTS' : 'TABLE MISSING');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
})();
```

Run: `node <scratchpad>/verify_testing_table.js` (from `CRM_BACKEND` directory)
Expected: `TABLE MISSING` (empty table)

- [ ] **Step 2: Write and run the migration script**

Create `<scratchpad>/create_testing_table.js`:

```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 8000,
});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_order_testing_results (
        testing_result_id SERIAL PRIMARY KEY,
        work_order_id INTEGER NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
        testing_type VARCHAR NOT NULL CHECK (testing_type IN ('Primary', 'Final')),
        qty INTEGER,
        test_date DATE,
        controller_type VARCHAR,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (work_order_id, testing_type)
      )
    `);
    console.log('Table created (or already existed)');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
```

Run: `node <scratchpad>/create_testing_table.js` (from `CRM_BACKEND` directory)
Expected: `Table created (or already existed)`

- [ ] **Step 3: Re-run the verification query (expect: table exists with correct columns)**

Run: `node <scratchpad>/verify_testing_table.js`
Expected: `TABLE EXISTS` with columns `testing_result_id, work_order_id, testing_type, qty, test_date, controller_type, updated_at`

- [ ] **Step 4: Delete both scratch scripts**

```bash
rm <scratchpad>/verify_testing_table.js <scratchpad>/create_testing_table.js
```

No commit for this task (it's a DB-only change, nothing to commit in git).

---

### Task 2: Add model methods to `models/manufacturing/process.js`

**Files:**
- Modify: `CRM_BACKEND/models/manufacturing/process.js` (add methods at the end of the `Process` class, right before the closing `}` on line 945, after `getWorkOrderStages`)

- [ ] **Step 1: Add `getTestingResults` and `upsertTestingResult` methods**

Insert immediately before the final `}` that closes the `Process` class (currently line 945):

```js
  static async getTestingResults(work_order_id) {
    const pool = require('../../config/db');

    const workOrderIdNum = parseInt(work_order_id, 10);
    if (isNaN(workOrderIdNum)) throw new Error('Invalid work_order_id');

    const { rows } = await pool.query(
      `SELECT testing_type, qty, TO_CHAR(test_date, 'YYYY-MM-DD') AS test_date, controller_type
       FROM work_order_testing_results
       WHERE work_order_id = $1`,
      [workOrderIdNum]
    );

    const byType = new Map(rows.map((r) => [r.testing_type, r]));
    return ['Primary', 'Final'].map((type) => {
      const r = byType.get(type);
      return {
        testingType: type,
        qty: r ? r.qty : null,
        testDate: r ? r.test_date : null,
        controllerType: r ? r.controller_type : null,
      };
    });
  }

  static async upsertTestingResult(work_order_id, { testing_type, qty, test_date, controller_type }, io) {
    const pool = require('../../config/db');

    const workOrderIdNum = parseInt(work_order_id, 10);
    if (isNaN(workOrderIdNum)) throw new Error('Invalid work_order_id');
    if (!['Primary', 'Final'].includes(testing_type)) {
      throw new Error('testing_type must be Primary or Final');
    }

    const { rows: [wo] } = await pool.query(
      'SELECT work_order_id FROM work_orders WHERE work_order_id = $1',
      [workOrderIdNum]
    );
    if (!wo) throw new Error(`Work order ${workOrderIdNum} not found`);

    let qtyNum = null;
    if (qty !== null && qty !== undefined && qty !== '') {
      qtyNum = parseInt(qty, 10);
      if (isNaN(qtyNum)) throw new Error('qty must be a number');
    }

    const { rows: [result] } = await pool.query(
      `INSERT INTO work_order_testing_results (work_order_id, testing_type, qty, test_date, controller_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (work_order_id, testing_type)
       DO UPDATE SET qty = EXCLUDED.qty, test_date = EXCLUDED.test_date, controller_type = EXCLUDED.controller_type, updated_at = CURRENT_TIMESTAMP
       RETURNING testing_type, qty, TO_CHAR(test_date, 'YYYY-MM-DD') AS test_date, controller_type`,
      [workOrderIdNum, testing_type, qtyNum, test_date || null, controller_type || null]
    );

    if (io) {
      io.emit('workOrderTestingUpdate', {
        workOrderId: workOrderIdNum,
        testingType: result.testing_type,
        qty: result.qty,
        testDate: result.test_date,
        controllerType: result.controller_type,
      });
    }

    return result;
  }
```

- [ ] **Step 2: Verify the file still parses correctly**

Run: `node -e "require('./models/manufacturing/process.js'); console.log('OK')"` (from `CRM_BACKEND` directory)
Expected: `OK`

No commit — leave the change in the working tree.

---

### Task 3: Embed `testing` into `Process.getAll`'s query and formatted output

**Files:**
- Modify: `CRM_BACKEND/models/manufacturing/process.js:374-497` (the `getAll` method)

- [ ] **Step 1: Add the `testing` subquery to the SELECT list**

In the `getAll` method's SQL, find the `stages` subquery block (currently lines 443-460):

```sql
          COALESCE((
            SELECT json_agg(
              json_build_object(
                'stageName', wos.stage_name,
                'stageDate', TO_CHAR(wos.stage_date, 'YYYY-MM-DD')
              )
              ORDER BY
                CASE wos.stage_name
                  WHEN 'Assembly' THEN 1
                  WHEN 'Testing'  THEN 2
                  WHEN 'PDI'      THEN 3
                  WHEN 'Packing'  THEN 4
                  WHEN 'Dispatch' THEN 5
                END
            )
            FROM work_order_stages wos
            WHERE wos.work_order_id = wo.work_order_id
          ), '[]'::json) AS stages,
```

Immediately after this block (still before the `(SELECT COUNT(DISTINCT wo2.work_order_id) ...) AS total` line), add:

```sql
          COALESCE((
            SELECT json_agg(
              json_build_object(
                'testingType', wtr.testing_type,
                'qty', wtr.qty,
                'testDate', TO_CHAR(wtr.test_date, 'YYYY-MM-DD'),
                'controllerType', wtr.controller_type
              )
            )
            FROM work_order_testing_results wtr
            WHERE wtr.work_order_id = wo.work_order_id
          ), '[]'::json) AS testing,
```

- [ ] **Step 2: Include `testing` in the formatted row mapping**

Find the `formatted` mapping (currently lines 481-493):

```js
      const formatted = rows.map(row => ({
        workOrderId: row.work_order_id,
        orderId: row.order_id,
        instanceGroupId: row.instance_group_id,
        instanceName: row.instance_name,
        instanceType: row.instance_type,
        targetDate: row.target_date ? row.target_date.toISOString().split('T')[0] : null,
        status: row.status,
        createdAt: row.created_at,
        stages: row.stages ?? [],
        components: row.components ?? [],
        total: parseInt(row.total, 10) || 0
      }));
```

Change it to:

```js
      const formatted = rows.map(row => ({
        workOrderId: row.work_order_id,
        orderId: row.order_id,
        instanceGroupId: row.instance_group_id,
        instanceName: row.instance_name,
        instanceType: row.instance_type,
        targetDate: row.target_date ? row.target_date.toISOString().split('T')[0] : null,
        status: row.status,
        createdAt: row.created_at,
        stages: row.stages ?? [],
        testing: row.testing ?? [],
        components: row.components ?? [],
        total: parseInt(row.total, 10) || 0
      }));
```

- [ ] **Step 3: Verify the file still parses correctly**

Run: `node -e "require('./models/manufacturing/process.js'); console.log('OK')"` (from `CRM_BACKEND` directory)
Expected: `OK`

No commit — leave the change in the working tree.

---

### Task 4: Add controller handlers to `controllers/manufacturing/process.controller.js`

**Files:**
- Modify: `CRM_BACKEND/controllers/manufacturing/process.controller.js` (add after `exports.updateWorkOrderStage`, currently ending at line 210)

- [ ] **Step 1: Add `getTestingResults` and `upsertTestingResult` handlers**

Append after `exports.updateWorkOrderStage` (after its closing `};` on line 210):

```js

exports.getTestingResults = async (req, res, next) => {
  try {
    res.json(await Process.getTestingResults(req.params.workOrderId));
  } catch (error) {
    logger.error(`Testing results fetch failed - workOrder ${req.params.workOrderId}: ${error.message}`, { stack: error.stack });
    next(error);
  }
};

exports.upsertTestingResult = async (req, res, next) => {
  const { workOrderId } = req.params;
  const { testing_type, qty, test_date, controller_type } = req.body;
  if (!testing_type) return res.status(400).json({ error: 'testing_type is required' });
  if (qty !== undefined && qty !== null && qty !== '' && (!Number.isInteger(Number(qty)) || Number(qty) < 0)) {
    return res.status(400).json({ error: 'qty must be a non-negative integer' });
  }
  if (test_date && !/^\d{4}-\d{2}-\d{2}$/.test(test_date)) {
    return res.status(400).json({ error: 'test_date must be in YYYY-MM-DD format' });
  }
  try {
    const result = await Process.upsertTestingResult(workOrderId, { testing_type, qty, test_date, controller_type }, req.io);
    setImmediate(async () => {
      const { rows: [wo] } = await pool.query('SELECT order_id FROM work_orders WHERE work_order_id = $1', [workOrderId]);
      if (wo) { const keys = await redis.keys(`processes_${wo.order_id}_*`); if (keys.length) await redis.del(keys); }
    });
    res.json(result);
  } catch (error) {
    logger.error(`Testing result update failed - workOrder ${workOrderId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
};
```

- [ ] **Step 2: Verify the file still parses correctly**

Run: `node -e "require('./controllers/manufacturing/process.controller.js'); console.log('OK')"` (from `CRM_BACKEND` directory)
Expected: `OK`

No commit — leave the change in the working tree.

---

### Task 5: Include `testing` in `formatWorkOrderResponse` and `createWorkOrder` response

**Files:**
- Modify: `CRM_BACKEND/controllers/manufacturing/process.controller.js:6-17` (`formatWorkOrderResponse`)
- Modify: `CRM_BACKEND/controllers/manufacturing/process.controller.js:153-162` (`exports.createWorkOrder`)

- [ ] **Step 1: Update `formatWorkOrderResponse`**

Current (lines 6-17):

```js
const formatWorkOrderResponse = (workOrder) => ({
  workOrderId: workOrder.workOrderId, orderId: workOrder.orderId, instanceGroupId: workOrder.instanceGroupId,
  instanceName: workOrder.instanceName, instanceType: workOrder.instanceType, targetDate: workOrder.targetDate,
  status: workOrder.status, createdAt: workOrder.createdAt, stages: workOrder.stages ?? [],
  components: workOrder.components.map(component => ({
    workOrderComponentId: component.workOrderComponentId, componentId: component.componentId,
    componentName: component.componentName, productType: component.productType, quantity: component.quantity,
    processes: component.processes.map(p => ({ processId: p.processId, processName: p.processName, sequence: p.sequence, responsiblePerson: p.responsiblePerson, description: p.description, status: p.status, completedQuantity: p.completedQuantity, inUseQuantity: p.inUseQuantity, allowedQuantity: p.allowedQuantity, completionDate: p.completionDate })),
    materials: component.materials.map(m => ({ workOrderMaterialId: m.workOrderMaterialId, rawMaterialId: m.rawMaterialId, rawMaterialName: m.rawMaterialName, quantity: m.quantity })),
  })),
  timezone: 'Asia/Kolkata',
});
```

Change the `stages` line to also include `testing`:

```js
const formatWorkOrderResponse = (workOrder) => ({
  workOrderId: workOrder.workOrderId, orderId: workOrder.orderId, instanceGroupId: workOrder.instanceGroupId,
  instanceName: workOrder.instanceName, instanceType: workOrder.instanceType, targetDate: workOrder.targetDate,
  status: workOrder.status, createdAt: workOrder.createdAt, stages: workOrder.stages ?? [], testing: workOrder.testing ?? [],
  components: workOrder.components.map(component => ({
    workOrderComponentId: component.workOrderComponentId, componentId: component.componentId,
    componentName: component.componentName, productType: component.productType, quantity: component.quantity,
    processes: component.processes.map(p => ({ processId: p.processId, processName: p.processName, sequence: p.sequence, responsiblePerson: p.responsiblePerson, description: p.description, status: p.status, completedQuantity: p.completedQuantity, inUseQuantity: p.inUseQuantity, allowedQuantity: p.allowedQuantity, completionDate: p.completionDate })),
    materials: component.materials.map(m => ({ workOrderMaterialId: m.workOrderMaterialId, rawMaterialId: m.rawMaterialId, rawMaterialName: m.rawMaterialName, quantity: m.quantity })),
  })),
  timezone: 'Asia/Kolkata',
});
```

- [ ] **Step 2: Update `exports.createWorkOrder`'s response**

Current (lines 153-162):

```js
exports.createWorkOrder = async (req, res, next) => {
  const { orderId } = req.params;
  const { instance_group_id, target_date } = req.body;
  try {
    const workOrder = await Process.createWorkOrder(orderId, { instance_group_id, target_date }, req.io);
    const { rows: [ig] = [{}] } = instance_group_id ? await pool.query('SELECT instance_name, instance_type FROM instance_groups WHERE instance_group_id = $1', [instance_group_id]) : [];
    setImmediate(async () => { const keys = await redis.keys(`processes_${orderId}_*`); if (keys.length) await redis.del(keys); });
    res.status(201).json({ workOrderId: workOrder.work_order_id, orderId: workOrder.order_id, instanceGroupId: workOrder.instance_group_id, instanceName: ig?.instance_name || null, instanceType: ig?.instance_type || null, targetDate: workOrder.target_date, status: workOrder.status, createdAt: workOrder.created_at, components: [], timezone: 'Asia/Kolkata' });
  } catch (error) { logger.error(`Create work order failed - order ${orderId}: ${error.message}`, { stack: error.stack }); res.status(error.status || 400).json({ error: error.message }); }
};
```

Add `testing: []` to the response object:

```js
exports.createWorkOrder = async (req, res, next) => {
  const { orderId } = req.params;
  const { instance_group_id, target_date } = req.body;
  try {
    const workOrder = await Process.createWorkOrder(orderId, { instance_group_id, target_date }, req.io);
    const { rows: [ig] = [{}] } = instance_group_id ? await pool.query('SELECT instance_name, instance_type FROM instance_groups WHERE instance_group_id = $1', [instance_group_id]) : [];
    setImmediate(async () => { const keys = await redis.keys(`processes_${orderId}_*`); if (keys.length) await redis.del(keys); });
    res.status(201).json({ workOrderId: workOrder.work_order_id, orderId: workOrder.order_id, instanceGroupId: workOrder.instance_group_id, instanceName: ig?.instance_name || null, instanceType: ig?.instance_type || null, targetDate: workOrder.target_date, status: workOrder.status, createdAt: workOrder.created_at, components: [], testing: [], timezone: 'Asia/Kolkata' });
  } catch (error) { logger.error(`Create work order failed - order ${orderId}: ${error.message}`, { stack: error.stack }); res.status(error.status || 400).json({ error: error.message }); }
};
```

- [ ] **Step 3: Verify the file still parses correctly**

Run: `node -e "require('./controllers/manufacturing/process.controller.js'); console.log('OK')"` (from `CRM_BACKEND` directory)
Expected: `OK`

No commit — leave the change in the working tree.

---

### Task 6: Register the new routes

**Files:**
- Modify: `CRM_BACKEND/routes/manufacturing/process.js:17-18`

- [ ] **Step 1: Add the two new routes next to the existing stages routes**

Current (lines 17-18):

```js
router.get('/work-orders/:workOrderId/stages', authenticateToken, checkPermission('Processes', 'can_read'), controller.getWorkOrderStages);
router.put('/work-orders/:workOrderId/stages', authenticateToken, checkPermission('Processes', 'can_write'), controller.updateWorkOrderStage);
```

Change to:

```js
router.get('/work-orders/:workOrderId/stages', authenticateToken, checkPermission('Processes', 'can_read'), controller.getWorkOrderStages);
router.put('/work-orders/:workOrderId/stages', authenticateToken, checkPermission('Processes', 'can_write'), controller.updateWorkOrderStage);
router.get('/work-orders/:workOrderId/testing', authenticateToken, checkPermission('Processes', 'can_read'), controller.getTestingResults);
router.put('/work-orders/:workOrderId/testing', authenticateToken, checkPermission('Processes', 'can_write'), controller.upsertTestingResult);
```

- [ ] **Step 2: Verify the file still parses correctly**

Run: `node -e "require('./routes/manufacturing/process.js'); console.log('OK')"` (from `CRM_BACKEND` directory)
Expected: `OK`

No commit — leave the change in the working tree.

---

### Task 7: Verify the backend end-to-end against the live database

**Files:**
- Create (temporary, delete after running): `<scratchpad>/verify_testing_api.js`

This exercises the model layer directly (bypassing HTTP/auth, since there's no test login available in this environment) against a real work order, then cleans up the row it created so no fabricated data is left behind.

- [ ] **Step 1: Find a real work_order_id to test against**

Run this from `CRM_BACKEND`:

```bash
node -e "
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, ssl: { rejectUnauthorized: false } });
pool.query('SELECT work_order_id FROM work_orders ORDER BY work_order_id LIMIT 1').then(r => { console.log(r.rows); pool.end(); });
"
```

Note the `work_order_id` returned — use it as `<TEST_WORK_ORDER_ID>` below.

- [ ] **Step 2: Write and run the verification script**

Create `<scratchpad>/verify_testing_api.js` (replace `<TEST_WORK_ORDER_ID>` with the real id from Step 1):

```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
process.chdir('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND');
const Process = require('./models/manufacturing/process');
const pool = require('./config/db');

const WORK_ORDER_ID = <TEST_WORK_ORDER_ID>;

(async () => {
  try {
    const before = await Process.getTestingResults(WORK_ORDER_ID);
    console.log('Before (expect qty/testDate/controllerType all null):', before);

    const upserted = await Process.upsertTestingResult(WORK_ORDER_ID, {
      testing_type: 'Primary',
      qty: 3,
      test_date: '2026-07-08',
      controller_type: 'VERIFICATION-SCRIPT-TEMP',
    });
    console.log('Upsert result:', upserted);

    const after = await Process.getTestingResults(WORK_ORDER_ID);
    console.log('After (expect Primary filled in, Final still null):', after);

    // Clean up: remove the row this script created so no fabricated data remains
    await pool.query(
      `DELETE FROM work_order_testing_results WHERE work_order_id = $1 AND testing_type = 'Primary' AND controller_type = 'VERIFICATION-SCRIPT-TEMP'`,
      [WORK_ORDER_ID]
    );
    const cleaned = await Process.getTestingResults(WORK_ORDER_ID);
    console.log('After cleanup (expect all null again):', cleaned);
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
})();
```

Run: `node <scratchpad>/verify_testing_api.js`
Expected: "Before" shows both Primary/Final null, "Upsert result" shows the Primary row with qty 3, "After" shows Primary filled/Final null, "After cleanup" shows both null again.

- [ ] **Step 3: Delete the scratch script**

```bash
rm <scratchpad>/verify_testing_api.js
```

No commit — backend changes stay uncommitted in the working tree for the owner to review and commit.

---

### Task 8: Create the shared `TestingEditor` component

**Files:**
- Create: `CRM/src/components/admin/TestingEditor.jsx`

- [ ] **Step 1: Write the component**

```jsx
import React, { useState } from "react";

const getBackendUrl = () => import.meta.env.VITE_BACKEND_URL || "";

const tokenGuard = () => {
  const token = localStorage.getItem("token");
  if (!token) throw new Error("Authentication token missing");
  return token;
};

/**
 * Shared editor for a single Testing sub-item (Primary or Final).
 * If `workOrderId` is null, the work order is created first using
 * `orderId` + `instanceGroupId` (mirrors the Motor page's on-demand
 * work-order creation for stage dates). Non-Motor callers should
 * already guarantee a workOrderId exists before opening this.
 */
export default function TestingEditor({
  orderId,
  workOrderId,
  instanceGroupId,
  testingType,
  initialQty,
  initialDate,
  initialControllerType,
  onClose,
  onSaved,
}) {
  const [qty, setQty] = useState(initialQty ?? "");
  const [date, setDate] = useState(initialDate ?? "");
  const [controllerType, setControllerType] = useState(initialControllerType ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const token = tokenGuard();
      let woId = workOrderId;

      if (!woId) {
        const createRes = await fetch(`${getBackendUrl()}/api/process/${orderId}/work-orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          credentials: "include",
          body: JSON.stringify({ instance_group_id: instanceGroupId }),
        });
        if (!createRes.ok) throw new Error("Failed to create work order");
        const wo = await createRes.json();
        woId = wo.workOrderId;
      }

      const res = await fetch(`${getBackendUrl()}/api/process/work-orders/${woId}/testing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        credentials: "include",
        body: JSON.stringify({
          testing_type: testingType,
          qty: qty === "" ? null : Number(qty),
          test_date: date || null,
          controller_type: controllerType || null,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Failed to save testing result");
      }

      onSaved();
    } catch (err) {
      setError(err.message || "Failed to save testing result");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">
          {testingType} Testing
        </h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Qty</label>
            <input
              type="number"
              min="0"
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-amber-300"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
            <input
              type="date"
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-amber-300"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Controller Type</label>
            <input
              type="text"
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-amber-300"
              value={controllerType}
              onChange={(e) => setControllerType(e.target.value)}
              placeholder="e.g. Sine wave controller X"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border" disabled={saving}>
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60"
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it lints cleanly**

Run: `cd CRM && npx eslint src/components/admin/TestingEditor.jsx`
Expected: no errors (warnings about project-wide conventions, if any, are acceptable — check there are none specific to this new file)

No commit — leave the new file uncommitted in the working tree.

---

### Task 9: Integrate the Testing column in `CreateMotorProcess.jsx`

**Files:**
- Modify: `CRM/src/components/admin/CreateMotorProcess.jsx`

- [ ] **Step 1: Import `TestingEditor`**

Near the top of the file, after the existing `import AddMotorModal from "./AddMotorModal";` line (line 16):

```js
import AddMotorModal from "./AddMotorModal";
import TestingEditor from "./TestingEditor";
```

- [ ] **Step 2: Add `editTesting` state**

Next to the existing `const [editStage, setEditStage] = useState(null);` (line 1107):

```js
  const [editStage, setEditStage] = useState(null);
  const [editTesting, setEditTesting] = useState(null);
```

- [ ] **Step 3: Add a `testingByWorkOrder` memo**

Immediately after the existing `stagesByWorkOrder` memo (ends at line 1213, right before `const ensureWorkOrderComponent = useCallback(`):

```js
  const testingByWorkOrder = useMemo(() => {
    const map = new Map();

    workOrders.forEach((wo) => {
      const testingMap = new Map();
      (wo.testing || []).forEach((t) => {
        testingMap.set(t.testingType, t);
      });
      map.set(Number(wo.instanceGroupId), testingMap);
    });

    return map;
  }, [workOrders]);
```

- [ ] **Step 4: Special-case the Testing column cell**

Find the stage-cell rendering block (lines 1572-1616):

```jsx
                    if (col.isStage) {
                      const stageMap = stagesByWorkOrder.get(motor.instance_group_id);
                      const stage = stageMap?.get(normalizeNameKey(col.label));
                      const motorWorkOrder = workOrders.find(
                        (wo) => Number(wo.instanceGroupId) === Number(motor.instance_group_id)
                      );

                      return (
                        <td key={`stage-${col.label}`} className="py-5 px-4">
                          {stage ? (
                            <div className="flex items-center gap-2 text-sm">
                              <span className="text-gray-600">
                                {stage.targetDate || "—"}
                              </span>
                              <button
                                onClick={() =>
                                  setEditStage({
                                    ...stage,
                                    workOrderId: stage.workOrderId,
                                  })
                                }
                                className="text-amber-700 hover:underline text-xs"
                              >
                                edit
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() =>
                                setEditStage({
                                  name: col.label,
                                  targetDate: "",
                                  workOrderId: motorWorkOrder?.workOrderId ?? null,
                                  motorInstanceGroupId: motorWorkOrder
                                    ? null
                                    : motor.instance_group_id,
                                })
                              }
                              className="text-xs text-amber-600 hover:underline italic"
                            >
                              Add date
                            </button>
                          )}
                        </td>
                      );
                    }
```

Replace it with (adds a `col.label === "Testing"` branch before the existing logic, leaving Assembly/PDI/Packing/Dispatch untouched):

```jsx
                    if (col.isStage) {
                      const motorWorkOrder = workOrders.find(
                        (wo) => Number(wo.instanceGroupId) === Number(motor.instance_group_id)
                      );

                      if (col.label === "Testing") {
                        const testingMap = testingByWorkOrder.get(motor.instance_group_id);

                        return (
                          <td key="stage-Testing" className="py-5 px-4">
                            {["Primary", "Final"].map((type) => {
                              const entry = testingMap?.get(type);
                              return (
                                <div key={type} className="flex items-center gap-2 text-xs mb-1 last:mb-0">
                                  <span className="font-medium text-gray-700 w-14 shrink-0">{type}</span>
                                  <span className="text-gray-600">{entry?.testDate || "—"}</span>
                                  <button
                                    onClick={() =>
                                      setEditTesting({
                                        workOrderId: motorWorkOrder?.workOrderId ?? null,
                                        instanceGroupId: motor.instance_group_id,
                                        testingType: type,
                                        qty: entry?.qty ?? null,
                                        testDate: entry?.testDate ?? null,
                                        controllerType: entry?.controllerType ?? null,
                                      })
                                    }
                                    className="text-amber-700 hover:underline"
                                  >
                                    {entry?.testDate ? "edit" : "add"}
                                  </button>
                                </div>
                              );
                            })}
                          </td>
                        );
                      }

                      const stageMap = stagesByWorkOrder.get(motor.instance_group_id);
                      const stage = stageMap?.get(normalizeNameKey(col.label));

                      return (
                        <td key={`stage-${col.label}`} className="py-5 px-4">
                          {stage ? (
                            <div className="flex items-center gap-2 text-sm">
                              <span className="text-gray-600">
                                {stage.targetDate || "—"}
                              </span>
                              <button
                                onClick={() =>
                                  setEditStage({
                                    ...stage,
                                    workOrderId: stage.workOrderId,
                                  })
                                }
                                className="text-amber-700 hover:underline text-xs"
                              >
                                edit
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() =>
                                setEditStage({
                                  name: col.label,
                                  targetDate: "",
                                  workOrderId: motorWorkOrder?.workOrderId ?? null,
                                  motorInstanceGroupId: motorWorkOrder
                                    ? null
                                    : motor.instance_group_id,
                                })
                              }
                              className="text-xs text-amber-600 hover:underline italic"
                            >
                              Add date
                            </button>
                          )}
                        </td>
                      );
                    }
```

- [ ] **Step 5: Render `TestingEditor` alongside the existing `StageEditor`**

Find (around line 1718-1724):

```jsx
      {editStage && (
        <StageEditor
          stage={editStage}
          onCancel={() => setEditStage(null)}
          onSave={saveStageEdits}
        />
      )}
```

Add right after it:

```jsx
      {editStage && (
        <StageEditor
          stage={editStage}
          onCancel={() => setEditStage(null)}
          onSave={saveStageEdits}
        />
      )}

      {editTesting && (
        <TestingEditor
          orderId={orderId}
          workOrderId={editTesting.workOrderId}
          instanceGroupId={editTesting.instanceGroupId}
          testingType={editTesting.testingType}
          initialQty={editTesting.qty}
          initialDate={editTesting.testDate}
          initialControllerType={editTesting.controllerType}
          onClose={() => setEditTesting(null)}
          onSaved={async () => {
            setEditTesting(null);
            await refetchAll();
          }}
        />
      )}
```

- [ ] **Step 6: Verify it lints and builds cleanly**

Run: `cd CRM && npx eslint src/components/admin/CreateMotorProcess.jsx`
Expected: no *new* errors compared to before this change (pre-existing warnings in this file are fine — check the diff didn't introduce new ones)

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds with no new errors

No commit — leave the change in the working tree.

---

### Task 10: Integrate the Testing column in `CreateNonMotorProcess.jsx`

**Files:**
- Modify: `CRM/src/components/admin/CreateNonMotorProcess.jsx`

- [ ] **Step 1: Import `TestingEditor`**

Find the existing `import AddNonMotorModal from "./AddNonMotorModal";`-style import block near the top of the file and add:

```js
import TestingEditor from "./TestingEditor";
```

(If there's no `AddNonMotorModal`-style import to anchor to, add this import next to the other local component imports at the top of the file.)

- [ ] **Step 2: Add `editTesting` state**

Next to the existing `const [editStage, setEditStage] = useState(null);` (line 409):

```js
  const [editStage, setEditStage] = useState(null);
  const [editTesting, setEditTesting] = useState(null);
```

- [ ] **Step 3: Add a `handleEditTesting` guard function**

Right after the existing `handleEditStageDate` function (lines 516-529):

```js
  const handleEditTesting = (nonMotor, testingType) => {
    const wo = getWorkOrderForNonMotor(nonMotor.instance_group_id);
    if (!wo) {
      notifyWarning("Work order not created yet. Add at least one component first.");
      return;
    }

    const entry = (wo.testing || []).find((t) => t.testingType === testingType);
    setEditTesting({
      workOrderId: wo.workOrderId,
      testingType,
      qty: entry?.qty ?? null,
      testDate: entry?.testDate ?? null,
      controllerType: entry?.controllerType ?? null,
    });
  };
```

- [ ] **Step 4: Special-case the Testing column cell**

Find the `STAGE_LIST.map((stageName) => { ... })` block inside the table row rendering (lines 675-710):

```jsx
                    {STAGE_LIST.map((stageName) => {
                      const stageData = getStageData(wo, stageName);
                      const status = getStageStatus(stageData?.stageDate);
                      const displayText = statusToLabel(status, stageData?.stageDate);

                      return (
                        <td key={stageName} className="py-5 px-4">
                          {wo ? (
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => handleEditStageDate(nonMotor, stageName)}
                                className={`px-3.5 py-1.5 rounded-full text-xs font-medium ${statusToBadgeClass(
                                  status
                                )}`}
                                title="Click to set or change date"
                              >
                                {displayText}
                              </button>

                              {stageData?.stageDate && (
                                <button
                                  onClick={() => handleEditStageDate(nonMotor, stageName)}
                                  className="text-blue-600 hover:underline text-xs"
                                >
                                  edit
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400 italic">
                              Add components first
                            </span>
                          )}
                        </td>
                      );
                    })}
```

Replace it with (adds a `stageName === "Testing"` branch before the existing logic):

```jsx
                    {STAGE_LIST.map((stageName) => {
                      if (stageName === "Testing") {
                        const testingEntries = wo?.testing || [];

                        return (
                          <td key="Testing" className="py-5 px-4">
                            {wo ? (
                              ["Primary", "Final"].map((type) => {
                                const entry = testingEntries.find((t) => t.testingType === type);
                                return (
                                  <div key={type} className="flex items-center gap-2 text-xs mb-1 last:mb-0">
                                    <span className="font-medium text-gray-700 w-14 shrink-0">{type}</span>
                                    <span className="text-gray-600">{entry?.testDate || "—"}</span>
                                    <button
                                      onClick={() => handleEditTesting(nonMotor, type)}
                                      className="text-blue-600 hover:underline"
                                    >
                                      {entry?.testDate ? "edit" : "add"}
                                    </button>
                                  </div>
                                );
                              })
                            ) : (
                              <span className="text-xs text-gray-400 italic">
                                Add components first
                              </span>
                            )}
                          </td>
                        );
                      }

                      const stageData = getStageData(wo, stageName);
                      const status = getStageStatus(stageData?.stageDate);
                      const displayText = statusToLabel(status, stageData?.stageDate);

                      return (
                        <td key={stageName} className="py-5 px-4">
                          {wo ? (
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => handleEditStageDate(nonMotor, stageName)}
                                className={`px-3.5 py-1.5 rounded-full text-xs font-medium ${statusToBadgeClass(
                                  status
                                )}`}
                                title="Click to set or change date"
                              >
                                {displayText}
                              </button>

                              {stageData?.stageDate && (
                                <button
                                  onClick={() => handleEditStageDate(nonMotor, stageName)}
                                  className="text-blue-600 hover:underline text-xs"
                                >
                                  edit
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400 italic">
                              Add components first
                            </span>
                          )}
                        </td>
                      );
                    })}
```

- [ ] **Step 5: Render `TestingEditor` alongside the existing `StageDateEditorModal`**

Find (around lines 737-745):

```jsx
      {editStage && (
        <StageDateEditorModal
          workOrder={editStage.workOrder}
          stageName={editStage.stageName}
          currentDate={editStage.currentDate}
          onClose={() => setEditStage(null)}
          onSave={saveStageDate}
        />
      )}
```

Add right after it:

```jsx
      {editStage && (
        <StageDateEditorModal
          workOrder={editStage.workOrder}
          stageName={editStage.stageName}
          currentDate={editStage.currentDate}
          onClose={() => setEditStage(null)}
          onSave={saveStageDate}
        />
      )}

      {editTesting && (
        <TestingEditor
          workOrderId={editTesting.workOrderId}
          testingType={editTesting.testingType}
          initialQty={editTesting.qty}
          initialDate={editTesting.testDate}
          initialControllerType={editTesting.controllerType}
          onClose={() => setEditTesting(null)}
          onSaved={async () => {
            setEditTesting(null);
            await refetchAll();
          }}
        />
      )}
```

(Note: no `orderId`/`instanceGroupId` props are passed here — `workOrderId` is always non-null by the time this modal opens, because `handleEditTesting` already guards against a missing work order.)

- [ ] **Step 6: Verify it lints and builds cleanly**

Run: `cd CRM && npx eslint src/components/admin/CreateNonMotorProcess.jsx`
Expected: no *new* errors compared to before this change

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds with no new errors

No commit — leave the change in the working tree.

---

### Task 11: Final full verification

- [ ] **Step 1: Lint both changed frontend files together**

Run: `cd CRM && npx eslint src/components/admin/CreateMotorProcess.jsx src/components/admin/CreateNonMotorProcess.jsx src/components/admin/TestingEditor.jsx`
Expected: no new errors introduced by this feature (compare against the pre-existing baseline noted in Tasks 9/10 if unsure)

- [ ] **Step 2: Full frontend build**

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds

- [ ] **Step 3: Backend syntax sanity check on every touched file**

Run (from `CRM_BACKEND`):

```bash
node -e "require('./models/manufacturing/process.js'); require('./controllers/manufacturing/process.controller.js'); require('./routes/manufacturing/process.js'); console.log('ALL OK')"
```

Expected: `ALL OK`

- [ ] **Step 4: Summarize remaining manual QA for the owner**

Report to the project owner that automated verification is complete, but real UI click-through (logging in, opening a Motor and a Non-Motor work order, clicking Primary/Final testing "add"/"edit", saving, confirming it persists after refresh) still needs to happen in a browser with real credentials, since this environment has no logged-in session to drive one. Leave all changes uncommitted per the owner's instruction — they'll review and commit themselves.
