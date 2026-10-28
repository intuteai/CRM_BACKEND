# CRM_BACKEND: Auth, Core, Sales, Invoicing and Dispatch modules (technical notes)

All paths are relative to `CRM_BACKEND/`. Layout: `routes/<domain>/*.js` -> `controllers/<domain>/*.controller.js` -> `models/<domain>/*.js`. Mounts live in `server.js`.

## 0. Cross-cutting plumbing that these modules rely on

- **Socket.IO**: `server.js` creates one `Server` (path `/socket.io`, CORS = `FRONTEND_URL`), stores it with `app.set('io')` / `app.set('socketio')`, and a global middleware sets `req.io = io` on every request. The connection handler only logs connect/disconnect. **No code joins sockets to rooms**, so the `io.to('user_<id>').emit('notification', …)` calls in the enquiry model reach no one unless a room join exists elsewhere (none found in `server.js` or `config/socket.js`). `config/socket.js` (`initSocket`) is a second, unused factory.
- **Routers that override `req.io`**: `routes/sales/quotation.js`, `proforma.js`, `purchaseOrder.js`, `routes/dispatch/deliveryChallan.js` and `iaOrders.js` reset `req.io = req.app.get('io')` and then set `req.io.user = req.user`. Because `io` is a process-wide singleton, `io.user` is shared state. Concurrent requests can overwrite it, and the IA Orders model reads `io.user.user_id` as `created_by` (race condition).
- **Auth middleware** (`middleware/auth.js`):
  - `authenticateToken` reads only `Authorization: Bearer <jwt>`. The README says cookies are also accepted, but the code does not do that.
  - It verifies with `JWT_SECRET`, then re-loads the user and `role_name` from `users`/`roles` on every request.
  - Error codes: `AUTH_NO_TOKEN` (401), `AUTH_INVALID_TOKEN` (403), `AUTH_INVALID_USER` (403), and `AUTH_UNAVAILABLE` (503) when the DB lookup fails. A DB error is deliberately not treated as a bad token, so clients do not log the user out.
  - `checkPermission(module, action)` runs `SELECT <action> FROM permissions WHERE role_id AND module`, maps `can_create` to `can_write`, and returns `PERM_DENIED` (403) or `PERM_CHECK_FAILED` (500).
- **Redis** (`config/redis.js`): node-redis v4 client, `REDIS_URL` (default `redis://localhost:6379`). It exposes a `delPattern` helper, but most controllers do `redis.keys(pattern)` + `del` inline. Several controllers call `redis.del('<prefix>_*')` with a literal wildcard string. `DEL` does not expand globs, so those calls invalidate nothing (details per module below).
- **Google Drive** (`services/googleDrive.js`): service account key at `GOOGLE_SERVICE_ACCOUNT_PATH` (default `secrets/drive-sa.json`), scope `drive`, target folder `GOOGLE_DRIVE_FOLDER_ID`.
  - `uploadBufferToDrive` creates the file (`supportsAllDrives`), grants `anyone:reader`, and returns `directUrl = https://drive.google.com/uc?export=view&id=<id>` plus view and download links.
  - `uploadBufferToDrivePrivate` (no public permission), `streamFileToDrive` (proxies a file to the response with `Cache-Control: public, max-age=86400`), and `deleteDriveFile` also exist. `deleteDriveFile` *trashes* the file rather than deleting it, because the service account lacks `canDelete` on the Shared Drive.
- **Body limit**: `express.json({ limit: '40mb' })`, sized for the PDI generator. `trust proxy = 1` (single nginx hop) is set so the global IP rate limiter can see real client IPs.

---

## 1. Auth (`routes/auth.js`, `controllers/auth.controller.js`, `models/core/user.js`)

**Purpose:** credential login and JWT issuance for all 14 role IDs.

| Endpoint | Behaviour |
|---|---|
| `POST /api/auth/login` | Requires `email` + `password` (else 400 `AUTH_MISSING_FIELDS`). Looks up `users JOIN roles` by email. If the user is not found or bcrypt compare fails, returns 401 `AUTH_INVALID_CREDENTIALS` (the same message for both). If `password_hash` is null, returns 500 `AUTH_NO_PASSWORD`. Returns `{ role, token, name, user_id }`. |
| `GET /api/auth/verify-token` | Echoes `req.user` (populated by the middleware). |
| `GET /api/auth/user` | Returns `{ name }`, or 404 `USER_NOT_FOUND`. |
| `POST /api/auth/logout` | Stateless: logs and returns a message. There is no token blacklist. |
| `PUT /api/auth/update-password` | `User.updatePassword`: old password must match (401 `AUTH_INVALID_OLD_PASSWORD`), new password must be at least 6 characters (400 `AUTH_PASSWORD_TOO_SHORT`), bcrypt cost 10. |

- **JWT payload:** `{ user_id, role_id, name }`, signed with `JWT_SECRET`.
- **Token TTL:** `1h` by default, `12h` if the request carries an `X-App-Version` header. The PDI mobile app sends this header so tokens do not expire mid-inspection. The comment notes the header is self-declared and only widens expiry for someone who already has valid credentials.
- **Role map** (`ROLE_MAP` in the controller):

  | ID | Role | ID | Role |
  |---|---|---|---|
  | 1 | admin | 8 | accounts |
  | 2 | customer | 9 | employee |
  | 3 | sales | 10 | hr |
  | 4 | design | 11 | ia_employee |
  | 5 | production | 12 | ia_hr |
  | 6 | store | 13 | service_repair |
  | 7 | dispatch | 15 | representative |

  There is no role 14. Any unmapped role ID returns `'unknown'`.
- **`User.create`** (used by customer creation):
  - Runs inside its own client transaction.
  - First runs `setval('users_user_id_seq', GREATEST(MAX(user_id)+1, nextval(...)))` to resync the sequence.
  - Inserts the user with default `role_id = 2`. If no password is given, it uses a hard-coded default bcrypt hash.
  - Maps `23505` on `users_email_key` to 400 `DUPLICATE_EMAIL`, and on `users_pkey` to 500 `USER_ID_CONFLICT`.
  - Also signs a 1h JWT that the customer-create flow does not use.

---

## 2. Core

### 2.1 Customers (`routes/core/customers.js`, `controllers/core/customers.controller.js`, `models/core/customer.js`)

**Purpose:** customer master. Each customer is a `users` row (role 2) plus a `customers` row (contact, GST, addresses).

- **Endpoints:**
  - `GET /api/customers/search?q=` (auth only, no permission check): `ILIKE` on `users.name`, limit 20.
  - `GET /api/customers` (`Customers.can_read`): paginated, with `limit` capped at 100 and a non-negative `offset`.
  - `POST /api/customers` (`Customers.can_create`).
- **Validation** (route middleware `validateCustomerInput`):
  - name at least 3 characters; contact_person at least 3 characters; city required.
  - phone matches `^[0-9]{10}$`; email matches a basic regex.
  - optional GST matches `^[0-9A-Z]{15}$`; shipping and billing addresses required.
  - All failures return 400 `VALIDATION_ERROR`.
- **Create flow:** `Customer.create` opens a transaction on its own client, but calls `User.create`, which uses a *separate* pooled connection and transaction. The user row therefore commits independently. If the `customers` insert then fails, an orphan user is left behind.
- **List query:** joins `customers`, `users`, `orders` and `queries` (LEFT JOINs) and returns `COUNT(DISTINCT order_id)` and `COUNT(DISTINCT query_id)` per customer.
- **Caching:** key `customers_<limit>_<offset>`, TTL 3600 s. On create, all keys matching `customers_*_*` are deleted and the `customerUpdate` socket event is emitted.
- **Unused method:** `Customer.update` exists in the model but no route uses it. It runs the customer and user updates in parallel with no transaction.

### 2.2 Users (`routes/core/users.js`, `controllers/core/users.controller.js`)

- `GET /api/users/customers` (`Customers.can_read`): all users with `role_id = 2`, as `user_id, name`.
- `GET /api/users/employees-hr`: returns team members within the caller's organisation.
  - IA roles [11, 12] see users with roles 11 and 12.
  - Compage roles [9, 10] see users with roles 9 and 10.
  - Any other role gets 403.

### 2.3 Orders (`routes/core/orders.js`, `controllers/core/orders.controller.js`, `models/core/order.js`)

**Purpose:** customer sales orders for finished goods (`inventory` products), with inventory reservation (holds) and stock consumption at dispatch.

**Endpoints**

| Method / path | Permission | Notes |
|---|---|---|
| `GET /api/orders` | `Orders.can_read` | Keyset pagination on `created_at` (`cursor`, `limit` up to 100). Admin (1), production (5) and sales (3) see all orders; other roles see only their own (`user_id`). |
| `GET /api/orders/export` | `Orders.can_read` | CSV export (declared before `/:id`). No cache; fetches up to 100000 rows under the same visibility rules. Columns: Order ID, Customer Name, Items (`name (Qty: n)` joined with `; `), Total Amount (INR), Status, Status Reason, Target Delivery, Payment Status, Created At. Every field is double-quote escaped. Sets the `X-Total-Exported` header and the filename `orders_export_YYYY-MM-DD.csv`. |
| `POST /api/orders` | `Orders.can_write` | Admin and sales may pass `user_id` to order on a customer's behalf; other roles always order for themselves. Requires a non-empty `items`. |
| `PUT /api/orders/:id/update` | `Orders.can_write` + controller role check {1, 5, 3} | Rejects `status: 'Cancelled'`. `payment_status` must be `Pending` or `Paid`. An empty `items` array is rejected. |
| `POST /api/orders/:id/cancel` | `Orders.can_write` | Body `{ goods_returned }`. |

**Status state machine** (`STATUS_RANK` in `models/core/order.js`)

| Status | Rank |
|---|---|
| Pending | 0 (initial) |
| Processing | 1 |
| Testing | 2 |
| Ready for Shipment | 3 |
| Shipped | 4 (dispatch threshold) |
| Partially Delivered | 5 (requires `status_reason`) |
| Delivered | 6 |
| Cancelled | not ranked; terminal; only via `cancelOrder()` |

- Both the old and new status must be ranked, otherwise the update fails with `Invalid status transition`.
- **Downgrades** are blocked only once the old rank is at least Shipped. Before shipping, moving backwards (for example Testing to Processing) is allowed.
- **Line items** become immutable once the order is at Shipped or later. The comparison sorts the incoming items by product and compares product, quantity and price against the stored rows.
- **Errors:** the controller maps all update and cancel errors to HTTP 400 (create uses `error.status || 400`).

**Inventory holds (reservation)**

- **On create** (single transaction): `checkInventoryAvailability` computes `stock_quantity - SUM(active holds)` per product, but only logs warnings. **Negative stock is allowed.** The flow then:
  1. inserts the order with status `Pending` and payment status `Pending`;
  2. bulk-inserts `order_items` via `unnest`;
  3. inserts one `inventory_holds` row per item with `reason='Order fulfillment'`, `reference_type='ORDER'`, `reference_value=<order_id>`, `status='ACTIVE'`.
- **On item change** (before shipping): releases the order's active holds (`status='RELEASED'`, `released_at=NOW()`), deletes and re-inserts the items, and creates new holds.
- **Dispatch hook:** fires the first time the rank crosses from below 4 to 4 or above, including direct jumps such as Testing to Delivered. It:
  - runs `UPDATE inventory SET stock_quantity = stock_quantity - qty` for every item (may go negative; negatives are logged as a warning);
  - releases the holds;
  - emits `stockUpdate { product_id, stock_quantity }` per product.
- **Cancel rules:**
  - Only admin or the order owner may cancel (otherwise `Unauthorized`).
  - An already-cancelled order is rejected.
  - A Delivered order needs `goods_returned=true`.
  - Shipped or Delivered with goods returned: stock is added back and `stockUpdate` is emitted.
  - Not shipped: holds are released.
  - Shipped or Delivered without goods returned: nothing is restocked; the code comment says to use the inventory `accept-return` endpoint later.
  - **Gap:** `wasShipped` only checks `Shipped`/`Delivered`, so cancelling a `Partially Delivered` order takes the "never shipped" branch. It releases (already released) holds and does not restore stock.
- **Invoice event:** create, update and cancel each look up `customer_invoices WHERE order_id` and emit `invoiceUpdate` if a row exists.

**Response shape and caching**

- Responses compute `totalAmount = Σ price × quantity` from `order_items`, include `timezone: 'Asia/Kolkata'`, and look up the customer name with one query per order (N+1).
- `GET` cache key: `orders_<limit>_<cursor|null>_<user_id>`, TTL 300 s. `force_refresh=true` bypasses it.
- After every write, `setImmediate` deletes `orders_*` and `inventory_*` keys.
- `Order.getAll` contains a leftover `console.log('Orders from DB:', …)` debug line.

**Status sync with dispatch:** the README (`README.md` around line 353) says `orders` and `dispatch_tracking_details` are kept in sync by bidirectional PostgreSQL triggers (`sync_orders_status` and `sync_dispatch_status`, with a loop guard). The trigger SQL is not in this repo; it lives only in the database.

**Tables:** `orders` (order_id, user_id, status, status_reason, target_delivery_date, payment_status, created_at), `order_items` (order_item_id, order_id, product_id, quantity, price), `inventory_holds`, `inventory`, `customer_invoices`.

### 2.4 Inventory: finished goods (`routes/core/inventory.js`, `controllers/core/inventory.controller.js`, `models/core/inventory.js`)

**Purpose:** finished-product master (`inventory` table) with stock, returnable quantity, manual holds and returns.

- **Rate limit:** the router applies `express-rate-limit` at 100 requests per 15 minutes per IP to all inventory routes.
- **Endpoints:**
  - `POST /` and `PUT /:id` (`Inventory.can_write`).
  - `GET /available` and `GET /check-part-number` (auth only).
  - `GET /` (`Inventory.can_read`).
  - `DELETE /:id`.
  - `POST /:id/hold` and `POST /hold/:hold_id/release`.
  - `GET /:id/holds`.
  - `POST /:id/accept-return`.
- **Numbering scheme:**
  - `product_code` must be exactly 11 characters. Its first 4 characters are the **Part Number** (`part_number` column, unique constraint `inventory_part_number_unique`; `product_code` is unique via `unique_product_code`).
  - `check-part-number` requires a 4-digit `part_number` and accepts an optional `exclude_id`.
  - With `part_number_auto`, after insert the controller rewrites the code prefix to `String(product_id).padStart(4,'0')`. If the product ID is above 9999, or the rewrite hits a unique violation, the response includes a `partNumberWarning` instead of failing.
- **Validation and sanitising:** product_name is required; stock and returnable_qty may not be negative; price must be 0 or more. Name, description and code are passed through `sanitize-html` with no tags allowed.
- **Update:**
  - `Inventory.update(..., isAdmin=true)` is always called. It overwrites every column directly, including `stock_quantity` and `returnable_qty`.
  - If the client omits those fields they are bound as `undefined`, which becomes NULL (or a constraint error).
  - When `price` is supplied, `syncPriceWithPriceList` updates `price_list.price` for that product.
  - Emits `stockUpdate` when stock or returnable quantity changed.
- **Delete guard:** refused when any `ACTIVE` hold exists or when `stock_quantity` or `returnable_qty` is non-zero. Deletes `RELEASED` holds first to avoid an FK violation, then emits `stockUpdate` with zeros.
- **Holds:**
  - `createHold` requires `quantity > 0` and a `reason`, and records `reference_type/value` and `created_by`.
  - `releaseHold` only releases `ACTIVE` holds; otherwise it returns 404 "Hold not found or already released".
  - Availability = `stock_quantity - SUM(ACTIVE holds)` (`getInventoryWithAvailability`). `/available` adds `available: available_quantity > 0`.
- **Accept return:** `qty` must be greater than 0 and no more than `returnable_qty`. Runs `stock_quantity += qty, returnable_qty -= qty` as a single UPDATE and emits `stockUpdate`. `returnable_qty` is raised by returnable Delivery Challans (see 5.2).
- **Caching:**
  - `inventory_<limit>_<offset>` and `inventory_availability_<limit>_<offset>`, both TTL 3600 s.
  - Writes delete `inventory_*`; hold changes delete only `inventory_availability_*`.
  - `redis.del('price_list_*')` is a literal-key delete and is ineffective.
- **Socket:** `stockUpdate { product_id, stock_quantity, returnable_qty }`.

### 2.5 Stock: raw materials (`routes/core/stock.js`, `controllers/core/stock.controller.js`, `models/core/stock.js`)

**Purpose:** raw-material master (`raw_materials` table) with location, required quantity, photo, and an audited adjustment log (`stock_adjustments`).

- **Validation:**
  - `validateStockInput`: productName (string); productCode is a string of exactly 11 characters; price is a number of 0 or more; stockQuantity and qtyRequired are numbers of 0 or more if present; location and imageUrl are strings. Failures return 400 `INVALID_INPUT`.
  - `validateAdjustInput`: `quantity` must be a number and may be negative; `reason` must be a string.
- **Part numbers:** same 4-digit prefix scheme as inventory, against `raw_materials.part_number` (constraints `raw_materials_part_number_unique` and `raw_materials_product_code_key`). Error codes `PART_NUMBER_TAKEN` and `DUPLICATE_CODE`.
- **Update:** `COALESCE` keeps the existing stock, image and returnable values when they are omitted, but `qty_required` defaults to 0 and `location` to NULL when omitted.
- **Photo upload:** `POST /:productId/photo`.
  - multer memory storage, **8 MB** limit, field `photo`.
  - Allowed types: JPEG, PNG, WebP, GIF.
  - Filename `raw_<id>_<timestamp>.<ext>`, uploaded with `uploadBufferToDrive` (public).
  - `image_url` is set to the Drive `directUrl` and `stockUpdate` is emitted.
- **Adjust:** `POST /:productId/adjust` runs `stock_quantity += quantity` and inserts into `stock_adjustments (product_id, quantity, reason, created_by, created_at)`.
  - **Bug:** `BEGIN`/`COMMIT`/`ROLLBACK` are issued with `pool.query`, so each statement may run on a different pooled connection. The adjustment and its log entry are therefore **not actually atomic**.
- **Delete:** `DELETE /:productId` requires `Stock.can_delete`, has no guards, and returns 204.
- **Caching:** none. **Socket:** `stockUpdate` (with `location` and `image_url`, or `status: 'deleted'`).

### 2.6 Reports (`routes/core/reports.js`, `controllers/core/reports.controller.js`)

- `GET /api/reports/order-summary` (`Reports.can_read`): per order, `item_count` and `total_amount = SUM(quantity*price)`. Uses an inner join to `order_items`, so orders without items are excluded. Paginated.
- `GET /api/reports/inventory-status`: inventory rows with `stock_quantity < 10`, ascending.

### 2.7 Dashboard (`routes/core/dashboard.js`, `controllers/core/dashboard.controller.js`)

- Eight role-specific endpoints (`/sales-dashboard`, `/admin-dashboard`, …) each check `dashboard.can_read` and then require an exact `role_id` match (403 `PERM_DENIED` otherwise). Each only returns `{ dashboard: '<name>' }`, so they act as access probes.
- `GET /api/dashboard`: checks `permissions(module='dashboard').can_read` and maps roles 1 to 8 to a dashboard name. Other roles get 403 `INVALID_ROLE`.
- `GET /api/dashboard/admin-stats` (admin only) runs four counts in parallel:
  - open orders: `COALESCE(status,'Pending') NOT IN ('Delivered','Cancelled')`;
  - pending queries: `COALESCE(query_status,'Open') <> 'Closed'`;
  - low stock: `COALESCE(stock_quantity,0) < 10`;
  - dispatches today: `dispatch_tracking_details.dispatch_date::date` equals today in **IST** (`NOW() AT TIME ZONE 'Asia/Kolkata'`).

---

## 3. Sales

### 3.1 Enquiry, the CRM lead pipeline (`routes/sales/enquiry.js`, `controllers/sales/enquiry.controller.js`, `models/sales/enquiry.js`)

**Purpose:** capture and track sales leads, assign them between Sales, Design and field Representatives, keep a comment/activity thread, and track pipeline stage.

**Endpoints** (all require `Enquiries.*` permissions)

| Endpoint | Purpose |
|---|---|
| `GET /templates` | Global comment templates (`comment_templates WHERE is_global`). |
| `GET /representatives` | Users whose role name is `representative`. |
| `POST /refresh` | Deletes `enquiry_*` and `enquiry_list_*` cache keys. |
| `POST /`, `GET /`, `GET /:id`, `PUT /:id`, `DELETE /:id` | CRUD. |
| `POST /:id/assign` | Reassign (`assigned_to` required). |
| `POST /:id/mark-done` | Design hands the enquiry back to Sales. |
| `POST /:id/comment` | Add a comment with mentions. |
| `PATCH /:id/stage` | Pipeline stage change. |
| `POST /:id/follow`, `DELETE /:id/follow` | Watchers (`enquiry_watchers`, `ON CONFLICT DO NOTHING`). |
| `POST /:enquiryId/activity/:activityId/read` | Read receipt (`enquiry_read_receipts`, upsert `read_at`). |
| `POST /:id/photo`, `DELETE /:id/photo` | Photo array management. |

**ID scheme**

- If no `enquiry_id` is supplied, it comes from the DB function `SELECT get_next_enquiry_id()` (not defined in this repo).
- If that call fails, the fallback is `ENQ<year><random 4 digits>`.
- A duplicate ID raises `23505`, returned as 400 `DUPLICATE_ENQUIRY_ID`.

**Status, lead and stage**

- **`status`** is one of `Pending`, `In Progress`, `Closed`, `Cancelled`. Invalid input is normalised to `In Progress` when assigned, `Pending` otherwise.
- **`lead`** (exposed as `priority`) is one of `hotlead`, `followup`, `lead`, `not_interested`, `closed`, lower-cased; the default is `lead`.
- **`stage`:**
  - Initial value is `new`, or `in_discussion` if the enquiry is created already assigned.
  - Valid values for `changeStage` and the status each one sets:

    | Stage | Resulting status |
    |---|---|
    | closed_won | Closed |
    | closed_lost | Closed |
    | regret | Cancelled |
    | in_discussion | In Progress |
    | design_review | In Progress |
    | admin_review | In Progress |

  - A stage change also adds a comment (the note, or "Stage changed to …") and emits `enquiryUpdate` with `type: 'stage_change'`. No transition-order rules are enforced.

**Ownership and visibility**

- Roles whose name contains `design` or `representative` only see and mutate enquiries where `assigned_to` is their own ID.
- This applies to `getAll`, `getById` and every mutating method via `assertMutationAllowed`. A failure throws `Forbidden`, returned as 403 `FORBIDDEN`.
- A representative creating an enquiry without an assignee gets it auto-assigned to themselves.

**Assignment and hand-off**

- **`assign`** (transaction):
  - sets `assigned_to`, `assigned_by`, `assigned_at=NOW()`, `due_date`, `stage='in_discussion'`, `status='In Progress'`;
  - inserts an `enquiry_activities` row of type `assignment` with mentions `[assigned_to]`;
  - emits `enquiryUpdate` (`type: 'assigned'`) and, to room `user_<id>`, `notification`.
- **`mark-done`:**
  - Only roles whose name contains `design`, and only the current assignee.
  - In a transaction with `SELECT … FOR UPDATE` row locking, it reassigns the enquiry to the default Sales user `DEFAULT_SALES_USER_ID` (environment variable, fallback **7**) and logs an assignment activity ("Design completed work and returned enquiry to Sales").
  - `enquiryUpdate` is emitted twice: once by the model and once by the controller.

**Comments and other behaviour**

- **Comments:** `enquiry_activities(activity_type='comment', message, mentions int[], expected_by, is_internal)`. Emits `enquiryActivity { enquiryId, activity }` plus a `notification` (`type: 'mention'`) to each mentioned user's room.
- **Overdue check:** `checkOverdue(io)` posts an "overdue by N hours" system comment if the due date has passed, the stage is not closed, and no overdue message was posted in the last hour. **It is never called anywhere in the repo** (dead code).
- **Delete:** a transaction deletes `enquiry_activities`, then `enquiries`, and emits `enquiryUpdate { type: 'deleted' }`.
- **Search:** `LOWER(...) LIKE` across id, company, contact, mail, phone, items, status and application. Ordered by `created_at DESC`, with a `LIMIT/OFFSET` page plus an optional `created_at` cursor.
- **Photos:**
  - multer memory storage, **10 MB**, JPEG/PNG/WebP/GIF.
  - Filename `enquiry_<id>_<ts>.<ext>`, uploaded with public `uploadBufferToDrive`, then `photos = array_append(...)`.
  - Removal runs `array_remove` on the URL only; the Drive file is not deleted.

**Caching:** list key `enquiry_list_<user>_<limit>_<offset>_<search|all>`, single-record key `enquiry_<user>_<id>`, both TTL 300 s. Mutations delete `enquiry_*_<id>` and `enquiry_list_*`. Create only clears the list keys.

**Tables:** `enquiries` (enquiry_id, company_name, contact_person, mail_id, phone_no, items_required, source [default 'Website'], application, lead, tags[], stage, status, assigned_to/by/at, due_date, last_discussion, next_interaction, created_by, city, photos[], timestamps), `enquiry_activities`, `enquiry_watchers`, `enquiry_read_receipts`, `comment_templates`.

### 3.2 Enquiry Requirements (`routes/sales/enquiryRequirements.js`, `controllers/sales/enquiryRequirements.controller.js`, `models/sales/enquiryRequirements.js`)

**Purpose:** structured technical requirements attached to an enquiry, including motor specifications.

- **Tables:**
  - `enquiry_requirements` (id, enquiry_id, title, description, requirement_type, priority [default `medium`], status [default `open`], assignee_id, due_date, attachments, metadata, created_by, updated_by, timestamps).
  - `enquiry_requirement_motors` (requirement_id, application, power_rating, motor_voltage, motor_rpm, motor_max_rpm, motor_type, em_brake bool, em_brake_voltage, shaft_type, gvw, controller, controller_text).
- **Validation:** route middleware `validateMotorType`: `motors` must be an array and `motor_type` must be `BLDC` or `PMSM` (or null).
- **Endpoints:** `GET /` with filters `enquiryId`, `status`, `priority`, `assigneeId`, plus CRUD. `GET /:id?includeMotors=true` also returns the motors.
- **Create/update with motors:** both run in a transaction. Update *replaces* all motors when a `motors` array is supplied: it deletes them and runs a multi-row parameterised INSERT (13 parameters per motor).
- **Single-motor endpoints:** `/:requirementId/motors` (list, add) and `/motors/:motorId` (update, delete). `updateMotor` builds a dynamic SET from the provided fields and throws 'Nothing to update for motor' when the patch is empty.
- **Socket events:** `enquiryRequirement:created`, `:updated`, `:deleted`, `:motors:added`, `:motors:updated`, `:motors:deleted`. No caching.

### 3.3 Price List (`routes/sales/priceList.js`, `controllers/sales/priceList.controller.js`, `models/sales/priceList.js`)

**Purpose:** sales price per finished product, kept in sync with `inventory.price`.

- **Read:** `GET` (`PriceList.can_read`) joins `price_list` to `inventory` (inner join, so rows without a product are hidden), with an optional `search` (`ILIKE` on price_id or description). Ordered by `created_at DESC`.
- **Create/update** (transaction): write `price_list`, then `UPDATE inventory SET price` for the product. Update merges the supplied fields over the current row. The reverse sync from inventory edits lives in `Inventory.syncPriceWithPriceList`.
- **Delete:** removes only the price row; the inventory price is left as is.
- **Caching:** key `price_list_<limit>_<offset>_<search>`, TTL 300 s. Writes delete `price_list_*` and `inventory_*`.
- **Socket:** `priceListUpdate { type: CREATE|UPDATE|DELETE, item|itemId, timestamp }`.
- **Errors:** all write errors return 400 `INVALID_INPUT`, including not-found.

### 3.4 Quotation, Proforma Invoice, Purchase Order: stateless PDF generators

All three are `POST /api/<doc>/generate` behind `authenticateToken` only (**no `checkPermission`**). They take the full document data in the JSON body, **persist nothing**, and stream a PDFKit A4 PDF back as an attachment. Fonts are Roboto Regular/Bold (Quotation also Medium) from `assets/fonts/`, falling back to Helvetica. Images come from `assets/` (`compage_header_left/right.png`, `compage_signature.png`; Quotation also falls back to `/mnt/data/`). None of them upload to Drive.

| | Quotation (`models/sales/quotation.js`) | Proforma (`models/sales/proforma.js`) | Purchase Order (`models/sales/purchaseOrder.js`) |
|---|---|---|---|
| Required field | `quotation_no` | `proforma_no` | `po_no` |
| File name | `QUOTATION_<safe>.pdf` | `PROFORMA_<safe>.pdf` | `PO_<safe>.pdf` |
| Margin | 36 | 18 (outer bordered box) | 36 (single outer box) |
| Item columns | S.No, Description, HSN Code, Qty, Unit Price (₹), Total Price (₹) | S.No, Description, Qty, Rate, Total | S.No, Description, Qty (KG), Unit price, Total Price, Discount, Net Price |
| Line total | `total_price` ?? `unit_price × qty` (qty defaults to 1) | `total_price` ?? `qty × rate` | `total_price` ?? `qty × unit_price`; `net = net_price ?? total × (1 − discount%/100)` |
| Tax | `gst_percent` (default **18**): Subtotal, `GST @ x%`, Grand Total = subtotal × (1 + x/100) | `gst_percent` (default 18): Taxable Amount, `Tax @ x%`, Total Payable | No tax computation; the default terms say "Taxes : GST Extra". Shows only the grand net total. |
| Amount in words | Yes, Indian system (thousand/lakh/crore): "Rupees … and … paise only" | Yes, title case: "Rs. … and … Paise Only" | No |
| Terms | `data.terms` or 4 standard terms (10-day validity, Ex-Works Faridabad, 100% advance, 4–6 weeks delivery); heading marks Default or Custom (`allowOverrideTerms`) | Not shown | `data.terms` / `data.notes` or defaults (Ex-Faridabad, GST extra, payment after delivery, immediate delivery) |
| Fixed blocks | Company header, recipient GST, Kind Attn / Subject, sign-off, signature, hard-coded Axis Bank account details, two-line footer on every page | Full header on first page and a reduced header on continuation pages; "To" plus a 4-row meta box (Proforma No, Date, Order No, Date 2); RTGS detail block; receiver/company signatures; green/magenta footer | Company registration numbers (ST/CST, TIN, ECC, GST, RC), To / Ref No. / dates, signature, "Authorized Signatory", footer |
| Pagination | Repeats the table header on new pages; reserves 90 pt for the footer; page breaks inside terms, sign-off and bank blocks | Adds pages when rows exceed the limit (reserves 340 pt) and keeps the trailing blocks (about 380 pt) together | Single page layout (no `addPage` calls) |

- **Shared details:**
  - Currency is formatted with `toLocaleString('en-IN')` to 2 decimals.
  - Company GSTIN `06AAACC3923F1Z4` is embedded in all three.
  - Number-to-words floors rupees and rounds paise.
- **Proforma stream handling:** the controller attaches `pdfStream.on('error')` and destroys the stream when the response closes. Quotation and PO lack these handlers.

---

## 4. Invoicing

### 4.1 Customer Invoices (`routes/invoicing/customerInvoices.js`, `controllers/invoicing/customerInvoices.controller.js`, `models/invoicing/customerInvoice.js`)

**Purpose:** register of sales invoices: number, date, value and PDF link, optionally linked to a customer and an order. **No PDF is generated here**; `link_pdf` is a stored URL.

- **Endpoints:** CRUD with `CustomerInvoices.can_*`. Create requires `invoice_number`. The model also has a fallback of `INV-<Date.now()>` and defaults `issue_date` to now and `total_value` to 0.00.
- **List:** keyset by `issue_date` (cursor), ordered `issue_date DESC, invoice_id DESC`. Joins customers, users (`customer_name`) and orders (`order_status`). Returns a `sr_no` column.
- **Update:** overwrites customer_id, order_id, invoice_number, issue_date and link_pdf, setting missing values to NULL. **`total_value` cannot be changed after create.**
- **Errors:** FK violation `23503` returns 400 `FOREIGN_KEY_VIOLATION` ("Invalid customer_id or order_id"); not-found returns 404.
- **Caching:** `invoice_list_<limit>[_<cursor>]` and `invoice_<id>`, TTL 300 s. Writes delete `invoice_*`.
- **Socket:** `invoiceUpdate { invoice_id, invoice_number, total_value, issue_date }` (or `{status:'Deleted'}`). The same event is also emitted from the Orders model.

### 4.2 Purchase Invoices (`routes/invoicing/purchaseInvoices.js`, `controllers/invoicing/purchaseInvoices.controller.js`, `models/invoicing/purchaseInvoice.js`)

**Purpose:** supplier invoices for raw materials (one line per invoice, tied to a `raw_materials.product_id`).

- **Access:** routes use `authenticateToken` only, with **no permission check**.
- **Validation:** `validateInvoiceInput` requires supplierCode, supplierName, invoiceNumber and description as strings; `issueDate` must parse as a date; unitPrice and quantity must be numbers of 0 or more (falsy 0 is rejected because of `!unitPrice`); `productId` must be an integer of 1 or more; `linkPdf` is an optional string.
- **Table:** `purchase_invoices` (invoice_id, sr_no, supplier_code, supplier_name, invoice_number, issue_date, description, unit_price, quantity, link_pdf, product_id, created_at, updated_at).
- **Stock side effect:** after create, update and delete, the controller reads back `raw_materials.stock_quantity` and logs it. No application code changes stock here, so any automatic stock-in would have to come from a DB trigger that is not in this repo. **The code does not show this; verify in the DB.**
- **Caching:** key `purchase_invoices_<limit>_<offset>`, TTL 300 s. Writes call `redis.del('purchase_invoices_*')`, a literal key, so **cached pages are not invalidated** until the TTL expires.
- **Socket:** `invoiceUpdate` (the same event name as customer invoices, with a different payload shape).

---

## 5. Dispatch

### 5.1 Dispatch Tracking (`routes/dispatch/dispatchTracking.js`, `controllers/dispatch/dispatchTracking.controller.js`, `models/dispatch/dispatchTracking.js`)

**Purpose:** shipment and docket tracking per order (`dispatch_tracking_details`: tracking_id, sr_no, order_id, docket_number, dispatch_date, delivery_date, status, timestamps).

- **Endpoints:** `GET /` (paginated, ordered by `sr_no ASC`), `PUT /:trackingId`, `DELETE /:trackingId` (`DispatchTracking.can_*`). There is **no create endpoint**; rows are expected to come from the DB status-sync trigger described in the README (`sync_orders_status` / `sync_dispatch_status`).
- **Update:** uses `COALESCE`, so only the provided fields change.
  - **Bug:** the controller passes `order_id`, but the model destructures `tracking_id`. `order_id` is silently ignored and `tracking_id` is never changed.
  - A `status` change here is expected to propagate to `orders` through the trigger. No application-level validation of status values happens here.
- **Caching:** `dispatch_tracking_<limit>_<offset>`, TTL 300 s. Invalidation uses the literal `redis.del('dispatch_tracking_*')`, which is **ineffective**.
- **Socket:** `dispatchUpdate` (no payload).

### 5.2 Delivery Challan (`routes/dispatch/deliveryChallan.js`, `controllers/dispatch/deliveryChallan.controller.js`, `models/dispatch/deliveryChallan.js`)

**Purpose:** generate a Delivery Challan PDF for goods leaving the factory, and record **returnable** goods (for example items sent for repair or trial) so they can later be accepted back into stock.

- **Endpoint:** `POST /api/delivery-challan/generate` (auth only, no permission check).
- **Validation:** `challan_no` is required. `items` must be non-empty, and each item needs `productId`, `qty > 0`, and `source` of `'raw'` or `'inventory'`.
- **Flow:**
  1. Render the PDF into a buffer (`generateBuffer`).
  2. In a transaction, for each item with `returnable` true, run `UPDATE <inventory|raw_materials> SET returnable_qty = COALESCE(returnable_qty,0) + qty`. Inventory quantities are rounded to integers. A missing product rolls back with a 500.
  3. Commit, emit `stockUpdate { product_id, returnable_qty, status:'updated' }`, and send the PDF with `Content-Length`.
- **Stock effect:** the challan **does not deduct `stock_quantity`**; only `returnable_qty` increases. Returns are accepted via `POST /api/inventory/:id/accept-return`. There is no raw-material equivalent in these modules.
- **PDF layout:** PDFKit A4, margin 24, Roboto.
  - "DELIVERY CHALLAN" title; To / M/s. block with optional party GST.
  - Meta rows: Challan No / Date, Order No / Order Date, Vehicle No.
  - Table columns: No., Description (**only `productName`**, by design), Qty, Remarks.
  - Fixed text: a discrepancy clause (report within 2 days; guarantee void unless signed copies are returned), receiver and company signature lines, and a factory footer.
  - It has no prices or tax.

### 5.3 IA Orders: Intute AI dispatch register (`routes/dispatch/iaOrders.js`, `controllers/dispatch/iaOrders.controller.js`, `models/dispatch/iaOrders.js`)

**Purpose:** record Intute AI dispatches by device serial. Each order lists VCU units (serial, make, model) and optional paired HMI units (IMEI, make, model).

- **Endpoints** (`ia_orders.can_*`): `GET /` (cursor pagination, limit 1–100, default 20), `GET /check-serials?serials=a,b,c` (returns the VCU serials already used), `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`.
- **Validation:**
  - Order needs customer_name, invoice_number, dispatch_date and at least one item.
  - Each item needs a VCU serial, make and model.
  - If any HMI field is supplied, all three HMI fields are required.
- **Uniqueness:** unique constraints on `ia_order_items.vcu_serial` and `hmi_imei`. A `23505` violation becomes a readable message ("VCU serial "X" already exists in another order"), returned as 400.
- **Transactions:**
  - Create inserts `ia_orders` and its items in one transaction.
  - Update patches only the supplied header fields. If `items` is supplied, it deletes all items and re-inserts them.
  - Delete removes `ia_orders` only, so item cleanup relies on an FK cascade in the DB.
- **`created_by`** is taken from `io.user.user_id`, the shared singleton field described in section 0 (race-prone).
- **List query:** aggregates items with `JSON_AGG`. The cursor is formatted as `"<order_id>:<created_at>"` and parsed with `split(':')`. Because timestamps contain colons, the parsed timestamp is truncated, which is a likely pagination bug.
- **Caching:** prefix `ia_orders_`, keys `ia_orders_list_<limit>_<cursor|initial>`, **TTL 120 s**, written asynchronously via `setImmediate`. Invalidation is the only place in these modules that uses `SCAN` (`scanIterator MATCH ia_orders_*`, batches of 500) rather than `KEYS`.
- **Socket:** `ia_orders:created`, `ia_orders:updated`, `ia_orders:deleted`.

---

## 6. Summary tables

### Socket.IO events emitted by these modules

| Event | Emitted by |
|---|---|
| `customerUpdate` | customers create |
| `stockUpdate` | orders (dispatch, cancel), inventory (create, update, delete, accept-return), stock (create, update, photo, delete, adjust), delivery challan |
| `invoiceUpdate` | orders (create, update, cancel), customer invoices, purchase invoices |
| `enquiryUpdate` (type created / updated / assigned / stage_change / deleted), `enquiryActivity`, `notification` (room `user_<id>`) | enquiry |
| `enquiryRequirement:created/updated/deleted`, `enquiryRequirement:motors:added/updated/deleted` | enquiry requirements |
| `priceListUpdate` | price list |
| `dispatchUpdate` | dispatch tracking |
| `ia_orders:created/updated/deleted` | IA orders |

### Redis keys

| Key pattern | TTL | Invalidation works? |
|---|---|---|
| `customers_<limit>_<offset>` | 3600 s | Yes (KEYS `customers_*_*`) |
| `orders_<limit>_<cursor>_<user>` | 300 s | Yes (KEYS `orders_*`) |
| `inventory_<l>_<o>`, `inventory_availability_<l>_<o>` | 3600 s | Yes |
| `enquiry_list_<user>_<l>_<o>_<search>`, `enquiry_<user>_<id>` | 300 s | Yes |
| `price_list_<l>_<o>_<search>` | 300 s | Yes from price-list writes; no from inventory writes (literal `del`) |
| `invoice_list_<l>[_<cursor>]`, `invoice_<id>` | 300 s | Yes |
| `purchase_invoices_<l>_<o>` | 300 s | **No** (literal `del`) |
| `dispatch_tracking_<l>_<o>` | 300 s | **No** (literal `del`) |
| `ia_orders_list_<l>_<cursor>` | 120 s | Yes (SCAN) |

### File-upload limits

| Upload | Limit | Types | Destination |
|---|---|---|---|
| Raw-material photo (`/api/stock/:id/photo`) | 8 MB | JPEG/PNG/WebP/GIF | Google Drive, public |
| Enquiry photo (`/api/enquiry/:id/photo`) | 10 MB | JPEG/PNG/WebP/GIF | Google Drive, public |

### Known gaps and risks seen in code

1. `Stock.adjustStock` uses `pool.query('BEGIN')`, so the adjustment and its log entry are not atomic.
2. Customer creation is not atomic across `users` and `customers`, because `User.create` uses its own connection.
3. `PUT /api/inventory/:id` always runs the admin path and can null out stock if the fields are omitted.
4. Cancelling a `Partially Delivered` order neither restocks nor takes the post-shipment path.
5. `io.user` is a shared singleton; IA Orders `created_by` is race-prone.
6. Literal-wildcard `redis.del` calls (purchase invoices, dispatch tracking, inventory→price_list) do not invalidate anything.
7. Dispatch tracking update ignores `order_id` (parameter name mismatch).
8. IA Orders cursor parsing splits on `:` inside an ISO timestamp.
9. `Enquiry.checkOverdue` is never scheduled, and no socket room joins exist for `user_<id>` notifications.
10. PDF generator routes and purchase-invoice routes have no `checkPermission` RBAC; any authenticated user can call them.
11. The README says JWTs are accepted from a cookie, but `authenticateToken` only reads the `Authorization` header.
12. DB-side objects referenced but not defined in this repo: `get_next_enquiry_id()`, the order/dispatch status-sync triggers, and any stock trigger on `purchase_invoices`.
