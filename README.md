# RohiField Family Clinic: Booking API

I'm OluwaSheyi, an AI automation specialist in Lagos. This is my Task 1 submission for the Koya Cohort 4 assessment: a clinic booking API and a web page that uses it. All five levels are done, and everything is live.

## Links
- **Live site:** https://clinic-booking-api-rj9u.onrender.com
- **API base URL:** https://clinic-booking-api-rj9u.onrender.com (same server, so one address covers both)
- **API key:** `my-secret-key-123` (send it in the `X-API-Key` header on every request. It's a throwaway key made for this assessment.)

## What a patient can do
Pick a free time, enter a name and email, and get a booking ID like `RFC-9F3A21`. Changed your mind? Cancel it and the slot opens up for someone else.

## Endpoints
- `POST /reset`: replaces all slots and clears every booking
- `GET /slots`: all slots, earliest first, each with an `available` flag (optional `?provider=`)
- `POST /bookings`: books a slot
- `GET /bookings/:id`: looks up one booking
- `DELETE /bookings/:id`: cancels a booking and frees its slot
- `GET /bookings?email=&limit=&cursor=`: one person's bookings, a page at a time

## How I handled each level
1. **Level 1:** list slots, book one, look one up. Booking IDs are short and readable, and the code checks that none ever repeat.
2. **Level 2:** one piece of middleware checks the API key before anything else runs, so a missing or wrong key gets 401 everywhere. Bookings are validated (missing fields, bad email, unknown slot, slot already started). Name and email are trimmed and the email is stored in lower case. Every error comes back as `{"error": "..."}`.
3. **Level 3:** checking whether a slot is free and saving the booking happen in one step with nothing in between, so two people can't both get the same slot. The second one gets 409. I tested it on the live site by firing 20 bookings at one slot at the same moment: 1 got through, 19 got 409. Cancelling frees the slot.
4. **Level 4:** an `Idempotency-Key` saves the first response. Same key and same body gives back the same status and the same booking ID. Same key with a different body gets 422. Paging uses a cursor you pass back to get the next page, and `limit` must be between 1 and 50.
5. **Level 5:** each email gets 5 attempts per rolling minute, and failed attempts count too. The 6th gets 429 with a `Retry-After` header in whole seconds. Other emails aren't affected.

## How I built it
Backend isn't my home turf. My day job is automations with n8n, Make and CRMs, so I built this one level at a time and tested every rule before moving on. I used Claude to explain each step and explain the why, then I ran, broke and re-tested everything myself, including the 20-at-once race test and spamming the booking button until the rate limit kicked in.

## Tradeoffs I know about
- **Data lives in memory,** so a restart clears it. That works here because `/reset` loads the slots. For a real clinic I'd move to Postgres with a unique rule allowing one confirmed booking per slot.
- **The no-double-booking guarantee holds on one server.** With several servers, the database would have to enforce it.
- **The web page sends the API key from the browser,** so anyone can see it in the page source. In a real product the key would stay on the server.
- **Free hosting sleeps when idle,** so the first visit can take a little while. I use an uptime monitor to keep it awake.

## Run it locally
    npm install
    node server.js

Set the `API_KEY` environment variable. The web page is served from `/public`.
