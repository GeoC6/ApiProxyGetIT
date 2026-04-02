import express from 'express';
import axios from 'axios';
import { getSetting } from '../database.js';
import { log } from '../services/logger.js';

const router = express.Router();

const getXSignBase = async () => {
    const url = await getSetting('XSIGN_URL', process.env.XSIGN_URL || 'http://localhost:5999');
    return url.replace(/\/sign\/\d+.*$/, '');
};

/**
 * POST /api/flejes/print
 * Body: { name, price, barcode, sku }
 * Envía un fleje al servicio XSign /print
 */
router.post('/print', async (req, res) => {
    const { name, price, barcode, sku } = req.body;

    if (!name) {
        return res.status(400).json({ success: false, error: 'El campo name es requerido' });
    }

    const xsignBase = await getXSignBase();

    // Código a mostrar: barcode tiene prioridad, si no hay se usa SKU
    const codigoBarras = barcode || sku || '';

    const detalle = [];

    detalle.push({ tipo: 'Titulo', contenido: name });

    if (price !== undefined && price !== null) {
        const precioFormateado = `$${Number(price).toLocaleString('es-CL')}`;
        detalle.push({ tipo: 'TextoCentrado', contenido: precioFormateado });
    }

    if (codigoBarras) {
        detalle.push({ tipo: 'Barcode', contenido: codigoBarras });
        detalle.push({ tipo: 'TextoCentrado', contenido: codigoBarras });
    }

    const payload = {
        nombre: `Fleje - ${name}`,
        detalle
    };

    log.info(`Fleje: enviando "${name}" (código: ${codigoBarras || 'sin código'}) a XSign ${xsignBase}/print`);

    try {
        await axios.post(`${xsignBase}/print`, payload, { timeout: 8000 });
        log.success(`Fleje impreso correctamente: ${name}`);
        res.json({ success: true });
    } catch (error) {
        const msg = error.response?.data?.message || error.message || 'Error desconocido';
        log.error(`Error imprimiendo fleje "${name}": ${msg}`);
        res.status(500).json({ success: false, error: msg });
    }
});

export default router;
