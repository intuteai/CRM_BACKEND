# Client Applications — Research Notes

Source roots:
- Web CRM: `C:\Users\Rahul\OneDrive\Desktop\Projects\ERP-CRM\CRM` (paths below are relative to it unless stated)
- PDI mobile app: `C:\Users\Rahul\OneDrive\Desktop\Projects\ERP-CRM\pdi-erp-app` (git repo). Note: the `main` checkout is at `10e518e` (app v1.0.1, docs-only commits on top). The current app code lives on branch `origin/feature/pdi-testing-feedback-1.0.7` (head `faa0d61`, 2026-10-09, app v1.1.1 build 14), checked out as the detached worktree `ERP-CRM\pdi-erp-app-review`. Section 2 documents that branch; differences from `main` are called out.

---

## 1. Web CRM (React SPA)

### 1.1 Tech stack (`package.json`)

| Area | Library |
|---|---|
| UI runtime | React 19 (`react`, `react-dom` ^19.0.0) |
| Build tool | Vite 6 (`vite`, `@vitejs/plugin-react`) |
| Routing | `react-router-dom` ^7.2 (BrowserRouter) |
| State | Redux Toolkit ^2.11 + `react-redux` ^9 |
| HTTP | `axios` ^1.8 (23 files) and native `fetch` (61 files) — no shared axios instance |
| Realtime | `socket.io-client` ^4.8 |
| Styling | Tailwind CSS 3.4 (+ PostCSS/autoprefixer); `bootstrap` 5.3 is a dependency but is not imported anywhere in `src` (Tailwind is the effective styling layer) |
| Icons | `lucide-react`, `react-icons` |
| Other | `@hello-pangea/dnd` (drag/drop, PDI template editor), `react-easy-crop` (photo crop), `react-select`, `react-modal`, `xlsx` (SheetJS, Excel export), `qrcode`, `number-to-words` (invoice amounts in words), `date-fns`, `lodash.debounce`, `serve` (static server for `npm start`) |

Scripts: `dev` (vite), `build` (vite build -> `dist/`), `start` (`serve dist -s -p $PORT`), `lint` (eslint), `preview`.

### 1.2 Entry point and app bootstrap

- `src/main.jsx` — creates the React root, wraps `<App/>` in the Redux `<Provider store>`, and calls `installApiStatusTracking(store)` before render (global 401/403 handling, see 1.5).
- `src/app/store.js` — `configureStore` with two slices only:
  - `auth` (`src/features/auth/authSlice.js`): `userRole`, `userName`, `token`, `showLogin`, `socketStatus` (`'idle' | 'connected' | 'error'`). Initial state is hydrated synchronously from `localStorage` (`token`, `role`, `name`) so a page refresh renders the current route as the signed-in user. Actions: `setAuth`, `logout`, `toggleLogin`, `setSocketStatus`.
  - `notifications` (`src/features/notifications/notificationSlice.js`): array of `{id, type, message}` toasts; `addNotification` de-duplicates identical messages; `removeNotification`, `clearNotifications`.
  - All business data (orders, inventory, PDI, etc.) is held in component-local state, not Redux.
- `src/App.jsx` (`AppWrapper` = `<Router><ErrorBoundary><App/></ErrorBoundary></Router>`):
  - Re-reads `token`/`role`/`name` from localStorage on mount; shows `LoginModal` if absent.
  - Login success (`handleLoginSubmit`) stores `role`, `name`, `token`, and a JSON `user` object `{user_id, role_name, name}` (used by Design/Representative pages to know "is this enquiry assigned to me").
  - Opens the shared Socket.IO connection when `userRole` + `token` exist; maps `connect` -> `socketStatus='connected'`, `connect_error` -> `'error'`.
  - Role-based redirect: if the current path is `/`, empty, or not in `allowedPathsByRole[role]` (`:param` segments matched generically by regex), navigates to `DASHBOARD_ROUTES[role]`.
  - Chooses chrome: roles with an entry in `config/roleNav.js` get the sidebar `AppShell`; others (hr, employee, ia_hr, ia_employee) get the classic top `Navbar` (`components/pages/Navbar.jsx`).
  - Always mounts `NotificationCenter`; mounts `ConnectionBanner` when `socketStatus==='error'`; mounts `ChatbotWidget` only for `admin`.
  - Logout: `POST {VITE_BACKEND_URL}/api/auth/logout` with Bearer token, then `localStorage.clear()`, Redux `logout`, socket disconnect.
- `src/routeConfig.jsx` — array of `{path, allowedRoles, component}`; `renderRoute` wraps every route in its own `ErrorBoundary` and passes `socket` + `userRole` props; unauthorised role -> `<Navigate to="/">`. Several shared paths pick a role-specific component (e.g. `/inventory` -> `StoreInventoryPage` / `ProductionInventoryPage` / `InventoryPage`; `/stock`, `/bom`, `/orders`, `/proforma` similarly). Generic PDI template forms (`/pdi-generator/:templateId`) are keyed by `templateId` to force a remount; a legacy `/pdi-generator/autonxt_controller` redirects to `/pdi-generator/autonxt-controller`. A typo redirect maps `/account-dashboard` -> `/accounts-dashboard`.

### 1.3 Roles, dashboards and allowed paths (`src/constants.js`)

`ROLES` defines 14 roles. `DASHBOARD_ROUTES` (landing page per role):

| Role | Dashboard path | Dashboard component |
|---|---|---|
| admin | `/admin-dashboard` | `AdminDashboard` |
| sales | `/sales-dashboard` | `RoleDashboard` |
| design | `/design-dashboard` | `RoleDashboard` |
| representative | `/representative-dashboard` | `RoleDashboard` |
| production | `/production-dashboard` | `RoleDashboard` |
| store | `/store-dashboard` | `RoleDashboard` |
| dispatch | `/dispatch-dashboard` | `RoleDashboard` |
| accounts | `/accounts-dashboard` | `RoleDashboard` |
| customer | `/customer-dashboard` | `RoleDashboard` |
| service_repair | `/service-repair-dashboard` | `RoleDashboard` |
| hr (Compage) | `/hr-dashboard` | `PeopleDashboard` |
| employee (Compage) | `/employee-dashboard` | `PeopleDashboard` |
| ia_hr (Intute AI) | `/ia-hr-dashboard` | `PeopleDashboard` |
| ia_employee (Intute AI) | `/ia-employee-dashboard` | `PeopleDashboard` |

`allowedPathsByRole` is a second, client-side allow-list used by the redirect effect; it must stay in sync with `routeConfig.jsx` (comments warn that each new PDI template slug must be added per role). Observed inconsistency: `/edit-profile` is in `allowedPathsByRole.representative` but `representative` is not in the route's `allowedRoles`, so a representative opening Edit Profile is bounced to `/`.

### 1.4 Navigation configuration

- `src/config/adminNav.js` — `adminNavSections`, single source of truth for the admin Sidebar accordion and the dashboard Module Showcase. Sections: Sales & Customer Management (Orders, Customer Invoices, Customers, Enquiries, Queries, Quotations, Proforma, Delivery Challan); Inventory & Materials (Finished Goods, Raw Materials, Price List, BOM, Part Drawings, Part Creation); Production Management (Work Orders, Motor Recipes, IPT Kit Assembly); Quality & Logistics (PDI Records, PDI Generator, PDI Templates, Dispatch Tracking, Problems); Procurement (Purchase Orders, Purchase Invoices); Service & Repair (Repair Records). Each section has an `accent` colour and `shortLabel`.
- `src/config/roleNav.js` — sidebar sections for sales, production, design, accounts, service_repair, store, dispatch, representative, customer (+ admin via `adminNavSections`). `getRoleNav(role)` returns `{dashboardPath, sections, socketToasts?}`. Customer config carries `socketToasts` for `orderUpdate` and `queryUpdate`.
- `src/config/peopleNav.js` — card menus + `socketToasts` for hr, employee, ia_employee, ia_hr (`getPeopleDashboard(role)`). Toast events: `attendanceMarked`, `leaveRequestCreated`, `payrollProcessed`, `activities:created`, `ia_orders:created`.

### 1.5 Layout components (`src/components/layout`)

- `AppShell.jsx` — sidebar + header shell. Uses a `useMediaQuery('(min-width: 768px)')` hook: below `md` the sidebar becomes an off-canvas drawer opened from the header menu button (auto-closes on navigation); from `md` up it is fixed and collapsible, with the collapsed state persisted in `localStorage['sidebar:collapsed']`.
- `Sidebar.jsx` — fixed left `w-64` (collapsed `md:w-16`) navy gradient (`from-navy-800 to-navy-600`) accordion; auto-opens the section containing the current path.
- `TopHeader.jsx` — dark navy header with search, bell (animated `anim-ring`), clock (`useClock`), user and logout buttons, mobile menu toggle.
- `components/pages/Navbar.jsx` — classic top bar for people roles; also calls `/api/auth/logout`.
- `components/ErrorBoundary.jsx` — app-level and per-route error boundary.

### 1.6 Dashboards (`src/components/dashboards`)

- **AdminDashboard.jsx** — greeting (`shared/DashboardGreeting`), 4 KPI `StatCard`s (Open Orders, Pending Queries, Low Stock Items, Dispatches Today) loaded via `hooks/useAdminStats.js` -> `GET /api/dashboard/admin-stats` (fetch + Bearer token), a live activity feed/rail (`admin/ActivityFeed.jsx`, `ActivityRail.jsx`, last 15 events), and `ModuleShowcase` cards generated from `adminNavSections`. Socket listeners: `newQuery`, `queryUpdate`, `stockUpdate`, `customerUpdate`, `problem:created`, `solution:created`, `processUpdate` (each produces a toast + feed entry; comment notes the backend never emits `orderUpdate`, so no listener).
- **RoleDashboard.jsx** — generic module launcher for any role with a `roleNav` entry: greeting + `ModuleShowcase` of that role's sections. Calls no API; subscribes to the role's optional `socketToasts` (currently customer only).
- **PeopleDashboard.jsx** — HR/Employee/IA dashboards: warm `PeopleBackdrop` (from `shared/PeoplePage.jsx`), greeting with company subtitle (e.g. "HR · Compage", "Employee · Intute AI"), and accent-coloured cards from `peopleNav.js`. Calls no API; subscribes to the role's `socketToasts`.

### 1.7 Hooks (`src/hooks`)

| Hook | Purpose |
|---|---|
| `useAdminStats.js` | `GET /api/dashboard/admin-stats`; returns `{stats, isLoading, error, fetchStats}` |
| `useProblems.js` | `GET /api/problems` plus socket `problem:created` / `solution:created` live merge |
| `useQueries.js` | `GET /api/queries?limit=10&offset=0` |
| `useNotify.js` | Dispatches `addNotification` with `success`/`error`/`info`/`warning` |
| `useClock.js` | Ticking clock for the header |
| `useCountUp.js` | Animated number count-up for KPI cards |

### 1.8 How API calls are made

- **Base URL**: `import.meta.env.VITE_BACKEND_URL` (referenced ~143 times), usually with fallback `http://localhost:5000`. There is no axios instance or `baseURL`; each page builds `${BASE_URL}/api/...` itself.
- **Auth header**: `Authorization: Bearer ${localStorage.getItem('token')}` is added manually per request. Login (`components/pages/LoginModal.jsx`) is `POST /api/auth/login` with `{email, password}` and `credentials: 'include'`; response `{token, role, name, user_id}`; a 429 is shown as "Too many login attempts".
- **Global 401/403 handling** — `src/services/apiStatus.js` (`installApiStatusTracking`):
  - Monkey-patches `window.fetch` and installs an axios response interceptor.
  - On 401/403 to a `/api/` URL it reads the error `code`. Codes `AUTH_INVALID_TOKEN`, `AUTH_INVALID_USER`, `AUTH_NO_TOKEN` end the session (clear localStorage, disconnect socket, Redux logout, show login, warning toast "Your session has expired"). Safeguards: ignores late replies carrying an older token; for `AUTH_INVALID_TOKEN` only signs out if the JWT's `exp` really has passed (the backend can return that code on DB errors).
  - Any other 403 records a timestamp; `wasForbiddenRecently()` (10 s window) lets `components/pages/ConnectionError.jsx` say "Access denied" instead of "Connection interrupted".
- **ConnectionBanner** (`components/pages/ConnectionBanner.jsx`) — gold-accent floating banner "Connection interrupted", shown when the socket reports `connect_error`; actions: reconnect (implemented as logout -> sign in again) or dismiss (resets `socketStatus` to idle).
- **ConnectionError** (`components/pages/ConnectionError.jsx`) — full-page error state used by data pages; buttons: Retry, Back to dashboard, Sign out.
- **Vite dev proxy** (`vite.config.js`): `/api` -> `https://crmbackend-production-c426.up.railway.app` (legacy Railway backend); `allowedHosts: ['intuteai.up.railway.app']`.

Backend endpoint families used by the web client (counted from template literals in `src/components`): `/api/pdi/reports` (most used), `/api/pdi/report-batches`, `/api/pdi/templates`, `/api/pdi/admin/templates`, `/api/inventory` (+ `/available`, `/check-part-number`, `/hold/`), `/api/stock`, `/api/queries`, `/api/orders`, `/api/parts` (+ `/types`, `/next-code`), `/api/bom`, `/api/activities`, `/api/attendance` (+ `/summary`), `/api/service-repair`, `/api/invoice-records` (+ `/upload`), `/api/ia-orders` (+ `/check-serials`), `/api/quotation/generate`, `/api/proforma/generate`, `/api/purchase-order/generate`, `/api/delivery-challan/generate`, `/api/payslip/generate`, `/api/purchase-invoices`, `/api/customer-invoices`, `/api/part-drawings`, `/api/part-drawings-raw`, `/api/ipt-kits` (+ `/next-serial`), `/api/process/orders`, `/api/problems`, `/api/price-list`, `/api/dispatch-tracking`, `/api/employee-details`, `/api/users/employees-hr`, `/api/users/customers`, `/api/customers` (+ `/search`), `/api/enquiry`, `/api/motor-recipes` (+ `/dropdown-data`), `/api/auth/login|logout|update-password`, `/api/dashboard/admin-stats`, and chatbot endpoints `/api/{module}/chatbot`.

### 1.9 Realtime (Socket.IO)

- Shared connection: `src/services/socket.js` — singleton `io(VITE_BACKEND_URL, {path:'/socket.io', transports:['websocket','polling'], withCredentials:true, reconnection:true, reconnectionAttempts:5, reconnectionDelay:2000, auth:{token}})`; `connectSocket`, `getSocket`, `disconnectSocket`. Passed to every routed page as the `socket` prop.
- Additionally, ~27 page components import `socket.io-client` and open their own connection (e.g. `components/pages/OrdersPage.jsx` opens `io(backendUrl, {withCredentials:true, transports:['websocket']})` for `orderUpdate`; `components/admin/QueriesPage.jsx` similar).
- Events listened to across the client: `newQuery`, `queryUpdate`, `orderUpdate`, `stockUpdate`, `inventoryUpdate`, `customerUpdate`, `priceListUpdate`, `invoiceUpdate`, `dispatchUpdate`, `processUpdate`, `workOrderUpdate`, `instanceGroupUpdate`, `partDrawingsUpdate`, `partDrawingsRawUpdate`, `pdiReportUpdate`, `enquiryUpdate`, `enquiryActivity`, `problem:created`, `solution:created`, `bom:created|updated|deleted`, `ipt_kits:created|updated|deleted`, `ia_orders:created|updated|deleted`, `invoice_records:created|deleted`, `activities:created|updated|deleted`, `attendanceMarked`, `leaveRequestCreated`, `payrollProcessed`, plus `connect`/`disconnect`/`connect_error`/`reconnect`.

### 1.10 NotificationCenter

`components/pages/NotificationCenter.jsx` renders the Redux `notifications` array as a bottom-right stack of gradient toasts (green success, red error, yellow warning, blue info); each auto-dismisses after 4 s or on close. All pages raise toasts through `useNotify()`.

### 1.11 Chatbot widget (`src/chatbot`)

- Mounted only for `admin` (App.jsx).
- `chatbotConfig.js` — `CHATBOT_MODULES`: Orders (`orders/chatbot`), Customer Invoices (`customer-invoices/chatbot`), Customers (`customers/chatbot`), Inventory (`inventory/chatbot`), Stock (`stock/chatbot`), BOM (`bom/chatbot`), Work Orders (endpoint `null`, "not connected yet"). Each module has preset question chips (e.g. "Show pending orders", "Count orders by status", "Total invoice value", "Show monthly invoice trend").
- `chatbotApi.js` — `askChatbot(endpoint, message)` -> `POST {VITE_BACKEND_URL}/api/{endpoint}` with `{message}` and Bearer token; throws on non-OK using `data.response`/`data.error`.
- `ChatbotWidget.jsx` (~480 lines) — floating launcher, module selector, message list and loading state.

### 1.12 PDI support utilities

- `utils/pdiRoutes.js` — single source of truth for PDI form URLs: `pdiFormPath(templateId, reportId)` (slugs `general`, `autonxt`, `autonxt-controller`) and `pdiBatchPath(templateId, batchId)` (`autonxt-batch`, `autonxt-controller-batch`); `BATCHABLE_TEMPLATE_IDS = ['autonxt','autonxt_controller']`.
- `utils/pdiImageUpload.js` — 20 MB raw cap; crop to 4:3 (matches PDF photo box), downscale long edge to 1600 px, re-encode JPEG at 0.85 via canvas.
- `utils/pdiTemplateSlug.js`, `components/shared/PdiImageUpload.jsx`, `PdiReportsTable.jsx` (shared list used by admin `/pdi` and production `/production-pdi`), `PdiTemplatePicker.jsx` (`GET /api/pdi/templates`).

### 1.13 Theming (navy/gold) and responsive approach

- `tailwind.config.js` extends colours: `navy` 50 `#eef1f6` … 800 `#0b1a33`, 900 `#081328`; `gold` 300 `#f6d989`, 400 `#f2c14e`, 500 `#e0a92e`, 600 `#b8841c`. Display font `Plus Jakarta Sans` (Google Fonts, linked in `index.html`). Favicon `/IntuteAIYellow.png`.
- Conventions: navy sidebar/header, gold primary/create buttons and focus rings (`focus:ring-gold-400`), page background `bg-navy-50`, per-module accent colours (indigo/amber/emerald/violet/orange) on module cards; People dashboards use a warm cream backdrop with border `#f0e6c8`.
- Motion: CSS classes `anim-in` (staggered via `--i` custom property), `anim-bar-x`, `anim-ring` (bell), card hover lift.
- Responsive: mobile-first Tailwind breakpoints (`sm`/`md`/`lg` grids such as `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`), off-canvas sidebar below 768 px, toasts capped to `max-w-[calc(100vw-2.5rem)]`.

### 1.14 Build, deploy and environment

- **Build**: `npm run build` -> static bundle in `dist/` (`vite.config.js` `build.outDir`). A built `dist/` folder is present in the working tree.
- **Production deploy** — `.github/workflows/frontend-s3.yml` ("Deploy CRM Frontend to S3"): triggers on every push to `main` (paths `**`) and manually (`workflow_dispatch`). Steps: checkout, Node 18, cache `node_modules`, `npm install`, `npm run build`, sync `dist/` to the S3 bucket (`jakejarvis/s3-sync-action`, `--delete`, region `ap-south-1`), then `aws cloudfront create-invalidation --distribution-id E2JXDLEFAXYK5P --paths "/*"`. Secrets: `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. So the web CRM is served as a static SPA from S3 + CloudFront and auto-deploys on push.
- **Legacy Railway config** — `railway.json` (NIXPACKS builder, `startCommand: "vite"`, 60 s health-check timeout) and `npm start` (`serve dist -s -p $PORT`) remain from the earlier Railway hosting; the Vite proxy/allowedHosts also reference Railway hosts.
- **Environment variables** (`.env`, `.env.local`; values not reproduced here):
  - `VITE_BACKEND_URL` — backend origin for REST and Socket.IO (required).
  - `VITE_DEFAULT_SALES_USER_ID`, `VITE_DEFAULT_ADMIN_USER_ID` — optional, used by `components/design/DesignEnquiryPage.jsx` when handing enquiries back to sales/admin (backend default sales user 7).
  - Vite inlines `VITE_*` values at build time, so the CI build environment must supply them.

### 1.15 Per-role page / feature catalogue

Common to all roles except representative: **Edit Profile** (`/edit-profile`, `pages/EditProfile.jsx`) — change own password (`/api/auth/update-password`).

**admin** (AppShell, `/admin-dashboard`)
- Admin Dashboard — KPI cards, live activity feed and module launcher.
- Orders (`/orders`, `pages/OrdersPage.jsx` + `forms/CreateOrderForm`/`EditOrderForm`) — create, edit and track sales orders with live `orderUpdate`.
- Customer Invoices (`/customer-invoices`) — list and manage customer invoices.
- Customers (`/customer-list`) — customer master with detail view.
- Enquiries (`/enquiries`, `admin/EnquiryPage.jsx`) — lead/enquiry pipeline across sales, design and representatives.
- Queries (`/queries`) — customer and internal query tickets with live updates.
- Quotations (`/quotation`), Proforma (`/proforma`), Delivery Challan (`/delivery-challan`), Purchase Orders (`/purchase-order`) — form-driven PDF document generators (`/api/{doc}/generate`).
- Documents hub (`/documents`, `admin/DocumentsHub.jsx`) — landing tiles for Quotations, Proforma Invoice and Delivery Challan.
- Finished Goods inventory (`/inventory`) and Raw Materials stock (`/stock`) — stock levels, part-number checks, holds.
- Price List (`/price-list`) — product pricing.
- Bill of Materials (`/bom`) — priced BOM management.
- Part Drawings (`/part-drawings` -> `/part-drawings/finished`, `/part-drawings/raw`) — drawing library for finished and raw parts.
- Part Creation (`/part-creation`) — create parts with auto-generated codes (`/api/parts/next-code`, `/types`).
- Work Orders (`/work-orders`, `/select-component/:orderId/:action`, `/processes/:orderId`, `/processes/non-motor/:orderId`) — production process tracking for motor and non-motor orders.
- Motor Recipes (`/motor-recipes`) — winding specification per customer motor.
- IPT Kit Assembly (`/ipt-kits`) — record component serials per IPT kit with auto serials.
- PDI Records (`/pdi`) — searchable table of all PDI reports.
- PDI Generator (`/pdi-generator` -> General, AutoNXT, AutoNXT Batch, AutoNXT Controller, Controller Batch, authored `/:templateId`) — fill in, save drafts and finalize PDI report PDFs, including lot/batch reports.
- PDI Templates (`/pdi-templates`, `admin/PdiTemplatesAdminPage.jsx`) — drag-and-drop authoring of new PDI report formats with live preview.
- Dispatch Tracking (`/dispatch-tracking`) — shipment status.
- Problems (`/problems`) — reported problems and solutions with live updates.
- Purchase Invoices (`/purchase-invoices`) — supplier invoices.
- Service & Repair (`/service-repair`) — repair job records (shared with service_repair).
- Chatbot widget — natural-language queries over orders, invoices, customers, inventory, stock and BOM.

**sales** (AppShell, `/sales-dashboard`)
- Orders, Customer Invoices, Dispatch Tracking, Price List, Raw-material Stock — shared pages as above.
- Quotations (`/sales/quotations`, `SalesQuotationForm`) — generate customer quotations.
- Proforma (`/proforma` -> `SalesProformaForm`) and Purchase Orders (`/purchase-order`); Documents hub (`/documents`).
- Enquiries (`/sales/enquiries`, `SalesEnquiryPage`) — manage and assign leads.
- Queries (`/sales-queries`) — handle customer queries.
- Finished Goods (`/sales-inventory`) — sales view of finished goods stock.

**design** (AppShell, `/design-dashboard`)
- Enquiries (`/design/enquiries`, `DesignEnquiryPage`) — design-side work on assigned enquiries, "Mark Done", hand back to sales/admin.
- Queries (`/queries`) — technical queries.
- Part Creation (`/design/part-creation`) — create part definitions.
- Motor Recipes (`/motor-recipes`).
- Raw and Finished Part Drawings (`/part-drawings/raw`, `/part-drawings/finished`) — upload/manage drawings.
- Unpriced BOM (`/bom`) — BOM view without prices.

**representative** (AppShell, `/representative-dashboard`)
- Enquiries (`/representative/enquiries`, `RepresentativeEnquiryPage`) — field sales lead capture and follow-up (`/api/enquiry`).

**production** (AppShell, `/production-dashboard`)
- Orders (`/production-orders`; `/orders` also routes to `ProductionOrdersPage`) — production view of orders.
- Work Orders and process pages (`/work-orders`, `/processes/...`) — update production process steps.
- Motor Recipes, IPT Kit Assembly — as admin.
- Queries (`/production-queries`) — production queries.
- Raw Materials (`/production-stock`), Finished Goods (`/production-inventory`), Unpriced BOM (`/production-bom-unpriced`).
- Raw/Finished Drawings (`/production-part-drawings-raw`, `/production-part-drawings`) — read drawings.
- PDI Records (`/production-pdi`) and PDI Generator (`/pdi-generator/...`) — same PDI tooling as admin except template authoring.

**store** (AppShell, `/store-dashboard`)
- Inventory (`/inventory` -> `StoreInventoryPage`) — manage finished goods.
- Raw Materials (`/stock` -> `StoreStockPage`) — raw material levels.
- BOM (`/bom` -> `StoreBOMPage`) — unpriced BOM.

**dispatch** (AppShell, `/dispatch-dashboard`)
- Queries (`/queries`), Stock (`/stock`), Dispatch Tracking (`/dispatch-tracking`) — dispatch updates and logistics.

**accounts** (AppShell, `/accounts-dashboard`)
- Customer Invoices, Purchase Invoices — billing and expenses.
- Dispatch Tracking, Orders — order and shipment visibility.

**customer** (AppShell, `/customer-dashboard`)
- Orders (`/customer-orders`) — track own orders with live `orderUpdate` toasts.
- Queries (`/customer-queries`) — raise and follow own queries with `queryUpdate` toasts.

**service_repair** (AppShell, `/service-repair-dashboard`)
- Repair Records (`/service-repair`, `service/ServiceRepairPage.jsx`) — log repair jobs with customer typeahead (`/api/customers/search`), status badges, photo thumbnails/lightbox.

**hr** — Compage (Navbar, PeopleDashboard)
- Attendance Summary (`/attendance-summary`) — daily/monthly attendance for all employees.
- Activities (`/hr-activities`) — create and assign tasks to Compage employees.
- Employee Details (`/employee-details`) — employee contact and onboarding records (`/api/employee-details`).

**employee** — Compage
- Attendance History (`/attendance-history`) — own attendance.
- My Activities (`/my-activities`) — update status of assigned tasks.

**ia_hr** — Intute AI
- Attendance Summary (`/ia-attendance-summary`).
- Activities (`/activities`) — manage team tasks.
- Dispatch Orders (`/ia-orders`) — VCU/HMI dispatch with serial numbers (format `{prefix}{code}--{running}`, e.g. `VCL001--058`; `/api/ia-orders/check-serials`).
- Payslip Generator (`/hr-payslips`) — manual payslip PDF (`/api/payslip/generate`).
- Invoice Generator (`/ia-invoices`) — customer invoices with auto GST, PDF and history (`/api/invoice-records`).

**ia_employee** — Intute AI
- Attendance History (`/ia-attendance-history`), Activities (`/activities`), Dispatch Orders (`/ia-orders`), Invoice Generator (`/ia-invoices`).

---

## 2. PDI Mobile App (`pdi-erp-app`)

### 2.1 Tech stack

It is a **bare React Native CLI app, not Expo** (no `eas.json`; `app.json` only holds `{"name":"PDIApp","displayName":"PDIApp"}`). Written in TypeScript.

| Area | Library (feature branch `package.json`) |
|---|---|
| Runtime | React Native 0.87.1, React 19.2.3 |
| Navigation | `@react-navigation/native` 7 + `native-stack` 7, `react-native-screens`, `react-native-safe-area-context` |
| Storage | `@react-native-async-storage/async-storage` ^3.1 (drafts) |
| Secure storage | `react-native-keychain` ^10 (login session) — not on `main` |
| Photos | `react-native-image-crop-picker` ^0.51 (camera/gallery + crop + compression) |
| Files/PDF | `react-native-blob-util` ^0.24 (PDF download to cache, publish to Downloads) |
| Date input | `@react-native-community/datetimepicker` ^9.2 — not on `main` |
| Tooling | Jest 29 (`@react-native/jest-preset`), ESLint, Prettier, TypeScript; Node >= 22.11 |

Package name / Android `applicationId`: `com.compageautomation.pdi`. Android `versionCode`/`versionName`: `main` = 2 / "1.0.1"; feature branch at commit `41fbc40` = 13 / "1.1.1"; `src/config/appVersion.ts` at branch head = `1.1.1 (14)`.

### 2.2 App structure (feature branch)

- `App.tsx` — `SafeAreaProvider` > `AppDialogProvider` (custom modal dialogs) > `AuthProvider` > `AppNavigator`; status bar hidden.
- `src/navigation/AppNavigator.tsx` + `types.ts` — native stack: `Login`, `Reports`, `TemplatePicker`, `BatchCreate {templateId, templateName, batchId?}`, `BatchOverview {batchId, fromCreate?}`, `ReportEditor {reportId?, createdHere?}`, `GenericReportEditor {reportId, templateId, templateName, batchId?, lotIndex?, lotQuantity?}`. Theme colours from `src/theme/colors.ts` (navy `#111B2E`, orange/amber `#F5A019`, cream background `#FFFCF2`).
- `src/screens/`
  - `LoginScreen.tsx` — email/password login; explains expired sessions.
  - `ReportsScreen.tsx` — merged list of server reports and device drafts, status filters (All/Pending/In Progress/Completed/Failed), pending-sync markers, duplicate/delete, PDF actions.
  - `TemplatePickerScreen.tsx` — loads `GET /api/pdi/templates`; General opens `ReportEditor`; other templates open `GenericReportEditor`; AutoNXT and AutoNXT Controller also show a "create lot" card.
  - `ReportEditorScreen.tsx` (~1600 lines on main) — the hand-built General template editor (header, electrical/mechanical checks with tolerance evaluation, photos).
  - `GenericReportEditorScreen.tsx` — data-driven editor that renders any template definition (`/api/pdi/templates/:id/definition`), used for AutoNXT Motor, AutoNXT Controller and admin-authored templates; lot-aware.
  - `BatchCreateScreen.tsx` / `BatchOverviewScreen.tsx` — lot creation and lot dashboard (see 2.6).
- `src/components/pdi/` — `ElectricalCheckForm.tsx`, `MechanicalCheckForm.tsx`, `PhotosForm.tsx`.
- `src/api/` — `client.ts` (fetch wrapper), `reports.ts`, `reportBatches.ts`, `templates.ts`.
- `src/auth/` — `AuthContext.tsx`, `sessionStorage.ts` (Keychain), `sessionEvents.ts` (expiry warnings), `expiredSession.ts` (backup draft on expiry).
- `src/services/` — `tolerance.ts` (Symmetric/Percentage/Bilateral checks mirroring backend), `autonxtParity.ts` (AutoNXT spec presets and display-text lock), `genericTemplate.ts` (initialise/split template data, validate definitions and dates), `finalizeWarnings.ts` (pre-finalize checks per template), `motorSerials.ts`, `inspectionDate.ts`, `reportList.ts` (merge local+server lists), `reportPhotos.ts`, `reportPdf.ts`, `pdiCompatibility.ts` (migrations of older draft/photo shapes).
- `src/data/` — `autonxtTemplate.ts`, `autonxtControllerTemplate.ts` (built-in definitions, incl. the 35-row CASHV38140 controller preset).
- `src/storage/` — `pdiDrafts.ts`, `genericPdiDrafts.ts`, `indexedDraftStorage.ts`.
- `__tests__/` — Jest suites for client, auth, screens, templates, tolerance, drafts, duplicate, etc.; `__mocks__/` for AsyncStorage, blob-util, image-crop-picker.

### 2.3 Authentication and token persistence

- `POST /api/auth/login` with `{email, password}` (email trimmed and lower-cased). Response must contain `token`, `name`, `role`.
- Role gate (feature branch): only `admin` or `production` may use the app (`PDI_FORBIDDEN` "This account doesn't have access to PDI reports"). On `main` the gate was a hard-coded email check (`admin@compageauto.com`); this is now deprecated, matching the backend's admin+production PDI permission.
- **Persistence**: on `main` the session lived only in React state (lost on app restart). On the feature branch `sessionStorage.ts` stores `{name, role, token, email, expiresAt}` in the platform Keychain/Keystore (`react-native-keychain`, service `com.compageautomation.pdi.session`, 5 s read timeout). At launch `restoreStoredSession()` drops a stored session whose JWT `exp` has passed or which lacks an email, and tells Login it expired.
- **X-App-Version header**: `src/api/client.ts` sends `X-App-Version: "1.1.1 (14)"` (from `config/appVersion.ts`) on every request. The backend (`CRM_BACKEND/controllers/auth.controller.js`) issues a **12 h** JWT when this header is present on login, versus **1 h** for the web CRM, because inspections are long and the app restores its login from secure storage.
- **Expiry handling**: a timer fires 10 min before `expiresAt`, emits `sessionExpiring` (open editors write a device draft) and shows a "Session expires soon" dialog. Any 401, or 403 with `AUTH_INVALID_TOKEN`/`AUTH_INVALID_USER`, triggers `notifySessionExpired()`; the editor backs up the open report as a `pendingSync` draft and Login explains "Your session expired".

### 2.4 API client and `/api/pdi` usage

`apiRequest<T>(path, options, token, timeoutMs)` in `src/api/client.ts`:
- Base URL hard-coded `https://api.intute.biz`.
- Headers: `Accept`/`Content-Type: application/json`, `X-App-Version`, `Authorization: Bearer <token>`.
- Timeout via `AbortController`: default 15 s, extended for large bodies (`30 s + 1 s per 64 KB`); report writes 60 s; PDF 60 s; lot PDF 180 s.
- Error mapping to `ApiError {status, code, lots?}` with friendly messages for 413, 429, 502, 503, 504 and any 5xx/`INTERNAL_ERROR` (raw server text never shown); `TIMEOUT`, `NETWORK_ERROR`, `BAD_RESPONSE` for client-side failures; 204 handled.

Endpoints used:

| Purpose | Call |
|---|---|
| Template list / definition | `GET /api/pdi/templates`, `GET /api/pdi/templates/:id/definition` |
| List reports (cursor paging, status filter) | `GET /api/pdi/reports?limit=&cursor=&status=` -> `{data, total, cursor}` |
| Open report / light open | `GET /api/pdi/reports/:id`, `GET /api/pdi/reports/:id?photos=summary` |
| Create / duplicate | `POST /api/pdi/reports`, `POST /api/pdi/reports/:id/duplicate` |
| Save | `PATCH /api/pdi/reports/:id` (with `expected_revision` when editing a Completed report; retried once on 500) |
| Delete | `DELETE /api/pdi/reports/:id` (retried once on 500) |
| Revisions | `GET /api/pdi/reports/:id/revisions` |
| Finalize + PDF | `POST /api/pdi/reports/:id/finalize`, `GET /api/pdi/reports/:id/pdf` |
| Lots | `POST/GET /api/pdi/report-batches`, `GET/PATCH/DELETE /api/pdi/report-batches/:id`, `POST /api/pdi/report-batches/:id/finalize`, `GET /api/pdi/report-batches/:id/pdf` |

Report statuses: `Pending`, `In Progress`, `Completed`, `Failed`. Report payload: `{template_id, inspected_by, inspection_date, status, data, photos}` where `data` is the shared JSON blob also edited by the web CRM (so tolerance logic must match the backend exactly). Write size is checked client-side before sending: max 60 photos per report (`MAX_GENERAL_REPORT_PHOTOS`) and 35 M characters per request (backend JSON limit 40 MiB).

PDF handling (`src/services/reportPdf.ts`): downloads with `react-native-blob-util` to `CacheDir/PDI_<pdi_no>.pdf`, sends `X-Request-ID` so phone and server logs can be matched, requests Android storage permission where needed, and publishes a copy to Downloads / opens it.

### 2.5 Offline / draft storage

- AsyncStorage namespace `pdi-app` (`createAsyncStorage('pdi-app')`). On `main`: one JSON array per type under keys `pdi:drafts` (General) and `pdi:generic-drafts` (template-driven), newest first.
- Feature branch (`indexedDraftStorage.ts`): drafts are stored one item per key with an index (`<root>:index:v2`, `<root>:item:v2:<id>`), large items split into 256 KB chunks with a generation-numbered manifest, migrated from the legacy single-blob key, and **scoped per account email** so one user's drafts are never read or deleted by another. Damaged entries are quarantined to `<key>:corrupt:<timestamp>` rather than overwritten, and the UI offers retry/delete for "device backup issues".
- Drafts carry `pendingSync: true` when a save could not reach the server (offline, expired session); the Reports list merges local and server entries and shows the device copy until it is uploaded. Drafts of a deleted lot can be purged from the device.

### 2.6 Lots / batches

Per `docs/pdi-batch-lot-reports.md` and `src/api/reportBatches.ts`:
- A batch is `{batch_id, template_id, pdi_no, lot_quantity, status}`; creating one atomically creates N ordinary PDI reports stamped with the shared `pdi_no` and `lot_index` 1..N.
- Supported for `autonxt` and `autonxt_controller`. Shared fields set once for the lot: `customer_name`, `product_id`, `product_specifications`, `drawing_no`, `controller_type`.
- Lot status: `In Progress` | `Finalizing` | `Completed` (a failed finalize returns to In Progress). Server errors may include `lots: number[]` (e.g. missing serial numbers) which the app turns into messages (`reportBatchErrorMessage`, `missingSerialMessage`).
- `BatchCreateScreen` creates the lot; `BatchOverviewScreen` lists units (serial `motor_sr_no`/`controller_sr_no`, status), opens each unit in `GenericReportEditor`, polls status while finalizing, then downloads/opens the combined lot PDF; handles a lot deleted elsewhere (404).

### 2.7 Photo capture and compression

`src/components/pdi/PhotosForm.tsx` (feature branch):
- Camera (`ImagePicker.openCamera`) or gallery (`openPicker`, multi-select up to remaining slots), each image then cropped.
- Crop/compress options: `cropping: true`, output 1600x1200, `compressImageMaxWidth 1600`, `compressImageMaxHeight 1200`, `compressImageQuality 0.85`, `includeBase64: true` (images stored as base64 data URIs inside the report JSON).
- Limits: 12 labelled photo entries, 25 images per entry, 60 images per report, ~33 M characters of photo data; the UI shows a running "n / 60 photos · ≈ size" counter. These numbers are kept in parity with the web CRM (`docs/pdi-web-mobile-parity-audit.md`).

### 2.8 Build and release

- No Expo/EAS. Builds use the React Native CLI and Gradle: `npm run android` / `npm run ios` for development, `npm start` for Metro, `npm test` for Jest.
- Release signing (`android/app/build.gradle`): reads `android/keystore.properties` (template `keystore.properties.example`) for the release keystore when present; otherwise the debug keystore is used. Version is bumped manually in `build.gradle` (`versionCode`/`versionName`) and `src/config/appVersion.ts` (which also drives the `X-App-Version` header).
- The release artifact is an Android APK/AAB distributed outside CI; there is no `.github` workflow in this repo. The API URL is hard-coded, so there are no environment files.

### 2.9 `docs/` folder summary (handoff documents from the backend/web side to the app developer)

| File | Content |
|---|---|
| `pdi-general-template-changes.md` (1191 lines) | Adds Bilateral tolerance mode and Shaft Diameter to General; tolerance parity with backend |
| `pdi-shaft-diameter-length-split.md` | Reverts the combined "diameter/length" field into two separate measured fields |
| `pdi-web-mobile-parity-audit.md` | Side-by-side photo/upload settings, web vs mobile; one gap found (photos per entry) |
| `pdi-batch-lot-reports.md` | API contract for AutoNXT lot/batch reports |
| `pdi-finalized-report-editing.md` | Controlled editing of Completed reports (permission, `expected_revision` conflict check, revisions) |
| `pdi-autonxt-spec-display-lock.md` | Fix for AutoNXT "PDF display text" drifting from nominal/tolerance values |
| `pdi-report-open-timeout.md` | "Report could not be opened" timeout on photo-heavy reports; client fix (photo summary, longer timeouts) |
| `2026-10-01-qa-followups.md` | Forward/reverse measurement parser mismatch and lot shared-field lock fallback |
| `2026-10-05-autonxt-controller-template.md` | Handoff for the third template, `autonxt_controller` (fields, CASHV38140 preset, batch support) |
| `2026-10-05-autonxt-controller-followups.md` | Review of commit `b75bb07`; fixes required before release |
| `2026-10-06-pdi-app-full-hardening.md` (2380 lines) | Line-by-line hardening audit: no lost work, PDF matches screen, sync with backend/web |
| `2026-10-09-pdi-app-hardening-final.md` | Round-5 handover with a reference patch for every open item |

Several of these (`2026-10-05-autonxt-controller-followups.md`, `2026-10-06-...`, `2026-10-09-...`, `pdi-finalized-report-editing.md`, `pdi-report-open-timeout.md`) are untracked or modified in the `main` working tree.

---

## 3. Observations useful for the documentation

1. The web client has no central HTTP layer: base URL and Bearer header are repeated per page; session expiry and 403 handling are centralised only through the fetch/axios interception in `services/apiStatus.js`.
2. Two parallel allow-lists (`constants.js` `allowedPathsByRole` and `routeConfig.jsx` `allowedRoles`) must be kept in sync; the representative/`/edit-profile` mismatch shows the risk.
3. Many pages open their own Socket.IO connection besides the shared one in `services/socket.js`, which multiplies connections per user.
4. `railway.json`, the Vite Railway proxy and `npm start` are legacy; the live web deploy is GitHub Actions -> S3 -> CloudFront (`ap-south-1`).
5. The PDI app's `main` branch is behind the active feature branch (`feature/pdi-testing-feedback-1.0.7`); Keychain session persistence, `X-App-Version`, the 12 h token, lots and per-account chunked drafts exist only on that branch.
