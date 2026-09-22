import express from 'express';
import db from './db';

const app = express();
app.use(express.json());
app.use(express.static('html'));

const PORT = process.env.PORT || 4000;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

const REPOS = ['Perch', 'manview', 'DroidSpaces', 'KernelSU-Next', 'Whatsapp-bot'];


function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const auth = req.headers.authorization;
    if (!INTERNAL_TOKEN || auth !== `Bearer ${INTERNAL_TOKEN}`) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

const RATE_LIMIT_WINDOW_MS = 30_000;
const submitTimestamps = new Map<string, number>();

setInterval(() => {
   const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
   for (const [ip, ts] of submitTimestamps) {
       if (ts < cutoff) submitTimestamps.delete(ip);
    }
}, RATE_LIMIT_WINDOW_MS).unref();

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
    const ip = req.ip || 'unknown';
    const last = submitTimestamps.get(ip);
    const now = Date.now();
    if (last && now - last < RATE_LIMIT_WINDOW_MS) {
        return res.status(429).json({ error: 'too many requests, please try again later' });
    }
    submitTimestamps.set(ip, now);
    next();
}

app.post('/api/issues', rateLimit, (req, res) => {
    const { repo, title, body, severity, reporter_name, reporter_contact, honeypot } = req.body;
    const visibility = req.body.visibility === 'internal' ? 'internal' : 'public'; // ← here

    if (honeypot) return res.status(400).end();
    if (!repo || !REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
    if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'title and body required' });

    const stmt = db.prepare(`
    INSERT INTO issues (repo, title, body, severity, reporter_name, reporter_contact, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
    const info = stmt.run(
        repo, title.trim(), body.trim(),
        ['low', 'normal', 'high', 'critical'].includes(severity) ? severity : 'normal',
        reporter_name || null, reporter_contact || null,
        visibility   // ← added as the 7th param
    );

    res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/issues/public', (req, res) => {
    const repo = req.query.repo as string | undefined;
    const base = `SELECT id, repo, title, severity, status, created_at FROM issues WHERE visibility = 'public'`;
    const rows = repo
        ? db.prepare(base + ' AND repo = ? ORDER BY created_at DESC').all(repo)
        : db.prepare(base + ' ORDER BY created_at DESC').all();
    res.json(rows);
});

app.get('/api/issues', requireAuth, (req, res) => {
    const { repo, status } = req.query as { repo?: string; status?: string };
    let query = 'SELECT * FROM issues WHERE 1=1';
    const params: string[] = [];
    if (repo) { query += ' AND repo = ?'; params.push(repo); }
    if (status) { query += ' AND status = ?'; params.push(status); }
    res.json(db.prepare(query + ' ORDER BY created_at DESC').all(...params));
});

app.get('/api/issues/:id/public', (req, res) => {
    const row = db.prepare(`
    SELECT id, repo, title, body, severity, status, created_at
    FROM issues WHERE id = ? AND visibility = 'public'
    `).get(req.params.id);

    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
});
app.get('/api/issues/:id', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT * FROM issues WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
});

app.patch('/api/issues/:id', requireAuth, (req, res) => {
    const { status, severity, visibility } = req.body;
    db.prepare(`
    UPDATE issues SET status = COALESCE(?, status), severity = COALESCE(?, severity),
    visibility = COALESCE(?, visibility), updated_at = datetime('now')
    WHERE id = ?
    `).run(status ?? null, severity ?? null, visibility ?? null, req.params.id);
    res.status(204).end();
});

app.listen(PORT, () => console.log(`issues-tracker listening on :${PORT}`));
