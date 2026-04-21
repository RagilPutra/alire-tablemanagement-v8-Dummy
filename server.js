const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;

// Enforce SESSION_SECRET in production
if (!SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET environment variable is required!');
  console.error('Set it in Railway: Variables tab → Add SESSION_SECRET');
  process.exit(1);
}

// ── Crash Protection ──────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Don't exit - keep server running
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// ── Users ─────────────────────────────────────────────────────────────────────
const USERS = {
  'Alire': { password: 'Sajiannusantara', role: 'master', displayName: 'Alire' },
};

// ── Database ──────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'alire.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize SQLite database
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // Better concurrency

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tableId TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    pax INTEGER NOT NULL,
    duration INTEGER DEFAULT 150,
    staff TEXT,
    notes TEXT,
    babyChairs INTEGER DEFAULT 0,
    combos TEXT DEFAULT '[]',
    preOrder TEXT DEFAULT '[]',
    poNote TEXT DEFAULT '',
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS waiting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pax INTEGER NOT NULL,
    zone TEXT,
    notes TEXT,
    addedAt TEXT NOT NULL,
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
  CREATE INDEX IF NOT EXISTS idx_bookings_type ON bookings(type);
`);

console.log('✓ SQLite database initialized');

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    httpOnly: true
  }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Request validation helpers
function validateBooking(data) {
  const errors = [];
  if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
    errors.push('Name is required');
  }
  if (data.name && data.name.length > 30) {
    errors.push('Name must be 30 characters or less');
  }
  if (!data.phone || typeof data.phone !== 'string' || data.phone.trim().length === 0) {
    errors.push('Phone number is required');
  }
  if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    errors.push('Valid date is required (YYYY-MM-DD)');
  }
  if (!data.time || !/^\d{2}:\d{2}$/.test(data.time)) {
    errors.push('Valid time is required (HH:MM)');
  }
  if (!data.pax || typeof data.pax !== 'number' || data.pax < 1 || data.pax > 60) {
    errors.push('Party size must be between 1 and 60');
  }
  if (!data.tableId || typeof data.tableId !== 'string') {
    errors.push('Table selection is required');
  }
  if (data.notes && data.notes.length > 150) {
    errors.push('Notes must be 150 characters or less');
  }
  return errors;
}

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const user = USERS[username];
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    req.session.user = { username, role: user.role, displayName: user.displayName };
    res.json({ ok: true, user: req.session.user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json(req.session.user);
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// ── Booking routes ────────────────────────────────────────────────────────────
app.get('/api/bookings', requireAuth, (req, res) => {
  try {
    const { date } = req.query;
    let bookings;
    
    if (date) {
      const stmt = db.prepare('SELECT * FROM bookings WHERE date = ? ORDER BY time');
      bookings = stmt.all(date);
    } else {
      const stmt = db.prepare('SELECT * FROM bookings ORDER BY date DESC, time DESC LIMIT 1000');
      bookings = stmt.all();
    }
    
    // Parse JSON fields
    bookings = bookings.map(b => ({
      ...b,
      combos: JSON.parse(b.combos || '[]'),
      preOrder: JSON.parse(b.preOrder || '[]'),
    }));
    
    res.json(bookings);
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

app.get('/api/bookings/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const stmt = db.prepare('SELECT * FROM bookings WHERE id = ?');
    const booking = stmt.get(id);
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    // Parse JSON fields
    booking.combos = JSON.parse(booking.combos || '[]');
    booking.preOrder = JSON.parse(booking.preOrder || '[]');
    
    res.json(booking);
  } catch (error) {
    console.error('Get booking error:', error);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

app.post('/api/bookings', requireAuth, (req, res) => {
  try {
    const data = req.body;
    
    // Validate
    const errors = validateBooking(data);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', ') });
    }
    
    // Sanitize and enforce limits
    const booking = {
      tableId: data.tableId,
      type: data.type || 'reservation',
      name: data.name.trim().slice(0, 30),
      phone: (data.phone || '').trim().slice(0, 20),
      date: data.date,
      time: data.time,
      pax: Math.min(60, Math.max(1, parseInt(data.pax))),
      duration: parseInt(data.duration) || 150,
      staff: (data.staff || '').trim(),
      notes: (data.notes || '').trim().slice(0, 150),
      babyChairs: parseInt(data.babyChairs) || 0,
      combos: JSON.stringify(data.combos || []),
      preOrder: JSON.stringify(data.preOrder || []),
      poNote: (data.poNote || '').trim()
    };
    
    const stmt = db.prepare(`
      INSERT INTO bookings (tableId, type, name, phone, date, time, pax, duration, staff, notes, babyChairs, combos, preOrder, poNote)
      VALUES (@tableId, @type, @name, @phone, @date, @time, @pax, @duration, @staff, @notes, @babyChairs, @combos, @preOrder, @poNote)
    `);
    
    const result = stmt.run(booking);
    
    // Return created booking
    const newBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
    newBooking.combos = JSON.parse(newBooking.combos);
    newBooking.preOrder = JSON.parse(newBooking.preOrder);
    
    res.json(newBooking);
  } catch (error) {
    console.error('Create booking error:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

app.put('/api/bookings/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    
    // Validate
    const errors = validateBooking(data);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', ') });
    }
    
    // Check if exists
    const existing = db.prepare('SELECT id FROM bookings WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    // Sanitize and enforce limits
    const booking = {
      id: parseInt(id),
      tableId: data.tableId,
      type: data.type || 'reservation',
      name: data.name.trim().slice(0, 30),
      phone: (data.phone || '').trim().slice(0, 20),
      date: data.date,
      time: data.time,
      pax: Math.min(60, Math.max(1, parseInt(data.pax))),
      duration: parseInt(data.duration) || 150,
      staff: (data.staff || '').trim(),
      notes: (data.notes || '').trim().slice(0, 150),
      babyChairs: parseInt(data.babyChairs) || 0,
      combos: JSON.stringify(data.combos || []),
      preOrder: JSON.stringify(data.preOrder || []),
      poNote: (data.poNote || '').trim()
    };
    
    const stmt = db.prepare(`
      UPDATE bookings 
      SET tableId = @tableId, type = @type, name = @name, phone = @phone, date = @date, time = @time, 
          pax = @pax, duration = @duration, staff = @staff, notes = @notes, babyChairs = @babyChairs,
          combos = @combos, preOrder = @preOrder, poNote = @poNote
      WHERE id = @id
    `);
    
    stmt.run(booking);
    
    // Return updated booking
    const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    updated.combos = JSON.parse(updated.combos);
    updated.preOrder = JSON.parse(updated.preOrder);
    
    res.json(updated);
  } catch (error) {
    console.error('Update booking error:', error);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

app.delete('/api/bookings/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const stmt = db.prepare('DELETE FROM bookings WHERE id = ?');
    const result = stmt.run(id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete booking error:', error);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

// ── Waiting list routes ───────────────────────────────────────────────────────
app.get('/api/waiting', requireAuth, (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM waiting ORDER BY createdAt');
    const waiting = stmt.all();
    res.json(waiting);
  } catch (error) {
    console.error('Get waiting list error:', error);
    res.status(500).json({ error: 'Failed to fetch waiting list' });
  }
});

app.post('/api/waiting', requireAuth, (req, res) => {
  try {
    const { name, pax, zone, notes, addedAt } = req.body;
    
    if (!name || !pax || !addedAt) {
      return res.status(400).json({ error: 'Name, pax, and time are required' });
    }
    
    const stmt = db.prepare(`
      INSERT INTO waiting (name, pax, zone, notes, addedAt)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      name.trim().slice(0, 30),
      Math.min(60, Math.max(1, parseInt(pax))),
      zone || '',
      (notes || '').trim().slice(0, 150),
      addedAt
    );
    
    const newEntry = db.prepare('SELECT * FROM waiting WHERE id = ?').get(result.lastInsertRowid);
    res.json(newEntry);
  } catch (error) {
    console.error('Create waiting entry error:', error);
    res.status(500).json({ error: 'Failed to add to waiting list' });
  }
});

app.delete('/api/waiting/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const stmt = db.prepare('DELETE FROM waiting WHERE id = ?');
    const result = stmt.run(id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete waiting entry error:', error);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// ── Download DB Backup ────────────────────────────────────────────────────────
app.get('/api/download-db', requireAuth, (req, res) => {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return res.status(404).json({ error: 'Database file not found' });
    }
    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename="alire_backup_${timestamp}.db"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(DB_FILE);
  } catch (error) {
    console.error('Download DB error:', error);
    res.status(500).json({ error: 'Failed to download database' });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  try {
    // Test database connection
    db.prepare('SELECT 1').get();
    res.json({ ok: true, database: 'connected' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ── SPA ───────────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Alire Table Management running on port ${PORT}`);
  console.log(`✓ Database: ${DB_FILE}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing database...');
  db.close();
  process.exit(0);
});
