# Online booking (test mode) — setup guide

The website stays on GitHub Pages. A small server on **Vercel** (the `api/` folder) talks to **Paystack** (payments and refunds), **Supabase** (bookings and dates) and **Resend** (branded email receipts). Nothing here charges real money until you swap in your *live* Paystack keys.

## House rules built in
- **Per night.** Arrive any time on your check-in day. Every night ends with **check-out by 12:00 noon** the next day.
- **Caution fee** is added to the total and is **refundable** after the team inspects the apartment.
- Receipts, emails and pages carry the Priestly logo, tagline, address, phones and **"The Priestly Apartments Team"** sign-off.

## How a booking flows
1. Guest opens `book.html`, picks an apartment and dates (taken dates are refused).
2. `/api/book` works out the price on the server, holds the dates for 15 minutes and starts a Paystack payment.
3. The guest pays and returns to `book.html?ref=...`. Paystack also calls `/api/paystack-webhook`. The server asks Paystack to confirm the payment, checks the amount, marks the booking **confirmed** and emails the guest receipt and an owner alert (once only).

## How a caution-fee refund flows
1. From **check-out day**, the guest opens their receipt page (link is in the receipt email) and taps **Request caution fee refund**. They confirm their email; they may add a message and, if they paid by bank transfer, bank details.
2. The request is recorded and **you get an email** with a secure "Open refund review" button. The guest gets an acknowledgement.
3. You inspect the apartment. Then open the review page and choose: **refund in full**, **refund part** (deduct for damage, with a reason), or **do not refund** (with a reason). Tick "I have physically inspected the apartment".
4. **Through Paystack** sends the refund to the guest's original payment method automatically; **Already paid by bank transfer** just records it. The guest is emailed the outcome.
5. Each request can be decided once. Keep the review email private: the button is the key (it is signed with `ADMIN_SECRET`).

Note: Paystack decides which payments can be refunded automatically (card refunds are the usual case). If Paystack refuses, refund from the Paystack dashboard or by bank transfer and choose "Already paid by bank transfer" to record it.

## One-time setup (do this after your Paystack account is confirmed)

### 1. Supabase (free)
1. Create a project at supabase.com.
2. SQL Editor -> New query -> paste `supabase/schema.sql` -> Run.
3. Project Settings -> API: copy the **Project URL** and the **service_role** key (keep it secret).

### 2. Resend (free)
1. Create an account at resend.com and an API key.
2. For testing you can send from `onboarding@resend.dev`, but only to your own Resend account email. To email real guests, verify a domain you own and use an address on it.

### 3. Paystack (test keys)
Dashboard -> Settings -> API Keys & Webhooks. Make sure **Test Mode** is on and copy the **Test Secret Key** (`sk_test_...`). Never put it in a web page or in GitHub.

### 4. Vercel
1. Import this GitHub repo as a new project (use the `booking-test-mode` branch while testing).
2. Add these **Environment Variables**, then redeploy:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | your Supabase service_role key |
| `PAYSTACK_SECRET_KEY` | `sk_test_...` |
| `RESEND_API_KEY` | your Resend key |
| `FROM_EMAIL` | e.g. `Priestly Apartments <bookings@yourdomain.com>` (test: leave empty) |
| `OWNER_EMAILS` | owner email(s), comma separated |
| `ADMIN_SECRET` | a long random phrase you invent (30+ characters). Never share it |
| `SITE_URL` | `https://jike2025-ai.github.io/priestly-guest-portal` |
| `ALLOWED_ORIGIN` | `https://jike2025-ai.github.io` |

3. Copy your Vercel address (like `https://priestly-xxxx.vercel.app`) into **`config.js`** (`API: ...`). Both `book.html` and `admin.html` read it from there.

### 5. Tell Paystack where to send payment notices
Paystack Dashboard -> Settings -> API Keys & Webhooks -> **Test Webhook URL**: `https://YOUR-VERCEL-ADDRESS/api/paystack-webhook`

## Test it
1. Book a future date and pay with a test card from Paystack's documentation. Check the receipt page, the guest email, the owner email and the Supabase row (`confirmed`). Booking the same dates again must be refused.
2. To test a refund before the check-out date, set that booking's `check_out` to today or earlier in Supabase (Table Editor), then request the refund from the receipt page and review it from the owner email.

## Going live
1. After Paystack activation, put the **Live Secret Key** in `PAYSTACK_SECRET_KEY` and set the **Live Webhook URL**.
2. Verify a sending domain in Resend and set `FROM_EMAIL`.
3. In `config.js` set `TEST_MODE: false`.
4. Merge `booking-test-mode` into `main` and add "Book online" buttons to `index.html` linking to `book.html?room=paris` etc.

## Things to know
- Prices are per night and live in `lib/core.js` (`ROOMS`). Keep them in step with `index.html`.
- A check-out day and the next guest's check-in day can be the same day.
- If a guest pays after their 15-minute hold expired and the dates were taken, the booking is flagged `paid_conflict` and you get an email to refund or rebook. A payment whose amount does not match is flagged `amount_mismatch` and you get an email.
- Guest names, phones, emails and any bank details are personal data under Nigeria's data protection law. Keep the Supabase service key private.
