const express = require('express');
const crypto = require('crypto');
const app = express();

const API_KEY = process.env.API_KEY || 'my-secret-key-123';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function seedSlots() {
  const out = [];
  let n = 1;
  for (let d = 1; d <= 3; d++) {
    for (const provider of ['Dr Ade', 'Dr Bisi']) {
      for (let i = 0; i < 6; i++) {
        const start = new Date();
        start.setUTCDate(start.getUTCDate() + d);
        start.setUTCHours(9, i * 30, 0, 0);
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        out.push({ id: 's' + n++, provider, start: start.toISOString(), end: end.toISOString() });
      }
    }
  }
  return out;
}
let slots = seedSlots();
let bookings = [];
let attempts = new Map();       // Level 5: email -> times of recent attempts
let savedResponses = new Map(); // Level 4: Idempotency-Key -> saved response

// The web page (public folder) loads without a key; the API calls inside it send the key
app.use(express.static('public'));
// LEVEL 2: the lock
app.use((req, res, next) => {
  if (req.get('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'invalid or missing API key' });
  }
  next();
});

app.use(express.json());

function isBooked(slotId) {
  return bookings.some(b => b.slot_id === slotId && b.status === 'confirmed');
}
function newBookingId() {
  let id;
  do {
    id = 'RFC-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (bookings.some(b => b.id === id));
  return id;
}

// LEVEL 5: max 5 attempts per email per minute. Returns seconds to wait, or 0 if allowed.
const WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
function checkRateLimit(email) {
  const now = Date.now();
  const recent = (attempts.get(email) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    attempts.set(email, recent);
    return Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  attempts.set(email, recent);
  return 0;
}

// POST /reset
app.post('/reset', (req, res) => {
  const list = req.body && req.body.slots;
  if (!Array.isArray(list)) {
    return res.status(400).json({ error: 'slots must be an array' });
  }
  slots = list.map(s => ({ id: s.id, provider: s.provider, start: s.start, end: s.end }));
  bookings = [];
  attempts = new Map();
  savedResponses = new Map();
  res.status(200).json({ ok: true });
});

// GET /slots
app.get('/slots', (req, res) => {
  let list = slots;
  if (req.query.provider) {
    list = list.filter(s => s.provider === req.query.provider);
  }
  list = [...list].sort((a, b) => new Date(a.start) - new Date(b.start));
  res.json({ slots: list.map(s => ({ ...s, available: !isBooked(s.id) })) });
});

// POST /bookings
app.post('/bookings', (req, res) => {
  const body = req.body || {};
  const slot_id = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  // LEVEL 5: count every attempt, even ones that fail later
  if (email) {
    const wait = checkRateLimit(email);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
  }

  // LEVEL 4: idempotency
  const idemKey = req.get('Idempotency-Key');
  const fingerprint = JSON.stringify(body);
  if (idemKey && savedResponses.has(idemKey)) {
    const saved = savedResponses.get(idemKey);
    if (saved.fingerprint !== fingerprint) {
      return res.status(422).json({ error: 'Idempotency-Key was used with a different request' });
    }
    return res.status(saved.status).json(saved.body);
  }

  // LEVEL 2: validation
  if (!slot_id || !name || !email) {
    return res.status(400).json({ error: 'slot_id, name and email are required' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'email is not valid' });
  }
  const slot = slots.find(s => s.id === slot_id);
  if (!slot) {
    return res.status(404).json({ error: 'slot not found' });
  }
  if (new Date(slot.start) <= new Date()) {
    return res.status(400).json({ error: 'slot has already started' });
  }

  // LEVEL 3: slot already taken. No pause between this check and the save below,
  // so two requests can never both get through.
  if (isBooked(slot_id)) {
    return res.status(409).json({ error: 'slot already booked' });
  }

  const booking = {
    id: newBookingId(),
    slot_id,
    name,
    email,
    status: 'confirmed',
    created_at: new Date().toISOString(),
  };
  bookings.push(booking);

  if (idemKey) {
    savedResponses.set(idemKey, { fingerprint, status: 201, body: booking });
  }
  res.status(201).json(booking);
});

// GET /bookings?email=&limit=&cursor=  (LEVEL 4)
app.get('/bookings', (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }

  let limit = 10;
  if (req.query.limit !== undefined) {
    const raw = String(req.query.limit);
    if (!/^\d+$/.test(raw)) {
      return res.status(400).json({ error: 'limit must be a whole number from 1 to 50' });
    }
    limit = parseInt(raw, 10);
    if (limit < 1 || limit > 50) {
      return res.status(400).json({ error: 'limit must be a whole number from 1 to 50' });
    }
  }

  let start = 0;
  if (req.query.cursor) {
    const n = parseInt(Buffer.from(String(req.query.cursor), 'base64').toString(), 10);
    if (Number.isNaN(n) || n < 0) {
      return res.status(400).json({ error: 'invalid cursor' });
    }
    start = n;
  }

  const matches = [];
  for (let i = start; i < bookings.length; i++) {
    if (bookings[i].email === email) matches.push(i);
  }
  const pageIdx = matches.slice(0, limit);
  const hasMore = matches.length > limit;
  const lastIdx = pageIdx[pageIdx.length - 1];
  res.json({
    bookings: pageIdx.map(i => bookings[i]),
    next_cursor: hasMore ? Buffer.from(String(lastIdx + 1)).toString('base64') : null,
  });
});

// GET /bookings/:id
app.get('/bookings/:id', (req, res) => {
  const booking = bookings.find(b => b.id === req.params.id);
  if (!booking) {
    return res.status(404).json({ error: 'booking not found' });
  }
  res.json(booking);
});

// DELETE /bookings/:id: cancel (LEVEL 3)
app.delete('/bookings/:id', (req, res) => {
  const booking = bookings.find(b => b.id === req.params.id);
  if (!booking) {
    return res.status(404).json({ error: 'booking not found' });
  }
  if (booking.status === 'cancelled') {
    return res.status(409).json({ error: 'booking already cancelled' });
  }
  booking.status = 'cancelled';
  res.json(booking);
});

// Errors always come back as {"error": "..."}
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  res.status(500).json({ error: 'server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));