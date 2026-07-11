# Product Chart & Sub Code List Update

## Context

Every page with a `ProductCodeBuilder` (4 finished-goods pages, 3 raw-materials pages — 7 total, each with its own duplicated copy per this codebase's established convention) defines two static picklists that drive the "Product Chart" and "Sub Code" segments of the 11-character product code:

- `PRODUCT_CHARTS`: 7 entries (IPT, Rikshaw, 2Wheeler, Autonxt, Special, CO, General), each with `symbol`, `digit`, optional `pair` (for two-letter combinations that aren't symbol+digit-derivable, e.g. General → "GN"), `defaultSub` (auto-filled Sub Code on selection), and `color`.
- `SUB_CODES`: 5 entries (BR, SH, FF, RF, AL), each with `abbr` and `label`, rendered as the Sub Code picker buttons.

## Decisions

- **Add to `PRODUCT_CHARTS`:** Motor —
  ```js
  { label: "Motor", symbol: "M", digit: "O", pair: "MO", defaultSub: "", color: "rose" }
  ```
  `symbol`/`digit` combine naturally to "MO" via the existing generic `buildCode`/`parseCode` logic (same mechanism as "General" → "GN") — no special-casing required, unlike "CO" which needs one because its `digit` is empty. Neither "M" nor "O" collides with any existing chart's `symbol`/`digit`. `defaultSub` is empty (no auto-fill), matching CO/General.
- **Remove from `SUB_CODES`:** AL (Aluminium).
- **Add to `SUB_CODES`:** AU (Auxiliary) — `{ abbr: "AU", label: "Auxiliary" }`.
- **Cascading fix:** the existing `Special` chart entry has `defaultSub: "AL"`. Since AL is removed, `Special`'s `defaultSub` becomes `""` (no auto-fill), matching CO/General/Motor.
- **Documentation comment:** each file's top-of-file comment block documenting the sub-code numbering (`0→RF, 1→SH, 2→FF, 3→AL, 4→reserved, 5→BR`) gets `3→AL` updated to `3→AU` for accuracy. This is a comment only, not functional code.

## Scope

All 7 files, each edited identically (matching the per-page-duplication convention already used throughout this codebase and this session's prior work):
- Finished goods: `CRM/src/components/admin/InventoryPage.jsx`, `CRM/src/components/production/ProductionInventoryPage.jsx`, `CRM/src/components/stores/StoreInventoryPage.jsx`, `CRM/src/components/sales/SalesInventoryPage.jsx`
- Raw materials: `CRM/src/components/admin/StockPage.jsx`, `CRM/src/components/stores/StoreStockPage.jsx`, `CRM/src/components/production/ProductionStockPage.jsx`

## Backward compatibility

Existing saved product codes that already contain "AL" as their sub-code segment are unaffected — `parseCode` reads raw characters from the stored string without validating against `SUB_CODES`, so historical data continues to display and parse correctly. Removing AL from the picker only means it's no longer offered as a clickable option going forward; a user editing an old AL-coded item who doesn't touch the Sub Code field keeps "AL" as-is.

## Out of scope

- No backend/schema changes — this is purely a frontend picklist content change.
- No changes to `buildCode`/`parseCode`/`pad4` logic (Motor's symbol+digit combination works with the existing generic logic, no new special-casing needed).
- No changes to any other chart or sub-code entry beyond what's listed above.
