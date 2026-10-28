# CRM_BACKEND research notes: Manufacturing, Service, HR, Operations, Chatbot, Jobs, Tests, Migrations

All paths are relative to `CRM_BACKEND/`. Route mounts come from `server.js` (lines 168-213). Unless stated otherwise, every route runs `authenticateToken`. `checkPermission(module, action)` (`middleware/auth.js`) looks up the `permissions` table for `(role_id, module)` and checks `can_read`, `can_write` or `can_delete`. It returns 403 `PERM_DENIED`, or 500 `PERM_CHECK_FAILED` if the lookup fails.

Cross-cutting facts:
- **Socket.IO**: `server.js` creates one `Server` and stores it with `app.set('io')` and `app.set('socketio')`. Global middleware also sets `req.io = io` on every request. Some routers (iptKits, payslip, invoice, invoiceRecords, activities) re-assign `req.io = req.app.get('io')` and attach `req.io.user = req.user`. Their models use `io.user` to fill `created_by`. **No code anywhere calls `socket.join(...)`**, so every emit is a global broadcast, and room-targeted emits (`io.to('user:<id>')`) reach nobody.
- **Redis**: `config/redis.js` is a node-redis v4 client (`REDIS_URL`, default `redis://localhost:6379`). It adds a custom `delPattern(pattern)` method that runs `KEYS` then `DEL`. Most modules invalidate with `redis.keys(pattern)`, which blocks Redis (`KEYS` is O(N)). Only activities uses the non-blocking `scanIterator`.
- **Global error handler** (`middleware/error.js`): returns `err.status || 500` and `{ error: err.message, code: err.code || 'INTERNAL_ERROR' }`.
- **JSON body limit** is 40 MB (`express.json({ limit: '40mb' })`). The limit was raised for PDI photo uploads.

---

## 1. Manufacturing

### 1.1 Bill of Materials (BOM): `/api/bom`
Files: `routes/manufacturing/bom.js`, `controllers/manufacturing/bom.controller.js`, `models/manufacturing/bom.js`

**Purpose:** defines which raw materials, and how much of each, make up one unit of a finished product.

**Endpoints.** These use express-validator but have **no `checkPermission`**, so any authenticated user can call them.

| Method | Path | Notes |
|---|---|---|
| GET | `/` | `limit` (1-100, default 10), `offset`, `force_refresh`; response is `{ data, total }` |
| GET | `/:id` | single BOM |
| POST | `/` | body `{ productId, materials:[{materialId, quantityPerUnit>0}] }` (min 1 material) |
| PUT | `/:id` | same body; replaces the material list |
| DELETE | `/:id` | |

**Tables:**
- `bill_of_materials`: `bom_id`, `product_id`, `created_at`, `updated_at`.
- `bom_materials`: `bom_material_id`, `bom_id`, `material_id`, `quantity_per_unit`, `unit_price`, `total_value`.
- Joins `inventory` (finished product: `product_name`, `description`, `product_code`) and `raw_materials` (material name).

**Behaviour:**
- **Create** runs in a transaction on a dedicated `client` (BEGIN/COMMIT/ROLLBACK). It checks that the product exists in `inventory` and every material exists in `raw_materials`. It also accepts lookup by `productName` or `materialName`. It then inserts the header row and the material rows.
- The insert supplies only `(bom_id, material_id, quantity_per_unit)`. `unit_price` and `total_value` come back via `RETURNING`, so they are evidently filled by a DB trigger or default; the JS never computes them. The controller maps any error containing `"No price found"` or `"foreign key constraint"` to 400 `Invalid productId or materialId`. This suggests the price-lookup trigger raises "No price found".
- **Update** runs in one transaction. It updates the header, runs `DELETE FROM bom_materials WHERE bom_id`, then re-inserts all materials.
- **Delete** deletes the header row. Material-row cleanup relies on the FK.

**Redis:** list cache key `bom_list_<limit>_<offset>`, TTL 300 s. Every write invalidates `bom_list_*`. `force_refresh=true` also invalidates.

**Socket.IO:** `bom:created`, `bom:updated` (payload includes `triggeredBy`), `bom:deleted` `{bomId, triggeredBy}`.

**Gaps:**
- `BOM.getById` *throws* when the BOM is missing instead of returning null, so GET `/:id` returns 500 (not 404) for a missing BOM. PUT and DELETE behave the same way.

### 1.2 Parts master and part-code generation: `/api/parts`
Files: `routes/manufacturing/parts.js`, `controllers/manufacturing/parts.controller.js`, `models/manufacturing/parts.js`

**Purpose:** a catalogue of engineering parts with auto-generated part codes per part type.

**Endpoints** (permission module `Parts`):

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/` | read | `{data,total}`, ordered by id ASC |
| GET | `/types` | read | `part_types` (`id`, `typeName`, `prefix`) |
| GET | `/next-code?partTypeId=` | **write** | preview only, consumes nothing |
| POST | `/` | write | body `partTypeId` (number), `name`, `description`, `drawingNo` required; `customerPartNo` and `supplierPartNo` optional strings |
| PUT | `/:id` | write | `part_code` and `part_type_id` are immutable |
| DELETE | `/:id` | delete | hard delete, returns 204 |

**Numbering scheme:**
- Format is `part_code = <part_types.prefix> + zero-padded serial (7 digits)`, for example `<prefix>0000001`.
- The per-type counter lives in `part_serials(part_type_id, last_serial)`.
- Create does `SELECT ... FROM part_types ... FOR UPDATE`, then `SELECT last_serial ... FOR UPDATE`. If no counter row exists it inserts one with value 0. It then increments, updates `part_serials`, and inserts into `parts`.

**Tables:**
- `parts`: `id`, `part_code`, `part_type_id`, `name`, `description`, `drawing_no`, `customer_part_no`, `supplier_part_no`, timestamps.
- `part_types`: `id`, `type_name`, `prefix`.
- `part_serials`.

**Error codes:** `INVALID_INPUT` (400), `INVALID_PART_TYPE` (400), `NOT_FOUND` (404), `SERVER_ERROR` (500).

**Gap (significant):**
- `Parts.create` runs `BEGIN`, `FOR UPDATE` and `COMMIT` through **`pool.query`, not a dedicated client**. Each statement can land on a different pooled connection, so the transaction and row locks do not actually protect the serial counter. Concurrent creates could produce duplicate codes, and ROLLBACK may hit the wrong connection.

### 1.3 Part drawings: `/api/part-drawings` and `/api/part-drawings-raw`
Files: `routes|controllers|models/manufacturing/partDrawings*.js`. The two modules are textual clones.

**Purpose:** store a drawing link (URL) per finished product (`part_drawings` → `inventory`) or per raw material (`part_drawings_raw` → `raw_materials`).

**Endpoints:** `GET /` (`limit`, `offset`, `search`, `force_refresh`), `POST /` `{drawing_link, product_id}`, `PUT /:srNo`, `DELETE /:srNo`. Only `authenticateToken` applies, with **no permission check**.

**Columns:** `sr_no` (PK), `drawing_id`, `item_name`, `drawing_link`, `product_id`, `updated_at`. Insert sets only `product_id` and `drawing_link`, so `drawing_id` and `item_name` must be filled by DB defaults or triggers.

**Behaviour:**
- Search is an ILIKE across sr_no, drawing_id, item_name, product_name and product_id. The response shape is `{ drawings, total }`.
- Create, update and delete each run in a client transaction. Update merges supplied fields with the current row.

**Redis:**
- Key `part_drawings_<limit>_<offset>_<search>` (or `part_drawings_raw_...`), TTL 300 s.
- Writes delete `part_drawings_*` plus `inventory_*`, or `part_drawings_raw_*` plus `raw_materials_*`.
- Both controllers also flush these patterns **once at module load** (an IIFE).
- The `part_drawings_*` pattern also matches the raw keys.

**Socket.IO:** `partDrawingsUpdate` / `partDrawingsRawUpdate` with `{type: 'CREATE'|'UPDATE'|'DELETE', item|itemId, timestamp}`.

**Errors:** every model error, including "not found", returns **400**.

### 1.4 Motor recipes: `/api/motor-recipes`
Files: `routes/manufacturing/motorRecipes.js`, controller, `models/manufacturing/motorRecipe.js`

**Purpose:** a customer-specific winding recipe for a motor product: number of turns and number of coils.

**Endpoints** (module `MotorRecipes`):
- `GET /` (`limit` default 50, max 200).
- `GET /dropdown-data`: customers joined to users plus the inventory product list.
- `GET /customer/:customerId`
- `GET /:customerId/:productId`
- `POST /` (upsert)
- `DELETE /:customerId/:productId`

**Validation:** `customer_id` and `product_id` are required. `num_turns` and `num_coils` must be positive integers (`VALIDATION_ERROR`).

**Upsert:** `INSERT ... ON CONFLICT ON CONSTRAINT uq_motor_recipes_customer_product DO UPDATE` (turns, coils, notes, `updated_at=now()`). This gives exactly one recipe per (customer, product).

**Table:** `motor_recipes` (`customer_id`, `product_id`, `num_turns`, `num_coils`, `notes`, `updated_at`, ...).

**Errors:** delete-not-found returns 404 `NOT_FOUND`. Other errors go to the global handler. No cache and no sockets.

### 1.5 IPT kits: `/api/ipt-kits`
Files: `routes/manufacturing/iptKits.js`, controller, `models/manufacturing/iptKits.js`. Test: `tests/iptKits.test.js`.

**Purpose:** records the assembly of an "IPT kit". It ties together the serial numbers of the seven components shipped as one kit, and supports reverse lookup ("which kit holds motor X?").

**Endpoints** (module `ipt_kits`): `GET /` (read), `GET /next-serial` (read), `GET /:id`, `POST /` (write), `PUT /next-serial` (write), `PUT /:id` (write), `DELETE /:id` (delete).

**Component fields:** `motor_serial`, `controller_serial`, `gearbox_serial`, `harness_serial`, `cluster_serial`, `vcu_serial`, `dcdc_serial`.
- All seven are required.
- Each is trimmed and upper-cased.
- A unique violation (`23505`) is mapped via the constraint name to a field-specific message: `"<component> serial "X" is already used in another kit"`, with `field`.

**Kit serial numbering:**
- `kit_serial = 'IPT' || lpad(nextval('ipt_kit_serial_seq'), 3, '0')`, for example `IPT001`. It is generated in SQL on insert.
- `GET /next-serial` previews the next value from the sequence's `last_value` and `is_called` without consuming it.
- `PUT /next-serial {next}` is the admin re-point. `next` must be a positive integer. It is rejected if an existing kit already uses that `IPTnnn`. Otherwise it runs `setval('ipt_kit_serial_seq', n, false)`. Numbers freed by deletes can be reused.

**Table:** `ipt_kits` (`kit_id`, `kit_serial`, the seven serials, `created_by`, `updated_by`, `created_at`, `updated_at`). `created_by` and `updated_by` come from `io.user.user_id`.

**List pagination:**
- Keyset cursor `"<kit_id>:<created_at text>"`, limit 1-100 (default 20).
- `created_at` is compared as `to_char(... 'YYYY-MM-DD HH24:MI:SS.US')` text, which avoids timezone shifting.
- Fetches `limit+1` rows to compute `hasMore`.
- Search is an ILIKE across all seven serials plus `kit_serial`.
- Response is `{ data, total, cursor }`.

**Socket.IO:** `ipt_kits:created`, `ipt_kits:updated`, `ipt_kits:deleted` (emits are wrapped in try/catch).

**Errors:** 400 `{error, field}` for validation or duplicates. 404 `'Kit not found'`.

### 1.6 Production process (work orders): `/api/process`
Files: `routes/manufacturing/process.js`, `controllers/manufacturing/process.controller.js` (242 lines), `models/manufacturing/process.js` (1028 lines). Permission module: `Processes`.

**Purpose:** tracks manufacturing of a sales order. The hierarchy is: order → optional instance groups → work orders → components with quantities → per-component process steps (status and quantities) plus raw-material allocations. Each work order also has milestone stages and testing results.

**Data model:**

| Table | Key columns / constraints |
|---|---|
| `instance_groups` | `instance_group_id`, `order_id`, `instance_name`, `instance_type` ∈ {`Motor`,`Non-Motor`}; constraint `unique_instance_name_per_order` |
| `components` | `component_id`, `component_name`, `product_type` ∈ {`Motor`,`Non-Motor`}, `is_fixed`; `unique_component_name` |
| `component_processes` | `process_id`, `component_id`, `process_name`, `sequence` (int ≥0), `responsible_person`, `description`; `unique_process_per_component` |
| `work_orders` | `work_order_id`, `order_id`, `instance_group_id`, `target_date`, `status` (`Pending`/`In Progress`/`Completed`), `created_at` |
| `work_order_components` | `work_order_component_id`, `work_order_id`, `component_id`, `quantity`; unique (`work_order_id`,`component_id`) |
| `process_status` | `status_id`, `work_order_component_id`, `process_id`, `status`, `completed_quantity`, `in_use_quantity`, `allowed_quantity`, `completion_date`, `responsible_person`; unique (woc, process) |
| `work_order_materials` | `work_order_material_id`, `work_order_component_id`, `work_order_id`, `component_id`, `raw_material_id`, `quantity`; unique (woc, raw_material) |
| `process_material_usage` | (woc, process, raw_material) unique, `used_quantity` |
| `work_order_stages` | `work_order_stage_id`, `work_order_id`, `stage_name`, `stage_date` |
| `work_order_testing_results` | (`work_order_id`,`testing_type`) unique, `qty`, `test_date`, `controller_type`, `updated_at` |

**Endpoints:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/orders` | all orders plus customer name (for the order picker) |
| GET | `/components` | component master with its process template (JSON-aggregated, ordered by sequence) |
| POST | `/components` | `{component_name, product_type}` |
| POST | `/components/:componentId/processes` | `{process_name, sequence, responsible_person?, description?}` |
| POST | `/work-orders/:workOrderId/components` | attach a component `{component_id, quantity>0}` |
| GET/PUT | `/components/:wocId/processes`, `/process-status` | view and update per-process progress |
| GET/POST/PUT/DELETE | `/components/:wocId/materials[/:materialId]` | material allocation |
| GET/PUT | `/work-orders/:id/stages` | milestone dates |
| GET/PUT | `/work-orders/:id/testing` | Primary/Final testing results |
| POST | `/:orderId/work-orders` | `{instance_group_id?, target_date?}`; status starts `Pending` |
| GET/POST | `/:orderId/instance-groups` | |
| GET | `/:orderId` | paginated full work-order tree |

**Business rules:**
- **Attaching a component (transaction).** Duplicate attachment fails. If the component's `product_type === 'Motor'`, one `process_status` row (`Pending`, all quantities 0) is seeded for every `component_processes` step. **Non-Motor components get no process tracking.** Process status and material endpoints reject non-Motor components (`Processes are only applicable to Motor components` and `Materials can only be assigned to Motor components`).
- **Process status update (transaction, `updateProcessStatus`).** The documented rule (in-code comment):
  - `total_material = SUM(work_order_materials.quantity)` for the component.
  - **In-use is global.** The sum of `in_use_quantity` across all processes of the component must be ≤ total material. Otherwise the error is "Global in-use capacity exceeded…".
  - **Completed is local.** Each process's `completed_quantity` must be ≤ total material.
  - **Auto status per process:** `Completed` if completed ≥ total material, else `In Progress` if in_use > 0, else `Pending`.
  - **Work-order roll-up:** `Completed` if every process_status row in the work order is Completed. Otherwise `In Progress` if any row is In Progress or Completed. Otherwise `Pending`. The result is written to `work_orders.status`.
  - `allowed_quantity` is set to total material on all rows of that component (informational).
  - Controller validation: non-negative integers, and `completion_date` must be `YYYY-MM-DD`.
  - Edge case: when total material is 0, any update sets the process to `Completed` (0 ≥ 0).
- **Material allocation (POST, transaction).**
  - Upserts on (woc, raw_material) and recomputes the total.
  - If the current total in-use now exceeds the new total, it scales every process's in_use **proportionally**: `FLOOR(in_use * new/old)`. It re-derives status and logs a warning.
  - It updates `allowed_quantity`.
  - PUT and DELETE of a material run in the **controller** without a transaction. They recompute `allowed_quantity` but do not re-scale in-use.
- **Stages.** Valid names are `Assembly`, `Testing`, `PDI`, `Packing`, `Dispatch`, always ordered in that sequence. PUT only *updates* `stage_date` on an existing row. If the row is missing the error is "Stage X not found", so stage rows must be pre-created elsewhere (presumably a DB trigger on `work_orders` insert, since JS never inserts them).
- **Testing results.** `testing_type` ∈ {`Primary`,`Final`}. Upsert on (work_order_id, testing_type). GET always returns both types, with nulls when unset.
- **Instance groups.** Order must exist. Type must be Motor or Non-Motor. A duplicate name per order gives an error.
- `upsertProcessMaterialUsage` and `getProcessMaterialUsage` exist in the model but are **not exposed by any route**. The `materialsUsed` array in the tree is read-only. That model function also deletes a stale cache key (`processes:order:<id>`) that does not match the real key format.

**Redis:**
- `GET /:orderId` caches under `processes_<orderId>_<instance_group|all>_<limit>_<cursor>_<userId>` for 300 s. It reads `req.user?.userId`, which is likely undefined because the auth user uses `user_id`, so the key ends in `_anon`.
- Every mutation clears `processes_<orderId>_*` in a `setImmediate` (fire-and-forget).

**Pagination:** cursor = previous page's last `created_at` (`wo.created_at < cursor`). `nextCursor` is set only when a full page is returned.

**Socket.IO events:**
- `instanceGroupUpdate`
- `componentUpdate`
- `componentProcessUpdate`
- `workOrderCreated`
- `workOrderComponentAdded`
- `processUpdate` (from the controller; the model's `processStatusUpdated` is not fired because the controller does not pass `io`)
- `workOrderMaterialUpdate`
- `materialDeleted`
- `workOrderStageUpdate`
- `workOrderTestingUpdate`

Several model emits fire *before* COMMIT.

**Responses** carry `timezone: 'Asia/Kolkata'`. Errors are mostly 400 with the raw message (`error.status || 400`).

---

## 2. Service: Service Repair: `/api/service-repair`
Files: `routes/service/serviceRepair.js`, `controllers/service/serviceRepair.controller.js`, `models/service/serviceRepair.js`. Permission module: `ServiceRepair`.

**Purpose:** logs customer units returned for repair or service: what came in, the reported fault, the actual issue found, repair status, who is responsible, and challan / photo evidence.

**Table:** `service_repair_records`.
- Columns: `record_id`, `customer_name` (required), `dispatch_material_no`, `part_details`, `receiving_quantity`, `dispatch_quantity`, `fault_query`, `actual_issue`, `repair_status` (default **`pending`**), `responsibility_person`, `testing_responsibility`, `remarks`, `sent_date`, `service_type` (default **`repair`**), `created_by`, `created_at`.
- Single-URL photo columns: `chalan_photo_url`, `delivery_challan_photo_url`.
- TEXT[] photo arrays: `fault_photos_urls`, `actual_issue_photos_urls`, `chalan_photos_urls`, `delivery_challan_photos_urls`, `repaired_photos_urls`.
- Status values are **not validated server-side**. The backend only defaults `pending` and `repair`.

**Endpoints:** `GET /` (limit ≤100, offset), `GET /:id`, `POST /`, `PUT /:id` (full replace; `customer_name` required), `DELETE /:id` (delete perm), `DELETE /:id/photo` body `{field, url}` (uses `array_remove`). Photo uploads are all write perm, `multipart` field `photo`:
- `POST /:id/photo?field=chalan_photo_url|delivery_challan_photo_url` sets a single column.
- `POST /:id/chalan-photo`, `/delivery-challan-photo`, `/fault-photo`, `/actual-issue-photo`, `/repaired-photo` append to the matching array (`array_append(COALESCE(col,'{}'), url)`).

**File upload handling:**
- multer `memoryStorage`, 10 MB limit.
- Allowed MIME types: JPEG, PNG, WebP, GIF, PDF.
- Upload goes through `services/googleDrive.uploadBufferToDrive` with filename `service_repair_<id>_<kind>_<timestamp>.<ext>`. The file is made **public** (anyone-with-link reader). The stored value is the `https://drive.google.com/uc?export=view&id=…` URL.

**Errors:** `VALIDATION_ERROR` 400, `NOT_FOUND` 404, `SERVER_ERROR` 500.

**Gaps:**
- The Drive upload happens *before* the record-exists check, so a 404 leaves an orphan public Drive file.
- `removePhoto` and `DELETE` do not trash the Drive file.
- A `proxyImage` controller (streams a Drive file through the service account) exists but **no route is wired to it**.
- `PUT` overwrites `repaired_photos_urls` from the body but not the other arrays.
- No Socket.IO events and no cache.

---

## 3. HR

Role constants (in the attendance, employeeDetails and activities code): `COM_ROLES = [9, 10]` (Compage; 9 = employee, 10 = HR) and `IA_ROLES = [11, 12]` (Intute AI). `getOrgRoles(role_id)` scopes HR views to the caller's own organisation. Any other role gets 403.

### 3.1 Attendance: `/api/attendance`
Files: `routes/hr/attendance.js`, controller, `models/hr/attendance.js`; table `attendance`.

**Endpoints:**
- `GET /` (perm `attendance_history:can_read`): the caller's own records, cursor = `created_at`.
- `POST /` (`mark_attendance:can_write`): check in, check out, or mark absent.
- `GET /summary` (`attendance_summary:can_read`): HR view filtered to the caller's org roles. Supports `date`, `search` (name/email/employee_id) and cursor.

**Rules (controller):**
- `present_absent` must be `present` or `absent` (`ATTENDANCE_INVALID_STATUS`).
- `date` must equal **today in IST** (`ATTENDANCE_INVALID_DATE`), so no back-dating is possible.
- Absent: times and mode must be null (`ATTENDANCE_INVALID_ABSENT_FIELDS`).
- Present: `mode` ∈ {`office`,`remote`} (`ATTENDANCE_INVALID_MODE`). Other failure codes:
  - `ATTENDANCE_ALREADY_CHECKED_IN`
  - `ATTENDANCE_NO_CHECK_IN` (check-out without check-in)
  - `ATTENDANCE_ALREADY_CHECKED_OUT`
  - `ATTENDANCE_INVALID_TIME` (check-out must be after check-in)

**Model `createOrUpdate` (transaction):** one row per (user, date). Existing rows are updated with `COALESCE` so a check-out does not erase the check-in. Note that it also resets `created_at = CURRENT_TIMESTAMP` on update, which affects cursor ordering.

**Socket.IO:** `attendanceMarked` (name, email, employee_id, check_in, check_out, status, mode).

**Redis:**
- Personal key `attendance_<limit>_<cursor>_<user_id>`, TTL **10 s**.
- HR summary key `hr_attendance_summary_...`, TTL 30 s, cached **only for past dates**. Today's view always hits the DB.
- Marking attendance invalidates both.

**Error codes:** `SERVER_ERROR`, `HR_ATTENDANCE_SUMMARY_ERROR`.

### 3.2 Employee details: `/api/employee-details`
- `GET /`, `GET /:employee_id` (`employee_details:can_read`), `PATCH /:employee_id` (`can_write`).
- **Table:** `employee_details` (`employee_id` text key, `user_id`, `phone_number`, `date_of_joining`, `address`, timestamps), joined to `users` and `roles`.
- PATCH updates only `phone_number`, `date_of_joining` and `address` (COALESCE, so empty input means no change). It first verifies the employee belongs to the caller's org and otherwise returns 404 `EMPLOYEE_NOT_FOUND`.
- **Redis:** `employees_<limit>_<cursor>_<search>_<employee_id>_roles_<roles>`, TTL 60 s. Updates clear `employees_*`.

### 3.3 Payslip PDF: `POST /api/payslip/generate`
Files: `controllers/hr/payslip.controller.js`, `models/hr/payslip.js`.
- **No permission check**; any authenticated user can call it.
- **Stateless.** Nothing is stored. The PDF is streamed back as `attachment; filename="PAYSLIP_<NAME>_<PERIOD>.pdf"`.
- **Input:** `{ employee:{name, id}, period, payDate?, earnings:[{label, amount}], deductions:[{label, amount}] }`. Employee name and period are required.
- **Calculation:**
  - `gross = Σ finite earnings.amount`
  - `totalDeductions = Σ finite deductions.amount`
  - `netPay = max(0, gross − totalDeductions)`
  - Amount in words: `Rupees <number-to-words(round(netPay))> Only`.
  - No statutory logic (PF, ESI, TDS) is applied server-side. All components are supplied by the client.
- **PDF (PDFKit, A4, single page):**
  - Roboto fonts from `assets/fonts`, with a Helvetica fallback.
  - Header gradient, logo `assets/image.png`.
  - Company "Intute AI Technologies (OPC) Pvt. Ltd., A-5, Sector 68, Noida", with a "PAYSLIP" pill.
  - Employee card, then EARNINGS and DEDUCTIONS tables.
  - Gross/Total bar, NET PAY card (₹, en-IN format), amount-in-words box.
  - Stamp `assets/stamp.png` and a "Generated on" footer. Content is pulled up to guarantee a single page.
- **Socket:** `payslip:generated` `{filename, generated_at, generated_by}`.

### 3.4 IA invoice PDF: `POST /api/invoice/generate`
File: `models/hr/invoice.js`. **No permission check.**
- **Seller is fixed:** INTUTE-AI TECHNOLOGIES (OPC) PVT. LTD., GST `09AAHCI7346B1ZK`, plus registered and office addresses, tagline "AI | EV | CLEANTECH". The RTGS block hardcodes the HDFC Bank account, branch, type and IFSC.
- **Input:**
  - Required: `invoiceNumber`, `billing.name`, and `items:[{description, qty, rate}]` (at least one item with a description).
  - Optional: `date`, `orderNo`, `orderDate`, `billing.{address, phone, email, gst}`, `hsn`, `vendorCode`, `gstPercent` (default **18**).
- **Totals:**
  - `line = qty × rate`
  - `totalAmount = Σ line`
  - `gstAmount = totalAmount × gstPercent/100` (a single GST line, no CGST/SGST/IGST split)
  - `grandTotal = round2(total + gst)`
  - Words: `INR <words(round(grandTotal))>`.
- **PDF layout (bordered grid, A4):**
  1. Logo and company header, then the INVOICE title bar.
  2. "To," billing block next to the meta rows (Invoice No., Date, Order No., Order Date). Cell heights are measured so long values wrap.
  3. HSN and Vendor code row.
  4. Item table: Sr, Description, Qty, Unit Rate, Total. Page breaks reserve space for the trailing totals, RTGS and signature blocks.
  5. Totals, GST, TOTAL rows, then amount in words.
  6. RTGS details.
  7. Signature block: the stamp is sized from the PNG's real IHDR dimensions, followed by "For {company}".
  8. Footer addresses and tagline.
- **Socket:** `invoice:generated`.

### 3.5 Invoice records: `/api/invoice-records`
File: `models/hr/invoiceRecords.js`. **No permission check** (authenticateToken only).

**Purpose:** the persisted register of IA invoices. It holds both system-generated invoices and uploaded legacy PDFs.

**Endpoints:** `GET /` (cursor, search on number or billing name), `POST /` (create generated), `POST /upload` (multipart `file`, PDF only, 10 MB), `GET /:id`, `GET /:id/pdf`, `DELETE /:id`.

**Table `invoices`:**
- `invoice_id`, `invoice_number` (unique), `invoice_date`, `order_no`, `order_date`.
- `billing_name`, `billing_address`, `billing_phone`, `billing_email`, `billing_gst`.
- `hsn`, `vendor_code`, `gst_percent`, `items` (JSONB).
- `total_amount`, `gst_amount`, `grand_total`.
- `created_by`, `source` (`generated` | `uploaded`), `drive_file_id`, timestamps.
- Dates are always read back via `to_char` to avoid IST/UTC shifting (documented in-code).

**Generated flow:**
- Validates the input (items need a description *and* qty > 0) and uses the same totals formula.
- Renders the PDF to a buffer and makes a **best-effort private** Drive backup (`uploadBufferToDrivePrivate`, no public permission). A Drive failure does not block saving.
- If the insert then fails (for example a duplicate invoice number, which returns "Invoice number "X" already exists"), the Drive file is trashed to avoid orphans.

**Uploaded flow:**
- Requires `invoiceNumber`, `date`, `customerName` and `grandTotal > 0`.
- Validates the `%PDF-` magic bytes.
- Drive upload is mandatory because Drive holds the only copy.
- Stores `gst_percent 0`, `items []`, and `total = grand_total`.

**`GET /:id/pdf`:** generated invoices are **re-rendered on the fly** from stored data. Uploaded ones are streamed from private Drive (`streamFileToDrive`).

**Delete:** removes the row and trashes the Drive file (best effort).

**Socket:** `invoice_records:created`, `invoice_records:deleted`.

**Pagination:** the cursor is `"<id>:<created_at text>"`, split on the **first** colon, with a text comparison.

---

## 4. Operations

### 4.1 Activities (task manager): `/api/activities`
Files: `routes/operations/activities.js`, controller, `models/operations/activities.js`.

**Access:** a router-level allow-list `ALLOWED_ROLES = [9, 10, 11, 12]`. Any other role gets 403 "Not authorized to access activities". No `checkPermission` is used.

**Org model:** each activity has `org` ∈ {`com`, `ia`}, derived from the creator's role (9/10 → `com`, 11/12 → `ia`). List queries are scoped by org.

**Role rules (Compage employee, role 9):**
- Cannot create (403) or delete (403).
- The list shows only activities assigned to them.
- Update may change **only `status`**, which must be one of `todo`, `in_progress`, `done`.
- Roles 10, 11 and 12 see and manage all activities in their org.

**Tables:**
- `activities`: `id`, `summary`, `status` (default `todo`), `due_date`, `priority` (default `medium`; templates know `low`, `medium`, `high`, `urgent`), `comments`, `org`, `created_by`, timestamps.
- `activity_assignees`: `activity_id`, `user_id`, `assigned_at`.

**Behaviour:**
- Create and update are transactional.
- Update replaces the assignee set when `assignee_ids` is supplied.
- FK violation `23503` is mapped to "Assignee user not found".

**Email:** on create, **for the IA org only**, each assignee receives a "New Task Assigned to You" email (`generateNewTaskAssignmentHtml`, link `https://intute.biz/activities/<id>`), sent asynchronously in `setImmediate`.

**Redis:**
- List key `activities_list_<limit>_<cursor|initial>_user_<id>` (role 9) or `_role_<roleId>`.
- Item key `activities_<id>`. TTL 300 s.
- Every write invalidates `activities_*` via `SCAN`.

**Socket.IO:** `activities:created`, `activities:updated`, `activities:deleted`.

**Gaps:**
- `GET /:id`, `PUT /:id` and `DELETE /:id` do **not** check org or assignment. A Compage employee can read, or status-update, any activity by id, including other-org activities.
- The list cursor is built from `created_at` (an ISO string containing colons) and parsed with `cursor.split(':')`. The timestamp is truncated, so pages after the first are unreliable.
- The create path builds the assignee INSERT by string interpolation, with ids filtered through `Number.isFinite`.

### 4.2 Customer queries (support tickets): `/api/queries`
Files: `routes/operations/queries.js`, `controllers/operations/queries.controller.js`, **`services/queryService.js`** (the logic). `models/operations/query.js` is an older, unused model.

**Endpoints** (authenticateToken only):
- `GET /` (limit/offset)
- `POST /` `{description}`
- `PUT /:id/respond` `{response}`
- `PUT /:id/in-progress`
- `PUT /:id/close`

**State machine:** `Open` → `In Progress` (on any response, or explicit set-in-progress) → `Closed`.
- Responding to, or setting in-progress, a Closed query gives 400.
- Setting in-progress when it is already In Progress gives 400.
- Closing an already-closed query gives 400.
- Role 2 (customer, by inference) may close only its own query (403 otherwise).

**Visibility:** roles 1 and 5 (admin, and role 5) see all queries. Everyone else sees only their own.

**Tables:**
- `queries`: `query_id`, `user_id`, `query_text`, `query_status`, `date_of_query_raised`, `last_updated`.
- `query_responses`: `query_id`, `responded_by`, `response`, `response_date`.

Each mutation uses a transaction with `SELECT ... FOR UPDATE`. `closeQuery` runs its UPDATE on `pool` rather than the locked client, which is a minor inconsistency.

**Errors:** `QueryError(message, statusCode)`, handled by a router-local error middleware.

**Redis:** key `queries:<user>:<limit>:<offset>`, TTL 3600 s. However, `getQueries` **deletes the key before reading it**, so caching is effectively disabled. Writes run `delPattern('queries:*')`.

**Socket:** `newQuery` emitted to room `user:<id>` and `queryUpdate` to `user:<ownerId>`. Since no socket ever joins rooms, these are not delivered.

**Other gap:** `getQueries` logs the full result set at info level.

### 4.3 Problems / solutions knowledge base: `/api/problems`
Files: `routes/operations/problems.js`, controller, `models/operations/Problem.js`. Permission module `Problems`.

**Purpose:** records product problems and the solutions attempted (with a success flag). It works as a troubleshooting log per inventory product.

**Endpoints:**
- `GET /` (limit ≤100, offset): each problem with a JSON-aggregated `solutions` array ordered by `attempted_at`.
- `POST /` `{product_id, problem_description}`
- `POST /:id/solutions` `{solution_description, is_successful}`

**Tables:**
- `problems`: `id`, `product_id`, `problem_description`, `created_at`.
- `problem_solutions`: `solution_id`, `problem_id`, `solution_description`, `is_successful` (default false), `attempted_at`.

**Redis:** `problems_<limit>_<offset>_<user_id>`, TTL 300 s. Writes invalidate only the *acting user's* keys, so other users' caches stay stale for up to 5 minutes.

**Socket:** `problem:created`, `solution:created`.

---

## 5. Chatbot (`chatbot/`)

**How it works:** purely **rule-based, exact-phrase matching. No LLM or NLP** (no OpenAI or Anthropic dependency anywhere in `chatbot/`).
- **Pipeline:** route → `*ChatbotService.handle(message, user)` → `detectIntent` → model query → formatter.
- **`detectIntent`** (`chatbot/utils/*Intents.js`) trims and lower-cases the message, collapses whitespace, and looks it up in a fixed `INTENTS` dictionary. An unknown phrase returns `{success:false, response:"I didn't understand that. Try commands like …"}`.
- **Formatters** (`chatbot/utils/*Formatter.js`) build plain-text, newline-separated answers (e.g. `Order 12 - Customer: X - Pending`).
- **Response:** `{ success, response, data }`.
- All routes are `POST` with body `{message}` and use authenticateToken only. There is **no role or permission filtering**, so any logged-in user can read company-wide order, invoice and stock figures.
- Results are typically capped at 10 rows.

| Endpoint | Supported phrases (intents) |
|---|---|
| `POST /api/orders/chatbot` | show all / recent / pending / processing / testing / ready for shipment / shipped / partially delivered / delivered / cancelled orders; count orders by status |
| `POST /api/customer-invoices/chatbot` | show all / recent invoices; count total invoices; show high value invoices (≥ ₹50,000); show invoices this month; total invoice value; show monthly invoice trend (last 6 months) |
| `POST /api/customers/chatbot` | show all / recent customers; count total customers; top customers by orders; customers with no orders; customers by city; customer order breakdown |
| `POST /api/inventory/chatbot` | show all products; low stock (0 < qty ≤ 10); out of stock; count; top by stock; products with holds (reserved qty); inventory value |
| `POST /api/stock/chatbot` (raw materials) | all; low (stock < qty_required); out of stock; count; by location; most needed (qty_required − stock); raw material value |
| `POST /api/bom/chatbot` | show all BOMs; count total BOMs; most complex (by material count); recently updated; high value (by total BOM value) |

---

## 6. Background jobs (`jobs/`), email, Drive, logger

Jobs are loaded only when `server.js` is run directly (`require.main === module`), so tests do not start cron timers. All use `node-cron` with `timezone: 'Asia/Kolkata'`.

| File | Schedule (IST) | What it does |
|---|---|---|
| `jobs/daily-task-summaries.js` | 09:00 (morning), 18:30 (evening) | For a **hard-coded user list `user_id IN (45, 69, 70, 71, 72, 73)`**: emails each user their pending activities (and, in the evening, those completed today, i.e. `status='done'` with `updated_at` today). Sends the manager (`MANAGER_DAILY_REPORT_EMAIL`, greeted as "Akshay") a combined report. |
| `jobs/daily-due-reminders.js` | 11:00 daily | Finds activities with `due_date = tomorrow` and status `todo`/`in_progress`, groups them by assignee email, and sends one reminder per person (`generateDueTomorrowReminderHtml`). Runs every day, including Sunday. |
| `jobs/attendanceSummary.js` | 10:00 check-in summary, 19:30 check-out summary | Emails the manager today's `present` check-ins, then check-outs with hours worked (`Xh Ym`) and "still active" employees. **Excludes** user_ids 45, 69-73. |

- The "weekend" skip (`isWeekendIST`) checks only `getDay() === 0`, so the summary jobs run **Monday-Saturday** and skip Sunday only. A log message says "weekdays".
- Manager name and user ids are hard-coded.

**`services/email.js`:**
- Nodemailer with `service: 'gmail'`, `EMAIL_USER` / `EMAIL_PASS` (app password). The transporter is verified at load.
- `sendEmail({to, subject, text, html})` validates its inputs. It sends from `"Task Manager" <EMAIL_USER>`. It **returns true or false and never throws**; failures are only logged.

**`utils/emailTemplates.js`** (858 lines): inline-styled HTML email builders.
- The five builders are:
  - `generateDueTomorrowReminderHtml`
  - `generateDailyTaskSummaryHtml`
  - `generateNewTaskAssignmentHtml`
  - `generateAttendanceCheckInSummaryHtml`
  - `generateAttendanceCheckOutSummaryHtml`
- A shared `getPriorityBadge` gives colour-coded badges: Low, Medium, High, Urgent.
- Links point to `https://intute.biz/...`.
- Values are interpolated **without HTML escaping**.

**`services/googleDrive.js`:**
- `googleapis` with service-account auth. The key comes from `GOOGLE_SERVICE_ACCOUNT_PATH` (default `secrets/drive-sa.json`). The scope is full `drive`. The target folder is `GOOGLE_DRIVE_FOLDER_ID`, on a Shared Drive (`supportsAllDrives`).
- Functions:
  - `uploadBufferToDrive`: uploads, then grants `anyone: reader`. Returns `directUrl` (`uc?export=view`), `webViewLink` and `webContentLink`.
  - `uploadBufferToDrivePrivate`: no public permission. Used for invoices.
  - `streamFileToDrive(fileId, res)`: despite the name, it **streams a file from Drive to the HTTP response**, setting Content-Type and `Cache-Control: public, max-age=86400`.
  - `deleteDriveFile`: **trashes** rather than deletes. The service account has `canTrash` but not `canDelete` on the Shared Drive. Trash is auto-purged after 30 days.

**`utils/logger.js`:** Winston at level `info`, JSON format with timestamps. Transports: `logs/error.log` (errors only), `logs/combined.log`, and the console. There is no rotation.

---

## 7. Tests (`tests/`)

**Runner:** Jest 29 (`npm test` → `jest`), with Babel transform-ignore exceptions for htmlparser2 and related packages. Per project memory, `*.test.js` is gitignored but the files are tracked, so new tests need `git add -f`.

There are 28 files and about 340 test cases, concentrated on the **PDI (pre-dispatch inspection) module and auth**:

| Area | Files (approx. # tests) | Style |
|---|---|---|
| Auth | `auth.test.js` (5: signup, login, password change/validation), `auth_permission.test.js` (8: `hasPermission`, `checkPermission`), `auth_token_lifetime.test.js` (2: PDI mobile app `X-App-Version` gets a 12 h token, others 1 h), `pdi_auth_unavailable.test.js` (3: DB failure must not look like an invalid token) | auth.test is integration (supertest); the others mock the DB |
| Sales enquiry | `enquiry_controller.test.js` (9), `enquiry_model.test.js` (18): representative role scoping, photo upload ownership | mocked |
| Manufacturing | `iptKits.test.js` (9): create with auto serial, duplicate-serial field error, reverse search, cursor pagination with no gaps or overlaps, update, delete freeing serials, next-serial preview and set | **integration against a real DB** (inserts temporary admin role-1 and production role-5 users, cleans up afterwards) |
| PDI reports and lots | `pdiReports`, `pdi_report_batches` (42), `pdi_lot_rules`, `pdi_finalize_pdf`, `pdi_finalized_edit`, `pdi_delete_report`, `pdi_photos_summary`, `pdi_inspection_date` | DB and Drive mocked |
| PDI templates and PDF | `pdi_template_renderer` (30), `pdi_primitives`, `pdi_generator`, `pdi_generator_combined`, `pdi_general_v1_0_8`, `pdi_autonxt_tolerance`, `pdi_autonxt_controller` (20), `pdi_tolerance`, `pdi_photo_optimizer`, `pdi_pdf_cache_prefix`, `pdi_admin` (16), `pdi_authored_templates`, `pdi_authored_template_adapter` | unit |

**Not covered by any test:** BOM, parts / part-code generation, part drawings, motor recipes, process / work orders, service repair, attendance, employee details, payslip, invoice / invoice records, activities, queries, problems, chatbot, cron jobs, email.

---

## 8. Migration scripts (`scripts/migrations/`)

Standalone Node scripts (`node scripts/migrations/<file>.js`). Each loads `.env`, runs idempotent DDL (`IF NOT EXISTS`) through `config/db`, then calls `pool.end()`. There is no migration framework or tracking table, and no other migrations directory exists (`migrations/` at the root is absent). The base schema for most modules is not in the repo.

| Script | Effect |
|---|---|
| `2026-09-04-add-pdi-report-content.js` | `pre_dispatch_inspection_reports`: adds `data JSONB DEFAULT '{}'`, `photos JSONB DEFAULT '[]'`, `template_id TEXT DEFAULT 'general'`, `drive_file_id TEXT` |
| `2026-09-08-add-pdi-templates.js` | creates `pdi_templates(id, version, name, status ∈ draft/active/archived, definition JSONB, created_by, created_at, PK(id,version))` with an index on (id, version DESC); adds `template_version INT` to reports |
| `2026-09-23-add-representative-role.js` | `enquiries`: adds `city TEXT` and `photos TEXT[] DEFAULT '{}'`. Ensures a `representative` role exists, first re-syncing `roles_role_id_seq` because explicit ids had collided in production. Grants `permissions(Enquiries: read+write, no delete)` |
| `2026-09-23-seed-representative-user.js` | seeds a test user `representative@compageauto.com` with password **`password123`** via `User.create`; idempotent on duplicate email |
| `2026-09-29-add-pdi-report-batches.js` | creates `pdi_report_batches(batch_id, template_id, pdi_no, lot_quantity, status DEFAULT 'In Progress', drive_file_id, created_by, created_at)`; adds `batch_id` FK and `lot_index` to reports |
| `2026-09-30-add-pdi-batch-shared-fields.js` | batches gain `customer_name`, `product_id`, `product_specifications`, `drawing_no`, `controller_type`. These lot-level fields are entered once and authoritative at render |
| `2026-09-30-add-pdi-report-revisions.js` | reports gain `revision_no INT DEFAULT 1`; creates `pdi_report_revisions(revision_id, report_id FK ON DELETE CASCADE, revision_no, data JSONB, edited_by, edited_at)`, which snapshots `data` before each edit of a Completed report (photos not snapshotted) |
| `2026-09-30-fix-autonxt-spec-display.js` | one-off **data** fix, supports `--dry-run`. Recomputes the 19 `spec_<id>_display` strings on every AutoNXT report from stored nominal and tolerance values, mirroring the web form's formula. Overwrites `data` with no version check, so it should run in a maintenance window |
| `2026-10-05-pdi-batch-indexes.js` | index `idx_pdi_reports_batch_id`; partial unique index `uq_pdi_reports_batch_lot_index (batch_id, lot_index) WHERE batch_id IS NOT NULL` |

Related startup behaviour (`server.js` `initializeServer`): any `pdi_report_batches` row left in status `Finalizing` (for example by a crash mid-render) is reset to `In Progress` at boot.

---

## 9. Consolidated known gaps / risks (from code)

1. **Parts code generation is not truly transactional**: it uses `pool.query('BEGIN')` instead of a dedicated client, so duplicate part codes are possible under concurrency.
2. **Missing authorisation:**
   - BOM, part drawings (both), payslip, invoice and invoice-records have no `checkPermission`.
   - Chatbot endpoints expose company-wide data to any authenticated user.
   - The activities `getById`, `update` and `delete` paths ignore org and assignment scope.
3. **Socket rooms are never joined**, so query notifications sent to `user:<id>` rooms are never delivered.
4. **Cache defects:**
   - The queries cache is deleted before every read.
   - The process cache key uses `req.user.userId` (undefined).
   - Problems invalidation is per-user only.
   - Wide use of blocking `KEYS`.
5. **Status-code inaccuracies:**
   - BOM not-found returns 500.
   - Part-drawing not-found returns 400.
   - Activities pagination cursor splits an ISO timestamp on `:`.
6. **Drive hygiene in service repair:**
   - Uploads become public before the record is validated (orphan on 404).
   - Removing a photo does not trash the Drive file.
   - The `proxyImage` handler is unrouted.
7. **Dead or unrouted code:** `Process.upsertProcessMaterialUsage` / `getProcessMaterialUsage`, `models/operations/query.js`.
8. **Hard-coded operational data:** cron user ids (45, 69-73), manager name "Akshay", the invoice seller GST and bank details, and the payslip company address.
9. **Emails are not HTML-escaped.** The "weekend" skip excludes Sunday only.
10. **No automated tests** for manufacturing (except IPT kits), service, HR, operations, chatbot or jobs.
11. **Seed script contains a default password** (`password123`) for a test representative account.
