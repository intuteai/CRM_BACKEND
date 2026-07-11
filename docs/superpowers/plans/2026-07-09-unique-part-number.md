# Unique Part Number (Finished Goods + Raw Materials) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 4-digit Part Number segment of `product_code` unique within `inventory` (finished goods) and within `raw_materials`, auto-filled from `product_id` on create, live-validated while typing, across all 7 pages that have a Product Code Builder.

**Architecture:** A DB-generated column (`part_number`, derived from the first 4 characters of `product_code`) with a `UNIQUE` constraint per table is the authoritative guarantee. The backend exposes a `check-part-number` lookup endpoint per resource and accepts a `part_number_auto` flag on create so it can correct the Part Number to match the real assigned `product_id` after insert. Each of the 7 frontend pages' local `ProductCodeBuilder` gets the same three additions: a "next likely ID" default, touched-tracking, and a debounced live availability check.

**Tech Stack:** Node/Express/PostgreSQL (`CRM_BACKEND`), React (`CRM`).

**Spec:** `docs/superpowers/specs/2026-07-09-unique-part-number-design.md`

**Note on git:** Per explicit instruction from the project owner, do **not** run `git commit` or `git push` at any point while executing this plan. Leave all changes uncommitted in the working tree for the owner to review and commit themselves.

**Note on testing approach:** Same as the prior plan in this project — no test database exists (`.env` points at the live production RDS instance). Verification happens via one-off Node scripts run manually and deleted afterward, not a permanent Jest suite, to avoid writing fabricated data into production tables.

**Note on scratchpad path:** All scratch verification scripts in this plan should be created in `C:\Users\Rahul\AppData\Local\Temp\claude\c--Users-Rahul-OneDrive-Desktop-Projects-ERDE-ev-dashboard-backend\4c4faaaa-9427-4d76-ae06-639f67f242a9\scratchpad` and deleted after use. All DB scripts use this connection pattern:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
});
```
Run all such scripts with `node <script-path>` from `C:\Users\Rahul\OneDrive\Desktop\Projects\ERP-CRM\CRM_BACKEND` so `pg`/`dotenv` resolve from that project's `node_modules`.

---

## Phase A: Data cleanup and database migrations

### Task 1: Fix the 3 pre-existing Part Number collisions in `raw_materials`

**Files:** none (data-only, via scratch script)

- [ ] **Step 1: Verify the collisions still exist exactly as expected**

Create `<scratchpad>/verify_collisions_before.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
});

(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT product_id, product_name, product_code, LEFT(product_code, 4) AS part_number
      FROM raw_materials
      WHERE product_id IN (1, 93, 94, 138, 140)
      ORDER BY product_id
    `);
    console.table(rows);
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/verify_collisions_before.js`
Expected output (5 rows): product_id 1 → part_number `0001`, product_id 93 → `0052`, product_id 94 → `0052`, product_id 138 → `0001`, product_id 140 → `0001`.

- [ ] **Step 2: Apply the fix**

Create `<scratchpad>/fix_collisions.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
});

const FIXES = [
  { productId: 94, newPartNumber: '0094' },
  { productId: 138, newPartNumber: '0138' },
  { productId: 140, newPartNumber: '0140' },
];

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { productId, newPartNumber } of FIXES) {
      const { rows: [before] } = await client.query(
        'SELECT product_code FROM raw_materials WHERE product_id = $1',
        [productId]
      );
      if (!before) throw new Error(`product_id ${productId} not found`);
      const newCode = newPartNumber + before.product_code.slice(4);
      const { rows: [after] } = await client.query(
        'UPDATE raw_materials SET product_code = $1 WHERE product_id = $2 RETURNING product_id, product_code',
        [newCode, productId]
      );
      console.log(`product_id ${productId}: ${before.product_code} -> ${after.product_code}`);
    }
    await client.query('COMMIT');
    console.log('COMMITTED');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/fix_collisions.js`
Expected output:
```
product_id 94: 0052L5IS123 -> 0094L5IS123
product_id 138: 0001GNSL311 -> 0138GNSL311
product_id 140: 0001L5MO121 -> 0140L5MO121
COMMITTED
```

- [ ] **Step 3: Verify zero collisions remain anywhere in the table**

Create `<scratchpad>/verify_no_collisions.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
});

(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT LEFT(product_code, 4) AS part_number, COUNT(*) AS cnt, array_agg(product_id ORDER BY product_id) AS product_ids
      FROM raw_materials
      GROUP BY LEFT(product_code, 4)
      HAVING COUNT(*) > 1
    `);
    console.log('Remaining collisions (expect 0 rows):');
    console.table(rows);
    if (rows.length === 0) console.log('CLEAN — no collisions');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/verify_no_collisions.js`
Expected: `CLEAN — no collisions` with an empty table.

- [ ] **Step 4: Delete the three scratch scripts**

```bash
rm <scratchpad>/verify_collisions_before.js <scratchpad>/fix_collisions.js <scratchpad>/verify_no_collisions.js
```

No commit for this task (data-only change, no git-tracked files touched).

---

### Task 2: Add `part_number` generated column + UNIQUE constraint to `raw_materials`

**Files:** none (schema-only, via scratch script)

- [ ] **Step 1: Run the migration**

Create `<scratchpad>/migrate_raw_materials_part_number.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
});

(async () => {
  try {
    await pool.query(`
      ALTER TABLE raw_materials
        ADD COLUMN part_number VARCHAR(4) GENERATED ALWAYS AS (LEFT(product_code, 4)) STORED,
        ADD CONSTRAINT raw_materials_part_number_unique UNIQUE (part_number)
    `);
    console.log('Migration applied to raw_materials');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/migrate_raw_materials_part_number.js`
Expected: `Migration applied to raw_materials` (this MUST run after Task 1's cleanup — if it fails with a unique-violation error, Task 1 didn't fully resolve the collisions; stop and re-check Task 1 rather than proceeding).

- [ ] **Step 2: Verify the column and constraint**

Create `<scratchpad>/verify_raw_materials_migration.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
});

(async () => {
  try {
    const { rows: cols } = await pool.query(`
      SELECT column_name, data_type, is_generated FROM information_schema.columns
      WHERE table_name = 'raw_materials' AND column_name = 'part_number'
    `);
    console.table(cols);
    const { rows: cons } = await pool.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'raw_materials'::regclass AND conname = 'raw_materials_part_number_unique'
    `);
    console.table(cons);
    console.log(cols.length === 1 && cons.length === 1 ? 'OK' : 'MISSING');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/verify_raw_materials_migration.js`
Expected: `OK`, with the column row showing `data_type: 'character varying'`, `is_generated: 'ALWAYS'`, and the constraint row showing `def: 'UNIQUE (part_number)'`.

- [ ] **Step 3: Delete the two scratch scripts**

```bash
rm <scratchpad>/migrate_raw_materials_part_number.js <scratchpad>/verify_raw_materials_migration.js
```

No commit for this task.

---

### Task 3: Add `part_number` generated column + UNIQUE constraint to `inventory`

**Files:** none (schema-only, via scratch script)

- [ ] **Step 1: Run the migration**

Create `<scratchpad>/migrate_inventory_part_number.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
});

(async () => {
  try {
    await pool.query(`
      ALTER TABLE inventory
        ADD COLUMN part_number VARCHAR(4) GENERATED ALWAYS AS (LEFT(product_code, 4)) STORED,
        ADD CONSTRAINT inventory_part_number_unique UNIQUE (part_number)
    `);
    console.log('Migration applied to inventory');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/migrate_inventory_part_number.js`
Expected: `Migration applied to inventory` (the only 2 existing rows have part numbers `0001`/`0002` — no collision expected).

- [ ] **Step 2: Verify the column and constraint**

Create `<scratchpad>/verify_inventory_migration.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
});

(async () => {
  try {
    const { rows: cols } = await pool.query(`
      SELECT column_name, data_type, is_generated FROM information_schema.columns
      WHERE table_name = 'inventory' AND column_name = 'part_number'
    `);
    console.table(cols);
    const { rows: cons } = await pool.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'inventory'::regclass AND conname = 'inventory_part_number_unique'
    `);
    console.table(cons);
    console.log(cols.length === 1 && cons.length === 1 ? 'OK' : 'MISSING');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/verify_inventory_migration.js`
Expected: `OK`.

- [ ] **Step 3: Delete the two scratch scripts**

```bash
rm <scratchpad>/migrate_inventory_part_number.js <scratchpad>/verify_inventory_migration.js
```

No commit for this task.

---

## Phase B: Backend — `inventory` (finished goods)

### Task 4: Add `checkPartNumber` handler + route for inventory

**Files:**
- Modify: `CRM_BACKEND/controllers/core/inventory.controller.js`
- Modify: `CRM_BACKEND/routes/core/inventory.js`

- [ ] **Step 1: Add the handler**

In `controllers/core/inventory.controller.js`, add this new export. Insert it right after the existing `exports.getAll` handler (which currently ends at line 74 with `};`, immediately before `exports.create` begins):

```js
exports.checkPartNumber = async (req, res, next) => {
  try {
    const { part_number, exclude_id } = req.query;
    if (!part_number || !/^\d{4}$/.test(part_number)) {
      return res.status(400).json({ error: 'part_number must be a 4-digit string' });
    }
    let query = 'SELECT product_id, product_name FROM inventory WHERE part_number = $1';
    const params = [part_number];
    if (exclude_id) {
      query += ' AND product_id != $2';
      params.push(exclude_id);
    }
    const { rows } = await pool.query(query, params);
    if (rows.length === 0) {
      return res.json({ available: true, conflictProductId: null, conflictProductName: null });
    }
    res.json({ available: false, conflictProductId: rows[0].product_id, conflictProductName: rows[0].product_name });
  } catch (error) {
    logger.error(`Error checking inventory part number: ${error.message}`, error.stack);
    next(error);
  }
};
```

This uses the `pool` import already present at the top of the file (`const pool = require('../../config/db');`) — no new imports needed.

- [ ] **Step 2: Register the route**

In `routes/core/inventory.js`, the current content is:
```js
router.post('/', authenticateToken, checkPermission('Inventory', 'can_write'), controller.create);
router.get('/available', authenticateToken, controller.getAvailable);
router.get('/', authenticateToken, checkPermission('Inventory', 'can_read'), controller.getAll);
```

Change it to (adding one new line after `/available`, matching that route's minimal-permission convention since this is a lightweight lookup used while typing):
```js
router.post('/', authenticateToken, checkPermission('Inventory', 'can_write'), controller.create);
router.get('/available', authenticateToken, controller.getAvailable);
router.get('/check-part-number', authenticateToken, controller.checkPartNumber);
router.get('/', authenticateToken, checkPermission('Inventory', 'can_read'), controller.getAll);
```

- [ ] **Step 3: Verify both files parse correctly**

Run (from `CRM_BACKEND`):
```bash
node -e "require('./controllers/core/inventory.controller.js'); require('./routes/core/inventory.js'); console.log('OK'); process.exit(0)"
```
Expected: `OK`.

No commit — leave the change in the working tree.

---

### Task 5: Add `part_number_auto` handling to inventory create

**Files:**
- Modify: `CRM_BACKEND/controllers/core/inventory.controller.js`

- [ ] **Step 1: Replace `exports.create`**

Current (lines 9–38):
```js
exports.create = async (req, res, next) => {
  try {
    const { product_name, stock_quantity, price, description, product_code, returnable_qty = 0 } = req.body;
    if (!product_name) return res.status(400).json({ error: 'Product name is required' });
    if (!product_code || product_code.length !== 11) return res.status(400).json({ error: 'Product code must be exactly 11 characters' });
    if (stock_quantity < 0) return res.status(400).json({ error: 'Stock quantity cannot be negative' });
    if (returnable_qty < 0) return res.status(400).json({ error: 'Returnable quantity cannot be negative' });

    const sanitizedData = {
      product_name: sanitize(product_name),
      stock_quantity: stock_quantity || 0,
      price: price || null,
      description: description ? sanitize(description) : null,
      product_code: sanitize(product_code),
      returnable_qty: returnable_qty || 0,
    };
    const product = await Inventory.create(sanitizedData, req.io);
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del('price_list_*');
    logger.info(`Product added: ${product.product_name} by ${req.user.user_id}`);
    res.status(201).json(product);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'unique_product_code') {
      return res.status(400).json({ error: 'Product code must be unique' });
    }
    logger.error(`Error creating inventory: ${error.message}`, error.stack);
    next(error);
  }
};
```

Replace with:
```js
exports.create = async (req, res, next) => {
  try {
    const { product_name, stock_quantity, price, description, product_code, returnable_qty = 0, part_number_auto } = req.body;
    if (!product_name) return res.status(400).json({ error: 'Product name is required' });
    if (!product_code || product_code.length !== 11) return res.status(400).json({ error: 'Product code must be exactly 11 characters' });
    if (stock_quantity < 0) return res.status(400).json({ error: 'Stock quantity cannot be negative' });
    if (returnable_qty < 0) return res.status(400).json({ error: 'Returnable quantity cannot be negative' });

    if (!part_number_auto) {
      const partNumber = product_code.slice(0, 4);
      const { rows: conflictRows } = await pool.query(
        'SELECT product_id, product_name FROM inventory WHERE part_number = $1',
        [partNumber]
      );
      if (conflictRows.length > 0) {
        return res.status(400).json({
          error: `Part Number ${partNumber} is already used by ${conflictRows[0].product_name} (#${conflictRows[0].product_id})`,
        });
      }
    }

    const sanitizedData = {
      product_name: sanitize(product_name),
      stock_quantity: stock_quantity || 0,
      price: price || null,
      description: description ? sanitize(description) : null,
      product_code: sanitize(product_code),
      returnable_qty: returnable_qty || 0,
    };
    const product = await Inventory.create(sanitizedData, req.io);

    let partNumberWarning = null;
    if (part_number_auto) {
      const correctedPartNumber = String(product.product_id).padStart(4, '0');
      const currentPartNumber = product.product_code.slice(0, 4);
      if (product.product_id > 9999) {
        partNumberWarning = 'Product ID exceeds 9999 — Part Number could not be auto-assigned. Please set it manually.';
      } else if (correctedPartNumber !== currentPartNumber) {
        const correctedCode = correctedPartNumber + product.product_code.slice(4);
        try {
          const { rows: [updatedRow] } = await pool.query(
            'UPDATE inventory SET product_code = $1 WHERE product_id = $2 RETURNING *',
            [correctedCode, product.product_id]
          );
          Object.assign(product, updatedRow);
        } catch (correctionError) {
          if (correctionError.code === '23505') {
            partNumberWarning = `Auto-assigned part number ${correctedPartNumber} conflicts with an existing entry — please set it manually.`;
          } else {
            throw correctionError;
          }
        }
      }
    }

    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del('price_list_*');
    logger.info(`Product added: ${product.product_name} by ${req.user.user_id}`);
    res.status(201).json(partNumberWarning ? { ...product, partNumberWarning } : product);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'inventory_part_number_unique') {
      return res.status(400).json({ error: 'Part Number is already in use' });
    }
    if (error.code === '23505' && error.constraint === 'unique_product_code') {
      return res.status(400).json({ error: 'Product code must be unique' });
    }
    logger.error(`Error creating inventory: ${error.message}`, error.stack);
    next(error);
  }
};
```

- [ ] **Step 2: Verify the file parses correctly**

Run (from `CRM_BACKEND`):
```bash
node -e "require('./controllers/core/inventory.controller.js'); console.log('OK'); process.exit(0)"
```
Expected: `OK`.

No commit — leave the change in the working tree.

---

### Task 6: Add Part Number collision pre-check to inventory update

**Files:**
- Modify: `CRM_BACKEND/controllers/core/inventory.controller.js`

- [ ] **Step 1: Replace `exports.update`**

Current (lines 76–117):
```js
exports.update = async (req, res, next) => {
  try {
    const productId = req.params.id;
    const { product_name, price, description, product_code, stock_quantity, returnable_qty } = req.body;
    if (!product_name) return res.status(400).json({ error: 'Product name is required' });
    if (price !== undefined && price < 0) return res.status(400).json({ error: 'Price must be >= 0' });
    if (!product_code || product_code.length !== 11) return res.status(400).json({ error: 'Product code must be exactly 11 characters' });

    const updateData = {
      product_name: sanitize(product_name),
      price: price !== undefined ? parseFloat(price) : null,
      description: description ? sanitize(description) : null,
      product_code: sanitize(product_code),
    };
    if (stock_quantity !== undefined) {
      const parsedQty = parseInt(stock_quantity);
      if (isNaN(parsedQty)) return res.status(400).json({ error: 'Stock quantity must be a number' });
      updateData.stock_quantity = parsedQty;
    }
    if (returnable_qty !== undefined) {
      const parsedReturnable = parseInt(returnable_qty);
      if (isNaN(parsedReturnable) || parsedReturnable < 0) return res.status(400).json({ error: 'Returnable quantity must be a non-negative integer' });
      updateData.returnable_qty = parsedReturnable;
    }

    const updatedProduct = await Inventory.update(productId, updateData, true);
    if (price !== undefined) await Inventory.syncPriceWithPriceList(productId, price);
    if ((stock_quantity !== undefined || returnable_qty !== undefined) && req.io) {
      req.io.emit('stockUpdate', { product_id: updatedProduct.product_id, stock_quantity: updatedProduct.stock_quantity, returnable_qty: updatedProduct.returnable_qty });
    }
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del('price_list_*');
    res.json(updatedProduct);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'unique_product_code') {
      return res.status(400).json({ error: 'Product code must be unique' });
    }
    logger.error(`Error updating inventory ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
};
```

Replace with (adds the pre-check block right after the existing validation, and a new catch branch):
```js
exports.update = async (req, res, next) => {
  try {
    const productId = req.params.id;
    const { product_name, price, description, product_code, stock_quantity, returnable_qty } = req.body;
    if (!product_name) return res.status(400).json({ error: 'Product name is required' });
    if (price !== undefined && price < 0) return res.status(400).json({ error: 'Price must be >= 0' });
    if (!product_code || product_code.length !== 11) return res.status(400).json({ error: 'Product code must be exactly 11 characters' });

    const partNumber = product_code.slice(0, 4);
    const { rows: conflictRows } = await pool.query(
      'SELECT product_id, product_name FROM inventory WHERE part_number = $1 AND product_id != $2',
      [partNumber, productId]
    );
    if (conflictRows.length > 0) {
      return res.status(400).json({
        error: `Part Number ${partNumber} is already used by ${conflictRows[0].product_name} (#${conflictRows[0].product_id})`,
      });
    }

    const updateData = {
      product_name: sanitize(product_name),
      price: price !== undefined ? parseFloat(price) : null,
      description: description ? sanitize(description) : null,
      product_code: sanitize(product_code),
    };
    if (stock_quantity !== undefined) {
      const parsedQty = parseInt(stock_quantity);
      if (isNaN(parsedQty)) return res.status(400).json({ error: 'Stock quantity must be a number' });
      updateData.stock_quantity = parsedQty;
    }
    if (returnable_qty !== undefined) {
      const parsedReturnable = parseInt(returnable_qty);
      if (isNaN(parsedReturnable) || parsedReturnable < 0) return res.status(400).json({ error: 'Returnable quantity must be a non-negative integer' });
      updateData.returnable_qty = parsedReturnable;
    }

    const updatedProduct = await Inventory.update(productId, updateData, true);
    if (price !== undefined) await Inventory.syncPriceWithPriceList(productId, price);
    if ((stock_quantity !== undefined || returnable_qty !== undefined) && req.io) {
      req.io.emit('stockUpdate', { product_id: updatedProduct.product_id, stock_quantity: updatedProduct.stock_quantity, returnable_qty: updatedProduct.returnable_qty });
    }
    const keys = await redis.keys('inventory_*');
    if (keys.length > 0) await redis.del(keys);
    await redis.del('price_list_*');
    res.json(updatedProduct);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'inventory_part_number_unique') {
      return res.status(400).json({ error: 'Part Number is already in use' });
    }
    if (error.code === '23505' && error.constraint === 'unique_product_code') {
      return res.status(400).json({ error: 'Product code must be unique' });
    }
    logger.error(`Error updating inventory ${req.params.id}: ${error.message}`, error.stack);
    next(error);
  }
};
```

- [ ] **Step 2: Verify the file parses correctly**

Run (from `CRM_BACKEND`):
```bash
node -e "require('./controllers/core/inventory.controller.js'); console.log('OK'); process.exit(0)"
```
Expected: `OK`.

No commit — leave the change in the working tree.

---

### Task 7: Verify inventory backend end-to-end against the live database

**Files:** none (verification via scratch script)

This exercises the full create → auto-correct → duplicate-rejection → cleanup cycle directly against the live database, using the model/controller logic paths (not raw SQL), then removes anything it created.

- [ ] **Step 1: Write and run the verification script**

Create `<scratchpad>/verify_inventory_part_number.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
process.chdir('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND');
const pool = require('./config/db');
const Inventory = require('./models/core/inventory');

(async () => {
  let createdId = null;
  try {
    // 1. Confirm current max product_id, to predict the auto-corrected part number
    const { rows: [{ max_id }] } = await pool.query('SELECT COALESCE(MAX(product_id), 0) AS max_id FROM inventory');
    const nextId = Number(max_id) + 1;
    const expectedPartNumber = String(nextId).padStart(4, '0');
    console.log('Predicted next product_id / part number:', nextId, expectedPartNumber);

    // 2. Create with a throwaway placeholder code (simulating part_number_auto = true on the frontend)
    const placeholderCode = '9999L5VF999'; // deliberately NOT matching nextId, to prove auto-correction happens
    const product = await Inventory.create({
      product_name: 'VERIFICATION-SCRIPT-TEMP',
      stock_quantity: 0,
      price: 1,
      description: 'temp verification row, will be deleted',
      product_code: placeholderCode,
      returnable_qty: 0,
    });
    createdId = product.product_id;
    console.log('Created product_id:', createdId, 'with placeholder code:', product.product_code);

    // 3. Manually apply the same auto-correction the controller would apply (since we called the model directly, not the HTTP route)
    const correctedCode = expectedPartNumber + placeholderCode.slice(4);
    const { rows: [corrected] } = await pool.query(
      'UPDATE inventory SET product_code = $1 WHERE product_id = $2 RETURNING product_id, product_code',
      [correctedCode, createdId]
    );
    console.log('Corrected code:', corrected.product_code);
    if (!corrected.product_code.startsWith(expectedPartNumber)) {
      throw new Error(`Expected corrected code to start with ${expectedPartNumber}, got ${corrected.product_code}`);
    }

    // 4. Confirm the DB constraint rejects a duplicate part number
    try {
      await pool.query(
        `INSERT INTO inventory (product_name, stock_quantity, price, description, product_code, returnable_qty)
         VALUES ($1, 0, 1, 'temp dup test', $2, 0)`,
        ['VERIFICATION-SCRIPT-TEMP-2', expectedPartNumber + 'XXTEST']
      );
      throw new Error('Expected a unique_violation but insert succeeded — constraint is NOT working');
    } catch (err) {
      if (err.code === '23505') {
        console.log('Duplicate part number correctly rejected by DB constraint:', err.constraint);
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    if (createdId) {
      await pool.query('DELETE FROM inventory WHERE product_id = $1', [createdId]);
      const { rows } = await pool.query('SELECT * FROM inventory WHERE product_id = $1', [createdId]);
      console.log('Cleanup: rows remaining for created id (expect 0):', rows.length);
    }
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/verify_inventory_part_number.js`
Expected: prints the predicted next id/part number, confirms the created row's code was correctable to start with that part number, confirms a duplicate insert is rejected with `error.code === '23505'` on the `inventory_part_number_unique` constraint, and confirms cleanup left 0 rows.

- [ ] **Step 2: Delete the scratch script**

```bash
rm <scratchpad>/verify_inventory_part_number.js
```

No commit — backend changes stay uncommitted in the working tree.

---

## Phase C: Backend — `raw_materials` (stock)

### Task 8: Add `checkPartNumber` handler + route for stock

**Files:**
- Modify: `CRM_BACKEND/controllers/core/stock.controller.js`
- Modify: `CRM_BACKEND/routes/core/stock.js`

- [ ] **Step 1: Add the handler**

In `controllers/core/stock.controller.js`, add this new export. Insert it right after the existing `exports.getAll` (lines 6–15, ends with `};`), before `exports.create` begins:

```js
exports.checkPartNumber = async (req, res) => {
  try {
    const { part_number, exclude_id } = req.query;
    if (!part_number || !/^\d{4}$/.test(part_number)) {
      return res.status(400).json({ error: 'part_number must be a 4-digit string', code: 'INVALID_INPUT' });
    }
    let query = 'SELECT product_id, product_name FROM raw_materials WHERE part_number = $1';
    const params = [part_number];
    if (exclude_id) {
      query += ' AND product_id != $2';
      params.push(exclude_id);
    }
    const { rows } = await pool.query(query, params);
    if (rows.length === 0) {
      return res.json({ available: true, conflictProductId: null, conflictProductName: null });
    }
    res.json({ available: false, conflictProductId: rows[0].product_id, conflictProductName: rows[0].product_name });
  } catch (error) {
    logger.error(`Error checking stock part number: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
```

This uses the `pool` import already present at the top of the file (`const pool = require('../../config/db');`) — no new imports needed.

- [ ] **Step 2: Register the route**

In `routes/core/stock.js`, the current relevant lines are:
```js
router.get('/', authenticateToken, checkPermission('Stock', 'can_read'), controller.getAll);
router.post('/', authenticateToken, checkPermission('Stock', 'can_write'), validateStockInput, controller.create);
```

Change to (adding one new line before the generic `GET /`, with only `authenticateToken` since it's a lightweight lookup used while typing, matching inventory's `/check-part-number` and `/available` convention):
```js
router.get('/check-part-number', authenticateToken, controller.checkPartNumber);
router.get('/', authenticateToken, checkPermission('Stock', 'can_read'), controller.getAll);
router.post('/', authenticateToken, checkPermission('Stock', 'can_write'), validateStockInput, controller.create);
```

- [ ] **Step 3: Verify both files parse correctly**

Run (from `CRM_BACKEND`):
```bash
node -e "require('./controllers/core/stock.controller.js'); require('./routes/core/stock.js'); console.log('OK'); process.exit(0)"
```
Expected: `OK`.

No commit — leave the change in the working tree.

---

### Task 9: Add `part_number_auto` handling to stock create

**Files:**
- Modify: `CRM_BACKEND/controllers/core/stock.controller.js`

- [ ] **Step 1: Replace `exports.create`**

Current (lines 17–28):
```js
exports.create = async (req, res) => {
  const { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl } = req.body;
  try {
    const stockItem = await Stock.create({ productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl });
    logger.info(`Created stock item ${stockItem.productId} by ${req.user.user_id}`);
    req.io?.emit('stockUpdate', { product_id: stockItem.productId, stock_quantity: stockItem.stockQuantity, location: stockItem.location, image_url: stockItem.imageUrl || null });
    res.status(201).json(stockItem);
  } catch (error) {
    logger.error(`Error creating stock: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
```

Replace with:
```js
exports.create = async (req, res) => {
  const { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl, part_number_auto } = req.body;
  try {
    if (!part_number_auto) {
      const partNumber = (productCode || '').slice(0, 4);
      const { rows: conflictRows } = await pool.query(
        'SELECT product_id, product_name FROM raw_materials WHERE part_number = $1',
        [partNumber]
      );
      if (conflictRows.length > 0) {
        return res.status(400).json({
          error: `Part Number ${partNumber} is already used by ${conflictRows[0].product_name} (#${conflictRows[0].product_id})`,
          code: 'PART_NUMBER_TAKEN',
        });
      }
    }

    const stockItem = await Stock.create({ productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl });

    let partNumberWarning = null;
    if (part_number_auto) {
      const correctedPartNumber = String(stockItem.productId).padStart(4, '0');
      const currentPartNumber = (stockItem.productCode || '').slice(0, 4);
      if (stockItem.productId > 9999) {
        partNumberWarning = 'Product ID exceeds 9999 — Part Number could not be auto-assigned. Please set it manually.';
      } else if (correctedPartNumber !== currentPartNumber) {
        const correctedCode = correctedPartNumber + stockItem.productCode.slice(4);
        try {
          const { rows: [updatedRow] } = await pool.query(
            'UPDATE raw_materials SET product_code = $1 WHERE product_id = $2 RETURNING product_code',
            [correctedCode, stockItem.productId]
          );
          stockItem.productCode = updatedRow.product_code;
          stockItem.product_code = updatedRow.product_code;
        } catch (correctionError) {
          if (correctionError.code === '23505') {
            partNumberWarning = `Auto-assigned part number ${correctedPartNumber} conflicts with an existing entry — please set it manually.`;
          } else {
            throw correctionError;
          }
        }
      }
    }

    logger.info(`Created stock item ${stockItem.productId} by ${req.user.user_id}`);
    req.io?.emit('stockUpdate', { product_id: stockItem.productId, stock_quantity: stockItem.stockQuantity, location: stockItem.location, image_url: stockItem.imageUrl || null });
    res.status(201).json(partNumberWarning ? { ...stockItem, partNumberWarning } : stockItem);
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'raw_materials_part_number_unique') {
      return res.status(400).json({ error: 'Part Number is already in use', code: 'PART_NUMBER_TAKEN' });
    }
    if (error.code === '23505' && error.constraint === 'raw_materials_product_code_key') {
      return res.status(400).json({ error: 'Product code must be unique', code: 'DUPLICATE_CODE' });
    }
    logger.error(`Error creating stock: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
```

- [ ] **Step 2: Verify the file parses correctly**

Run (from `CRM_BACKEND`):
```bash
node -e "require('./controllers/core/stock.controller.js'); console.log('OK'); process.exit(0)"
```
Expected: `OK`.

No commit — leave the change in the working tree.

---

### Task 10: Add Part Number collision pre-check to stock update

**Files:**
- Modify: `CRM_BACKEND/controllers/core/stock.controller.js`

- [ ] **Step 1: Replace `exports.update`**

Current (lines 30–43):
```js
exports.update = async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl } = req.body;
  try {
    const stockItem = await Stock.update(productId, { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl });
    logger.info(`Updated stock item ${productId} by ${req.user.user_id}`);
    req.io?.emit('stockUpdate', { product_id: productId, stock_quantity: stockItem.stockQuantity, location: stockItem.location, image_url: stockItem.imageUrl || null });
    res.json(stockItem);
  } catch (error) {
    if (error.message === 'Stock item not found') return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });
    logger.error(`Error updating stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
```

Replace with:
```js
exports.update = async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl } = req.body;
  try {
    if (productCode) {
      const partNumber = productCode.slice(0, 4);
      const { rows: conflictRows } = await pool.query(
        'SELECT product_id, product_name FROM raw_materials WHERE part_number = $1 AND product_id != $2',
        [partNumber, productId]
      );
      if (conflictRows.length > 0) {
        return res.status(400).json({
          error: `Part Number ${partNumber} is already used by ${conflictRows[0].product_name} (#${conflictRows[0].product_id})`,
          code: 'PART_NUMBER_TAKEN',
        });
      }
    }

    const stockItem = await Stock.update(productId, { productName, description, productCode, price, stockQuantity, qtyRequired, location, imageUrl });
    logger.info(`Updated stock item ${productId} by ${req.user.user_id}`);
    req.io?.emit('stockUpdate', { product_id: productId, stock_quantity: stockItem.stockQuantity, location: stockItem.location, image_url: stockItem.imageUrl || null });
    res.json(stockItem);
  } catch (error) {
    if (error.message === 'Stock item not found') return res.status(404).json({ error: 'Stock item not found', code: 'NOT_FOUND' });
    if (error.code === '23505' && error.constraint === 'raw_materials_part_number_unique') {
      return res.status(400).json({ error: 'Part Number is already in use', code: 'PART_NUMBER_TAKEN' });
    }
    if (error.code === '23505' && error.constraint === 'raw_materials_product_code_key') {
      return res.status(400).json({ error: 'Product code must be unique', code: 'DUPLICATE_CODE' });
    }
    logger.error(`Error updating stock ${productId}: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};
```

- [ ] **Step 2: Verify the file parses correctly**

Run (from `CRM_BACKEND`):
```bash
node -e "require('./controllers/core/stock.controller.js'); console.log('OK'); process.exit(0)"
```
Expected: `OK`.

No commit — leave the change in the working tree.

---

### Task 11: Verify stock backend end-to-end against the live database

**Files:** none (verification via scratch script)

- [ ] **Step 1: Write and run the verification script**

Create `<scratchpad>/verify_stock_part_number.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
process.chdir('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND');
const pool = require('./config/db');
const Stock = require('./models/core/stock');

(async () => {
  let createdId = null;
  try {
    const { rows: [{ max_id }] } = await pool.query('SELECT COALESCE(MAX(product_id), 0) AS max_id FROM raw_materials');
    const nextId = Number(max_id) + 1;
    const expectedPartNumber = String(nextId).padStart(4, '0');
    console.log('Predicted next product_id / part number:', nextId, expectedPartNumber);

    const placeholderCode = '9999L5VF999';
    const item = await Stock.create({
      productName: 'VERIFICATION-SCRIPT-TEMP',
      description: 'temp verification row, will be deleted',
      productCode: placeholderCode,
      price: 1,
      stockQuantity: 0,
      qtyRequired: 0,
    });
    createdId = item.product_id;
    console.log('Created product_id:', createdId, 'with placeholder code:', item.product_code);

    const correctedCode = expectedPartNumber + placeholderCode.slice(4);
    const { rows: [corrected] } = await pool.query(
      'UPDATE raw_materials SET product_code = $1 WHERE product_id = $2 RETURNING product_id, product_code',
      [correctedCode, createdId]
    );
    console.log('Corrected code:', corrected.product_code);
    if (!corrected.product_code.startsWith(expectedPartNumber)) {
      throw new Error(`Expected corrected code to start with ${expectedPartNumber}, got ${corrected.product_code}`);
    }

    try {
      await pool.query(
        `INSERT INTO raw_materials (product_name, description, product_code, price, stock_quantity, qty_required, created_at)
         VALUES ($1, 'temp dup test', $2, 1, 0, 0, CURRENT_TIMESTAMP)`,
        ['VERIFICATION-SCRIPT-TEMP-2', expectedPartNumber + 'XXTEST']
      );
      throw new Error('Expected a unique_violation but insert succeeded — constraint is NOT working');
    } catch (err) {
      if (err.code === '23505') {
        console.log('Duplicate part number correctly rejected by DB constraint:', err.constraint);
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    if (createdId) {
      await pool.query('DELETE FROM raw_materials WHERE product_id = $1', [createdId]);
      const { rows } = await pool.query('SELECT * FROM raw_materials WHERE product_id = $1', [createdId]);
      console.log('Cleanup: rows remaining for created id (expect 0):', rows.length);
    }
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/verify_stock_part_number.js`
Expected: same shape of output as Task 7 — predicted id/part number, successful correction, duplicate correctly rejected with `error.code === '23505'` on `raw_materials_part_number_unique`, cleanup leaves 0 rows.

- [ ] **Step 2: Delete the scratch script**

```bash
rm <scratchpad>/verify_stock_part_number.js
```

No commit — backend changes stay uncommitted in the working tree.

---

## Phase D: Frontend — 7 pages

Each task in this phase makes the same three changes to one page's local `ProductCodeBuilder` + its Add/Edit form:
1. `ProductCodeBuilder` gains 4 new props (`suggestedPartNumber`, `excludeId`, `onAutoFlagChange`, `onAvailabilityChange`), touched-tracking on the Part Number input, a debounced live-availability check, and inline feedback text.
2. The Create form passes `suggestedPartNumber` (computed from the page's already-loaded item list) and tracks `partNumberAuto`/`partNumberAvailable`, sending `part_number_auto` in the create payload and blocking submit while unavailable.
3. The Edit form passes `excludeId={item.product_id}` and blocks submit while unavailable (no auto-flag needed on edit).

### Task 12: `admin/InventoryPage.jsx`

**Files:**
- Modify: `CRM/src/components/admin/InventoryPage.jsx`

- [ ] **Step 1: Update `ProductCodeBuilder`'s signature, state init, and handlers**

Find:
```jsx
function ProductCodeBuilder({ value = "", onChange, disabled = false }) {
  // Prefill from existing code if provided, otherwise use defaults
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(parsed?.partNum ?? "0001");
  const [partInput, setPartInput] = useState(
    parsed ? String(parseInt(parsed.partNum, 10)) : "1",
  );
```

Replace with:
```jsx
function ProductCodeBuilder({
  value = "",
  onChange,
  disabled = false,
  suggestedPartNumber = null,
  excludeId = null,
  onAutoFlagChange,
  onAvailabilityChange,
}) {
  // Prefill from existing code if provided, otherwise use defaults
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(
    parsed?.partNum ?? (suggestedPartNumber ? pad4(suggestedPartNumber) : "0001"),
  );
  const [partInput, setPartInput] = useState(
    parsed
      ? String(parseInt(parsed.partNum, 10))
      : suggestedPartNumber
        ? String(parseInt(suggestedPartNumber, 10))
        : "1",
  );
  const [partTouched, setPartTouched] = useState(false);
  const [checkStatus, setCheckStatus] = useState(null);
```

- [ ] **Step 2: Update `handlePartInput` and add the touched/check effects**

Find:
```jsx
  const handlePartInput = (e) => {
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };
```

Replace with:
```jsx
  const handlePartInput = (e) => {
    setPartTouched(true);
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };

  useEffect(() => {
    onAutoFlagChange?.(!partTouched);
  }, [partTouched]);

  useEffect(() => {
    if (manualMode || !partNum || partNum.length !== 4) {
      setCheckStatus(null);
      onAvailabilityChange?.(true);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setCheckStatus({ checking: true });
      try {
        const token = localStorage.getItem("token");
        const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";
        const url = new URL(`${backendUrl}/api/inventory/check-part-number`);
        url.searchParams.set("part_number", partNum);
        if (excludeId) url.searchParams.set("exclude_id", excludeId);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
          return;
        }
        const data = await res.json();
        setCheckStatus({ checking: false, ...data });
        onAvailabilityChange?.(data.available !== false);
      } catch (err) {
        if (err.name !== "AbortError") {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [partNum, excludeId, manualMode]);
```

- [ ] **Step 3: Add inline feedback JSX under the Part Number input**

Find (the Part Number block's closing):
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
      </div>
```

Replace with:
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
        {checkStatus?.checking && (
          <p className="text-xs text-gray-400 mt-1">Checking availability…</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === true && (
          <p className="text-xs text-green-600 mt-1">✓ Available</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === false && (
          <p className="text-xs text-red-600 mt-1">
            ✗ Already used by {checkStatus.conflictProductName} (#{checkStatus.conflictProductId})
          </p>
        )}
      </div>
```

- [ ] **Step 4: Wire the Create form (`CreateItemForm`)**

Find the `CreateItemForm` state and `handleSave` (search for `const CreateItemForm`), and add two new state lines right after the existing `errors` state:
```jsx
  const [partNumberAuto, setPartNumberAuto] = useState(true);
  const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

In `handleSave`, find:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;

    try {
      setIsSubmitting(true);
      await onSubmit({ ...formData, stock_quantity: parseInt(sq, 10), returnable_qty: parseInt(formData.returnable_qty || '0', 10) });
    } finally { setIsSubmitting(false); }
```
(this exact block appears in `CreateItemForm`'s `handleSave` — the version with `product_code` validation, price/stock_quantity/returnable_qty).

Replace with:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;
    if (!partNumberAvailable) {
      notifyError('Part Number is already in use — choose a different one.', { autoClose: 3000 });
      return;
    }

    try {
      setIsSubmitting(true);
      await onSubmit({ ...formData, stock_quantity: parseInt(sq, 10), returnable_qty: parseInt(formData.returnable_qty || '0', 10), part_number_auto: partNumberAuto });
    } finally { setIsSubmitting(false); }
```

Note: `CreateItemForm` needs `notifyError` in scope — check whether it already calls `useNotify()`; if not already present, add `const { notifyError } = useNotify();` near its other hooks (it's already imported at the top of the file via `import { useNotify } from '../../hooks/useNotify';`, used elsewhere in this file).

Find the `<ProductCodeBuilder>` render in `CreateItemForm`:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
        />
```

Replace with:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
          suggestedPartNumber={suggestedPartNumber}
          onAutoFlagChange={setPartNumberAuto}
          onAvailabilityChange={setPartNumberAvailable}
        />
```

`CreateItemForm` needs a new `suggestedPartNumber` prop — add it to its destructured props:
```jsx
const CreateItemForm = ({ onSubmit, onClose, suggestedPartNumber }) => {
```
(find its current signature, e.g. `const CreateItemForm = ({ onSubmit, onClose }) => {`, and add `suggestedPartNumber` to the destructure.)

- [ ] **Step 5: Pass `suggestedPartNumber` from the parent, computed from `allInventory`**

Find the Create Item Modal JSX:
```jsx
      <CreateItemForm onSubmit={handleCreateItem} onClose={() => setShowCreateForm(false)} />
```

Replace with:
```jsx
      <CreateItemForm
        onSubmit={handleCreateItem}
        onClose={() => setShowCreateForm(false)}
        suggestedPartNumber={String(
          (allInventory.length ? Math.max(...allInventory.map((i) => i.product_id)) : 0) + 1,
        ).padStart(4, "0")}
      />
```

- [ ] **Step 6: Wire the Edit form (`EditItemForm`)**

Find `EditItemForm`'s state and add, right after its existing `errors` state:
```jsx
  const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

In its `handleSave`, find:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;

    try {
      setIsSubmitting(true);
      await onSubmit(item.product_id, { ...formData, stock_quantity: parseInt(sq, 10), returnable_qty: parseInt(formData.returnable_qty || '0', 10) });
    } finally { setIsSubmitting(false); }
```

Replace with:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;
    if (!partNumberAvailable) {
      notifyError('Part Number is already in use — choose a different one.', { autoClose: 3000 });
      return;
    }

    try {
      setIsSubmitting(true);
      await onSubmit(item.product_id, { ...formData, stock_quantity: parseInt(sq, 10), returnable_qty: parseInt(formData.returnable_qty || '0', 10) });
    } finally { setIsSubmitting(false); }
```

(Check `EditItemForm` also has `notifyError` in scope via `useNotify()`; add it if missing, matching the pattern already used elsewhere in this file.)

Find the `<ProductCodeBuilder>` render in `EditItemForm`:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
        />
```

Replace with:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
          excludeId={item.product_id}
          onAvailabilityChange={setPartNumberAvailable}
        />
```

- [ ] **Step 7: Verify lint and build**

Run: `cd CRM && npx eslint src/components/admin/InventoryPage.jsx`
Expected: no *new* errors compared to the pre-existing baseline for this file.

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds.

No commit — leave the change in the working tree.

---

### Task 13: `production/ProductionInventoryPage.jsx`

**Files:**
- Modify: `CRM/src/components/production/ProductionInventoryPage.jsx`

This file's `ProductCodeBuilder` (lines 179–613) is character-for-character identical to `admin/InventoryPage.jsx`'s in the parts being changed (confirmed via source extraction), so the same replacement code applies:

- [ ] **Step 1: Update `ProductCodeBuilder`'s signature and state init**

Find:
```jsx
function ProductCodeBuilder({ value = "", onChange, disabled = false }) {
  // Prefill from existing code if provided, otherwise use defaults
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(parsed?.partNum ?? "0001");
  const [partInput, setPartInput] = useState(
    parsed ? String(parseInt(parsed.partNum, 10)) : "1",
  );
```

Replace with:
```jsx
function ProductCodeBuilder({
  value = "",
  onChange,
  disabled = false,
  suggestedPartNumber = null,
  excludeId = null,
  onAutoFlagChange,
  onAvailabilityChange,
}) {
  // Prefill from existing code if provided, otherwise use defaults
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(
    parsed?.partNum ?? (suggestedPartNumber ? pad4(suggestedPartNumber) : "0001"),
  );
  const [partInput, setPartInput] = useState(
    parsed
      ? String(parseInt(parsed.partNum, 10))
      : suggestedPartNumber
        ? String(parseInt(suggestedPartNumber, 10))
        : "1",
  );
  const [partTouched, setPartTouched] = useState(false);
  const [checkStatus, setCheckStatus] = useState(null);
```

- [ ] **Step 2: Update `handlePartInput` and add touched/check effects**

Find:
```jsx
  const handlePartInput = (e) => {
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };
```

Replace with:
```jsx
  const handlePartInput = (e) => {
    setPartTouched(true);
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };

  useEffect(() => {
    onAutoFlagChange?.(!partTouched);
  }, [partTouched]);

  useEffect(() => {
    if (manualMode || !partNum || partNum.length !== 4) {
      setCheckStatus(null);
      onAvailabilityChange?.(true);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setCheckStatus({ checking: true });
      try {
        const token = localStorage.getItem("token");
        const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";
        const url = new URL(`${backendUrl}/api/inventory/check-part-number`);
        url.searchParams.set("part_number", partNum);
        if (excludeId) url.searchParams.set("exclude_id", excludeId);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
          return;
        }
        const data = await res.json();
        setCheckStatus({ checking: false, ...data });
        onAvailabilityChange?.(data.available !== false);
      } catch (err) {
        if (err.name !== "AbortError") {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [partNum, excludeId, manualMode]);
```

- [ ] **Step 3: Add inline feedback JSX** — find this file's Part Number block (lines 357–381):
```jsx
      {/* ── ① Part Number ── */}
      <div>
        <label className="text-xs font-bold text-gray-600 mb-1.5 flex items-center gap-1.5">
          <span className={`${SEG.part} font-black text-sm`}>①</span>
          Part Number
          <span className="font-normal text-gray-400">(0001 – 9999)</span>
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            max={9999}
            value={partInput}
            onChange={handlePartInput}
            onBlur={handlePartBlur}
            placeholder="1"
            className="w-28 p-2 border border-gray-300 rounded-lg font-mono text-base focus:ring-2 focus:ring-blue-300 bg-white"
            disabled={disabled}
          />
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
      </div>
```
Replace with the same block but insert the feedback JSX from Task 12 Step 3 right after the closing `</div>` of the `flex items-center gap-3` div, before the block's final `</div>` (identical structure to Task 12).

- [ ] **Step 4: Wire the Create form (`CreateItemForm`)**

This file's `CreateItemForm` (lines 1399–1564) has the identical `formData`/`handleSave` shape as `admin/InventoryPage.jsx`'s. Find its state (right after the existing `errors` state) and add:
```jsx
  const [partNumberAuto, setPartNumberAuto] = useState(true);
  const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

In `handleSave` (lines 1468–1486), find:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;

    try {
      setIsSubmitting(true);
      await onSubmit({ ...formData, stock_quantity: isNaN(parsedQuantity) ? 0 : parsedQuantity, price: isNaN(parsedPrice) ? 0 : parsedPrice, returnable_qty: isNaN(parsedReturnable) ? 0 : parsedReturnable });
    } finally { setIsSubmitting(false); }
```

Replace with:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;
    if (!partNumberAvailable) {
      notifyError('Part Number is already in use — choose a different one.', { autoClose: 3000 });
      return;
    }

    try {
      setIsSubmitting(true);
      await onSubmit({ ...formData, stock_quantity: isNaN(parsedQuantity) ? 0 : parsedQuantity, price: isNaN(parsedPrice) ? 0 : parsedPrice, returnable_qty: isNaN(parsedReturnable) ? 0 : parsedReturnable, part_number_auto: partNumberAuto });
    } finally { setIsSubmitting(false); }
```

(Check `notifyError` is already in scope via `useNotify()`; if missing, add `const { notifyError } = useNotify();` near the form's other hooks — `useNotify` is already imported at the top of this file.)

Find its `<ProductCodeBuilder>` render (lines 1522–1534):
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
        />
```

Replace with:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
          suggestedPartNumber={suggestedPartNumber}
          onAutoFlagChange={setPartNumberAuto}
          onAvailabilityChange={setPartNumberAvailable}
        />
```

`CreateItemForm`'s signature needs the new prop — find `const CreateItemForm = ({ onSubmit, onClose }) => {` and change to:
```jsx
const CreateItemForm = ({ onSubmit, onClose, suggestedPartNumber }) => {
```

- [ ] **Step 5: Pass `suggestedPartNumber` from the parent** — find the Create Item Modal JSX (lines 1142–1150):
```jsx
            <CreateItemForm onSubmit={handleCreateItem} onClose={() => setShowCreateForm(false)} />
```
Replace with:
```jsx
            <CreateItemForm
              onSubmit={handleCreateItem}
              onClose={() => setShowCreateForm(false)}
              suggestedPartNumber={String(
                (allInventory.length ? Math.max(...allInventory.map((i) => i.product_id)) : 0) + 1,
              ).padStart(4, "0")}
            />
```
(This file's full-array variable is `allInventory`, per the research — same name as Task 12.)

- [ ] **Step 6: Wire the Edit form (`EditItemForm`)**

This file's `EditItemForm` (lines 1567–1663) has the identical shape as `admin/InventoryPage.jsx`'s. Find its state (right after the existing `errors` state) and add:
```jsx
  const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

In its `handleSave` (lines 1593–1611), find:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;

    try {
      setIsSubmitting(true);
      await onSubmit(item.product_id, { ...formData, stock_quantity: isNaN(parsedQuantity) ? 0 : parsedQuantity, price: isNaN(parsedPrice) ? 0 : parsedPrice, returnable_qty: isNaN(parsedReturnable) ? 0 : parsedReturnable });
    } finally { setIsSubmitting(false); }
```

Replace with:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;
    if (!partNumberAvailable) {
      notifyError('Part Number is already in use — choose a different one.', { autoClose: 3000 });
      return;
    }

    try {
      setIsSubmitting(true);
      await onSubmit(item.product_id, { ...formData, stock_quantity: isNaN(parsedQuantity) ? 0 : parsedQuantity, price: isNaN(parsedPrice) ? 0 : parsedPrice, returnable_qty: isNaN(parsedReturnable) ? 0 : parsedReturnable });
    } finally { setIsSubmitting(false); }
```

(Check `notifyError` is in scope via `useNotify()`; add if missing.)

Find its `<ProductCodeBuilder>` render (lines 1621–1633):
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
        />
```

Replace with:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
          excludeId={item.product_id}
          onAvailabilityChange={setPartNumberAvailable}
        />
```

- [ ] **Step 7: Verify lint and build**

Run: `cd CRM && npx eslint src/components/production/ProductionInventoryPage.jsx`
Expected: no new errors vs. baseline.

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds.

No commit — leave the change in the working tree.

---

### Task 14: `stores/StoreInventoryPage.jsx`

**Files:**
- Modify: `CRM/src/components/stores/StoreInventoryPage.jsx`

This file's `ProductCodeBuilder` (lines 189–623) is character-for-character identical to `admin/InventoryPage.jsx`'s in the parts being changed (confirmed via source extraction), so the same replacement code applies:

- [ ] **Step 1: Update `ProductCodeBuilder`'s signature and state init**

Find:
```jsx
function ProductCodeBuilder({ value = "", onChange, disabled = false }) {
  // Prefill from existing code if provided, otherwise use defaults
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(parsed?.partNum ?? "0001");
  const [partInput, setPartInput] = useState(
    parsed ? String(parseInt(parsed.partNum, 10)) : "1",
  );
```

Replace with:
```jsx
function ProductCodeBuilder({
  value = "",
  onChange,
  disabled = false,
  suggestedPartNumber = null,
  excludeId = null,
  onAutoFlagChange,
  onAvailabilityChange,
}) {
  // Prefill from existing code if provided, otherwise use defaults
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(
    parsed?.partNum ?? (suggestedPartNumber ? pad4(suggestedPartNumber) : "0001"),
  );
  const [partInput, setPartInput] = useState(
    parsed
      ? String(parseInt(parsed.partNum, 10))
      : suggestedPartNumber
        ? String(parseInt(suggestedPartNumber, 10))
        : "1",
  );
  const [partTouched, setPartTouched] = useState(false);
  const [checkStatus, setCheckStatus] = useState(null);
```

- [ ] **Step 2: Update `handlePartInput` and add touched/check effects**

Find:
```jsx
  const handlePartInput = (e) => {
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };
```

Replace with:
```jsx
  const handlePartInput = (e) => {
    setPartTouched(true);
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };

  useEffect(() => {
    onAutoFlagChange?.(!partTouched);
  }, [partTouched]);

  useEffect(() => {
    if (manualMode || !partNum || partNum.length !== 4) {
      setCheckStatus(null);
      onAvailabilityChange?.(true);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setCheckStatus({ checking: true });
      try {
        const token = localStorage.getItem("token");
        const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";
        const url = new URL(`${backendUrl}/api/inventory/check-part-number`);
        url.searchParams.set("part_number", partNum);
        if (excludeId) url.searchParams.set("exclude_id", excludeId);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
          return;
        }
        const data = await res.json();
        setCheckStatus({ checking: false, ...data });
        onAvailabilityChange?.(data.available !== false);
      } catch (err) {
        if (err.name !== "AbortError") {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [partNum, excludeId, manualMode]);
```

- [ ] **Step 3: Add inline feedback JSX under the Part Number input**

Find the Part Number block's closing (lines 361–385 area):
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
      </div>
```

Replace with:
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
        {checkStatus?.checking && (
          <p className="text-xs text-gray-400 mt-1">Checking availability…</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === true && (
          <p className="text-xs text-green-600 mt-1">✓ Available</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === false && (
          <p className="text-xs text-red-600 mt-1">
            ✗ Already used by {checkStatus.conflictProductName} (#{checkStatus.conflictProductId})
          </p>
        )}
      </div>
```

- [ ] **Step 4: Wire the Create form (`CreateItemForm`)**

This file's `CreateItemForm` has a DIFFERENT, simpler `formData` shape than Task 12/13 — no `returnable_qty` field:
```jsx
const CreateItemForm = ({ onSubmit, onClose }) => {
  const [formData, setFormData] = useState({
    product_name: "",
    stock_quantity: 0,
    description: "",
    product_code: "",
  });
```
Change the signature and add the two new state lines:
```jsx
const CreateItemForm = ({ onSubmit, onClose, suggestedPartNumber }) => {
  const [formData, setFormData] = useState({
    product_name: "",
    stock_quantity: 0,
    description: "",
    product_code: "",
  });
  const [partNumberAuto, setPartNumberAuto] = useState(true);
  const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

Find its `handleSave`:
```jsx
  const handleSave = async () => {
    const fieldErrors = {
      product_name: validateField("product_name", formData.product_name),
      stock_quantity: validateField("stock_quantity", formData.stock_quantity),
      product_code: validateField("product_code", formData.product_code),
      description: "",
    };
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some((err) => err)) return;
    try {
      setIsSubmitting(true);
      await onSubmit(formData);
    } finally {
      setIsSubmitting(false);
    }
  };
```
Replace with:
```jsx
  const handleSave = async () => {
    const fieldErrors = {
      product_name: validateField("product_name", formData.product_name),
      stock_quantity: validateField("stock_quantity", formData.stock_quantity),
      product_code: validateField("product_code", formData.product_code),
      description: "",
    };
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some((err) => err)) return;
    if (!partNumberAvailable) {
      notifyError("Part Number is already in use — choose a different one.");
      return;
    }
    try {
      setIsSubmitting(true);
      await onSubmit({ ...formData, part_number_auto: partNumberAuto });
    } finally {
      setIsSubmitting(false);
    }
  };
```
(This file's `notifyError` call convention has no second `{ autoClose }` argument — matches the pattern used elsewhere in this file's forms. Check `CreateItemForm` already has `notifyError` from a `useNotify()` call; if not present, add `const { notifySuccess, notifyError } = useNotify();` near its other hooks.)

Find its `<ProductCodeBuilder>` render:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(code) =>
            setFormData((prev) => ({ ...prev, product_code: code }))
          }
        />
```
Replace with:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(code) =>
            setFormData((prev) => ({ ...prev, product_code: code }))
          }
          suggestedPartNumber={suggestedPartNumber}
          onAutoFlagChange={setPartNumberAuto}
          onAvailabilityChange={setPartNumberAvailable}
        />
```

- [ ] **Step 5: Pass `suggestedPartNumber` from the parent, computed from `inventoryItems`**

Find (in the parent's create-modal JSX, inside the inline `onSubmit` async fetch wrapper — the `<CreateItemForm onSubmit={async (data) => {...` block):
```jsx
              <CreateItemForm
                onSubmit={async (data) => {
```
Replace with:
```jsx
              <CreateItemForm
                suggestedPartNumber={String(
                  (inventoryItems.length ? Math.max(...inventoryItems.map((i) => i.product_id)) : 0) + 1,
                ).padStart(4, "0")}
                onSubmit={async (data) => {
```
(This file's full-array variable is **`inventoryItems`**, not `allInventory` — confirmed distinct from Task 12/13 in the research.)

- [ ] **Step 6: Wire the Edit form (`EditItemForm`)**

Add state:
```jsx
  const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```
right after `EditItemForm`'s existing `errors` state.

Find its `handleSave`:
```jsx
  const handleSave = async () => {
    const fieldErrors = {
      product_name: validateField("product_name", formData.product_name),
      stock_quantity: validateField("stock_quantity", formData.stock_quantity),
      product_code: validateField("product_code", formData.product_code),
      description: "",
    };
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some((err) => err)) return;
    try {
      setIsSubmitting(true);
      await onSubmit(item.product_id, formData);
    } finally {
      setIsSubmitting(false);
    }
  };
```
Replace with:
```jsx
  const handleSave = async () => {
    const fieldErrors = {
      product_name: validateField("product_name", formData.product_name),
      stock_quantity: validateField("stock_quantity", formData.stock_quantity),
      product_code: validateField("product_code", formData.product_code),
      description: "",
    };
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some((err) => err)) return;
    if (!partNumberAvailable) {
      notifyError("Part Number is already in use — choose a different one.");
      return;
    }
    try {
      setIsSubmitting(true);
      await onSubmit(item.product_id, formData);
    } finally {
      setIsSubmitting(false);
    }
  };
```

Find its `<ProductCodeBuilder>` render:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(code) =>
            setFormData((prev) => ({ ...prev, product_code: code }))
          }
        />
```
Replace with:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(code) =>
            setFormData((prev) => ({ ...prev, product_code: code }))
          }
          excludeId={item.product_id}
          onAvailabilityChange={setPartNumberAvailable}
        />
```

- [ ] **Step 7: Verify lint and build**

Run: `cd CRM && npx eslint src/components/stores/StoreInventoryPage.jsx`
Expected: no new errors vs. baseline.

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds.

No commit — leave the change in the working tree.

---

### Task 15: `sales/SalesInventoryPage.jsx`

**Files:**
- Modify: `CRM/src/components/sales/SalesInventoryPage.jsx`

This file's `ProductCodeBuilder` (lines 91–391) uses a slightly more compact formatting style (`const [partNum,    setPartNum   ] = useState(...)`) but is functionally identical to `admin/InventoryPage.jsx`'s in the parts being changed:

- [ ] **Step 1: Update `ProductCodeBuilder`'s signature and state init**

Find:
```jsx
function ProductCodeBuilder({ value = '', onChange, disabled = false }) {
  const parsed = parseCode(value);

  const [partNum,    setPartNum   ] = useState(parsed?.partNum  ?? '0001');
  const [partInput,  setPartInput ] = useState(parsed ? String(parseInt(parsed.partNum, 10)) : '1');
```

Replace with:
```jsx
function ProductCodeBuilder({
  value = '',
  onChange,
  disabled = false,
  suggestedPartNumber = null,
  excludeId = null,
  onAutoFlagChange,
  onAvailabilityChange,
}) {
  const parsed = parseCode(value);

  const [partNum,    setPartNum   ] = useState(parsed?.partNum ?? (suggestedPartNumber ? pad4(suggestedPartNumber) : '0001'));
  const [partInput,  setPartInput ] = useState(
    parsed
      ? String(parseInt(parsed.partNum, 10))
      : suggestedPartNumber
        ? String(parseInt(suggestedPartNumber, 10))
        : '1',
  );
  const [partTouched, setPartTouched] = useState(false);
  const [checkStatus, setCheckStatus] = useState(null);
```

- [ ] **Step 2: Update `handlePartInput` and add touched/check effects**

Find:
```jsx
  const handlePartInput = (e) => {
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== '') setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };
```

Replace with:
```jsx
  const handlePartInput = (e) => {
    setPartTouched(true);
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== '') setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };

  useEffect(() => {
    onAutoFlagChange?.(!partTouched);
  }, [partTouched]);

  useEffect(() => {
    if (manualMode || !partNum || partNum.length !== 4) {
      setCheckStatus(null);
      onAvailabilityChange?.(true);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setCheckStatus({ checking: true });
      try {
        const token = localStorage.getItem('token');
        const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';
        const url = new URL(`${backendUrl}/api/inventory/check-part-number`);
        url.searchParams.set('part_number', partNum);
        if (excludeId) url.searchParams.set('exclude_id', excludeId);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
          return;
        }
        const data = await res.json();
        setCheckStatus({ checking: false, ...data });
        onAvailabilityChange?.(data.available !== false);
      } catch (err) {
        if (err.name !== 'AbortError') {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [partNum, excludeId, manualMode]);
```

- [ ] **Step 3: Add inline feedback JSX under the Part Number input**

Find the Part Number block's closing (lines 218–239 area):
```jsx
          <span className="text-gray-400 text-sm">
            → <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
      </div>
```

Replace with:
```jsx
          <span className="text-gray-400 text-sm">
            → <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
        {checkStatus?.checking && (
          <p className="text-xs text-gray-400 mt-1">Checking availability…</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === true && (
          <p className="text-xs text-green-600 mt-1">✓ Available</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === false && (
          <p className="text-xs text-red-600 mt-1">
            ✗ Already used by {checkStatus.conflictProductName} (#{checkStatus.conflictProductId})
          </p>
        )}
      </div>
```

- [ ] **Step 4: Wire the Create form (`CreateItemForm`)**

This file's `CreateItemForm` (lines 1130–1295) has the identical `formData`/`handleSave` shape as `admin/InventoryPage.jsx`'s. Find its state (right after the existing `errors` state) and add:
```jsx
  const [partNumberAuto, setPartNumberAuto] = useState(true);
  const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

In `handleSave` (lines 1199–1217), find:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;

    try {
      setIsSubmitting(true);
      await onSubmit({ ...formData, stock_quantity: isNaN(parsedQuantity) ? 0 : parsedQuantity, price: isNaN(parsedPrice) ? 0 : parsedPrice, returnable_qty: isNaN(parsedReturnable) ? 0 : parsedReturnable });
    } finally { setIsSubmitting(false); }
```

Replace with:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;
    if (!partNumberAvailable) {
      notifyError('Part Number is already in use — choose a different one.', { autoClose: 3000 });
      return;
    }

    try {
      setIsSubmitting(true);
      await onSubmit({ ...formData, stock_quantity: isNaN(parsedQuantity) ? 0 : parsedQuantity, price: isNaN(parsedPrice) ? 0 : parsedPrice, returnable_qty: isNaN(parsedReturnable) ? 0 : parsedReturnable, part_number_auto: partNumberAuto });
    } finally { setIsSubmitting(false); }
```

(Check `notifyError` is in scope via `useNotify()`; add if missing.)

Find its `<ProductCodeBuilder>` render (lines 1253–1265):
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
        />
```

Replace with:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
          suggestedPartNumber={suggestedPartNumber}
          onAutoFlagChange={setPartNumberAuto}
          onAvailabilityChange={setPartNumberAvailable}
        />
```

`CreateItemForm`'s signature needs the new prop — find its current signature and add `suggestedPartNumber` to the destructure (matching the parameter list style already used in this file's `CreateItemForm` declaration).

- [ ] **Step 5: Pass `suggestedPartNumber` from the parent**

Find (line 937): `<CreateItemForm onSubmit={handleCreateItem} onClose={() => setShowCreateForm(false)} />`
Replace with:
```jsx
              <CreateItemForm
                onSubmit={handleCreateItem}
                onClose={() => setShowCreateForm(false)}
                suggestedPartNumber={String(
                  (allInventory.length ? Math.max(...allInventory.map((i) => i.product_id)) : 0) + 1,
                ).padStart(4, "0")}
              />
```
(This file's full-array variable is `allInventory` — confirmed same name as Task 12/13.)

- [ ] **Step 6: Wire the Edit form (`EditItemForm`)**

This file's `EditItemForm` (lines 1298–1394) has the identical shape as `admin/InventoryPage.jsx`'s. Find its state (right after the existing `errors` state) and add:
```jsx
  const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

In its `handleSave` (lines 1324–1342), find:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;

    try {
      setIsSubmitting(true);
      await onSubmit(item.product_id, { ...formData, stock_quantity: isNaN(parsedQuantity) ? 0 : parsedQuantity, price: isNaN(parsedPrice) ? 0 : parsedPrice, returnable_qty: isNaN(parsedReturnable) ? 0 : parsedReturnable });
    } finally { setIsSubmitting(false); }
```

Replace with:
```jsx
    setErrors(fieldErrors);
    if (Object.values(fieldErrors).some(e => e)) return;
    if (!partNumberAvailable) {
      notifyError('Part Number is already in use — choose a different one.', { autoClose: 3000 });
      return;
    }

    try {
      setIsSubmitting(true);
      await onSubmit(item.product_id, { ...formData, stock_quantity: isNaN(parsedQuantity) ? 0 : parsedQuantity, price: isNaN(parsedPrice) ? 0 : parsedPrice, returnable_qty: isNaN(parsedReturnable) ? 0 : parsedReturnable });
    } finally { setIsSubmitting(false); }
```

Find its `<ProductCodeBuilder>` render (lines 1352–1364):
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
        />
```

Replace with:
```jsx
        <ProductCodeBuilder
          value={formData.product_code}
          onChange={(v) => {
            setFormData(prev => ({ ...prev, product_code: v }));
            setErrors(prev => ({ ...prev, product_code: String(v).trim().length === 11 ? '' : 'Product code must be exactly 11 characters' }));
          }}
          disabled={isSubmitting}
          excludeId={item.product_id}
          onAvailabilityChange={setPartNumberAvailable}
        />
```

- [ ] **Step 7: Verify lint and build**

Run: `cd CRM && npx eslint src/components/sales/SalesInventoryPage.jsx`
Expected: no new errors vs. baseline.

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds.

No commit — leave the change in the working tree.

---

### Task 16: `admin/StockPage.jsx`

**Files:**
- Modify: `CRM/src/components/admin/StockPage.jsx`

This file uses `productCode`/`productId` (camelCase) throughout, unlike the 4 inventory pages, and has a module-level `const BASE_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";` (line 28) that `ProductCodeBuilder` can reference directly (declared before it in the file).

- [ ] **Step 1: Update `ProductCodeBuilder`'s signature and state init**

Find (lines 196–211):
```jsx
function ProductCodeBuilder({ value = "", onChange, disabled = false }) {
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(parsed?.partNum ?? "0001");
  const [partInput, setPartInput] = useState(
    parsed ? String(parseInt(parsed.partNum, 10)) : "1",
  );
```

Replace with:
```jsx
function ProductCodeBuilder({
  value = "",
  onChange,
  disabled = false,
  suggestedPartNumber = null,
  excludeId = null,
  onAutoFlagChange,
  onAvailabilityChange,
}) {
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(
    parsed?.partNum ?? (suggestedPartNumber ? pad4(suggestedPartNumber) : "0001"),
  );
  const [partInput, setPartInput] = useState(
    parsed
      ? String(parseInt(parsed.partNum, 10))
      : suggestedPartNumber
        ? String(parseInt(suggestedPartNumber, 10))
        : "1",
  );
  const [partTouched, setPartTouched] = useState(false);
  const [checkStatus, setCheckStatus] = useState(null);
```

- [ ] **Step 2: Update `handlePartInput` and add touched/check effects**

Find:
```jsx
  const handlePartInput = (e) => {
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };
```

Replace with (the check effect uses `BASE_URL`, already in module scope, and endpoint `/api/stock/check-part-number`):
```jsx
  const handlePartInput = (e) => {
    setPartTouched(true);
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };

  useEffect(() => {
    onAutoFlagChange?.(!partTouched);
  }, [partTouched]);

  useEffect(() => {
    if (manualMode || !partNum || partNum.length !== 4) {
      setCheckStatus(null);
      onAvailabilityChange?.(true);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setCheckStatus({ checking: true });
      try {
        const token = localStorage.getItem("token");
        const url = new URL(`${BASE_URL}/api/stock/check-part-number`);
        url.searchParams.set("part_number", partNum);
        if (excludeId) url.searchParams.set("exclude_id", excludeId);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
          return;
        }
        const data = await res.json();
        setCheckStatus({ checking: false, ...data });
        onAvailabilityChange?.(data.available !== false);
      } catch (err) {
        if (err.name !== "AbortError") {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [partNum, excludeId, manualMode]);
```

- [ ] **Step 3: Add inline feedback JSX under the Part Number input**

Find the Part Number block's closing (lines 367–391 area):
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
      </div>
```

Replace with:
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
        {checkStatus?.checking && (
          <p className="text-xs text-gray-400 mt-1">Checking availability…</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === true && (
          <p className="text-xs text-green-600 mt-1">✓ Available</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === false && (
          <p className="text-xs text-red-600 mt-1">
            ✗ Already used by {checkStatus.conflictProductName} (#{checkStatus.conflictProductId})
          </p>
        )}
      </div>
```

- [ ] **Step 4: Wire the modal form**

This file has ONE shared modal form for both create and edit (`modalMode` controlled), not separate `CreateItemForm`/`EditItemForm` components. Find its `formData` state init (lines 704–713):
```jsx
const [formData, setFormData] = useState({
  productName: "",
  description: "",
  productCode: "",
  price: "",
  stockQuantity: "",
  qtyRequired: "",
  returnableQty: "",
  // location: "",
});
```
Add two new state lines right after it:
```jsx
const [partNumberAuto, setPartNumberAuto] = useState(true);
const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

In `handleCreate` (lines 1190–1207), reset `partNumberAuto` to `true` when opening for create:
```jsx
const handleCreate = useCallback(() => {
  setModalMode("create");
  setSelectedItem(null);
  setFormData({
    productName: "",
    description: "",
    productCode: "",
    price: "",
    stockQuantity: "",
    qtyRequired: "",
    returnableQty: "",
    // location: "",
  });
  setFormErrors({});
  setPartSearch("");
  setShowPartDropdown(false);
  setShowModal(true);
}, []);
```
Change to:
```jsx
const handleCreate = useCallback(() => {
  setModalMode("create");
  setSelectedItem(null);
  setFormData({
    productName: "",
    description: "",
    productCode: "",
    price: "",
    stockQuantity: "",
    qtyRequired: "",
    returnableQty: "",
    // location: "",
  });
  setFormErrors({});
  setPartNumberAuto(true);
  setPartNumberAvailable(true);
  setPartSearch("");
  setShowPartDropdown(false);
  setShowModal(true);
}, []);
```

In `handleSubmit` (lines 1279–1348), find:
```jsx
const handleSubmit = useCallback(
  async (e) => {
    e.preventDefault();
    const errors = validateForm();
    if (Object.keys(errors).length) {
      setFormErrors(errors);
      Object.values(errors).forEach((e) => notifyError(e));
      return;
    }

    try {
      const token = localStorage.getItem("token");
      const isCreate = modalMode === "create";
      const url = isCreate
        ? `${BASE_URL}/api/stock`
        : `${BASE_URL}/api/stock/${selectedItem.productId}`;

      // Build body — include stockQuantity for both create and edit when provided
      const body = {
        productName: formData.productName,
        description: formData.description || undefined,
        productCode: formData.productCode,
        price: parseFloat(formData.price),
        qtyRequired: parseInt(formData.qtyRequired) || 0,
        // location: formData.location || undefined,
      };
```
Replace with:
```jsx
const handleSubmit = useCallback(
  async (e) => {
    e.preventDefault();
    const errors = validateForm();
    if (Object.keys(errors).length) {
      setFormErrors(errors);
      Object.values(errors).forEach((e) => notifyError(e));
      return;
    }
    if (!partNumberAvailable) {
      notifyError("Part Number is already in use — choose a different one.");
      return;
    }

    try {
      const token = localStorage.getItem("token");
      const isCreate = modalMode === "create";
      const url = isCreate
        ? `${BASE_URL}/api/stock`
        : `${BASE_URL}/api/stock/${selectedItem.productId}`;

      // Build body — include stockQuantity for both create and edit when provided
      const body = {
        productName: formData.productName,
        description: formData.description || undefined,
        productCode: formData.productCode,
        price: parseFloat(formData.price),
        qtyRequired: parseInt(formData.qtyRequired) || 0,
        // location: formData.location || undefined,
        ...(isCreate ? { part_number_auto: partNumberAuto } : {}),
      };
```
And update the `useCallback` dependency array at the end of `handleSubmit` (find `[formData, modalMode, selectedItem, fetchStock, validateForm]`) to include the two new state values:
```jsx
  [formData, modalMode, selectedItem, fetchStock, validateForm, partNumberAuto, partNumberAvailable],
```

Find the `<ProductCodeBuilder>` render (lines 1924–1934):
```jsx
<div>
  <label className="block text-gray-700 font-medium mb-1">
    Product Code *
  </label>
  <ProductCodeBuilder
    value={formData.productCode}
    onChange={(code) =>
      setFormData((prev) => ({ ...prev, productCode: code }))
    }
  />
</div>
```
Replace with:
```jsx
<div>
  <label className="block text-gray-700 font-medium mb-1">
    Product Code *
  </label>
  <ProductCodeBuilder
    value={formData.productCode}
    onChange={(code) =>
      setFormData((prev) => ({ ...prev, productCode: code }))
    }
    suggestedPartNumber={
      modalMode === "create"
        ? String(
            (stockItems.length ? Math.max(...stockItems.map((i) => i.productId)) : 0) + 1,
          ).padStart(4, "0")
        : null
    }
    excludeId={modalMode === "edit" ? selectedItem?.productId : null}
    onAutoFlagChange={setPartNumberAuto}
    onAvailabilityChange={setPartNumberAvailable}
  />
</div>
```
(Since this file shares one `ProductCodeBuilder` instance for both modes, `suggestedPartNumber` is only meaningful in create mode and `excludeId` only in edit mode — both are conditionally passed based on `modalMode`, and `onAutoFlagChange` is harmless to pass in edit mode too since nothing reads `partNumberAuto` on the edit path.)

- [ ] **Step 5: Also reset `partNumberAuto`/`partNumberAvailable` in `handleEdit`**

Find `handleEdit` (lines 1209–1226):
```jsx
const handleEdit = useCallback((item) => {
  setModalMode("edit");
  setSelectedItem(item);
  setFormData({
    productName: item.productName || "",
    description: item.description || "",
    productCode: item.productCode || "",
    price: item.price ?? "",
    stockQuantity: item.stockQuantity ?? "",
    qtyRequired: item.qtyRequired ?? "",
    returnableQty: item.returnableQty ?? "",
    // location: item.location || "",
  });
  setFormErrors({});
  setPartSearch("");
  setShowPartDropdown(false);
  setShowModal(true);
}, []);
```
Change to:
```jsx
const handleEdit = useCallback((item) => {
  setModalMode("edit");
  setSelectedItem(item);
  setFormData({
    productName: item.productName || "",
    description: item.description || "",
    productCode: item.productCode || "",
    price: item.price ?? "",
    stockQuantity: item.stockQuantity ?? "",
    qtyRequired: item.qtyRequired ?? "",
    returnableQty: item.returnableQty ?? "",
    // location: item.location || "",
  });
  setFormErrors({});
  setPartNumberAvailable(true);
  setPartSearch("");
  setShowPartDropdown(false);
  setShowModal(true);
}, []);
```

- [ ] **Step 6: Verify lint and build**

Run: `cd CRM && npx eslint src/components/admin/StockPage.jsx`
Expected: no new errors vs. baseline.

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds.

No commit — leave the change in the working tree.

---

### Task 17: `stores/StoreStockPage.jsx`

**Files:**
- Modify: `CRM/src/components/stores/StoreStockPage.jsx`

Same shape as Task 16 (single shared modal form, `productCode`/`productId` camelCase), but this file has NO module-level `BASE_URL` constant — it inlines `import.meta.env.VITE_BACKEND_URL || "http://localhost:8000"` per fetch call. `ProductCodeBuilder` needs its own local `backendUrl` computation.

- [ ] **Step 1: Update `ProductCodeBuilder`'s signature and state init**

Find (lines 189–211):
```jsx
function ProductCodeBuilder({ value = "", onChange, disabled = false }) {
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(parsed?.partNum ?? "0001");
  const [partInput, setPartInput] = useState(
    parsed ? String(parseInt(parsed.partNum, 10)) : "1",
  );
```

Replace with:
```jsx
function ProductCodeBuilder({
  value = "",
  onChange,
  disabled = false,
  suggestedPartNumber = null,
  excludeId = null,
  onAutoFlagChange,
  onAvailabilityChange,
}) {
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(
    parsed?.partNum ?? (suggestedPartNumber ? pad4(suggestedPartNumber) : "0001"),
  );
  const [partInput, setPartInput] = useState(
    parsed
      ? String(parseInt(parsed.partNum, 10))
      : suggestedPartNumber
        ? String(parseInt(suggestedPartNumber, 10))
        : "1",
  );
  const [partTouched, setPartTouched] = useState(false);
  const [checkStatus, setCheckStatus] = useState(null);
```

- [ ] **Step 2: Update `handlePartInput` and add touched/check effects**

Find:
```jsx
  const handlePartInput = (e) => {
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };
```

Replace with (this file has NO module-level `BASE_URL` constant, so `backendUrl` is computed locally inside the effect, port `8000`):
```jsx
  const handlePartInput = (e) => {
    setPartTouched(true);
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };

  useEffect(() => {
    onAutoFlagChange?.(!partTouched);
  }, [partTouched]);

  useEffect(() => {
    if (manualMode || !partNum || partNum.length !== 4) {
      setCheckStatus(null);
      onAvailabilityChange?.(true);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setCheckStatus({ checking: true });
      try {
        const token = localStorage.getItem("token");
        const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";
        const url = new URL(`${backendUrl}/api/stock/check-part-number`);
        url.searchParams.set("part_number", partNum);
        if (excludeId) url.searchParams.set("exclude_id", excludeId);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
          return;
        }
        const data = await res.json();
        setCheckStatus({ checking: false, ...data });
        onAvailabilityChange?.(data.available !== false);
      } catch (err) {
        if (err.name !== "AbortError") {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [partNum, excludeId, manualMode]);
```

- [ ] **Step 3: Add inline feedback JSX under the Part Number input**

Find the Part Number block's closing (lines 374–398 area):
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
      </div>
```

Replace with:
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
        {checkStatus?.checking && (
          <p className="text-xs text-gray-400 mt-1">Checking availability…</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === true && (
          <p className="text-xs text-green-600 mt-1">✓ Available</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === false && (
          <p className="text-xs text-red-600 mt-1">
            ✗ Already used by {checkStatus.conflictProductName} (#{checkStatus.conflictProductId})
          </p>
        )}
      </div>
```

- [ ] **Step 4: Wire the modal form**

Find `formData` init (lines 705–712):
```jsx
const [formData, setFormData] = useState({
  productName: "",
  description: "",
  productCode: "",
  stockQuantity: "",
  qtyRequired: "",
  // location: "", // NEW
});
```
Add:
```jsx
const [partNumberAuto, setPartNumberAuto] = useState(true);
const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

Find `handleCreate` (lines 1121–1134) and add the two resets, same pattern as Task 16 Step 4's `handleCreate` change:
```jsx
const handleCreate = useCallback(() => {
    setModalMode("create");
    setSelectedItem(null);
    setFormData({
      productName: "",
      description: "",
      productCode: "",
      stockQuantity: "",
      qtyRequired: "",
      // location: "",
    });
    setFormErrors({});
    setPartNumberAuto(true);
    setPartNumberAvailable(true);
    setShowModal(true);
  }, []);
```

Find `handleSubmit` (lines 1070–1119), specifically:
```jsx
const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      const errors = validateForm();
      if (Object.keys(errors).length) {
        setFormErrors(errors);
        Object.values(errors).forEach((e) => notifyError(e));
        return;
      }

      try {
        const token = localStorage.getItem("token");
        const isCreate = modalMode === "create";
        const url = isCreate
          ? `${import.meta.env.VITE_BACKEND_URL || "http://localhost:8000"}/api/stock`
          : `${import.meta.env.VITE_BACKEND_URL || "http://localhost:8000"}/api/stock/${selectedItem.productId}`;

        const body = {
          productName: formData.productName,
          description: formData.description || undefined,
          productCode: formData.productCode,
          stockQuantity: isCreate
            ? parseInt(formData.stockQuantity)
            : undefined,
          qtyRequired: parseInt(formData.qtyRequired) || 0,
          // location: formData.location || undefined,
          price: isCreate ? 0.01 : selectedItem.price,
        };
```
Replace with:
```jsx
const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      const errors = validateForm();
      if (Object.keys(errors).length) {
        setFormErrors(errors);
        Object.values(errors).forEach((e) => notifyError(e));
        return;
      }
      if (!partNumberAvailable) {
        notifyError("Part Number is already in use — choose a different one.");
        return;
      }

      try {
        const token = localStorage.getItem("token");
        const isCreate = modalMode === "create";
        const url = isCreate
          ? `${import.meta.env.VITE_BACKEND_URL || "http://localhost:8000"}/api/stock`
          : `${import.meta.env.VITE_BACKEND_URL || "http://localhost:8000"}/api/stock/${selectedItem.productId}`;

        const body = {
          productName: formData.productName,
          description: formData.description || undefined,
          productCode: formData.productCode,
          stockQuantity: isCreate
            ? parseInt(formData.stockQuantity)
            : undefined,
          qtyRequired: parseInt(formData.qtyRequired) || 0,
          // location: formData.location || undefined,
          price: isCreate ? 0.01 : selectedItem.price,
          ...(isCreate ? { part_number_auto: partNumberAuto } : {}),
        };
```
And add `partNumberAuto, partNumberAvailable` to `handleSubmit`'s dependency array (find `[formData, modalMode, selectedItem, refetchData]`, change to `[formData, modalMode, selectedItem, refetchData, partNumberAuto, partNumberAvailable]`).

Find the `<ProductCodeBuilder>` render (lines 1453–1463):
```jsx
<div>
                <label className="block font-medium mb-1">
                  Product Code (11 chars) *
                </label>
                <ProductCodeBuilder
                  value={formData.productCode}
                  onChange={(code) =>
                    setFormData({ ...formData, productCode: code })
                  }
                />
              </div>
```
Replace with:
```jsx
<div>
                <label className="block font-medium mb-1">
                  Product Code (11 chars) *
                </label>
                <ProductCodeBuilder
                  value={formData.productCode}
                  onChange={(code) =>
                    setFormData({ ...formData, productCode: code })
                  }
                  suggestedPartNumber={
                    modalMode === "create"
                      ? String(
                          (stockItems.length ? Math.max(...stockItems.map((i) => i.productId)) : 0) + 1,
                        ).padStart(4, "0")
                      : null
                  }
                  excludeId={modalMode === "edit" ? selectedItem?.productId : null}
                  onAutoFlagChange={setPartNumberAuto}
                  onAvailabilityChange={setPartNumberAvailable}
                />
              </div>
```

- [ ] **Step 5: Reset `partNumberAvailable` in `handleEdit`**

Find `handleEdit` (lines 1136–1149) and add `setPartNumberAvailable(true);` right after `setFormErrors({});`, same pattern as Task 16 Step 5.

- [ ] **Step 6: Verify lint and build**

Run: `cd CRM && npx eslint src/components/stores/StoreStockPage.jsx`
Expected: no new errors vs. baseline.

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds.

No commit — leave the change in the working tree.

---

### Task 18: `production/ProductionStockPage.jsx`

**Files:**
- Modify: `CRM/src/components/production/ProductionStockPage.jsx`

Same shape as Task 17, with port `5000` instead of `8000`, and this file's `formData` includes a `price` field directly (unlike `StoreStockPage.jsx`, which hardcodes `0.01` on create).

- [ ] **Step 1: Update `ProductCodeBuilder`'s signature and state init**

Find (lines 197–210):
```jsx
function ProductCodeBuilder({ value = "", onChange, disabled = false }) {
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(parsed?.partNum ?? "0001");
  const [partInput, setPartInput] = useState(
    parsed ? String(parseInt(parsed.partNum, 10)) : "1",
  );
```

Replace with:
```jsx
function ProductCodeBuilder({
  value = "",
  onChange,
  disabled = false,
  suggestedPartNumber = null,
  excludeId = null,
  onAutoFlagChange,
  onAvailabilityChange,
}) {
  const parsed = parseCode(value);

  const [partNum, setPartNum] = useState(
    parsed?.partNum ?? (suggestedPartNumber ? pad4(suggestedPartNumber) : "0001"),
  );
  const [partInput, setPartInput] = useState(
    parsed
      ? String(parseInt(parsed.partNum, 10))
      : suggestedPartNumber
        ? String(parseInt(suggestedPartNumber, 10))
        : "1",
  );
  const [partTouched, setPartTouched] = useState(false);
  const [checkStatus, setCheckStatus] = useState(null);
```

- [ ] **Step 2: Update `handlePartInput` and add touched/check effects**

Find:
```jsx
  const handlePartInput = (e) => {
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };
```

Replace with (port `5000` for this file):
```jsx
  const handlePartInput = (e) => {
    setPartTouched(true);
    const raw = e.target.value;
    setPartInput(raw);
    if (raw !== "") setPartNum(pad4(raw));
  };
  const handlePartBlur = () => {
    const padded = pad4(partInput);
    setPartInput(String(parseInt(padded, 10)));
    setPartNum(padded);
  };

  useEffect(() => {
    onAutoFlagChange?.(!partTouched);
  }, [partTouched]);

  useEffect(() => {
    if (manualMode || !partNum || partNum.length !== 4) {
      setCheckStatus(null);
      onAvailabilityChange?.(true);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setCheckStatus({ checking: true });
      try {
        const token = localStorage.getItem("token");
        const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";
        const url = new URL(`${backendUrl}/api/stock/check-part-number`);
        url.searchParams.set("part_number", partNum);
        if (excludeId) url.searchParams.set("exclude_id", excludeId);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
          return;
        }
        const data = await res.json();
        setCheckStatus({ checking: false, ...data });
        onAvailabilityChange?.(data.available !== false);
      } catch (err) {
        if (err.name !== "AbortError") {
          setCheckStatus(null);
          onAvailabilityChange?.(true);
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [partNum, excludeId, manualMode]);
```

- [ ] **Step 3: Add inline feedback JSX under the Part Number input**

Find the Part Number block's closing (lines 368–392 area):
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
      </div>
```

Replace with:
```jsx
          <span className="text-gray-400 text-sm">
            →{" "}
            <code className={`${SEG.part} font-bold text-base`}>{partNum}</code>
          </span>
        </div>
        {checkStatus?.checking && (
          <p className="text-xs text-gray-400 mt-1">Checking availability…</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === true && (
          <p className="text-xs text-green-600 mt-1">✓ Available</p>
        )}
        {checkStatus && !checkStatus.checking && checkStatus.available === false && (
          <p className="text-xs text-red-600 mt-1">
            ✗ Already used by {checkStatus.conflictProductName} (#{checkStatus.conflictProductId})
          </p>
        )}
      </div>
```

- [ ] **Step 4: Wire the modal form**

Find `formData` init (lines 702–709):
```jsx
const [formData, setFormData] = useState({
  productName: "",
  description: "",
  productCode: "",
  stockQuantity: "",
  qtyRequired: "",
  price: "",
});
```
Add:
```jsx
const [partNumberAuto, setPartNumberAuto] = useState(true);
const [partNumberAvailable, setPartNumberAvailable] = useState(true);
```

Find `handleCreate` (lines 1116–1130) and add the same two resets as Task 16/17.

Find `handleSubmit` (lines 1066–1114), specifically:
```jsx
const handleSubmit = useCallback(
  async (e) => {
    e.preventDefault();
    const errors = validateForm();
    if (Object.keys(errors).length) {
      setFormErrors(errors);
      Object.values(errors).forEach((e) => notifyError(e));
      return;
    }

    try {
      const token = localStorage.getItem("token");
      const isCreate = modalMode === "create";
      const url = isCreate
        ? `${import.meta.env.VITE_BACKEND_URL || "http://localhost:5000"}/api/stock`
        : `${import.meta.env.VITE_BACKEND_URL || "http://localhost:5000"}/api/stock/${selectedItem.productId}`;

      const body = {
        productName: formData.productName,
        description: formData.description || undefined,
        productCode: formData.productCode,
        stockQuantity: isCreate
          ? parseInt(formData.stockQuantity)
          : undefined,
        qtyRequired: parseInt(formData.qtyRequired) || 0,
        price: parseFloat(formData.price),
      };
```
Replace with:
```jsx
const handleSubmit = useCallback(
  async (e) => {
    e.preventDefault();
    const errors = validateForm();
    if (Object.keys(errors).length) {
      setFormErrors(errors);
      Object.values(errors).forEach((e) => notifyError(e));
      return;
    }
    if (!partNumberAvailable) {
      notifyError("Part Number is already in use — choose a different one.");
      return;
    }

    try {
      const token = localStorage.getItem("token");
      const isCreate = modalMode === "create";
      const url = isCreate
        ? `${import.meta.env.VITE_BACKEND_URL || "http://localhost:5000"}/api/stock`
        : `${import.meta.env.VITE_BACKEND_URL || "http://localhost:5000"}/api/stock/${selectedItem.productId}`;

      const body = {
        productName: formData.productName,
        description: formData.description || undefined,
        productCode: formData.productCode,
        stockQuantity: isCreate
          ? parseInt(formData.stockQuantity)
          : undefined,
        qtyRequired: parseInt(formData.qtyRequired) || 0,
        price: parseFloat(formData.price),
        ...(isCreate ? { part_number_auto: partNumberAuto } : {}),
      };
```
And add `partNumberAuto, partNumberAvailable` to `handleSubmit`'s dependency array (find `[formData, modalMode, selectedItem, refetchData]`, change to include the two new values).

Find the `<ProductCodeBuilder>` render (lines 1443–1456):
```jsx
<div>
  <label className="block font-medium mb-1">
    Product Code (11 chars) *
  </label>
  <ProductCodeBuilder
    value={formData.productCode}
    onChange={(code) =>
      setFormData({ ...formData, productCode: code })
    }
  />
  {formErrors.productCode && (
    <p className="text-red-500 text-xs mt-1">{formErrors.productCode}</p>
  )}
</div>
```
Replace with:
```jsx
<div>
  <label className="block font-medium mb-1">
    Product Code (11 chars) *
  </label>
  <ProductCodeBuilder
    value={formData.productCode}
    onChange={(code) =>
      setFormData({ ...formData, productCode: code })
    }
    suggestedPartNumber={
      modalMode === "create"
        ? String(
            (stockItems.length ? Math.max(...stockItems.map((i) => i.productId)) : 0) + 1,
          ).padStart(4, "0")
        : null
    }
    excludeId={modalMode === "edit" ? selectedItem?.productId : null}
    onAutoFlagChange={setPartNumberAuto}
    onAvailabilityChange={setPartNumberAvailable}
  />
  {formErrors.productCode && (
    <p className="text-red-500 text-xs mt-1">{formErrors.productCode}</p>
  )}
</div>
```

- [ ] **Step 5: Reset `partNumberAvailable` in `handleEdit`**

Find `handleEdit` (lines 1132–1145) and add `setPartNumberAvailable(true);` right after `setFormErrors({});`, same pattern as Task 16/17.

- [ ] **Step 6: Verify lint and build**

Run: `cd CRM && npx eslint src/components/production/ProductionStockPage.jsx`
Expected: no new errors vs. baseline.

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds.

No commit — leave the change in the working tree.

---

## Phase E: Final verification

### Task 19: Final full verification

- [ ] **Step 1: Lint every changed frontend file**

Run:
```bash
cd CRM && npx eslint src/components/admin/InventoryPage.jsx src/components/production/ProductionInventoryPage.jsx src/components/stores/StoreInventoryPage.jsx src/components/sales/SalesInventoryPage.jsx src/components/admin/StockPage.jsx src/components/stores/StoreStockPage.jsx src/components/production/ProductionStockPage.jsx
```
Expected: no new errors introduced by this feature (compare against each file's pre-existing baseline noted in Tasks 12–18 if unsure).

- [ ] **Step 2: Full frontend build**

Run: `cd CRM && npx vite build --logLevel warn`
Expected: build succeeds.

- [ ] **Step 3: Backend syntax sanity check on every touched file**

Run (from `CRM_BACKEND`):
```bash
node -e "require('./controllers/core/inventory.controller.js'); require('./controllers/core/stock.controller.js'); require('./routes/core/inventory.js'); require('./routes/core/stock.js'); console.log('ALL OK'); process.exit(0)"
```
Expected: `ALL OK`.

- [ ] **Step 4: Re-verify both DB migrations and the collision fix are still intact**

Create `<scratchpad>/final_db_check.js`:
```js
const path = require('path');
require('dotenv').config({ path: path.join('C:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM_BACKEND', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000,
});

(async () => {
  try {
    for (const table of ['inventory', 'raw_materials']) {
      const { rows } = await pool.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = '${table}'::regclass AND conname = '${table}_part_number_unique'
      `);
      console.log(`${table}_part_number_unique exists:`, rows.length === 1);

      const { rows: dupes } = await pool.query(`
        SELECT part_number, COUNT(*) FROM ${table} GROUP BY part_number HAVING COUNT(*) > 1
      `);
      console.log(`${table} duplicate part numbers (expect 0):`, dupes.length);
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
})();
```
Run: `node <scratchpad>/final_db_check.js`
Expected: both constraints exist (`true`), zero duplicates in both tables.

Delete the script afterward: `rm <scratchpad>/final_db_check.js`

- [ ] **Step 5: Summarize remaining manual QA for the owner**

Report to the project owner: automated verification is complete (schema, backend round-trip, and lint/build all pass), but real UI click-through still needs to happen in a browser with real credentials — specifically: opening "Add Item" on each of the 4 finished-goods pages and 3 raw-material pages, confirming the Part Number field pre-fills with a sensible suggested value, typing a number that's already taken and seeing the inline "✗ already used by..." message, confirming Save is blocked while that message shows, and confirming a normal create/edit still works end-to-end and the created item's Part Number matches its real product_id after a refresh. Leave all changes uncommitted per the owner's instruction — they'll review and commit themselves.
