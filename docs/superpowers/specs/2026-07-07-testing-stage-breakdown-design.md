# Testing Stage Breakdown: Primary/Final Testing

## Context

Work orders (both Motor and Non-Motor) track progress through five fixed stages: Assembly, Testing, PDI, Packing, Dispatch. Each stage today is a single row in `work_order_stages` (`work_order_id`, `stage_name`, `stage_date`), auto-created for every new work order by a DB trigger (`create_work_order_stages_trigger` on `work_orders` INSERT → `create_work_order_stages()`), and edited in the UI as a single date field with an "edit"/"Add date" link.

The client has asked for the "Testing" stage specifically to become richer:

- **Primary testing** — Qty, Date, Controller type
- **Final testing** — Qty, Date, Controller type

The other four stages (Assembly, PDI, Packing, Dispatch) are unaffected and keep their existing single-date behavior.

This applies to **both** Motor work orders (`CreateMotorProcess.jsx`) and Non-Motor work orders (`CreateNonMotorProcess.jsx`), since both currently render the same generic Testing stage against the same shared `work_order_stages` table.

## Decisions

- **Scope:** Both Motor and Non-Motor work orders get the Primary/Final testing breakdown.
- **Controller type:** Free-text field. No fixed lookup list — whoever fills the form types the controller type/model used.
- **Structure:** Primary/Final testing fully replaces the single top-level Testing date. There is no separate overall "Testing" date anymore — the column header represents the stage, and the two rows underneath (Primary, Final) are the only editable data points.
- **Qty meaning:** Number of units tested in that pass — a plain integer entered by whoever runs the test. No cross-validation against other quantities (e.g. work order component quantity) — it's an independent, simple field.
- **Sequencing:** None enforced. Primary and Final testing can be filled in any order, independently — consistent with how every other stage in this app already works (no ordering dependency between stages either).

## Data model

New table, decoupled from the existing `work_order_stages` mechanism (avoids touching the working trigger/CHECK constraint that the other four stages rely on):

```sql
CREATE TABLE work_order_testing_results (
  testing_result_id  SERIAL PRIMARY KEY,
  work_order_id       INTEGER NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
  testing_type        VARCHAR NOT NULL CHECK (testing_type IN ('Primary', 'Final')),
  qty                  INTEGER,
  test_date            DATE,
  controller_type       VARCHAR,
  updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (work_order_id, testing_type)
);
```

- No auto-creation trigger for this table (unlike `work_order_stages`). Rows are created lazily on first save via `INSERT ... ON CONFLICT (work_order_id, testing_type) DO UPDATE`, matching the existing upsert pattern used for `process_material_usage`.
- The existing `work_order_stages` row for `stage_name = 'Testing'` is left in place (the trigger still creates it — not touched, to avoid risk to the other four stages) but becomes vestigial: the UI stops reading/writing its `stage_date` for Testing specifically.
- All three fields (`qty`, `test_date`, `controller_type`) are nullable — Testing sub-items behave like the other stages' dates, which are optional/blank until filled in ("Add date").

## Backend API

New routes in `routes/manufacturing/process.js`, guarded by the same `checkPermission('Processes', ...)` used by all other process routes:

- `GET /api/process/work-orders/:workOrderId/testing` → `[{testingType, qty, testDate, controllerType}, ...]`, always returning both `Primary` and `Final` entries (nulls for unfilled fields) even if no rows exist yet in the table.
- `PUT /api/process/work-orders/:workOrderId/testing` → body `{testing_type, qty, test_date, controller_type}`, upserts exactly one testing_type per call — mirrors `updateWorkOrderStage`'s one-save-per-sub-item pattern.

New model methods in `models/manufacturing/process.js`: `getTestingResults(work_order_id)`, `upsertTestingResult(work_order_id, { testing_type, qty, test_date, controller_type }, io)`.

The main work-order list endpoint (`GET /api/process/:orderId`, `Process.getAll`) embeds a `testing` array into each work order object, the same way `stages` is embedded today via a correlated subquery — so the table view renders both Testing rows without extra round trips per motor/component. Existing redis cache invalidation (`processes_${orderId}_*` keys) is extended to fire on testing upserts too, matching the pattern already used for stage/material/status updates.

Socket event: `io.emit('workOrderTestingUpdate', { workOrderId, testingType, ... })`, mirroring `workOrderStageUpdate`.

## Frontend UI

In both `CreateMotorProcess.jsx` and `CreateNonMotorProcess.jsx`, the "Testing" column cell changes from:

```
[date]  edit
```

to two lines:

```
Primary testing — [date or "Add"]  edit
Final testing    — [date or "Add"]  edit
```

A new `TestingEditor` modal component (parallel to the existing `StageEditor` / `StageDateEditorModal`) with three fields:

- Qty — number input
- Date — date input
- Controller Type — text input

Saves via the new `PUT .../testing` endpoint for the specific `testing_type` being edited. No sequencing lock in the UI — both rows are always independently clickable/editable regardless of the other's state.

A `testingByWorkOrder` memo (parallel to the existing `stagesByWorkOrder`) derives Primary/Final data per work order from the embedded `testing` array for cell rendering.

## Edge cases

- Qty is optional — not required to save a testing entry (consistent with dates being optional elsewhere in this app).
- Deleting a work order cascades and removes its testing rows (`ON DELETE CASCADE`), consistent with `work_order_stages`.
- Existing work orders created before this change simply have no testing rows until someone fills them in — the table starts empty for everyone, no backfill/migration of historical data needed.
- The vestigial `work_order_stages` row for `stage_name = 'Testing'` keeps being created by the existing trigger for every new work order; it's simply ignored by the UI going forward. No trigger/constraint changes, so zero risk to Assembly/PDI/Packing/Dispatch.

## Out of scope

- No fixed/lookup list for controller types (free text only).
- No validation of Qty against component/material quantities elsewhere in the work order.
- No backfill of historical Testing stage dates into the new table.
- No changes to the Assembly/PDI/Packing/Dispatch stages or their existing single-date behavior.
