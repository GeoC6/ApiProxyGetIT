import express from 'express';
import { getSetting } from '../database.js';
import { log } from '../services/logger.js';
import printerService from '../services/printerService.js';

const router = express.Router();

/**
 * POST /api/flejes/print
 * Body: { name, price, barcode, sku }
 * Imprime via ESC/POS directo (PrinterHelper.exe).
 */
router.post('/print', async (req, res) => {
    const { name, price, barcode, sku } = req.body;

    if (!name) {
        return res.status(400).json({ success: false, error: 'El campo name es requerido' });
    }

    const flejePrinter = await getSetting('FLEJE_PRINTER_NAME', 'POS-80');

    try {
        await printerService.printFleje({ name, price, barcode, sku, printerName: flejePrinter });
        log.success(`[Fleje] Impreso via ESC/POS en "${flejePrinter}": ${name}`);
        return res.json({ success: true, method: 'escpos' });
    } catch (error) {
        log.error(`[Fleje] Error ESC/POS "${name}": ${error.message}`);
        return res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
