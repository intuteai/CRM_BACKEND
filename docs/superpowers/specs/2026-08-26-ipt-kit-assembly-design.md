# IPT Kit Assembly

## Context

Compage Automation's manufacturing floor assembles an "IPT Kit" (serial `IPT001`, `IPT002`, ...) from 7 fixed sub-components, each with its own physically-labeled serial: Motor, Controller, Gearbox, Harness, Cluster, VCU, DC/DC. Today nothing in the system records which component serials went into which kit. The client wants a traceability/genealogy log — "which kit was Controller C0047 used in?" — with no stock-quantity deduction involved. This is unrelated to the existing `models/dispatch/iaOrders.js` VCU dispatch feature, which tracks Intute AI's shipped VCU+HMI pairs for a different business entity; the "VCU" component slot here is a same-named but independent field.

The codebase already has an established manufacturing-module pattern (`routes/manufacturing/`, `controllers/manufacturing/`, `models/manufacturing/`) and a serial-generation precedent (`part_types`/`part_serials` prefix+counter), but this feature is simple enough (fixed 7-component set, no process/stage tracking) to not need the heavier `work_orders`/`components` process-tracking infrastructure.

## Decisions

- **Purpose:** Pure traceability record. No stock/inventory quantity deduction — assembling a kit does not touch `raw_materials` or `inventory`.
- **Component set:** Fixed at exactly 7 slots (Motor, Controller, Gearbox, Harness, Cluster, VCU, DC/DC), all required on every kit. Not configurable — matches the reference image exactly.
- **Serial entry:** `kit_serial` (IPT001, IPT002...) is auto-generated server-side. All 7 component serials are typed in manually by the user (read off physical labels), not auto-generated.
- **Uniqueness:** Each component column is independently unique — a Motor serial can never repeat across kits, but the same string could in principle appear in two different component columns (their real-world prefixes like `M0xx` vs `C0xx` already keep this from happening in practice). Enforced with a per-column `UNIQUE` constraint plus a friendly pre-check error (not a raw constraint-violation message).
- **Normalization:** Serials are trimmed and upper-cased on save, so `m001` and `M001` collide as duplicates rather than slipping through as distinct values.
- **Permissions:** Both `admin` and `production` roles get full create/edit/delete access — no read-only distinction between them for this feature.
- **Search:** Must support reverse lookup — searching by any of the 7 component serials (not just `kit_serial`) returns the kit that contains it.
- **Deletion:** Hard delete, no soft-delete. Deleting a kit frees its component serials for reuse in a future kit. The `kit_serial` sequence never reissues a deleted number (next kit is always highest-ever-used + 1, not `COUNT(*)+1`).

## Data model

```sql
CREATE SEQUENCE ipt_kit_serial_seq START 1;

CREATE TABLE ipt_kits (
  kit_id            SERIAL PRIMARY KEY,
  kit_serial        VARCHAR(20) UNIQUE NOT NULL,   -- 'IPT' || lpad(nextval, 3, '0')
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
);
```

A flat table (one row per kit, 7 serial columns) was chosen over a normalized `ipt_kits` + `ipt_kit_components` join: the fixed 7-slot requirement means there's no variability to model, and the flat shape makes both the list view (no pivot needed) and the reverse-serial-search (`WHERE 'X' IN (motor_serial, controller_serial, ...)`, each column already indexed by its own `UNIQUE` constraint) trivial. It also avoids reusing the `work_orders`/`components` process-tracking tables, which carry stage/testing-result concepts this feature doesn't need.

## Backend API

New files, mirroring the existing manufacturing-module convention: `models/manufacturing/iptKits.js`, `controllers/manufacturing/iptKits.controller.js`, `routes/manufacturing/iptKits.js`, mounted at `/api/ipt-kits` in `server.js`.

- `GET /api/ipt-kits?limit=&cursor=&search=` — cursor-paginated list (`created_at`/`kit_id` composite cursor, matching `ia_orders`/`invoice_records`). `search` matches `kit_serial` OR any of the 7 component columns (case-insensitive).
- `GET /api/ipt-kits/next-serial` — preview only, returns the `kit_serial` the next `POST` would generate, for the create form to display before submission.
- `POST /api/ipt-kits` — generates `kit_serial` from `ipt_kit_serial_seq`, normalizes (trim+uppercase) and validates all 7 component serials as non-empty and unique within a transaction (pre-check + DB constraint as backstop against races), inserts.
- `PUT /api/ipt-kits/:id` — edits component serials; re-validates uniqueness excluding the row's own current values. `kit_serial` itself is immutable after creation.
- `DELETE /api/ipt-kits/:id` — hard delete.

All routes gated by `checkPermission('ipt_kits', 'can_read'|'can_write'|'can_delete')`. `permissions` table gets seeded rows for both `admin` and `production` roles with all three flags true. Socket.io emits `ipt_kits:created` / `ipt_kits:updated` / `ipt_kits:deleted` for live list updates, matching the existing `ia_orders`/`invoice_records` pattern. Duplicate-serial rejections return a field-specific error (e.g. `{ field: 'controller_serial', error: "Controller serial C0047 is already used in kit IPT004" }`) rather than a generic message, so the frontend can highlight the exact input.

## Frontend

- New page: `CRM/src/components/production/IPTKitAssembly.jsx`, following the existing list+search+modal pattern used by the other production pages (Queries/Orders/Stock/BOM/Inventory) and by `IAOrdersPage.jsx`/`IAInvoiceForm.jsx` (stat cards, search bar, table, "+ New Kit" button, cursor "load more").
- Route: `/ipt-kits` added to `routeConfig.jsx` with `allowedRoles: ["admin", "production"]`, **and** added to both the `ADMIN` and `PRODUCTION` arrays in `constants.js`'s `allowedPathsByRole` map — a second, separate allowlist that has previously caused a silent redirect-loop bug when an entry was added to only one of the two.
- Dashboard cards linking to `/ipt-kits` added to `ProductionDashboard.jsx` and the Admin dashboard.
- List table columns: Kit Serial, Motor, Controller, Gearbox, Harness, Cluster, VCU, DC/DC, Created By, Date, Actions (edit, delete).
- Create/Edit modal: Kit Serial shown read-only (fetched from `/next-serial` when the modal opens on create; fixed/uneditable on edit), followed by 7 required plain-text inputs, one per component. No auto-generation toggle logic is needed here (unlike the earlier VCU dispatch feature), since it's always exactly one serial per component type per kit.
- Duplicate-serial errors from the backend are shown inline under the specific offending input, not just as a generic toast.

## Testing plan

Same rigor as the invoice-generator work earlier this session: direct DB/API script verification of create → duplicate-rejection → edit → delete, **plus** a real-browser Playwright pass against the actual running dev servers with real Admin and Production user sessions — create a kit, confirm the list updates live, trigger a duplicate-serial error and confirm it's field-specific, search by a component serial and confirm the reverse lookup returns the right kit, edit a kit, delete a kit, and confirm the database returns to a clean state afterward.

## Out of scope

- Stock/inventory quantity deduction when a kit is assembled.
- Configurable/variable component-type lists (fixed at exactly 7 for now).
- Linking or cross-referencing this feature with the unrelated Intute AI VCU dispatch module (`models/dispatch/iaOrders.js`).
- Soft-delete / audit history of edits and deletions.
