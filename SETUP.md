# Online booking (test mode) — setup guide

The website stays on GitHub Pages. A small server on **Vercel** (the `api/` folder) talks to **Paystack** (payment), **Supabase** (bookings and dates) and **Resend** (email receipts). Nothing here charges real money until you swap in your *live* Paystack keys.

## How a booking flows
1. Guest opens `book.html`, picks an apartment and dates (taken dates are refused).
2. `/api/book` works out the price on the server, holds the dates for 15 minutes and starts a Paystack payment.
3. The guest pays on Paystack and returns to `book.html?ref=...`.
4. Paystack calls `/api/paystack-webhook`. The server asks Paystack to confirm the payment, checks the amount, marks the booking **confirmed** and emails the guest receipt and the owner alert (once only).
5. If the webhook is slow, the return page also checks, so the guest still sees their receipt.

## One-time setup

### 1. Supabase (free)
1. Create a project at supabase.com.
2. SQL Editor -> New query -> paste `supabase/schema.sql` -> Run.
3. Project Settings -> API: copy the **Project URL** and the **service_role** key (keep it secret).

### 2. Resend (free)
1. Create an account at resend.com and an API key.
2. For testing you can send from `onboarding@resend.dev`, but only to your own Resend account email. To email real guests you must verify a domain you own (Resend -> Domains) and use an address on it.

### 3. Paystack (test keys)
1. Dashboard -> Settings -> API Keys & Webhooks. Make sure **Test Mode** is on.
2. Copy the **Test Secret Key** (`sk_test_...`). Never put it in a web page or in GitHub.

### 4. Vercel
1. Import this GitHub repo as a new project on vercel.com (use the `booking-test-mode` branch while testing).
2. Add these **Environment Variables** (Project Settings -> Environment Variables), then redeploy:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | your Supabase service_role key |
| `PAYSTACK_SECRET_KEY` | `sk_test_...` |
| `RESEND_API_KEY` | your Resend key |
| `FROM_EMAIL` | e.g. `Priestly Apartments <bookings@yourdomain.com>` (test: leave empty) |
| `OWNER_EMAILS` | owner email(s), comma separated |
| `SITE_URL` | `https://jike2025-ai.github.io/priestly-guest-portal` |
| `ALLOWED_ORIGIN` | `https://jike2025-ai.github.io` |
| `CHECKIN_TIME` / `CHECKOUT_TIME` | optional, e.g. `2:00 PM` / `12:00 PM` (shown in receipts only if set) |

3. Copy your Vercel address (like `https://priestly-xxxx.vercel.app`) and put it in `book.html` at `const API=...`.

### 5. Tell Paystack where to send payment notices
Paystack Dashboard -> Settings -> API Keys & Webhooks -> **Test Webhook URL**:
`https://YOUR-VERCEL-ADDRESS/api/paystack-webhook`

## Test it
Open `book.html`, book a future date, and pay with a test card from Paystack's documentation (Developers -> Test payments). Check: the receipt page, the guest email, the owner email, and the row in Supabase (Table Editor -> bookings, status `confirmed`). Then try booking the same dates again: it must be refused.

## Going live
1. Finish Paystack business activation, then copy the **Live Secret Key** into `PAYSTACK_SECRET_KEY` and set the **Live Webhook URL** the same way.
2. Verify a sending domain in Resend and set `FROM_EMAIL`.
3. In `book.html` set `TEST_MODE=false`.
4. Merge `booking-test-mode` into `main`, and add "Book online" buttons in `index.html` linking to `book.html?room=paris` etc.

## Things to know
- Prices are per night and live in `lib/core.js` (`ROOMS`). Keep them in step with `index.html`.
- Stays are whole nights (check-in day to check-out day). A check-out day and the next guest's check-in day can be the same day.
- If a guest pays after their 15-minute hold expired and the dates were taken meanwhile, the booking is flagged `paid_conflict` and you get an email to refund or rebook.
- If a payment amount does not match, the booking is flagged `amount_mismatch` and you get an email.
- Guest names, phones and emails are personal data under Nigeria's data protection law. Keep the Supabase service key private.
