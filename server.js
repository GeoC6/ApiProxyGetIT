import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import compression from 'compression';
import https from 'https';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import axios from 'axios';
import { initDatabase, db, getSetting, setSetting, getAllSettings } from './database.js';
import { log } from './services/logger.js';
import autoservicioRouter from './routes/autoservicio.js';
import proxyRouter from './routes/proxy.js';
import syncStatusRouter from './routes/sync-status.js';
import { startBackgroundProcessor } from './services/background.js';
import criticalErrorsRouter from './routes/critical-errors.js';
import posSessionsRouter from './routes/pos-sessions.js';
import ordersRouter from './routes/orders.js';
import logsRouter from './routes/logs.js';
import transbankRouter from './routes/transbankc2c.js';
import imagesRouter from './routes/images.js';
import promotionsRouter from './routes/promotions.js';
import customersRouter from './routes/customers.js';
import flejesRouter from './routes/flejes.js';

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60000,
    rejectUnauthorized: true
});

const app = express();
const ODOO_URL = process.env.ODOO_URL || 'https://getit.posgo.cl';

// Buffer temporal de productos por sesión (TTL 10 min)
const PRODUCTS_BUFFER = new Map();
const PRODUCTS_BUFFER_TTL = 10 * 60 * 1000;

// Caché completa de sesión por PIN (sin TTL fijo — se invalida por versión)
const SESSION_FULL_CACHE = new Map();
const SESSION_FULL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h como tope máximo de seguridad

const getDataVersionFromOdoo = async (configId) => {
    try {
        const response = await axios.get(`${ODOO_URL}/pos_data_version`, {
            params: { config_id: configId || 0 },
            timeout: 5000,
            httpsAgent,
        });
        if (response.status === 200 && response.data?.version) return response.data.version;
        return null;
    } catch {
        return null;
    }
};

// Jobs de carga asíncrona de sesión
const SESSION_LOADING_JOBS = new Map();
const JOB_TTL = 15 * 60 * 1000; // 15 min

const refreshSessionInBackground = (pin, body) => {
    axios.post(`${ODOO_URL}/pos_validate_session`, body, {
        timeout: 120000,
        headers: { 'Content-Type': 'application/json' },
        httpsAgent
    }).then(async response => {
        const fullData = response.data;
        if (fullData?.authenticated) {
            const version = await getDataVersionFromOdoo(fullData.config_id);
            const { products = [], categories = [], multi_barcodes = {}, pos_categories = [], ...sessionOnly } = fullData;
            const sessionId = String(sessionOnly.session_id || sessionOnly.pos_session_id || '');
            PRODUCTS_BUFFER.set(sessionId, { products, categories, multi_barcodes, pos_categories, ts: Date.now() });
            SESSION_FULL_CACHE.set(pin, { products, categories, multi_barcodes, pos_categories, sessionOnly, version, ts: Date.now() });
            log.info(`[session-cache] Refresh completado: sesión ${sessionId} (${products.length} productos)`);
        }
    }).catch(err => {
        log.warn('[session-cache] Background refresh falló:', err.message);
    });
};

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/static', express.static(path.join(__dirname, 'static')));
app.use('/display', express.static(path.join(__dirname, 'display')));

global.db = db;

app.use((req, res, next) => {
    if (!req.path.includes('/getWeight') &&
        !req.path.includes('/api/logs/stream') &&
        !req.path.includes('/display/') &&
        !req.path.includes('/images/')) {
        log.info(`${req.method} ${req.path}`, req.body ? 'with body' : 'no body');
    }
    next();
});

// Hash de la contraseña para poder validar contra el cache offline sin
// guardar el password en texto plano en el SQLite local.
const hashAuthCredential = (username, password) =>
    crypto.createHash('sha256').update(`${username}::${password}`).digest('hex');

app.post('/authenticate_user', async (req, res) => {
    const { username, password } = req.body || {};
    try {
        log.info('Proxy: /authenticate_user → Odoo');
        const response = await axios.post(`${ODOO_URL}/authenticate_user`, req.body, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' },
            httpsAgent: httpsAgent
        });

        if (response.data?.success && username && password) {
            // Guardar credenciales (hasheadas) + datos de usuario para poder
            // seguir autenticando localmente si Odoo no responde más tarde.
            await setSetting('CACHED_ADMIN_AUTH', JSON.stringify({
                hash: hashAuthCredential(username, password),
                user_id: response.data.user_id,
                username: response.data.username,
                name: response.data.name,
            }));
        }

        res.json(response.data);
    } catch (error) {
        log.error('Error en proxy /authenticate_user:', error.message);

        // Sin internet/Odoo caído → intentar con las últimas credenciales
        // válidas guardadas localmente, para no bloquear al cajero.
        if (username && password) {
            try {
                const cachedRaw = await getSetting('CACHED_ADMIN_AUTH', null);
                if (cachedRaw) {
                    const cached = JSON.parse(cachedRaw);
                    if (cached.hash === hashAuthCredential(username, password)) {
                        log.warn('authenticate_user: usando credenciales cacheadas (sin conexión a Odoo)');
                        return res.json({
                            success: true,
                            user_id: cached.user_id,
                            username: cached.username,
                            name: cached.name,
                            source: 'cache',
                        });
                    }
                }
            } catch (cacheErr) {
                log.warn('authenticate_user: error leyendo cache local:', cacheErr.message);
            }
        }

        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/pos_validate_session', async (req, res) => {
    try {
        const pinIngresado = (req.body.pin || '').toString().trim();
        log.info(`Proxy: /pos_validate_session → PIN recibido: ${'*'.repeat(pinIngresado.length)}`);

        // 1. Validación PIN local (instantánea)
        const localPin = await getSetting('POS_PIN', null);
        if (localPin && localPin.trim() !== '') {
            if (pinIngresado !== localPin.trim()) {
                log.error('PIN rechazado por validación local');
                return res.status(401).json({ authenticated: false, error: 'PIN incorrecto' });
            }
            log.info('PIN local verificado correctamente');
        }

        const cached = SESSION_FULL_CACHE.get(pinIngresado);
        const hasFreshCache = cached && Date.now() - cached.ts < SESSION_FULL_CACHE_TTL;

        // 2. Si hay caché → verificar versión antes de responder
        if (hasFreshCache) {
            const currentVersion = await getDataVersionFromOdoo(cached.sessionOnly?.config_id);

            if (currentVersion === null) {
                // Sin internet → usar caché como fallback
                const { products, categories, multi_barcodes, pos_categories, sessionOnly } = cached;
                const sessionId = String(sessionOnly.session_id || sessionOnly.pos_session_id || '');
                PRODUCTS_BUFFER.set(sessionId, { products, categories, multi_barcodes, pos_categories, ts: Date.now() });
                log.info(`Sesión ${sessionId} desde caché (fallback sin internet, ${products.length} productos)`);
                return res.json({ ...sessionOnly, authenticated: true, products_ready: true });
            }

            if (currentVersion === cached.version) {
                // Misma versión → caché vigente, responder inmediatamente sin tocar Odoo
                const { products, categories, multi_barcodes, pos_categories, sessionOnly } = cached;
                const sessionId = String(sessionOnly.session_id || sessionOnly.pos_session_id || '');
                PRODUCTS_BUFFER.set(sessionId, { products, categories, multi_barcodes, pos_categories, ts: Date.now() });
                log.info(`Sesión ${sessionId} desde caché (versión sin cambios, ${products.length} productos)`);
                return res.json({ ...sessionOnly, authenticated: true, products_ready: true });
            }

            // Versión cambió → responder con caché actual y refrescar en background
            log.info(`Versión cambió en Odoo — usando caché mientras se refresca en background`);
            const { products, categories, multi_barcodes, pos_categories, sessionOnly } = cached;
            const sessionId = String(sessionOnly.session_id || sessionOnly.pos_session_id || '');
            PRODUCTS_BUFFER.set(sessionId, { products, categories, multi_barcodes, pos_categories, ts: Date.now() });
            refreshSessionInBackground(pinIngresado, req.body);
            return res.json({ ...sessionOnly, authenticated: true, products_ready: true });
        }

        // 3. Sin caché → cargar desde Odoo en background, responder inmediatamente
        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        SESSION_LOADING_JOBS.set(jobId, { status: 'loading', ts: Date.now() });

        setImmediate(async () => {
            try {
                const response = await axios.post(`${ODOO_URL}/pos_validate_session`, req.body, {
                    timeout: 120000,
                    headers: { 'Content-Type': 'application/json' },
                    httpsAgent
                });
                const fullData = response.data;
                if (fullData?.authenticated) {
                    const version = await getDataVersionFromOdoo(fullData.config_id);
                    const { products = [], categories = [], multi_barcodes = {}, pos_categories = [], ...sessionOnly } = fullData;
                    const sessionId = String(sessionOnly.session_id || sessionOnly.pos_session_id || '');
                    PRODUCTS_BUFFER.set(sessionId, { products, categories, multi_barcodes, pos_categories, ts: Date.now() });
                    SESSION_FULL_CACHE.set(pinIngresado, { products, categories, multi_barcodes, pos_categories, sessionOnly, version, ts: Date.now() });
                    SESSION_LOADING_JOBS.set(jobId, { status: 'ready', sessionData: { ...sessionOnly, products_ready: true }, sessionId, ts: Date.now() });
                    log.info(`[job ${jobId}] Sesión lista: ${sessionId} (${products.length} productos)`);
                } else {
                    SESSION_LOADING_JOBS.set(jobId, { status: 'error', error: fullData?.error || 'Autenticación fallida', ts: Date.now() });
                    log.warn(`[job ${jobId}] Autenticación fallida en Odoo`);
                }
                for (const [k, v] of SESSION_LOADING_JOBS.entries()) {
                    if (Date.now() - v.ts > JOB_TTL) SESSION_LOADING_JOBS.delete(k);
                }
            } catch (err) {
                SESSION_LOADING_JOBS.set(jobId, { status: 'error', error: err.message, ts: Date.now() });
                log.error(`[job ${jobId}] Error en carga de sesión:`, err.message);
            }
        });

        log.info(`[job ${jobId}] Sin caché — cargando desde Odoo en background`);
        return res.json({ authenticated: true, session_loading: true, job_id: jobId });

    } catch (error) {
        log.error('Error en proxy /pos_validate_session:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/pos/balanza-rules', async (req, res) => {
    try {
        const response = await axios.get(`${ODOO_URL}/pos_balanza_rules`, {
            timeout: 5000,
            httpsAgent: httpsAgent
        });
        res.json(response.data);
    } catch (error) {
        res.json({ success: true, rules: [] });
    }
});

app.get('/api/pos/session-products', (req, res) => {
    const sessionId = String(req.query.session_id || '');
    const entry = PRODUCTS_BUFFER.get(sessionId);
    if (!entry) {
        return res.status(404).json({ success: false, error: 'Productos no disponibles, vuelve a iniciar sesión' });
    }
    log.info(`session-products: entregando ${entry.products.length} productos para sesión ${sessionId}`);
    res.json({
        success: true,
        products: entry.products,
        categories: entry.categories,
        multi_barcodes: entry.multi_barcodes,
        pos_categories: entry.pos_categories || []
    });
});

app.get('/api/pos/session-loading-status', (req, res) => {
    const jobId = req.query.job_id || '';
    const job = SESSION_LOADING_JOBS.get(jobId);
    if (!job) return res.status(404).json({ status: 'not_found' });
    res.json(job);
});

app.post('/check_session_exists', async (req, res) => {
    try {
        log.info('Proxy: /check_session_exists → Odoo');
        const response = await axios.post(`${ODOO_URL}/check_session_exists`, req.body, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' },
            httpsAgent: httpsAgent
        });
        res.json(response.data);
    } catch (error) {
        log.error('Error en proxy /check_session_exists:', error.message);
        res.status(500).json({ session_exists: false });
    }
});

app.post('/pos_close_session', async (req, res) => {
    try {
        log.info('Proxy: /pos_close_session → Odoo');
        const formData = new URLSearchParams();
        for (const [key, value] of Object.entries(req.body)) {
            formData.append(key, value);
        }
        const response = await axios.post(`${ODOO_URL}/pos_close_session`, formData, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent: httpsAgent
        });
        res.json(response.data);
    } catch (error) {
        log.error('Error en proxy /pos_close_session:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/pos/payment_totals', async (req, res) => {
    try {
        const { session_id } = req.body;
        if (!session_id) return res.status(400).json({ error: 'session_id requerido' });

        const formData = new URLSearchParams();
        formData.append('session_id', session_id.toString());

        const response = await axios.post(`${ODOO_URL}/pos_payment_totals`, formData, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent: httpsAgent
        });

        res.json(response.data);
    } catch (error) {
        log.error('Error en /api/pos/payment_totals:', error.message);
        res.json({ result: [] });
    }
});

app.get('/', (req, res) => {
    res.json({
        name: 'API Intermedia Autoservicio',
        version: '1.0.0',
        status: 'running',
        endpoints: [
            'POST /authenticate_user',
            'POST /pos_validate_session',
            'POST /check_session_exists',
            'POST /pos_close_session',
            'POST /api/autoservicio/create-order',
            'POST /api/autoservicio/create-order-im30',
            'GET /api/autoservicio/printers/list',
            'POST /api/sell',
            'POST /api/sell_im30',
            'POST /api/last_sell_im30',
            'POST /api/refund_im30',
            'POST /api/close_day_im30',
            'POST /api/poll_im30',
            'GET /api/orders/display',
            'POST /api/orders/update-status',
            'POST /api/orders/pos',
            'GET /api/orders/stats',
            'GET /api/orders/history',
            'GET /api/orders/delivered',
            'POST /api/pos/sessions/validate',
            'POST /api/pos/sessions/close',
            'GET /api/pos/sessions/status',
            'POST /api/pos/sessions/clear-cache',
            'GET /api/logs/history',
            'GET /api/logs/stream',
            'GET /api/logs/stats',
            'POST /api/logs/test',
            'GET /api/sync-status',
            'GET /api/sync-status/debug',
            'GET /api/critical-errors',
            'POST /api/critical-errors/clear/:id',
            'POST /api/critical-errors/clear-all',
            'GET /images/products/:productId',
            'DELETE /images/cache',
            'GET /images/cache/stats',
            'GET /health',
            'GET /api/status',
            'GET /display/employee',
            'GET /display/customer'
        ]
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/display/employee', (req, res) => {
    res.sendFile(path.join(__dirname, 'display', 'employee.html'));
});

app.get('/display/customer', (req, res) => {
    res.sendFile(path.join(__dirname, 'display', 'customer.html'));
});

app.get('/realtime-logs.html', (req, res) => {
    const realtimeLogsPath = path.join(__dirname, 'realtime-logs.html');
    if (fs.existsSync(realtimeLogsPath)) res.sendFile(realtimeLogsPath);
    else res.status(404).send('Archivo de logs en tiempo real no encontrado');
});

app.get('/api/config', async (req, res) => {
    try {
        const saved = await getAllSettings();
        const config = {
            APP_PORT: saved.APP_PORT || process.env.PORT || '9000',
            IM30_PORT: saved.IM30_PORT || process.env.IM30_PORT || 'COM8',
            TBK_URL: saved.TBK_URL || process.env.TBK_URL || 'https://localhost:8001',
            XSIGN_URL: saved.XSIGN_URL || process.env.XSIGN_URL || 'http://localhost:5999',
            KDS_URL: saved.KDS_URL || process.env.KDS_URL || 'http://192.168.1.83:9001',
            ODOO_URL: saved.ODOO_URL || process.env.ODOO_URL || 'https://getit.posgo.cl',
            PRINTER_ENABLED: saved.PRINTER_ENABLED || process.env.PRINTER_ENABLED || 'true',
            PRINTER_TICKET_NAME: saved.PRINTER_TICKET_NAME || process.env.PRINTER_TICKET_NAME || '',
            FLEJE_PRINTER_NAME: saved.FLEJE_PRINTER_NAME || process.env.FLEJE_PRINTER_NAME || 'POS-80',
            POS_PIN: saved.POS_PIN || '',
        };
        res.json({ success: true, config });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/config', async (req, res) => {
    try {
        const allowed = ['APP_PORT', 'IM30_PORT', 'TBK_URL', 'XSIGN_URL', 'KDS_URL', 'ODOO_URL', 'PRINTER_ENABLED', 'PRINTER_TICKET_NAME', 'FLEJE_PRINTER_NAME', 'POS_PIN'];
        const entries = Object.entries(req.body).filter(([key]) => allowed.includes(key));
        await Promise.all(entries.map(([key, value]) => setSetting(key, String(value))));
        log.success(`Configuración actualizada: ${entries.map(([k]) => k).join(', ')}`);
        res.json({ success: true, updated: entries.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.use('/api/autoservicio', autoservicioRouter);
app.use('/api', proxyRouter);
app.use('/api/sync-status', syncStatusRouter);
app.use('/api/critical-errors', criticalErrorsRouter);
app.use('/api/pos', posSessionsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/logs', logsRouter);
app.use('/api/tbk', transbankRouter);
app.use('/images', imagesRouter);
app.use('/api/promotions', promotionsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/flejes', flejesRouter);

app.use((err, req, res, next) => {
    log.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.use('*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

async function start() {
    try {
        await initDatabase();
        const savedPort = await getSetting('APP_PORT', process.env.PORT || '9000');
        const PORT = parseInt(savedPort, 10) || 9000;
        app.listen(PORT, () => {
            try { fs.writeFileSync(path.join(__dirname, '.current-port'), String(PORT)); } catch(e) {}
            log.success(`API Intermedia iniciada en puerto ${PORT}`);
            log.info(`URL: http://localhost:${PORT}`);
            log.info(`ENV path: ${path.join(__dirname, '.env')}`);
            log.info(`PRINTER_TICKET_NAME: "${process.env.PRINTER_TICKET_NAME || '(no definido)'}"`);
            log.info(`ODOO_URL: "${process.env.ODOO_URL || '(no definido)'}"`);
            log.info(`KDS_URL: "${process.env.KDS_URL || '(no definido)'}"`);
            log.info(`HTTPS Agent keepAlive: ACTIVO`);
            log.info(`═══════════════════════════════════════════════════════════`);
            log.info(`Sistema de notificaciones WhatsApp: ${process.env.N8N_WEBHOOK_URL ? 'ACTIVO' : 'DESACTIVADO'}`);
        });
        startBackgroundProcessor();
    } catch (error) {
        log.error('Error iniciando servidor:', error);
        process.exit(1);
    }
}

start();