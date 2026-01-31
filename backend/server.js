import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import feedsRouter from './routes/feeds.js';
import articlesRouter from './routes/articles.js';
import listsRouter from './routes/lists.js';
import { startScheduler } from './services/scheduler.js';
import { getLastFetchStatus, updateAllFeeds } from './services/fetcher.js';
import { subscribe } from './services/events.js';
import { logLine } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 1377;
let isManualFetchRunning = false;

logLine(`starting pid=${process.pid} node=${process.version} cwd=${process.cwd()}`);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/fetch/status', (_, res) => res.json(getLastFetchStatus()));
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = payload => {
        res.write(`event: update\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send({ event: 'connected', data: { at: new Date().toISOString() } });

    const unsubscribe = subscribe(payload => {
        send(payload);
    });

    const keepAlive = setInterval(() => {
        res.write(`event: ping\ndata: {}\n\n`);
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
    });
});

app.use('/api/feeds', feedsRouter);
app.use('/api/articles', articlesRouter);
app.use('/api/lists', listsRouter);

app.post('/api/fetch/run', async (req, res, next) => {
    if (isManualFetchRunning) {
        return res.status(409).json({ error: 'Fetch already running' });
    }

    isManualFetchRunning = true;

    try {
        await updateAllFeeds();
        res.status(200).json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Fetch failed' });
    } finally {
        isManualFetchRunning = false;
    }
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: err?.message || 'Unexpected server error' });
});

async function start() {
    const msg = `Server running at http://localhost:${PORT}`;

    app.listen(PORT, () => {
        console.log(msg);
        logLine(msg);
        return startScheduler();
    });
}

start().catch(err => {
    console.error('Failed to start server:', err);
    logLine(`Failed to start server: ${err?.stack || err?.message || String(err)}`);
    return process.exit(1);
});

process.on('uncaughtException', err => logLine(`uncaughtException: ${err?.stack || err?.message || String(err)}`));
process.on('unhandledRejection', err => logLine(`unhandledRejection: ${err?.stack || err?.message || String(err)}`));
