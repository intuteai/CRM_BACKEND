# ERP technical documentation

This folder holds the sources for `docs/ERP_Technical_Documentation.pdf`.

| Path | What it is | Who updates it |
|---|---|---|
| `chapters/*.md` | The written chapters (architecture, modules, PDI, clients, deployment) | You, whenever behaviour changes |
| `meta.json` | Version number, revision history, and chapter order | You, on each release of the document |
| `generated/routes.json` | Endpoint catalogue (Appendix A) | Regenerated automatically from `server.js` and `routes/` |
| `generated/schema.json` | Roles, permissions and DB schema (Appendices B and C) | Regenerated automatically from the live database (read-only queries) |

## Rebuild the PDF

Requirements: Node, Python 3 with `reportlab` (`pip install reportlab`), and a `.env` with database access.

```
npm run docs:pdf
```

This command:

1. Runs `scripts/docs/dump_routes.js` to rebuild the endpoint catalogue.
2. Runs `scripts/docs/dump_schema.js` to take a read-only snapshot of the DB schema, roles and permissions.
3. Runs `scripts/docs/build_erp_pdf.py` to write `docs/ERP_Technical_Documentation.pdf`.

The cover date and the commit hash are filled in automatically.

If the database is unreachable, run `npm run docs:pdf:offline` instead. It reuses the last `generated/schema.json`.

## When to update what

- **New or changed endpoint, or a permission change in code:** nothing to write for the appendices; just rebuild. Still describe any new behaviour in the relevant chapter.
- **New table, column, role or permission row in the DB:** rebuild (the appendices pick it up). Mention it in the chapter if it matters for the business logic.
- **New feature or changed business rule:** edit the matching `chapters/*.md` file. `30_pdi.md` covers PDI; `10_sales.md` covers orders, sales, invoicing and dispatch; `20_mfg_hr_ops.md` covers manufacturing, HR, operations, jobs and the chatbot; `40_clients.md` covers the web CRM and mobile app; `00_core.md` covers the overview, architecture, security and deployment.
- **A bug listed under "known gaps" gets fixed:** remove it from that chapter's gaps list.
- **New chapter:** add a `.md` file in `chapters/` and add an entry to `meta.json` → `chapters`.
- **Each documentation release:** bump `version` in `meta.json` and add a line to `history`.

## Markdown supported by the builder

The builder supports a small subset of Markdown:

- `#` to `####` headings. In a whole-file chapter, the file's top heading level becomes a section.
- Paragraphs, `-` and `1.` lists (nested with two spaces), pipe tables, fenced code blocks.
- Inline `**bold**`, `*italic*` and `` `code` ``.

Avoid characters that are not in the Roboto or Consolas fonts, such as math symbols. `→` is handled.
