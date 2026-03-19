import express from 'express';
import axios from 'axios';
import https from 'https';
import { log } from '../services/logger.js';

const router = express.Router();

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const CACHE_TTL = 60 * 60 * 1000; // 1 hora

// Cache por pos_config_id: { data, fetchedAt }
const promotionsCache = new Map();

const getOdooUrl = () => process.env.ODOO_URL || 'https://getit.posgo.cl';

const fetchFromOdoo = async (pos_config_id) => {
    const response = await axios.get(`${getOdooUrl()}/xsolution_loyalty/promotions`, {
        params: { pos_config_id },
        timeout: 10000,
        httpsAgent
    });
    return response.data;
};

// GET /api/promotions?pos_config_id=X
// Devuelve las promociones del cache, o las obtiene de Odoo si no están cacheadas
router.get('/', async (req, res) => {
    try {
        const { pos_config_id } = req.query;
        if (!pos_config_id) {
            return res.status(400).json({ success: false, error: 'pos_config_id es requerido' });
        }

        const cached = promotionsCache.get(pos_config_id);
        if (cached && (Date.now() - cached.fetchedAt < CACHE_TTL)) {
            log.info(`Promotions desde cache (config: ${pos_config_id})`);
            return res.json(cached.data);
        }

        log.info(`Fetching promotions desde Odoo (config: ${pos_config_id})`);
        const data = await fetchFromOdoo(pos_config_id);
        promotionsCache.set(pos_config_id, { data, fetchedAt: Date.now() });

        res.json(data);
    } catch (error) {
        log.error('Error obteniendo promotions:', error.message);
        // Si hay cache aunque sea viejo, devolverlo como fallback
        const cached = promotionsCache.get(req.query.pos_config_id);
        if (cached) {
            log.warn('Devolviendo cache expirado como fallback');
            return res.json(cached.data);
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/promotions/refresh?pos_config_id=X
// Fuerza recarga desde Odoo e invalida el cache
router.get('/refresh', async (req, res) => {
    try {
        const { pos_config_id } = req.query;
        if (!pos_config_id) {
            return res.status(400).json({ success: false, error: 'pos_config_id es requerido' });
        }

        log.info(`Refresh forzado de promotions (config: ${pos_config_id})`);
        const data = await fetchFromOdoo(pos_config_id);
        promotionsCache.set(pos_config_id, { data, fetchedAt: Date.now() });

        log.success(`Promotions actualizadas (config: ${pos_config_id})`);
        res.json({ success: true, message: 'Cache actualizado', data });
    } catch (error) {
        log.error('Error en refresh de promotions:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
