import express from 'express';
import axios from 'axios';
import https from 'https';
import { db } from '../database.js';

const router = express.Router();
const ODOO_URL = process.env.ODOO_URL || 'https://getit.posgo.cl';

const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });

const saveToCache = (productId, imageData, mimeType) => new Promise((resolve) => {
    db.run(
        'INSERT OR REPLACE INTO cached_images (product_id, image_data, mime_type) VALUES (?, ?, ?)',
        [productId, imageData, mimeType || 'image/jpeg'],
        (err) => { if (err) console.error(`Error guardando imagen ${productId} en cache:`, err.message); resolve(); }
    );
});

router.get('/products/:productId', async (req, res) => {
    const { productId } = req.params;

    try {
        // 1. Buscar en SQLite
        const cached = await new Promise((resolve, reject) => {
            db.get('SELECT image_data, mime_type FROM cached_images WHERE product_id = ?',
                [productId], (err, row) => { if (err) reject(err); else resolve(row); });
        });

        if (cached) {
            const buffer = Buffer.from(cached.image_data, 'base64');
            res.set('Content-Type', cached.mime_type);
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(buffer);
        }

        // 2. No está en caché → buscar en Odoo y cachear
        const odooUrl = `${ODOO_URL}/web/image/product.product/${productId}/image_1920`;
        const response = await axios.get(odooUrl, {
            responseType: 'arraybuffer',
            timeout: 10000,
            httpsAgent
        });

        const mimeType = response.headers['content-type'] || 'image/jpeg';
        const imageData = Buffer.from(response.data).toString('base64');

        // Guardar en SQLite en background (no bloquear la respuesta)
        saveToCache(productId, imageData, mimeType);

        res.set('Content-Type', mimeType);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(Buffer.from(response.data));

    } catch (error) {
        // Odoo no tiene imagen para este producto — responder transparente 1x1
        res.set('Content-Type', 'image/gif');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    }
});

router.post('/cache/:productId', async (req, res) => {
    const { productId } = req.params;
    const { imageData, mimeType } = req.body;

    try {
        await new Promise((resolve, reject) => {
            db.run('INSERT OR REPLACE INTO cached_images (product_id, image_data, mime_type) VALUES (?, ?, ?)',
                [productId, imageData, mimeType || 'image/jpeg'], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });

        console.log(`Imagen ${productId} cacheada por frontend`);
        res.json({ success: true });

    } catch (error) {
        console.error(`Error cacheando imagen ${productId}:`, error.message);
        res.status(500).json({ error: 'Error cacheando imagen' });
    }
});

router.delete('/cache', async (req, res) => {
    try {
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM cached_images', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        console.log('Cache de imagenes limpiado');
        res.json({ success: true, message: 'Cache limpiado' });

    } catch (error) {
        console.error('Error limpiando cache:', error.message);
        res.status(500).json({ error: 'Error limpiando cache' });
    }
});

router.get('/cache/stats', async (req, res) => {
    try {
        const stats = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count, SUM(LENGTH(image_data)) as total_size FROM cached_images',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
        });

        const sizeMB = ((stats.total_size || 0) / 1024 / 1024).toFixed(2);

        res.json({
            cached_images: stats.count || 0,
            total_size_mb: sizeMB
        });

    } catch (error) {
        console.error('Error obteniendo stats de cache:', error.message);
        res.status(500).json({ error: 'Error obteniendo stats' });
    }
});

export default router;