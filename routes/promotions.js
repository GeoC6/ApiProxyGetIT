import express from 'express';
import axios from 'axios';
import https from 'https';
import { log } from '../services/logger.js';
import { savePromotionsCache, loadPromotionsCache } from '../database.js';

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

// Guarda en memoria y en SQLite (la copia en disco sobrevive a reinicios del equipo)
const guardarPromos = (pos_config_id, data) => {
    const fetchedAt = Date.now();
    promotionsCache.set(pos_config_id, { data, fetchedAt });
    if (typeof pos_config_id === 'string') {
        savePromotionsCache(pos_config_id, JSON.stringify(data), fetchedAt)
            .catch(e => log.warn(`No se pudieron guardar las promotions en disco: ${e.message}`));
    }
};

// Última copia guardada en disco (null si no hay o no se puede leer)
const leerPromosDisco = async (pos_config_id) => {
    if (typeof pos_config_id !== 'string') return null;
    try {
        const row = await loadPromotionsCache(pos_config_id);
        return row ? { data: JSON.parse(row.data), fetchedAt: row.updated_at } : null;
    } catch (e) {
        log.warn(`No se pudieron leer las promotions guardadas: ${e.message}`);
        return null;
    }
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
        guardarPromos(pos_config_id, data);

        res.json(data);
    } catch (error) {
        log.error('Error obteniendo promotions:', error.message);
        // Si hay cache aunque sea viejo, devolverlo como fallback
        const cached = promotionsCache.get(req.query.pos_config_id);
        if (cached) {
            log.warn('Devolviendo cache expirado como fallback');
            return res.json(cached.data);
        }
        // Sin cache en memoria (equipo reiniciado): la última copia guardada en disco
        const disco = await leerPromosDisco(req.query.pos_config_id);
        if (disco) {
            log.warn(`Devolviendo promotions guardadas en disco como fallback (del ${new Date(disco.fetchedAt).toLocaleString('es-CL')})`);
            promotionsCache.set(req.query.pos_config_id, disco);
            return res.json(disco.data);
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
        guardarPromos(pos_config_id, data);

        log.success(`Promotions actualizadas (config: ${pos_config_id})`);
        res.json({ success: true, message: 'Cache actualizado', data });
    } catch (error) {
        log.error('Error en refresh de promotions:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
