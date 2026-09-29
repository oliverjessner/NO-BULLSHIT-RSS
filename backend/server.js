import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import feedsRouter from './routes/feeds.js';
import articlesRouter from './routes/articles.js';
import listsRouter from './routes/lists.js';
import digestSettingsRouter from './routes/digest-settings.js';
import bullshitRulesRouter from './routes/bullshit-rules.js';
import topicsRouter from './routes/topics.js';
import webhookRouter from './routes/webhook.js';
import { auth, requireLocalApiClient } from './middleware/auth.js';
import { startScheduler } from './services/scheduler.js';
import { getLastFetchStatus, updateAllFeeds } from './services/fetcher.js';
import { subscribe } from './services/events.js';
import { logLine } from './utils/logger.js';
import { initDatabase } from '../scripts/init-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const pinefetchCssPath = path.join(__dirname, '..', 'node_modules', 'pinefetch-designsystem', 'dist', 'pinefetch.css');
const app = express();
const PORT = process.env.PORT || 1377;
const HOST = process.env.HOST || '127.0.0.1';

let isManualFetchRunning = false;

function getStartMessage() {
    return `starting pid=${process.pid} node=${process.version} cwd=${process.cwd()}`;
}

function sendSseUpdate(res, payload) {
    res.write('event: update\n');
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function handleHealth(_req, res) {
    return res.json({ ok: true });
}

function handleFetchStatus(_req, res) {
    return res.json(getLastFetchStatus());
}

function handleEvents(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sendSseUpdate(res, { event: 'connected', data: { at: new Date().toISOString() } });

    const unsubscribe = subscribe(payload => {
        sendSseUpdate(res, payload);
    });

    const keepAlive = setInterval(() => {
        res.write('event: ping\ndata: {}\n\n');
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
    });
}

async function handleFetchRun(_req, res) {
    if (isManualFetchRunning) {
        return res.status(409).json({ error: 'Fetch already running' });
    }

    isManualFetchRunning = true;

    try {
        await updateAllFeeds();
        return res.status(200).json({ ok: true });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Fetch failed' });
    } finally {
        isManualFetchRunning = false;
    }
}

function handleUnhandledError(err, _req, res, _next) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: err?.message || 'Unexpected server error' });
}

async function start() {
    const msg = `Server running at http://${HOST}:${PORT}`;
    await initDatabase();

    app.listen(PORT, HOST, () => {
        console.log(msg);
        logLine(msg);
        return startScheduler();
    });
}

function registerProcessHandlers() {
    process.on('uncaughtException', err => logLine(`uncaughtException: ${err?.stack || err?.message || String(err)}`));
    process.on('unhandledRejection', err =>
        logLine(`unhandledRejection: ${err?.stack || err?.message || String(err)}`),
    );
}

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
});
const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    skip: req => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
});

app.use(
    helmet({
        contentSecurityPolicy: false,
    }),
);
app.use(express.json({ limit: '1mb' }));
app.get('/vendor/pinefetch.css', (_req, res) => res.sendFile(pinefetchCssPath));
app.use(express.static(publicDir));
app.use('/api', requireLocalApiClient, apiLimiter, writeLimiter);
app.use('/api/feeds', feedsRouter);
app.use('/api/articles', articlesRouter);
app.use('/api/lists', listsRouter);
app.use('/api/digest-settings', digestSettingsRouter);
app.use('/api/bullshit-rules', bullshitRulesRouter);
app.use('/api/topics', topicsRouter);
app.use('/api/webhook', webhookRouter);

app.get('/api/health', auth, handleHealth);
app.get('/api/fetch/status', auth, handleFetchStatus);
app.get('/api/events', auth, handleEvents);

app.post('/api/fetch/run', auth, handleFetchRun);

app.use(handleUnhandledError);

logLine(getStartMessage());
registerProcessHandlers();
start().catch(err => {
    console.error('Failed to start server:', err);
    logLine(`Failed to start server: ${err?.stack || err?.message || String(err)}`);
    return process.exit(1);
});
