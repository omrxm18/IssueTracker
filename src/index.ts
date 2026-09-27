import express from 'express';
import db, { dbReady } from './db';
import { timingSafeEqual } from 'crypto';

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static('html'));

const PORT = process.env.PORT || 4000;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

const REPOS = ['Perch', 'manview', 'DroidSpaces', 'KernelSU-Next', 'Whatsapp-bot'];

function safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const auth = req.headers.authorization;
    if (!INTERNAL_TOKEN || !auth || !safeCompare(auth, `Bearer ${INTERNAL_TOKEN}`)) {
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

// Every dependent route waits for migrations to finish before touching the DB.
app.use((req, res, next) => {
    dbReady.then(() => next()).catch(next);
});

app.post('/api/issues', rateLimit, async (req, res, next) => {
    try {
        const { repo, title, body, severity, reporter_name, reporter_contact, honeypot } = req.body;
        const visibility = req.body.visibility === 'internal' ? 'internal' : 'public';

        if (honeypot) return res.status(400).end();
        if (!repo || !REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
        if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
            return res.status(400).json({ error: 'title and body required' });
        }
        if (reporter_name !== undefined && reporter_name !== null && typeof reporter_name !== 'string') {
            return res.status(400).json({ error: 'invalid reporter_name' });
        }
        if (reporter_contact !== undefined && reporter_contact !== null && typeof reporter_contact !== 'string') {
            return res.status(400).json({ error: 'invalid reporter_contact' });
        }

        const row = await db.get<{ id: number | bigint }>(
            `INSERT INTO issues (repo, title, body, severity, reporter_name, reporter_contact, visibility)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             RETURNING id`,
            [
                repo, title.trim(), body.trim(),
                ['low', 'normal', 'high', 'critical'].includes(severity) ? severity : 'normal',
                reporter_name || null, reporter_contact || null,
                visibility,
            ]
        );

        res.status(201).json({ id: row?.id });
    } catch (err) {
        next(err);
    }
});

app.get('/api/issues/public', async (req, res, next) => {
    try {
        const repo = req.query.repo as string | undefined;
        const base = `SELECT id, repo, title, severity, status, created_at FROM issues WHERE visibility = 'public'`;
        const rows = repo
            ? await db.query(base + ' AND repo = ? ORDER BY created_at DESC', [repo])
            : await db.query(base + ' ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

app.get('/api/issues', requireAuth, async (req, res, next) => {
    try {
        const { repo, status } = req.query as { repo?: string; status?: string };
        let query = 'SELECT * FROM issues WHERE 1=1';
        const params: string[] = [];
        if (repo) { query += ' AND repo = ?'; params.push(repo); }
        if (status) { query += ' AND status = ?'; params.push(status); }
        res.json(await db.query(query + ' ORDER BY created_at DESC', params));
    } catch (err) {
        next(err);
    }
});

app.get('/api/issues/:id/public', async (req, res, next) => {
    try {
        const row = await db.get(
            `SELECT id, repo, title, body, severity, status, created_at
             FROM issues WHERE id = ? AND visibility = 'public'`,
            [req.params.id]
        );
        if (!row) return res.status(404).json({ error: 'not found' });
        res.json(row);
    } catch (err) {
        next(err);
    }
});

app.get('/api/issues/:id', requireAuth, async (req, res, next) => {
    try {
        const row = await db.get(`SELECT * FROM issues WHERE id = ?`, [req.params.id]);
        if (!row) return res.status(404).json({ error: 'not found' });
        res.json(row);
    } catch (err) {
        next(err);
    }
});

app.patch('/api/issues/:id', requireAuth, async (req, res, next) => {
    try {
        const { status, severity, visibility } = req.body;
        await db.run(
            `UPDATE issues SET status = COALESCE(?, status), severity = COALESCE(?, severity),
             visibility = COALESCE(?, visibility), updated_at = datetime('now')
             WHERE id = ?`,
            [status ?? null, severity ?? null, visibility ?? null, req.params.id]
        );
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => console.log(`issues-tracker listening on :${PORT}`));