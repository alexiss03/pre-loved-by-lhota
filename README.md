# Pre-loved by Lhota Website

Website for preloved clothes, bags, and miscellaneous items with:

- Buyer storefront and cart
- Checkout page includes a built-in shopping section (search + category filter + add to cart)
- Checkout with payment reference + screenshot upload
- Checkout mode: guest checkout or create account during checkout
- Delivery location picker loaded from the internet (Region -> City/Municipality -> Barangay)
- Admin direct-purchase URL generator for Facebook sharing (`/buy/:itemId?qty=N`)
- Admin AI product-name generator from uploaded image (OpenAI Vision)
- Admin checkout PayMongo links by amount step (every PHP 50), auto-shown on checkout
- Admin Facebook auto-post cron (random items to Facebook Page feed)
- Admin notification config: set email address for new-order alerts
- Admin order management pipeline: `PENDING` -> `PAID` -> `FOR_DELIVERY` -> `RECEIVED`
- Admin archive and delete controls for order records
- Unprocessed order reminder notifications (hourly scan, one-time reminder per overdue order)
- Generic delivery fee computed from selected region:
  - Manila: PHP 300
  - Luzon: PHP 500
  - Visayas: PHP 1000
  - Mindanao: PHP 2000
- Shop page with category tabs, search, and filters (`/shop`)
- Manual admin payment approval flow
- Buyer email notifications for payment approved and later status updates

## Tech

- Node.js + Express
- EJS templates
- SQLite database storage (`data/store.sqlite`) with JSON snapshot backup (`data/store.json`)
- `nodemailer` for email notifications

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment file and update values:

```bash
cp .env.example .env
```

Important env values:

- `ADMIN_EMAIL`, `ADMIN_PASSWORD`: admin login credentials
- `SMTP_*`, `FROM_EMAIL`: email sending settings (required for notifications)
- `FROM_NAME`, `SMTP_REJECT_UNAUTHORIZED`: optional SMTP sender/tls settings
- `SESSION_SECRET`: session encryption secret
- `STORAGE_PROVIDER`: `SQLITE` (default), `SUPABASE`, or `JSON`
- `SUPABASE_URL`, plus one key locally; in production use `SUPABASE_SERVICE_ROLE_KEY`
- `UPLOAD_STORAGE_PROVIDER`: `LOCAL` or `SUPABASE`
- `SUPABASE_STORAGE_BUCKET`: required when uploads should persist in Supabase Storage
- `ALLOW_LOCAL_STORAGE_IN_PRODUCTION`: keep `false` so production fails instead of silently using local container storage
- `UNPROCESSED_ORDER_REMINDER_HOURS` (optional): default is `24`
- `OPENAI_API_KEY` (optional): required for AI product-name generation in Admin
- `OPENAI_MODEL` (optional): default `gpt-4.1-mini`

3. Start the app:

```bash
npm run dev
```

or

```bash
npm start
```

4. Open:

- Shop: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin/login`

## How the order flow works

1. Buyer adds items to cart and checks out.
2. Buyer enters payment details and uploads payment proof.
3. Order is saved with `PENDING` status.
4. Admin gets a new-order email alert (if enabled in Admin dashboard settings).
5. Admin marks order as **Paid** after verifying payment.
6. Order moves to `PAID` and buyer receives a payment-approved email.
7. Admin updates order to `FOR_DELIVERY`, then `RECEIVED` as fulfillment progresses.
8. Buyer receives email updates for status changes.

## Notes

- Uploaded files can be stored locally (`public/uploads`) or in Supabase Storage.
- Initial product data is auto-seeded when DB state does not exist yet.
- Default database is SQLite (`data/store.sqlite`), which is free and does not require a paid DB service.
- For free hosted DB, use Supabase with `STORAGE_PROVIDER=SUPABASE`.
- In production, keep both database and uploads on Supabase so redeploys do not overwrite runtime data.
- If SMTP is not configured, email sending is skipped safely.
- Admin dashboard has an SMTP health card and **Send SMTP Test** action.
- Facebook auto-post requires a valid Facebook **Page ID** and **Page access token** configured in Admin.
- Overdue pending orders trigger a one-time reminder email to the configured admin notification email.
- Location dropdown data is fetched from [PSGC Cloud API](https://psgc.cloud/).

## Free Hosted DB (Supabase)

1. Create a free Supabase project.
2. Open Supabase SQL Editor and run:
   - [`sql/supabase_init.sql`](/Users/maryalexissolis/Documents/lhotas.preloved/sql/supabase_init.sql)
3. In `.env`, set:
   - `STORAGE_PROVIDER=SUPABASE`
   - `SUPABASE_URL=...`
   - `SUPABASE_SERVICE_ROLE_KEY=...`
   - `UPLOAD_STORAGE_PROVIDER=SUPABASE`
   - `SUPABASE_STORAGE_BUCKET=...`
   - `ALLOW_LOCAL_STORAGE_IN_PRODUCTION=false`
4. Restart the app.

The app will migrate current local snapshot data into Supabase automatically when remote state is empty.
For persistent uploads, create a public Storage bucket in Supabase and use that bucket name in `SUPABASE_STORAGE_BUCKET`.
In production, the app now expects `SUPABASE_SERVICE_ROLE_KEY` for both DB writes and Supabase Storage uploads.

## Admin Login

- URL: `http://localhost:3002/admin/login`
- Credentials are from `.env`:
  - `ADMIN_EMAIL`
  - `ADMIN_PASSWORD`

## SMTP quick fix (Gmail example)

1. Open `http://localhost:3002/admin/login` and go to **SMTP Email Settings** in Admin Orders.
2. Set real values:
   - `SMTP Host`: `smtp.gmail.com`
   - `SMTP Port`: `587`
   - `SMTP Secure`: `No`
   - `SMTP Username`: your real Gmail
   - `SMTP Password`: your Google app password (16-char, not your normal login password)
   - `From Email`: same real Gmail
3. Save, then use **Send SMTP Test**.

You can still use `.env` directly:

- `SMTP_USER=your-real-gmail@gmail.com`
- `SMTP_PASS=your-google-app-password`
- `FROM_EMAIL=your-real-gmail@gmail.com`
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `SMTP_SECURE=false`

If you save SMTP values in Admin, those saved values are used first; otherwise `.env` is used.

Legacy `.env`-only steps:

1. Set real values in `.env`:
   - `SMTP_USER=your-real-gmail@gmail.com`
   - `SMTP_PASS=your-google-app-password` (16-character app password, not your normal login password)
   - `FROM_EMAIL=your-real-gmail@gmail.com`
2. Keep:
   - `SMTP_HOST=smtp.gmail.com`
   - `SMTP_PORT=587`
   - `SMTP_SECURE=false`
3. In Admin Orders, use **Send SMTP Test** to verify delivery.
