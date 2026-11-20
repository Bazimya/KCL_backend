# Kigali Coffee Lab (KCL) Backend

GitHub repository: `KCL_backend`.

Node.js + Express + **MySQL** (via **Prisma**) API powering the KCL app: the
coffee/food menu, coffee-machine catalog, tables, guest ordering (no account
needed), staff order management, and notifications.

## Setup

1. Create a MySQL database (MySQL 5.7+/8+ or MariaDB both work):
   ```sql
   CREATE DATABASE kigali_coffee_lab;
   CREATE USER 'kcl'@'localhost' IDENTIFIED BY 'your_password';
   GRANT ALL PRIVILEGES ON kigali_coffee_lab.* TO 'kcl'@'localhost';
   FLUSH PRIVILEGES;
   ```

2. Install dependencies and configure environment:
   ```bash
   npm install               # also runs `prisma generate` via postinstall (Node 20.9+)
   cp .env_example .env      # fill in DATABASE_URL, PASSWORD_KEY, JWT_KEY
   ```
   `DATABASE_URL` is the only DB setting Prisma reads, in the form
   `mysql://USER:PASSWORD@HOST:PORT/DATABASE`.

3. Apply the schema to your database (creates all tables from
   `prisma/schema.prisma` + the committed migration in `prisma/migrations/`):
   ```bash
   npx prisma migrate deploy   # production/first-time setup
   # or, while developing and changing schema.prisma:
   npx prisma migrate dev
   ```

4. Run the server:
   ```bash
   npm run dev             # nodemon
   # or
   npm start
   ```

Useful Prisma commands (also available as `npm run prisma:*` scripts):
`npx prisma studio` (a GUI to browse/edit data), `npx prisma generate`
(regenerate the client after editing `schema.prisma`).

## Production deployment

### Quick start: one Ubuntu VPS (recommended)

`deploy/` sets up everything on a fresh Ubuntu 22.04/24.04 server: Node 20 +
pm2, MySQL, nginx (frontend + API), Let's Encrypt HTTPS, firewall and nightly
backups. Secrets are generated on the server and never committed.

1. Buy the domain and point two DNS **A records** at the server's IP:
   the site (e.g. `kigalicoffeelab.com`) and the API (e.g. `api.kigalicoffeelab.com`).
2. On the server, as root:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/Bazimya/KCL_backend/main/deploy/setup-vps.sh
   sudo APP_DOMAIN=kigalicoffeelab.com API_DOMAIN=api.kigalicoffeelab.com \
        LETSENCRYPT_EMAIL=you@example.com \
        INITIAL_ADMIN_EMAIL=admin@kigalicoffeelab.com \
        INITIAL_ADMIN_PASSWORD='a-unique-password-16+chars' \
        bash setup-vps.sh
   ```
   Private repos: add the server's SSH key as a GitHub deploy key and pass
   `BACKEND_REPO=git@github.com:Bazimya/KCL_backend.git FRONTEND_REPO=...`.
   DNS not ready yet: add `SKIP_TLS=1`, then re-run without it later.
3. Ship updates: `sudo -iu kcl /srv/kcl/KCL_backend/deploy/deploy.sh`
4. Copy `/var/backups/kcl` and `/srv/kcl/KCL_backend/.env` somewhere off the
   server regularly.

| File | Purpose |
|------|---------|
| `deploy/setup-vps.sh` | one-time (re-runnable) server setup |
| `deploy/deploy.sh` | pull, install, migrate, restart API, rebuild frontend |
| `deploy/ecosystem.config.js` | pm2 process definition |
| `deploy/nginx-kcl.conf.template` | nginx site (SPA fallback, API reverse proxy) |
| `deploy/backup.sh` | nightly MySQL dump + uploads archive, 14 days kept |

### Any other host

Requires **Node.js 20.9+** (needed by `sharp`) and a MySQL 5.7+/8 database.

1. **Install:** `npm ci` (Prisma is a regular dependency, so `npm ci --omit=dev`
   also works; `postinstall` runs `prisma generate`).
2. **Environment** (set in the host's dashboard, not in a committed file):
   - `NODE_ENV=production`
   - `DATABASE_URL=mysql://USER:PASSWORD@HOST:PORT/DATABASE`
   - `JWT_KEY` - generate with `openssl rand -hex 32` (32+ chars, no placeholder words)
   - `PASSWORD_KEY` - only needed if the database already has accounts from
     before the bcrypt switch; keep the **same** value they were created with.
     Those accounts are re-hashed with bcrypt on their next login.
   - `FRONTEND_URL` - exact frontend origin(s), comma-separated, e.g.
     `https://kigalicoffeelab.com,https://www.kigalicoffeelab.com`
   - `PUBLIC_APP_URL` (optional) - origin printed into table QR stickers;
     defaults to the first `FRONTEND_URL` origin.
   - `UPLOADS_DIR` - a **persistent** volume path (see below).
   - `PORT` - most hosts set this for you.
   - `TRUST_PROXY` (optional) - proxy hops in front of the API, default `1`.
   - `SMS_DRIVER` - `log` (default: texts are only written to `logs/sms.log`,
     nothing is sent) or `africastalking` with `AT_USERNAME`, `AT_API_KEY` and
     optional `AT_SENDER_ID`. `AT_USERNAME=sandbox` uses Africa's Talking's free
     sandbox. See "Customer text messages" below.
3. **Migrate** before each start/release: `npm run release`
   (= `prisma migrate deploy`). Never run `prisma migrate dev` in production.
4. **Start:** `npm start` (= `node server.js`; there is no build step).
5. **First admin:** set `INITIAL_ADMIN_EMAIL` and a unique
   `INITIAL_ADMIN_PASSWORD` (16+ chars), run `npm run seed` once with
   `NODE_ENV=production`, then remove the password from the host. Production
   seeding creates settings and that admin only - no demo data. Never run the
   seed without `NODE_ENV=production` on a real database (it creates the demo
   accounts below).

Typical host settings (Render / Railway / a VPS with pm2):
`Build command: npm ci` · `Pre-deploy/Release: npm run release` · `Start: npm start`.

**Uploads.** Images and payment proofs are written to `UPLOADS_DIR`. On hosts
with ephemeral disks (Render, Railway, Heroku without a volume) they vanish on
every redeploy - attach a persistent disk and point `UPLOADS_DIR` at it. The
sample images committed under `uploads/` must be copied into that volume once
(`cp -r uploads/products uploads/drinks uploads/staff "$UPLOADS_DIR"/`).
Payment proofs are never served publicly; staff view them through the
authenticated orders API.

**Security built in:** bcrypt password hashing, `helmet` security headers,
rate limiting on `/auth` (failed attempts only, `AUTH_RATE_LIMIT` per 15 min),
CORS restricted to `FRONTEND_URL`, and generic 500 messages in production.

**Existing databases:** migration `20261003151700_add_bookings_training_history`
adds `tables.qrToken` as `NOT NULL` with no default. It applies cleanly to an
empty database; if you are migrating a database that already has rows in
`tables`, back up first and fill the column before applying it.

The frontend is built separately - set `VITE_API_URL` (and optionally
`VITE_UPLOADS_URL`) to this API's public origin; see the frontend README.

## Customer text messages (SMS)

Customers get a text when:

| Event | Text |
|---|---|
| Order placed | order number + tracking link |
| Order **Ready for Pickup**, **Dispatched**, **Delivered**, or **Cancelled** by staff | status update |
| Table booking made / cancelled by staff / moved to a new time | confirmation with reference `B-<id>` |
| Training application received / **Approved** / **Rejected** | confirmation and decision |

All texts go through `utils/sms.js`. With `SMS_DRIVER=log` (the default) nothing
is sent: each text is printed in the server console and appended to
`logs/sms.log`, so you can check the wording during development. Switch to
`SMS_DRIVER=africastalking` once you have an account. A failed text never
fails the order, booking or application that triggered it.

Delivery orders also carry the **delivery fee** set by the admin in
Settings → Payment (0 = free). The server adds it to the order total.

## Seed demo data (coffee machines, menu items, tables, admin/manager users)

```bash
npm run seed
# or: node seed.js
```

Default accounts created by the seed script in development:

| Role    | Email                          | Password     |
|---------|---------------------------------|--------------|
| Admin   | admin@kigalicoffeelab.com        | Admin@123     |
| Manager | manager@kigalicoffeelab.rw      | Manager@123   |

These demo accounts are for local development only. Production bootstrap
requires a unique admin email and password from environment variables, and
does not create the demo manager account.

## How ordering works

There's no customer registration at all. A customer:

1. Browses the menu (coffee/food) or the coffee-machine catalog - no login.
2. Places an order via `POST /orders`. The response includes a public
   **order code** (e.g. `KCL-482131`) - that code is the customer's entire
   "account". They use it to track the order and see notifications about it.
3. Three order types, decided automatically by what's in the order (or the
   client's requested `orderType` for menu items):
   - **`dine_in`** - coffee/food, ordered while at the shop. Requires a
     `tableId` (see Tables below). Progresses: `Order Placed` → `Preparing`
     → `Ready for Pickup` → `Served`.
   - **`pickup`** - coffee/food ordered ahead (e.g. from home). No table
     needed - the customer collects it later. Same stage list as `dine_in`.
   - **`delivery`** - coffee-machine purchases only, shipped like
     e-commerce. Coffee/food can **never** be delivered. Progresses:
     `Order Placed` → `Pending` → `Confirmed` → `Dispatched` → `Delivered`.
4. `Cancelled` is always possible on top of any of these. A guest can cancel
   their own order (`PUT /orders/track/:code/cancel`) only while it's still
   at `Order Placed`; after that, only staff can cancel it.

**Only `Order Placed` is ever set automatically.** Every later stage is set
exclusively by staff (Admin, or a Manager with the `manageOrders`
permission) via `PUT /orders/:id { status }` - nothing on a timer, nothing
the customer can do to advance it themselves. See `utils/orderStages.js` for
the exact stage lists and validation.

## Tables

Admin/Manager (with `manageTables`) add physical tables (e.g. "Table 1") via
`POST /tables`. `GET /tables` is public so the app can offer a table picker
to a customer placing a `dine_in` order.

## Payment

Only three payment methods exist, matching real cash/mobile-money use in
Rwanda - no card processor:

- **Cash** - paid in person.
- **MoMo Pay** - sent to the shop's MoMo phone number.
- **MoMo Code** - paid to the shop's MoMo merchant/till code.

Admin controls which of these are enabled and the actual number/code via
`PUT /settings` (`cashEnabled`, `momoPayEnabled`, `momoCodeEnabled`,
`momoPayNumber`, `momoCode`). The app reads them from `GET /settings/public`
so it always shows the current number/code at checkout.

## Notifications

Every time staff changes an order's status, a `Notification` row is created
against that order's public code. `GET /notifications/:code` (public) lets
the app show the customer what happened to their order without any login;
`PUT /notifications/:id/read` and `PUT /notifications/:code/read-all` mark
them read.

## Roles & Permissions

- **admin** - full access to everything.
- **manager** - access only to what the admin has switched on for them, per
  permission: `manageProducts`, `manageDrinks`, `manageOrders`,
  `manageUsers`, `manageSettings`, `viewDashboard`, `manageBarista`,
  `manageTables`.
- Customers have **no account or role at all** - see "How ordering works".

## Data model (MySQL / Prisma)

Full schema lives in `prisma/schema.prisma` (source of truth) with the
applied migration in `prisma/migrations/`.

| Table            | Notes |
|------------------|-------|
| `users`          | staff only (admin/manager); role, permissions (JSON column) |
| `products`       | coffee machines; `listedById` → users.id |
| `ratings`        | one row per user review of a product |
| `drinks`         | KCL menu items - coffee AND food, distinguished by `type` |
| `tables`         | physical tables, e.g. "Table 1"; admin-managed |
| `carts` / `cart_items` | legacy: an optional server-side cart for logged-in accounts |
| `orders` / `order_items` | guest-friendly; `orderCode` is the public identifier; `order_items.itemType` is `machine` or `menu` |
| `notifications`  | keyed by `orderCode`, not a user id |
| `settings`       | singleton row: site info + Cash/MoMo Pay/MoMo Code toggles and details |
| `visits`         | one row per page visit, for dashboard analytics |
| `wishlists`      | many-to-many join table between users and products |

**API compatibility note:** the JSON API still returns a Mongo-style `_id`
string (mirroring the integer `id`) on every object, reconstructed on the
way out in `utils/transform.js`.

## Key endpoints

- `GET /menu?type=coffee|food` (alias of `/drinks`) - the KCL menu, public
- `GET /products` (public, active only) · staff CRUD at `POST/PUT/DELETE /products` (multipart `image` field)
- `GET /tables` (public) · staff CRUD at `POST/PUT/DELETE /tables`
- `POST /orders` (guest-friendly, no login) · `GET /orders/track/:code` (public)
  · `PUT /orders/track/:code/cancel` (public, guest self-cancel while still `Order Placed`)
  · staff: `GET /orders`, `GET /orders/:id`, `GET /orders/:id/proof`,
  `PUT /orders/:id { status }`, `DELETE /orders/:id`
- `GET /notifications/:code` (public) · `PUT /notifications/:id/read` · `PUT /notifications/:code/read-all`
- `GET /settings/public` (payment toggles + MoMo details) · staff: `GET/PUT /settings`
- `GET /dashboard` (staff, `viewDashboard` permission)
- `POST /auth/login` (staff only) · `POST /users/staff` (admin creates manager/admin accounts)

Product, drink, and staff-story images are served publicly from `/uploads/...`.
Payment proofs are not served from the public uploads path; authorized staff
view them through the orders API.

## Verified this session

- Ported from Sequelize to **Prisma**: `prisma/schema.prisma` is now the
  single source of truth for the data model, with the applied migration
  committed in `prisma/migrations/`.
- Every backend file passes `node --check` (syntax-clean) after every edit.
- A full dry-require pass loads every controller/route/middleware/util the
  same way `server.js` does, with the real generated Prisma Client - no
  typos, no broken imports.
- This was tested against a **real, live MariaDB instance**, not just
  syntax-checked: `prisma migrate dev` created all 16 tables correctly
  (including the `PaymentMethod` enum, whose values contain spaces and are
  mapped via `@map` - MySQL enum values can't contain spaces, so the app's
  public API keeps using `"Cash"` / `"MoMo Pay"` / `"MoMo Code"` while
  Prisma's Client uses `Cash` / `MoMoPay` / `MoMoCode` internally; see
  `utils/transform.js` and `orderController.js` for the two-way mapping).
  `node seed.js` seeded machines/menu/tables/staff accounts successfully,
  and the full guest-order-to-staff-confirms flow (place a dine-in order
  with no login → staff logs in → advances Preparing → Ready for Pickup →
  Served → guest sees the final status and 3 auto-generated notifications,
  still with no account) ran end-to-end with identical results to the
  pre-migration Sequelize version. Registration, product/drink creation via
  multipart forms, wishlist toggling, ratings, cart operations, dashboard
  stats, and table CRUD were also smoke-tested live.

## What's new in this update

- **QR table ordering**: every table gets a unique, downloadable sticker (PNG) with the
  KCL logo centered in the QR code (high error-correction so the logo never breaks
  scanning - verified with a real QR decoder), "Welcome to Kigali Coffee Lab" and the
  table name printed above it, and a "Scan to order" caption below. Scanning resolves
  the table via `GET /tables/scan/:qrToken`, which blocks a new order while one is
  already in progress at that table (until it's Served or Cancelled), and warns if a
  reservation starts within 30 minutes.
- **Table bookings**: `TableBooking` + `TableBookingTable` support reserving one or more
  tables at once, with party size and overlap/conflict detection.
- **Generalized Coffee Training**: `BaristaSession`/`BaristaApplication` were renamed to
  `TrainingSession`/`TrainingApplication` (same underlying tables, zero data loss) and
  extended with `courseType` (barista/cupping/roasting/cva) and `level`
  (Foundation/Intermediate/Professional for the 3 global-certificate courses). See
  `/training/*` routes.
- **History**: new `StaffStory` model (cover photo + gallery) for the public employee
  stories page, managed under the `manageHistory` permission.
- New permissions: `manageTrainings`, `manageTables` (now covers bookings too),
  `manageHistory` (replacing `manageBarista`).

Everything above was verified against a real, running MySQL instance and, for the
frontend-facing behaviour, against a real headless browser (Playwright) - including a
real QR code scan-and-decode test and an actual browser-triggered file download of the
sticker PNG.

## Sequential order codes (latest update)

Order codes are now sequential and 7 digits, starting at `KCL-0000001`, then
`KCL-0000002`, and so on - derived directly from the order's own
auto-incrementing database id (`utils/orderCode.js`), so there's no separate
counter to keep in sync and no collision risk even under concurrent checkouts
(verified with 10 simultaneous order submissions - all got unique, correctly
sequential codes with zero gaps or duplicates).

## Admin analytics, nav counts, and scan-first checkout (latest update)

- **`GET /dashboard/nav-counts`**: per-resource counts (products, drinks,
  orders, tables, upcoming/active bookings, training sessions, pending
  training applications, history stories, users) for the admin sidebar's
  little number badges. Open to any staff account (`AnyStaffAuth`) since
  it's harmless counts and real data access stays gated per-resource.
- **`GET /orders/stats`**: order counts for Today/Yesterday/This
  Week/This Month/This Year/Lifetime, for the admin Orders page's
  analytics cards.
- **`GET /orders?period=today|yesterday|week|month|year`**: the orders
  list now also filters by the same periods (shared `periodRange()`
  helper), so clicking an analytics card can filter the table under it.

## PDF reports + new permission (latest update)

- **`GET /reports/orders?period=today|yesterday|week|month|year|lifetime`**:
  streams a real PDF (via `pdfkit`) with a summary (total orders, total
  revenue, average order value), a breakdown by status and by order type,
  and an order list (capped to the most recent 200 rows for very large
  periods, so the file stays a reasonable size). Gated behind a new
  `manageReports` permission.
- To grant a manager this (or any) permission, use
  `PUT /users/staff/:id` with a full `permissions` object - this is the
  endpoint that actually writes permissions; `PUT /users/:id` only
  updates username/email/phone/address/password and silently ignores a
  `permissions` field if you send one there.

Verified end-to-end: a manager without `manageReports` gets a real 403;
after granting it, they can download reports; the generated PDF was
rendered to an image and its extracted text checked, not just confirmed
to be *a* PDF.

## Custom date reports, logo, and payment method (latest update)

- **`GET /reports/orders`** now also accepts `date=YYYY-MM-DD` (a single
  day) or `from=YYYY-MM-DD&to=YYYY-MM-DD` (an inclusive range), in
  addition to the existing `period=` presets - whichever is given, the
  report title reflects exactly that (e.g. "21 Oct 2026" or
  "15 Oct 2026 – 21 Oct 2026").
- The PDF now shows the KCL logo in the top-right corner of the header
  (`backend/assets/kcl-logo.jpg`, same file used for the table QR
  stickers).
- Added a **"By Payment Method"** breakdown (Cash / MoMo Pay / MoMo Code,
  count + revenue each), and each row in the order list now shows that
  order's payment method alongside its amount.

Verified: single-date and date-range reports both tested directly
(correct titles, correct filtering) and through the actual admin UI (a
real browser download, not just an API call); mixed Cash/MoMo Pay/MoMo
Code orders confirmed to break down and list correctly; invalid ranges
(from after to, or only one side given) correctly rejected with a clear
message.

## First-order date (latest update)

`GET /orders/stats` now also returns `firstOrderDate` (the very first
order ever placed, or `null`) - the admin Reports page uses this to bound
its date pickers so staff can't pick a day before any order existed.

## Reservation-aware table blocking (latest update)

`GET /tables/scan/:qrToken` now distinguishes two windows before a
reservation's start time, not just one:
- **Within 60 minutes** (`upcomingBooking` present): a warning only -
  ordering is still allowed.
- **Within 30 minutes, or the reservation is already underway**
  (`upcomingBooking.blocked: true`): ordering is not allowed at all.

This is enforced in two places so a direct API call can't skip past it:
the scan endpoint (what the frontend reads to decide what to show) and
`createOrder` itself, which now also re-checks both this and whether the
table already has an order in progress - previously only the scan
endpoint reported the latter; a direct `POST /orders` could bypass it.
Verified: a booking 2 minutes out correctly returns `blocked: true` and a
direct order attempt on that table is rejected with 400; a booking 45
minutes out returns a warning but still allows the order through.
