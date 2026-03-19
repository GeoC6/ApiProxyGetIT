import express from 'express';
import axios from 'axios';
import { db } from '../database.js';
import { log } from '../services/logger.js';

const router = express.Router();
const ODOO_URL = process.env.ODOO_URL || 'https://getit.posgo.cl';

let lastSync = null;
const SYNC_TTL = 60 * 60 * 1000; // 1 hora

const syncFromOdoo = async () => {
    const response = await axios.get(`${ODOO_URL}/get_customers`, { timeout: 30000 });
    const customers = response.data?.customers || [];

    await new Promise((resolve, reject) => {
        db.run('DELETE FROM customers', (err) => {
            if (err) return reject(err);
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO customers (id, name, vat, email, phone, street, city, giro, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            customers.forEach(c => stmt.run(c.id, c.name, c.vat, c.email, c.phone, c.street || '', c.city || '', c.giro || ''));
            stmt.finalize((err) => err ? reject(err) : resolve());
        });
    });

    lastSync = Date.now();
    log.info(`Clientes sincronizados: ${customers.length}`);
    return customers.length;
};

// GET /api/customers/sync — fuerza sincronización desde Odoo
router.get('/sync', async (req, res) => {
    try {
        const count = await syncFromOdoo();
        res.json({ success: true, count });
    } catch (error) {
        log.error('Error sincronizando clientes:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/customers/search?q=RUT_OR_NAME — busca en SQLite local
router.get('/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) {
            return res.json({ success: true, customers: [] });
        }

        // Auto-sync si nunca se ha hecho o expiró
        if (!lastSync || Date.now() - lastSync > SYNC_TTL) {
            try { await syncFromOdoo(); } catch (e) { log.warn('Sync fallido, usando cache existente'); }
        }

        const term = `%${q.toLowerCase()}%`;

        const customers = await new Promise((resolve, reject) => {
            db.all(`
                SELECT id, name, vat, email, phone, street, city, giro FROM customers
                WHERE LOWER(name) LIKE ? OR LOWER(REPLACE(REPLACE(vat, '.', ''), '-', '')) LIKE LOWER(REPLACE(REPLACE(?, '%', ''), '-', ''))
                ORDER BY name LIMIT 20
            `, [term, q], (err, rows) => err ? reject(err) : resolve(rows || []));
        });

        res.json({ success: true, customers });
    } catch (error) {
        log.error('Error buscando clientes:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
