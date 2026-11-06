# Alexa welcome greeting: setup

Flow: smart lock unlocks -> Alexa Routine -> private skill "Priestly Welcome" -> https://www.priestlyapartments.com/api/alexa -> looks up the Echo's room and today's booking -> Alexa speaks the guest's name.

## A. Server (no apartment visit needed)
1. Run `supabase/migration-alexa.sql` in the Supabase SQL editor (paste the SQL text, not the file name).
2. In Vercel > Settings > Environment Variables add `ALEXA_KEY` = a long random string (e.g. 40 letters/digits). Redeploy.
3. Test from a phone browser (shows what Alexa would say; changes nothing):
   `https://www.priestlyapartments.com/api/alexa?key=YOUR_KEY&room=moscow&hour=15`
   (`hour` = pretend time, `day=2026-11-06` = pretend date; rooms: new-york, moscow, rio, paris, dubai, giza, santorini, abuja, zanzibar, kigali.)

## B. Alexa skill (developer.amazon.com/alexa/console/ask, same Amazon account as the Echos)
1. Create skill > name "Priestly Welcome" > English (any region you use) > Custom > Provision your own > Start from scratch.
2. Build > JSON Editor: paste `alexa/interaction-model.json` > Save > Build.
3. Endpoint > HTTPS > Default region: `https://www.priestlyapartments.com/api/alexa?key=YOUR_KEY`, certificate type "My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority". Save.
4. Copy the Skill ID (Endpoint page) and add it in Vercel as `ALEXA_SKILL_ID`. Redeploy.
5. Test tab > enable "Development" > type `ask priestly welcome to greet the guest`. (Unknown Echo = generic welcome; expected.)
6. The skill is in development stage and works on every Echo signed in to that Amazon account. No certification needed.

## C. At the apartment (per room)
1. Alexa app > Devices: confirm the smart lock appears as a lock. (This is the key check; tell me the lock brand/model.)
2. Speak to the room's Echo: "Alexa, ask Priestly Welcome to greet the guest". This registers the Echo in the `echo_devices` table with no room yet.
3. In Supabase SQL editor, find it and name its room:
   `select device_id, last_seen from echo_devices where room is null order by last_seen desc;`
   `update echo_devices set room='moscow', label='Moscow living room' where device_id='PASTE_ID';`
4. Alexa app > More > Routines > + : When = Smart home > the lock > "unlocked" (if offered); Action = Custom > type `ask priestly welcome to greet the guest` > choose that room's Echo. Save.
5. Open the door with a test booking active; the Echo should greet.

## Rules built in
- Check-in day before 12:00: generic welcome only (staff/cleaners preparing the room).
- First unlock from 12:00 on a confirmed booking: personal welcome with first name and room, once.
- Later unlocks: "Welcome back, <name>" from 14:00, generic before that (housekeeping hours).
- After 12:00 on check-out day or no booking: generic welcome, no name.
- Hours adjustable with `ALEXA_GREET_FROM` and `ALEXA_RETURN_FROM`. Odd name pronunciation: `update bookings set say_name='Ah-dah' where reference='PR...';`
