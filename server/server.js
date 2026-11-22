require('dotenv').config();
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

if (!process.env.API_KEY) {
    console.error('API_KEY manquante.');
    process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname + '/../pwa'));

// On utilise une variable d'environnement pour le chemin, avec un fallback pour le local
const DB_PATH = process.env.DB_PATH || './poubelles.db';
const db = new DatabaseSync(DB_PATH);



// --- Initialisation de la base ---
db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'user'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS bins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    device_token TEXT UNIQUE NOT NULL,
    lat REAL,
    lng REAL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bin_id INTEGER NOT NULL,
    percentage INTEGER NOT NULL,
    distance INTEGER,
    status TEXT NOT NULL,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// --- Migration : colonnes de localisation (ajout\u00e9es en novembre 2026) ---
{
    const cols = db.prepare('PRAGMA table_info(bins)').all().map(c => c.name);
    if (!cols.includes('lat')) db.exec('ALTER TABLE bins ADD COLUMN lat REAL');
    if (!cols.includes('lng')) db.exec('ALTER TABLE bins ADD COLUMN lng REAL');
    // Coordonnées par défaut pour les poubelles sans emplacement
    db.exec('UPDATE bins SET lat = 46.2 + (id % 5 - 2) * 0.03, lng = 2.21 + (id % 5 - 2) * 0.04 WHERE lat IS NULL AND lng IS NULL');
}

const usersCount = db.prepare(`SELECT COUNT(*) as count FROM users`).get();
if (!usersCount || usersCount.count === 0) {
    const stmt = db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`);
    stmt.run('admin', bcrypt.hashSync('admin123', 10), 'admin');
    stmt.run('user', bcrypt.hashSync('user123', 10), 'user');
    console.log('Comptes cr\u00e9\u00e9s : admin/admin123 (admin), user/user123 (user)');
}

const binsCount = db.prepare(`SELECT COUNT(*) as count FROM bins`).get();
if (!binsCount || binsCount.count === 0) {
    const stmt = db.prepare(`INSERT INTO bins (name, device_token, lat, lng) VALUES (?, ?, ?, ?)`);
    const BIN_CENTER = { lat: 46.2, lng: 2.21 };
    const SEED_NAMES = ['March\u00e9 central', '\u00c9cole primaire', 'Gare routi\u00e8re', 'Quartier r\u00e9sidentiel', 'H\u00f4pital'];
    SEED_NAMES.forEach((name, i) => {
        stmt.run(name, 'BIN-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
            BIN_CENTER.lat + (i - 2) * 0.03, BIN_CENTER.lng + (i - 2) * 0.04);
    });
    console.log('5 poubelles de d\u00e9mo cr\u00e9\u00e9es avec leurs tokens.');
}

// --- Middlewares ---
function authRequired(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'token manquant' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (e) {
        res.status(401).json({ error: 'token invalide' });
    }
}

function adminOnly(req, res, next) {
    if (!req.user || req.user.role !== 'admin')
        return res.status(403).json({ error: 'acc\u00e8s refus\u00e9' });
    next();
}

// --- Auth ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'champs requis' });

    const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
    if (!user) return res.status(401).json({ error: 'identifiants invalides' });
    if (!bcrypt.compareSync(password, user.password_hash))
        return res.status(401).json({ error: 'identifiants invalides' });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role },
        JWT_SECRET, { expiresIn: '24h' }
    );
    res.json({ token, role: user.role, username: user.username });
});

// --- Bins ---
app.get('/api/bins', authRequired, (req, res) => {
    const rows = db.prepare(`
    SELECT
      b.id AS bin_id, b.name, b.device_token, b.lat, b.lng,
      e.percentage, e.distance, e.status, e.received_at
    FROM bins b
    LEFT JOIN (
      SELECT e1.* FROM events e1
      INNER JOIN (SELECT bin_id, MAX(received_at) AS m FROM events GROUP BY bin_id) e2
        ON e1.bin_id = e2.bin_id AND e1.received_at = e2.m
    ) e ON b.id = e.bin_id
    ORDER BY
      CASE WHEN e.percentage IS NULL THEN 1 ELSE 0 END,
      e.percentage DESC,
      b.id ASC
  `).all();

    // Le device_token n'est visible QUE pour l'admin
    if (req.user.role !== 'admin') {
        rows.forEach(row => { delete row.device_token; });
    }

    res.json(rows);
});

app.post('/api/bins', authRequired, adminOnly, (req, res) => {
    const { name, lat, lng } = req.body || {};
    if (!name || !String(name).trim())
        return res.status(400).json({ error: 'nom requis' });

    const toNum = v => (v === undefined || v === null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    const latNum = toNum(lat), lngNum = toNum(lng);
    if (lat !== undefined && lat !== null && latNum === null)
        return res.status(400).json({ error: 'lat invalide' });
    if (lng !== undefined && lng !== null && lngNum === null)
        return res.status(400).json({ error: 'lng invalide' });

    const token = 'BIN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const result = db.prepare(`INSERT INTO bins (name, device_token, lat, lng) VALUES (?, ?, ?, ?)`)
        .run(String(name).trim(), token, latNum, lngNum);
    res.json({ ok: true, id: result.lastInsertRowid, name: String(name).trim(), device_token: token, lat: latNum, lng: lngNum });
});

app.patch('/api/bins/:id', authRequired, adminOnly, (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'id invalide' });

    const body = req.body || {};
    const setParts = [], params = [];

    if (body.name !== undefined && body.name !== null && String(body.name).trim() !== '') {
        setParts.push('name = ?');
        params.push(String(body.name).trim());
    }

    const toNum = v => (v === undefined || v === null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    const latNum = toNum(body.lat), lngNum = toNum(body.lng);
    if (body.lat !== undefined && body.lat !== null && latNum === null)
        return res.status(400).json({ error: 'lat invalide' });
    if (body.lng !== undefined && body.lng !== null && lngNum === null)
        return res.status(400).json({ error: 'lng invalide' });
    if (latNum !== null) { setParts.push('lat = ?'); params.push(latNum); }
    if (lngNum !== null) { setParts.push('lng = ?'); params.push(lngNum); }

    if (setParts.length === 0) return res.status(400).json({ error: 'aucune modification' });
    params.push(id);

    const result = db.prepare(`UPDATE bins SET ${setParts.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) return res.status(404).json({ error: 'poubelle inconnue' });

    const bin = db.prepare(`SELECT * FROM bins WHERE id = ?`).get(id);
    const ev = db.prepare(`
        SELECT e.percentage, e.distance, e.status, e.received_at FROM events e
        INNER JOIN (SELECT bin_id, MAX(received_at) AS m FROM events GROUP BY bin_id) e2
          ON e.bin_id = e2.bin_id AND e.received_at = e2.m
        WHERE e.bin_id = ?
    `).get(id);

    res.json({ ok: true, bin: {
        bin_id: bin.id, name: bin.name, lat: bin.lat, lng: bin.lng,
        percentage: ev ? ev.percentage : null, distance: ev ? ev.distance : null,
        status: ev ? ev.status : null, received_at: ev ? ev.received_at : null
    }});
});

app.delete('/api/bins/:id', authRequired, adminOnly, (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'id invalide' });

    const result = db.prepare(`DELETE FROM bins WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM events WHERE bin_id = ?`).run(id);
    res.json({ ok: true, deleted: result.changes });
});

// --- Status (Arduino -> serveur) ---
app.post('/api/status', (req, res) => {
    const key = req.headers['x-api-key'] || req.body.api_key;
    if (key !== process.env.API_KEY)
        return res.status(401).json({ error: 'unauthorized' });

    const body = req.body;
    const bin_id = body.bin_id;
    const device_token = body.device_token;
    const percentage = body.percentage;
    const distance = body.distance;
    const status = body.status;

    if (typeof percentage !== 'number' || (!bin_id && !device_token))
        return res.status(400).json({ error: 'invalid payload' });

    const findBin = bin_id ?
        `SELECT id FROM bins WHERE id = ? AND device_token = ?` :
        `SELECT id FROM bins WHERE device_token = ?`;

    const params = bin_id ? [bin_id, device_token] : [device_token];
    const bin = db.prepare(findBin).get(...params);
    if (!bin) return res.status(404).json({ error: 'poubelle inconnue' });

    const finalStatus = status || (percentage >= 100 ? 'FULL' : 'OK');
    const safeDistance = (distance === undefined ? null : distance);

    const result = db.prepare(
        `INSERT INTO events (bin_id, percentage, distance, status) VALUES (?, ?, ?, ?)`
    ).run(bin.id, percentage, safeDistance, finalStatus);
    res.json({ ok: true, id: result.lastInsertRowid });
});

const PORT = process.env.PORT || 3000;

// Exported for Vercel: the serverless invocation calls the app per request.
module.exports = app;

// Demarrage du serveur (local).
app.listen(PORT, () => console.log(`Serveur sur http://localhost:${PORT}`));
