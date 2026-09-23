# Representative lead capture — design

Date: 2026-09-23

## Background

The client sent two documents describing a "Representative Dashboard" for field
sales reps:

- `Representative Dashboard Flow Chart.pdf` — a hand-drawn flow: rep logs in,
  opens a lead sheet, and per lead records Name, Date of Assign Lead, Contact
  No, City, Remarks (Follow Up / Hot Lead / Not Interested), Last Call
  Conversation, Description/Comment, and an attached picture of the
  client/store.
- `Representative login.xlsx` — a mockup of the same sheet as literal columns:
  `Sno | Date | Name | Contact no | City/state | Remark next call to action |
  Last call conversation | Attach picture | Description/Comments`, with the
  three Remark values noted (HOT LEAD, FOLLOWUP, NOT INTERSTED). No dropdown
  validation is actually wired into the sheet — it's a content mockup, not a
  functional spec.

This maps closely onto the existing Enquiry module
(`CRM_BACKEND/models/sales/enquiry.js`, `controllers/sales/enquiry.controller.js`,
`routes/sales/enquiry.js`, and the three role-based pages
`CRM/src/components/{sales,design,admin}/*EnquiryPage.jsx`), which already has
a `lead` field with values `hotlead` / `followup` / `not_interested` / `lead`
/ `closed`, a `last_discussion` field, an `assigned_at` timestamp, and a
threaded comment/activity system (`enquiry_activities`, `addComment`).

## Goal

Add a `representative` role that can capture and work leads from the field,
reusing the existing Enquiry data model and activity system wherever the
client's columns already map onto it, and adding only the two genuinely new
pieces of data: **city** and **photos**.

## Decisions (confirmed with the user)

1. Representative-captured leads live in the existing `enquiries` table, not
   a separate module — so Sales/Admin see them immediately in the current
   Enquiry pages.
2. Reps can both create new leads themselves (self-serve) **and** work leads
   assigned to them by Sales/Admin — both paths, not just one.
3. The Representative Dashboard is a new role/page inside the existing CRM
   web app, using the existing login/session and RBAC system — not a
   separate mobile app like the PDI app.
4. Remark → reuse the existing `lead` field (no new field).
5. Last Call Conversation → reuse the existing `last_discussion` field (no
   new field).
6. Date of Assign Lead → reuse the existing `assigned_at` timestamp (no new
   field, no manual entry).
7. Description/Comments → use the existing `enquiry_activities` comment
   thread (`addComment`), same as Sales/Design already use — not a new flat
   text field.
8. Photos: **multiple per enquiry**, following the existing array-column +
   append/remove convention already used in
   `controllers/service/serviceRepair.controller.js` (e.g.
   `appendFaultPhoto` / `removePhoto` against an array column), rather than a
   single overwritable `photo_url`.

## Data model changes

`enquiries` table — two new nullable columns:

- `city` (`text`)
- `photos` (`text[]`, default `'{}'`)

No changes needed to `enquiry_requirements` / `enquiry_requirement_motors`
(out of scope — unrelated to this feature, and currently has no frontend
consumer at all, per the earlier module inspection).

## Role & permissions

- New row in `roles`: `representative`.
- New `permissions` rows for `role_id = <representative>`, `module =
  'Enquiries'`: `can_read = true`, `can_write = true`, `can_delete = false`.
  Reps should never be able to delete leads.
- One seed user for testing/demo: `representative@compageauto.com`, password
  hashed with the same bcrypt scheme the rest of the `users` table uses.
  **This account will be created against the production database (there is
  no separate dev DB in this project's config) as an explicit step during
  implementation, confirmed with the user immediately before it's created —
  not silently as part of a migration script.**

## Backend changes

`models/sales/enquiry.js`:
- Extend the existing Design-only scoping in `getAll` and `getById` (current
  `isDesign` check) to also cover `representative`, so a rep only ever sees
  enquiries where `assigned_to = their user_id`. Reuse the same "must be
  numeric user_id or reject" guard already written for Design.
- `create`: no scoping change needed — already assigns `created_by` to the
  authenticated user; when a rep creates a lead, default `assigned_to` to
  themselves if not otherwise specified, so it immediately appears in their
  own restricted view.
- `update`: add `city` to the `COALESCE`-based column list, same pattern as
  the other optional fields.
- New methods `appendPhoto(enquiryId, url)` and `removePhoto(enquiryId,
  url)`, mirroring `ServiceRepair.appendFaultPhoto` /
  `ServiceRepair.removePhoto` — array append/remove against the `photos`
  column, each emitting `enquiryUpdate` over `io` same as other mutations.

`controllers/sales/enquiry.controller.js`:
- `update`: pass `city` through from `req.body` (already destructures a flat
  list of optional fields — just add `city` to it).
- New `uploadPhoto` / `deletePhoto` handlers, same shape as
  `ServiceRepair.uploadPhoto` / `ServiceRepair.deletePhoto`: multer
  memory-storage single file → MIME allowlist (JPEG/PNG/WebP/GIF) →
  `uploadBufferToDrive` → `Enquiry.appendPhoto`. Delete takes `{ url }` in
  the body and calls `Enquiry.removePhoto`.

`routes/sales/enquiry.js`:
- `POST /:id/photo` (`can_write`) → `controller.uploadPhoto`, with
  `upload.single('photo')` multer middleware, same `multer({ storage:
  memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })` config as
  `serviceRepair.js`.
- `DELETE /:id/photo` (`can_write`) → `controller.deletePhoto`.

Both new routes need `checkPermission('Enquiries', 'can_write')`, consistent
with the rest of this router.

## Frontend changes

New `CRM/src/components/representative/RepresentativeEnquiryPage.jsx`,
structured closest to `DesignEnquiryPage.jsx` (restricted, single-assignee
list) but with:

- A "New Lead" create button (Design's page doesn't have one; Sales/Admin's
  does — reuse that modal's shape, trimmed to the fields reps need: Name,
  Contact No, City, Remark).
- A `City` input in the create/edit form and detail view.
- A photo gallery control in the detail view: thumbnail grid, "Add photo"
  button (calls the new upload endpoint), and a delete (×) on each thumbnail
  (calls the new delete endpoint) — not a single upload/replace slot.
- The Remark dropdown constrained to Hot Lead / Follow Up / Not Interested
  only (hiding the `lead`/`closed` default values that Sales/Admin use
  internally, since the client's sheet only shows those three).
- Wired into `routeConfig.jsx` alongside the other three role-based Enquiry
  pages, gated on `role_name === 'representative'`.

Existing Sales/Design/Admin Enquiry pages: add `City` and the photo gallery
to their detail views too, so a rep-created lead's full data is visible
everywhere it already shows up (per the earlier open flag — treating this as
in scope now since the field is on the shared `enquiries` table and would
otherwise be invisible outside the rep's own view).

## Explicitly out of scope

- `enquiry_requirements` / motor sub-resource — untouched.
- Any change to the PDI mobile app or its login flow.
- A dedicated mobile-first surface for reps — decided against in favor of
  the existing web app.
