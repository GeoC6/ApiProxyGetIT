import express from 'express';
import axios from 'axios';
import { getSetting } from '../database.js';
import { log } from '../services/logger.js';
import printerService from '../services/printerService.js';

const router = express.Router();

const getXSignBase = async () => {
    const url = await getSetting('XSIGN_URL', process.env.XSIGN_URL || 'http://localhost:5999');
    return url.replace(/\/sign\/\d+.*$/, '');
};

/**
 * POST /api/flejes/print
 * Body: { name, price, barcode, sku }
 * Intenta imprimir via ESC/POS directo (PrinterHelper.exe).
 * Si falla, hace fallback a XSign.
 */
router.post('/print', async (req, res) => {
    const { name, price, barcode, sku } = req.body;

    if (!name) {
        return res.status(400).json({ success: false, error: 'El campo name es requerido' });
    }

    const flejePrinter = await getSetting('FLEJE_PRINTER_NAME', 'POS-80');

    // Intentar impresión ESC/POS directa primero
    try {
        await printerService.printFleje({ name, price, barcode, sku, printerName: flejePrinter });
        log.success(`[Fleje] Impreso via ESC/POS en "${flejePrinter}": ${name}`);
        return res.json({ success: true, method: 'escpos' });
    } catch (escposError) {
        log.warn(`[Fleje] ESC/POS falló (${escposError.message}), intentando XSign...`);
    }

    // Fallback a XSign
    const xsignBase = await getXSignBase();
    const codigoBarras = barcode || sku || '';
    const detalle = [];

    detalle.push({ tipo: 'Titulo', contenido: name });

    if (price !== undefined && price !== null) {
        const precioFormateado = `$${Number(price).toLocaleString('es-CL')}`;
        detalle.push({ tipo: 'Titulo', contenido: precioFormateado });
    }

    if (codigoBarras) {
        detalle.push({ tipo: 'Barcode', contenido: codigoBarras, width: 1 });
        detalle.push({ tipo: 'TextoCentrado', contenido: codigoBarras });
    }

    try {
        await axios.post(`${xsignBase}/print`, { nombre: `Fleje - ${name}`, detalle }, { timeout: 8000 });
        log.success(`[Fleje] Impreso via XSign: ${name}`);
        res.json({ success: true, method: 'xsign' });
    } catch (error) {
        const msg = error.response?.data?.message || error.message || 'Error desconocido';
        log.error(`[Fleje] Error XSign "${name}": ${msg}`);
        res.status(500).json({ success: false, error: msg });
    }
});

export default router;
