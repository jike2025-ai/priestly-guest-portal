# Priestly Apartments: website and online booking

Live at **https://www.priestlyapartments.com** (the plain `priestlyapartments.com` redirects to `www`). The old GitHub address redirects here too, so printed QR codes keep working.

## What lives where
| Part | Where |
|---|---|
| Landing page, booking page, owner refund page | This repo, served by **Vercel** from the `main` branch (every push to `main` redeploys) |
| Booking server (`api/`, `lib/`) | Vercel serverless functions in the same project |
| Bookings database | **Supabase** (`supabase/schema.sql`) |
| Payments and refunds | **Paystack** |
| Receipt and alert emails | **Resend** |
| Domain | **MokoHost** (DNS records point to Vercel) |
| Welcome-pass generator | `card.html` (staff tool) |

Site settings are in `config.js`. Prices are in `lib/core.js` (`ROOMS`) and must match `index.html`.

## House rules built in
- Per night. Arrive any time on the check-in day. Check-out by 12:00 noon the next day.
- The caution fee is added to the total and is refundable after the team inspects the apartment.
- Guests request the refund from their receipt page from check-out day. Owners review it from the secure link in the alert email, then refund in full or in part, or decline with a reason.

## Vercel environment variables
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (the `sb_secret_` key), `PAYSTACK_SECRET_KEY`, `RESEND_API_KEY`, `FROM_EMAIL`, `OWNER_EMAILS`, `ADMIN_SECRET`, `SITE_URL` (`https://www.priestlyapartments.com`), `ALLOWED_ORIGIN`. Optional: `HOLD_MINUTES` (default 15). After changing a variable, redeploy.

## Going live checklist
1. Paystack account approved. Put the **live** secret key in `PAYSTACK_SECRET_KEY`; set the **live webhook URL** to `https://www.priestlyapartments.com/api/paystack-webhook`.
2. In Paystack **Preferences**, keep "Pass fees to customers" **off**, and turn off Paystack's own customer receipts.
3. Resend: verify `priestlyapartments.com`, then set `FROM_EMAIL` to `Priestly Apartments <bookings@priestlyapartments.com>`. Set `OWNER_EMAILS` to the business inbox(es).
4. In Supabase, delete all test rows from the `bookings` table (test bookings block real dates). Check Supabase's current rules about free projects pausing when inactive.
5. Vercel: move to a paid (Pro) plan, because the free Hobby plan is for non-commercial use.
6. In `config.js` set `TEST_MODE` to `false`.
7. Make one small real booking and one refund end to end.

## Safety notes
- Never put secret keys in this repo or in chat. They live only in Vercel's environment variables.
- The server works out prices itself and confirms every payment directly with Paystack before sending receipts.
- Guest names, phones, emails and any bank details are personal data under Nigeria's data protection law.
- Keep refund-review emails private: the button inside is the key to the refund decision.
