import express from 'express';
import db, { dbReady } from './db';
import { timingSafeEqual } from 'crypto';

const app = express();

// Set TRUST_PROXY (e.g. "1") when running behind nginx/Caddy so req.ip is the real client IP.
if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v);
}

app.use(express.json({ limit: '50kb' }));
app.use(express.static('html'));

const PORT = process.env.PORT || 4000;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

// Single source of truth for repos. The form loads this list from /api/repos.
// Slugs are lowercase; incoming values are lowercased before matching.
const REPOS = [
    { slug: 'perch', label: 'Perch' },
    { slug: 'qubystock', label: 'QubyStock' },
    { slug: 'manview', label: 'manview' },
    { slug: 'droidspaces', label: 'DroidSpaces' },
    { slug: 'kernelsu-next', label: 'KernelSU-Next' },
    { slug: 'whatsapp-bot', label: 'whatsapp_bot' },
    { slug: 'remote-actions', label: 'RemoteActions' },
];
const REPO_SLUGS = new Set(REPOS.map(r => r.slug));

const SEVERITIES = ['low', 'normal', 'high', 'critical'];
const VISIBILITIES = ['public', 'internal'];

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

// Checks AND records. Called only after the submission passed validation,
// so a typo'd request doesn't lock the person out.
function hitRateLimit(ip: string): boolean {
    const now = Date.now();
    const last = submitTimestamps.get(ip);
    if (last && now - last < RATE_LIMIT_WINDOW_MS) return true;
    submitTimestamps.set(ip, now);
    return false;
}

function parseId(raw: string | string[] | undefined): number | null {
    const value = Array.isArray(raw) ? raw[0] : raw;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// A failed migration must stop the server instead of becoming an unhandled rejection.
dbReady.catch(err => {
    console.error('Database migration failed:', err);
    process.exit(1);
});

// Every dependent route waits for migrations to finish before touching the DB.
// (two-arg then: an error thrown inside next() must not call next() a second time)
app.use((req, res, next) => {
    dbReady.then(() => next(), next);
});

app.get('/api/repos', (req, res) => {
    res.json(REPOS);
});

app.post('/api/issues', async (req, res, next) => {
    try {
        const { title, body, severity, reporter_name, reporter_contact, honeypot } = req.body ?? {};
        const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim().toLowerCase() : '';
        const visibility = req.body?.visibility === 'internal' ? 'internal' : 'public';

        if (honeypot) return res.status(400).end();
        if (!REPO_SLUGS.has(repo)) return res.status(400).json({ error: 'invalid repo' });
        if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
            return res.status(400).json({ error: 'title and body required' });
        }
        if (reporter_name !== undefined && reporter_name !== null && typeof reporter_name !== 'string') {
            return res.status(400).json({ error: 'invalid reporter_name' });
        }
        if (reporter_contact !== undefined && reporter_contact !== null && typeof reporter_contact !== 'string') {
            return res.status(400).json({ error: 'invalid reporter_contact' });
        }

        if (hitRateLimit(req.ip || 'unknown')) {
            return res.status(429).json({ error: 'too many requests, please try again later' });
        }

        const row = await db.get<{ id: number | bigint }>(
            `INSERT INTO issues (repo, title, body, severity, reporter_name, reporter_contact, visibility)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             RETURNING id`,
            [
                repo, title.trim(), body.trim(),
                SEVERITIES.includes(severity) ? severity : 'normal',
                reporter_name?.trim() || null, reporter_contact?.trim() || null,
                visibility,
            ]
        );

        res.status(201).json({ id: row ? Number(row.id) : undefined });
    } catch (err) {
        next(err);
    }
});

app.get('/api/issues/public', async (req, res, next) => {
    try {
        const repo = typeof req.query.repo === 'string' ? req.query.repo.toLowerCase() : undefined;
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
        if (repo) { query += ' AND repo = ?'; params.push(repo.toLowerCase()); }
        if (status) { query += ' AND status = ?'; params.push(status); }
        res.json(await db.query(query + ' ORDER BY created_at DESC', params));
    } catch (err) {
        next(err);
    }
});

app.get('/api/issues/:id/public', async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (id === null) return res.status(404).json({ error: 'not found' });
        const row = await db.get(
            `SELECT id, repo, title, body, severity, status, created_at
             FROM issues WHERE id = ? AND visibility = 'public'`,
            [id]
        );
        if (!row) return res.status(404).json({ error: 'not found' });
        res.json(row);
    } catch (err) {
        next(err);
    }
});

app.get('/api/issues/:id', requireAuth, async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (id === null) return res.status(404).json({ error: 'not found' });
        const row = await db.get(`SELECT * FROM issues WHERE id = ?`, [id]);
        if (!row) return res.status(404).json({ error: 'not found' });
        res.json(row);
    } catch (err) {
        next(err);
    }
});

app.patch('/api/issues/:id', requireAuth, async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (id === null) return res.status(404).json({ error: 'not found' });

        const { status, severity, visibility } = req.body ?? {};

        // TODO: whitelist status values once the allowed set is known (it lives in the migrations).
        if (status !== undefined && (typeof status !== 'string' || !status.trim() || status.length > 32)) {
            return res.status(400).json({ error: 'invalid status' });
        }
        if (severity !== undefined && !SEVERITIES.includes(severity)) {
            return res.status(400).json({ error: 'invalid severity' });
        }
        if (visibility !== undefined && !VISIBILITIES.includes(visibility)) {
            return res.status(400).json({ error: 'invalid visibility' });
        }
        if (status === undefined && severity === undefined && visibility === undefined) {
            return res.status(400).json({ error: 'nothing to update' });
        }

        // CURRENT_TIMESTAMP works on both SQLite and Postgres (datetime('now') is SQLite-only).
        const result = await db.run(
            `UPDATE issues SET status = COALESCE(?, status), severity = COALESCE(?, severity),
             visibility = COALESCE(?, visibility), updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [status?.trim() ?? null, severity ?? null, visibility ?? null, id]
        );
        if (result.changes === 0) return res.status(404).json({ error: 'not found' });
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Body-parser errors (bad JSON, payload too large) carry a 4xx status; don't report them as 500s.
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) {
        console.error(err);
        return res.status(500).json({ error: 'internal server error' });
    }
    res.status(status).json({ error: status === 413 ? 'payload too large' : 'bad request' });
});

app.listen(PORT, () => console.log(`issues-tracker listening on :${PORT}`));