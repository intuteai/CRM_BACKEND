# Unique Part Number for Finished Goods and Raw Materials

## Context

Both `inventory` (finished goods) and `raw_materials` (raw material stock) store an 11-character `product_code` built from a `ProductCodeBuilder` UI component: `NNNN` (4-digit Part Number) + `CC` (2-char chart pair) + `SS` (2-char sub-code) + `T` (store) + `C` (col) + `R` (row). Today the Part Number segment defaults to a meaningless "0001" on every new item and has no uniqueness enforcement anywhere — at the database level, in the backend, or in the UI. `product_id` in both tables is a `SERIAL` (auto-increment) primary key, unrelated to the Part Number segment today, though in practice most existing rows already have Part Number == `product_id` (informally, by convention, not enforcement).

The client wants the Part Number to be a genuinely unique identifier: auto-filled from `product_id` by default, editable, but never savable if it collides with another product's Part Number.

`ProductCodeBuilder` is duplicated per-page (not a shared component) across 7 files, matching this codebase's existing convention:
- Finished goods (`inventory`, `/api/inventory`): `admin/InventoryPage.jsx`, `production/ProductionInventoryPage.jsx`, `stores/StoreInventoryPage.jsx`, `sales/SalesInventoryPage.jsx`
- Raw materials (`raw_materials`, `/api/stock`): `admin/StockPage.jsx`, `stores/StoreStockPage.jsx`, `production/ProductionStockPage.jsx`

## Decisions

- **Scope:** Applies to both `inventory` and `raw_materials` — same mechanism, independently enforced per table (a finished-good and a raw material can share the same Part Number; uniqueness is scoped within each table, not across both).
- **New-item auto-fill:** The Part Number field defaults to "next likely ID" (`max(existing product_id) + 1` in that table, computed client-side from data already loaded in the page — no extra request). If the user never touches the Part Number field, the backend overwrites it with the real assigned `product_id` right after insert, guaranteeing a correct match with zero race-condition risk. If the user does touch it, their value is validated and used as-is.
- **Live validation:** Debounced (~400ms) inline check while typing, in all 7 pages, showing "✓ available" or "✗ already used by Product #N — Name" directly under the Part Number input.
- **Enforcement:** A generated column (`LEFT(product_code, 4)`) with a `UNIQUE` constraint on each table is the authoritative guarantee, backed by an application-level pre-check for a friendly error message instead of a raw constraint-violation error.
- **Edit flow:** Existing Part Numbers are never silently rewritten just because someone opens Edit for unrelated fields. Only an actual attempt to change the Part Number to a colliding value is blocked.
- **Product ID gaps:** Confirmed as normal `SERIAL` behavior (deletions and rolled-back inserts permanently consume a number), not corruption. `inventory` has no gaps. `raw_materials` has 60 gaps across 1–140, referenced by 8 dependent tables via foreign keys (`bom_materials`, `part_drawings_raw`, `process_material_usage`, `purchase_invoices`, `work_order_materials`, etc.) — renumbering existing primary keys was explicitly declined as too high-risk to bundle into this feature. **Out of scope. No changes to any existing `product_id` value.** The `raw_materials_product_id_seq` sequence is already correctly synced to `MAX(product_id)` (both are 140) — no reset needed today.
- **Pre-existing collisions:** `raw_materials` currently has two live Part Number collisions that must be resolved before the UNIQUE constraint can be created (a constraint can't be added against data that already violates it):
  - `"0052"`: product_id 93 (IPTFS-RH Housing, keeps `0052L5GB123`) vs. product_id 94 (IP Shaft 001) → recoded to `0094L5IS123`.
  - `"0001"`: product_id 1 (Encoder PCB Connector 10Pin, keeps `0001L5CN411`) vs. product_id 138 (shell 125-4d) → recoded to `0138GNSL311`, vs. product_id 140 (B-125-M-5D-ES11-E04) → recoded to `0140L5MO121`.
  - Resolution rule: lowest `product_id` in each collision keeps its current code; every later duplicate gets its Part Number segment replaced with its own `product_id` (zero-padded), leaving the rest of its code untouched. This is a one-time manual data fix, run once before the migration, not application logic.

## Data model

Applied identically to both tables:

```sql
ALTER TABLE inventory
  ADD COLUMN part_number VARCHAR(4) GENERATED ALWAYS AS (LEFT(product_code, 4)) STORED,
  ADD CONSTRAINT inventory_part_number_unique UNIQUE (part_number);

ALTER TABLE raw_materials
  ADD COLUMN part_number VARCHAR(4) GENERATED ALWAYS AS (LEFT(product_code, 4)) STORED,
  ADD CONSTRAINT raw_materials_part_number_unique UNIQUE (part_number);
```

Order of operations for `raw_materials`: (1) run the one-time collision fix above, (2) verify zero collisions remain, (3) run the `ALTER TABLE`. For `inventory`, no pre-existing collisions exist, so the `ALTER TABLE` can run directly.

## Backend API

Mirrors the existing separate-controller convention (inventory and stock already have independent controllers/routes — no shared "product" abstraction introduced).

**New endpoints:**
- `GET /api/inventory/check-part-number?part_number=0042&exclude_id=5` → `{ available, conflictProductId, conflictProductName }`
- `GET /api/stock/check-part-number?part_number=0042&exclude_id=5` → same shape

**Create** (`POST /api/inventory`, `POST /api/stock`) gains one new payload field, `part_number_auto` (boolean):
- `false` (user picked a specific number): pre-check for a friendly duplicate error, then insert. The DB constraint is the backstop if a race still occurs (caught, turned into a clean error).
- `true` (user never touched the field): insert with the placeholder code as-is, then immediately correct the code's first 4 characters to the real newly-assigned `product_id` (zero-padded) in a follow-up update. Since `product_id` is the table's own primary key, this cannot collide with another auto-assigned row. The only collision risk is a legacy row where someone manually claimed that exact 4-digit number — in that rare case the product is still created successfully, but the response includes a warning field so the frontend can toast "Auto-assigned part number conflicts with an existing entry — please set it manually" instead of silently leaving a wrong value or failing the whole creation.

**Update** (`PUT /api/inventory/:id`, `PUT /api/stock/:id`): same pre-check + DB-constraint backstop if the Part Number segment changed from its current value. No auto-correction logic in the update path — editing unrelated fields never touches an existing Part Number.

## Frontend

Each of the 7 pages' local `ProductCodeBuilder` + Add/Edit form gets the same three changes:
1. Default Part Number on create to "next likely ID" computed from the page's already-loaded list (`max(product_id) + 1`), instead of the current hardcoded "0001".
2. Track whether the user touched the Part Number input specifically (not the whole builder); send `part_number_auto: !touched` on create.
3. Debounced live check against the new `check-part-number` endpoint, shown inline under the Part Number input, in both Add and Edit forms. Save is blocked client-side while a conflict is showing; the backend re-validates regardless.

## Known limitation (flagging, not solving)

Part Number is capped at 4 digits (0001–9999) by the existing builder. Once a table's `product_id` exceeds 9999, auto-fill can't represent it — the backend skips auto-correction and surfaces a warning rather than writing something wrong. `inventory` is at 2 rows and `raw_materials` at 140, so this is far off, but worth knowing about.

## Out of scope

- Renumbering existing `product_id` values in either table (explicitly declined — 8 dependent tables via FK in `raw_materials` alone, too high-risk to bundle here).
- Resetting `raw_materials_product_id_seq` (already correctly synced to `MAX(product_id)`; no action needed).
- Cross-table uniqueness (a finished good and a raw material may share the same Part Number).
- Raising the 4-digit / 9999 cap.
