import { promisify } from 'util';
import { exec } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

const ESC = '\x1B';
const GS = '\x1D';

const CENTER = `${ESC}\x61\x01`;
const LEFT = `${ESC}\x61\x00`;
const BOLD_ON = `${ESC}\x45\x01`;
const BOLD_OFF = `${ESC}\x45\x00`;
const SIZE_NORMAL = `${GS}\x21\x00`;
const SIZE_DOUBLE = `${GS}\x21\x11`;
const SIZE_HUGE = `${GS}\x21\x33`;

class PrinterService {
    constructor() {
        this.tempDir = path.join(os.tmpdir(), 'comandas');
    }

    getExePath() {
        if (__dirname.includes('app.asar')) {
            return path.join(path.dirname(path.dirname(__dirname)), 'app.asar.unpacked', 'PrinterHelper.exe');
        }
        return path.join(__dirname, '..', 'PrinterHelper.exe');
    }

    getEnvValue(key) {
        const envPath = path.join(__dirname, '..', '.env');
        try {
            const content = fsSync.readFileSync(envPath, 'utf8');
            const match = content.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
            if (match) return match[1].trim();
        } catch (e) {
            log.warn(`No se pudo leer .env desde ${envPath}: ${e.message}`);
        }
        return process.env[key] || null;
    }

    getPrinterName() {
        return this.getEnvValue('PRINTER_TICKET_NAME') || 'POS';
    }

    async ensureTempDir() {
        try {
            await fs.mkdir(this.tempDir, { recursive: true });
        } catch (error) {
            log.error('Error creando directorio temporal:', error.message);
        }
    }

    async getPrinters() {
        try {
            const { stdout } = await execAsync(
                'powershell -Command "Get-Printer | Select-Object -ExpandProperty Name"',
                { encoding: 'utf8' }
            );
            return stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0).map(name => ({ name }));
        } catch (error) {
            log.error('Error obteniendo impresoras:', error.message);
            return [];
        }
    }

    async printOrderTicket(orderNumber, orderData = null, options = {}) {
        const printerName = this.getPrinterName();
        const exePath = this.getExePath();

        log.info('══════════════════════════════════════');
        log.info(' INICIANDO IMPRESION TICKET CLIENTE');
        log.info(`  Orden:     ${orderNumber}`);
        log.info(`  Impresora: "${printerName}"`);
        log.info(`  .env path: ${path.join(__dirname, '..', '.env')}`);
        log.info(`  exe path:  ${exePath}`);
        log.info(`  exe existe: ${fsSync.existsSync(exePath)}`);

        try {
            const printers = await this.getPrinters();
            if (printers.length === 0) {
                log.warn('  No se encontraron impresoras en el sistema');
            } else {
                log.info(`  Impresoras disponibles (${printers.length}):`);
                printers.forEach((p, i) => {
                    const match = p.name.trim().toLowerCase() === printerName.trim().toLowerCase();
                    log.info(`    ${i + 1}. "${p.name}"${match ? '  << MATCH' : ''}`);
                });
                const found = printers.find(p =>
                    p.name.trim().toLowerCase() === printerName.trim().toLowerCase()
                );
                if (!found) {
                    log.warn(`  ADVERTENCIA: No hay impresora con nombre exacto "${printerName}"`);
                }
            }
        } catch (listError) {
            log.warn('  No se pudo listar impresoras:', listError.message);
        }

        try {
            const time = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
            const note = orderData?.sale_data?.note || '';
            let orderTypeLabel = '';
            let customerNote = '';

            if (note.includes('[PARA LLEVAR]')) {
                orderTypeLabel = 'PARA LLEVAR';
                customerNote = note.replace('[PARA LLEVAR]', '').trim();
            } else if (note.includes('[MESA / SERVIR]')) {
                orderTypeLabel = 'MESA / SERVIR';
                customerNote = note.replace('[MESA / SERVIR]', '').trim();
            } else {
                customerNote = note.trim();
            }

            const { isVoucher = false, voucherNumber = null } = options;
            const products = orderData?.sale_data?.products || [];
            const discounts = orderData?.sale_data?.discounts || [];
            const subtotal = products.reduce((sum, p) => sum + (p.price * p.cant), 0);
            const discountTotal = discounts.reduce((sum, d) => sum + (d.discount_amount || 0), 0);
            const total = isVoucher ? 0 : (orderData?.sale_data?.total || subtotal - discountTotal);

            let ticket = '';
            ticket += CENTER;
            ticket += '================================\n';
            ticket += BOLD_ON + SIZE_DOUBLE;
            ticket += isVoucher ? 'VALE INTERNO\n' : 'ORDEN CLIENTE\n';
            ticket += SIZE_NORMAL + BOLD_OFF;
            ticket += '================================\n';
            ticket += '\n';
            if (isVoucher && voucherNumber) {
                ticket += BOLD_ON;
                ticket += `N° ${voucherNumber}\n`;
                ticket += BOLD_OFF;
                ticket += '\n';
            }
            ticket += SIZE_HUGE;
            ticket += `${orderNumber}\n`;
            ticket += SIZE_NORMAL;
            ticket += '\n';

            if (orderTypeLabel) {
                ticket += BOLD_ON;
                ticket += `>> ${orderTypeLabel} <<\n`;
                ticket += BOLD_OFF;
                ticket += '\n';
            }

            ticket += '================================\n';

            if (products.length > 0) {
                ticket += LEFT;
                products.forEach(item => {
                    ticket += '\n';
                    ticket += BOLD_ON;
                    ticket += `${item.cant}x  ${item.name}\n`;
                    ticket += BOLD_OFF;

                    if (Array.isArray(item.attribute_lines) && item.attribute_lines.length > 0) {
                        item.attribute_lines.forEach(attr => {
                            const ingredient = attr.name || '';
                            const qty = attr.qty > 1 ? ` x${attr.qty}` : '';
                            const price = attr.price ? parseFloat(attr.price) : 0;
                            const isAddition = attr.is_addition || false;

                            // Calcular el valor total del atributo
                            const totalAttrPrice = price * (attr.qty || 1);
                            const priceText = (isAddition && totalAttrPrice > 0) ? ` +$${totalAttrPrice}` : '';

                            if (ingredient) {
                                ticket += `  - ${ingredient}${qty}${priceText}\n`;
                            }
                        });
                    }

                    if (item.customization) {
                        ticket += `  * ${item.customization}\n`;
                    }
                });
                ticket += '\n';
                ticket += CENTER;
                ticket += '================================\n';
            }

            if (customerNote) {
                ticket += LEFT;
                ticket += '================================\n';
                ticket += BOLD_ON;
                ticket += 'NOTA DEL PEDIDO:\n';
                ticket += BOLD_OFF;
                ticket += `${customerNote}\n`;
                ticket += '================================\n';
            }

            // Sección de descuentos y totales
            ticket += LEFT;
            if (discounts.length > 0) {
                ticket += '================================\n';
                ticket += BOLD_ON;
                ticket += 'DESCUENTOS:\n';
                ticket += BOLD_OFF;
                discounts.forEach(d => {
                    const nombre = d.promotion_name || 'Promoción';
                    const monto = `-$${Math.round(d.discount_amount).toLocaleString('es-CL')}`;
                    const spaces = 32 - nombre.length - monto.length;
                    ticket += `${nombre}${' '.repeat(Math.max(1, spaces))}${monto}\n`;
                });
                ticket += '================================\n';
                const subtotalStr = `$${Math.round(subtotal).toLocaleString('es-CL')}`;
                const stSpaces = 32 - 'Subtotal'.length - subtotalStr.length;
                ticket += `Subtotal${' '.repeat(Math.max(1, stSpaces))}${subtotalStr}\n`;
                const descStr = `-$${Math.round(discountTotal).toLocaleString('es-CL')}`;
                const dsSpaces = 32 - 'Descuento'.length - descStr.length;
                ticket += `Descuento${' '.repeat(Math.max(1, dsSpaces))}${descStr}\n`;
            }
            ticket += '================================\n';
            ticket += BOLD_ON + SIZE_DOUBLE;
            const totalStr = `$${Math.round(total).toLocaleString('es-CL')}`;
            const totalSpaces = 16 - 'TOTAL'.length - totalStr.length;
            ticket += `TOTAL${' '.repeat(Math.max(1, totalSpaces))}${totalStr}\n`;
            ticket += SIZE_NORMAL + BOLD_OFF;
            ticket += '================================\n';

            ticket += CENTER;
            ticket += `${time}\n`;
            ticket += '================================\n';
            ticket += '\n\n\n\n';

            await this.ensureTempDir();
            const filepath = path.join(this.tempDir, `ticket_${orderNumber}_${Date.now()}.txt`);
            await fs.writeFile(filepath, ticket, 'utf8');
            log.info(`  Archivo: ${filepath}`);

            const cmd = `"${exePath}" "${printerName}" "${filepath}"`;
            log.info(`  Ejecutando: ${cmd}`);

            const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
            log.info(`  stdout: "${stdout.trim()}"`);
            if (stderr) log.warn(`  stderr: "${stderr.trim()}"`);

            if (!stdout.includes('OK')) throw new Error(`PrinterHelper: ${stdout.trim()}`);

            log.success(`  Ticket ${orderNumber} impreso OK`);
            log.info('══════════════════════════════════════');

            setTimeout(() => fs.unlink(filepath).catch(() => { }), 3000);

        } catch (error) {
            log.error(`  FALLO impresion ${orderNumber}: ${error.message}`);
            log.info('══════════════════════════════════════');
        }
    }

    async renderLogoEscPos(imagePath, targetWidth) {
        const { default: Jimp } = await import('jimp');

        const targetW = Math.round(targetWidth / 8) * 8;
        const src = await Jimp.read(imagePath);
        src.resize(targetW, Jimp.AUTO);

        const imgWidth  = src.bitmap.width;
        const imgHeight = src.bitmap.height;
        const xBytes    = Math.ceil(imgWidth / 8);
        const raw       = src.bitmap.data; // Buffer RGBA directo, sin getPixelColor

        const header = Buffer.from([
            0x1D, 0x76, 0x30, 0x00,
            xBytes & 0xFF, (xBytes >> 8) & 0xFF,
            imgHeight & 0xFF, (imgHeight >> 8) & 0xFF
        ]);

        // Bayer 2×2: verde oscuro (grey~75) → negro sólido, naranja (grey~173) → punteado
        const bayer = [[51, 180], [204, 102]];

        const raster = Buffer.alloc(xBytes * imgHeight, 0);
        for (let y = 0; y < imgHeight; y++) {
            for (let x = 0; x < imgWidth; x++) {
                const i = (y * imgWidth + x) * 4;
                const r = raw[i], g = raw[i + 1], b = raw[i + 2], a = raw[i + 3];
                if (a < 20) continue;

                const grey = r * 0.299 + g * 0.587 + b * 0.114;
                const print = grey < 120              // verde → negro sólido
                    || (grey < 210 && grey <= bayer[y % 2][x % 2]); // naranja → dithering

                if (print) {
                    raster[(y * xBytes) + Math.floor(x / 8)] |= (1 << (7 - (x % 8)));
                }
            }
        }

        return Buffer.concat([header, raster]);
    }

    async printFleje({ name, price, barcode, sku, printerName }) {
        const printer = printerName || this.getEnvValue('FLEJE_PRINTER_NAME') || 'POS-80';
        const exePath = this.getExePath();
        const codigoBarras = barcode || sku || '';

        const CUT         = Buffer.from([0x1D, 0x56, 0x41, 0x00]); // cut sin feed extra
        const LINE_TIGHT  = Buffer.from([0x1B, 0x33, 0x16]);        // line spacing 22/180"
        const CENTER      = Buffer.from([0x1B, 0x61, 0x01]);
        const RIGHT       = Buffer.from([0x1B, 0x61, 0x02]);
        const LEFT        = Buffer.from([0x1B, 0x61, 0x00]);
        const BOLD_ON     = Buffer.from([0x1B, 0x45, 0x01]);
        const BOLD_OFF    = Buffer.from([0x1B, 0x45, 0x00]);
        const SIZE_NORMAL   = Buffer.from([0x1D, 0x21, 0x00]);
        const SIZE_WIDE     = Buffer.from([0x1D, 0x21, 0x10]); // 2x width, 1x height
        const SIZE_DOUBLE   = Buffer.from([0x1D, 0x21, 0x11]);
        const SIZE_MEDIUM   = Buffer.from([0x1D, 0x21, 0x21]); // 3x width, 2x height

        const isUpperLetter = (c) => c >= 'A' && c <= 'Z';
        const t = (str) => {
            const chars = [...String(str)];
            const bytes = [];
            for (let i = 0; i < chars.length; i++) {
                const ch = chars[i];
                if (ch.charCodeAt(0) < 128) {
                    bytes.push(ch.charCodeAt(0));
                } else {
                    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
                    for (const b of base) {
                        if (b.charCodeAt(0) >= 128) { bytes.push(0x3F); continue; }
                        let code = b.charCodeAt(0);
                        // Si la base quedó minúscula, verificar contexto para uppercasear
                        if (code >= 97 && code <= 122) {
                            const prevUp = i > 0 && isUpperLetter(chars[i - 1]);
                            const nextUp = i < chars.length - 1 && isUpperLetter(chars[i + 1]);
                            if (prevUp || nextUp) code -= 32;
                        }
                        bytes.push(code);
                    }
                }
            }
            return Buffer.from(bytes);
        };

        const FEED_SMALL  = Buffer.from([0x1B, 0x4A, 0x08]); // ESC J 8 — avance puntual 8/180"

        const parts = [LINE_TIGHT];

        // Logo
        const logoPath = path.join(__dirname, '..', 'LOGO_TRANSP_BG.png').replace('app.asar', 'app.asar.unpacked');
        try {
            const logoBuffer = await this.renderLogoEscPos(logoPath, 200);
            parts.push(LEFT, logoBuffer, Buffer.from([0x1B, 0x4A, 0x04]));
        } catch (e) {
            log.warn(`[Fleje] Logo no disponible, usando texto: ${e.message}`);
            parts.push(LEFT, BOLD_ON, t('GETit'), FEED_SMALL, BOLD_OFF);
        }

        // Fecha en esquina superior derecha
        const fecha = new Date().toLocaleDateString('es-CL');
        parts.push(RIGHT, t(`${fecha}`), FEED_SMALL);

        // Nombre en doble ANCHO (no altura) → gap mínimo igual que GETit→nombre
        parts.push(LEFT, BOLD_ON, SIZE_WIDE, t(name), FEED_SMALL, SIZE_NORMAL, BOLD_OFF);

        // Precio centrado (3x ancho, 2x alto)
        const precioStr = `$ ${Number(price).toLocaleString('es-CL')}`;
        parts.push(CENTER, BOLD_ON, SIZE_MEDIUM, t(`${precioStr}`), Buffer.from([0x1B, 0x4A, 0x28]), SIZE_NORMAL, BOLD_OFF);

        // Código de barras gráfico con número debajo
        if (codigoBarras) {
            const barcodeData = `{B${codigoBarras}`;
            parts.push(
                CENTER,
                Buffer.from([0x1D, 0x68, 0x30]),                          // altura 48
                Buffer.from([0x1D, 0x77, 0x02]),                          // ancho módulo 2
                Buffer.from([0x1D, 0x48, 0x02]),                          // HRI debajo
                Buffer.from([0x1D, 0x6B, 0x49, barcodeData.length]),      // CODE128
                Buffer.from(barcodeData, 'ascii'),
                Buffer.from([0x1B, 0x4A, 0x10])
            );
        }

        parts.push(CUT);

        const ticket = Buffer.concat(parts);
        await this.ensureTempDir();
        const filepath = path.join(this.tempDir, `fleje_${Date.now()}.bin`);
        await fs.writeFile(filepath, ticket);
        log.info(`[Fleje] Imprimiendo "${name}" en "${printer}"`);

        const cmd = `"${exePath}" "${printer}" "${filepath}"`;
        const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
        if (stderr) log.warn(`[Fleje] stderr: ${stderr.trim()}`);
        if (!stdout.includes('OK')) throw new Error(`PrinterHelper: ${stdout.trim()}`);

        log.success(`[Fleje] Impreso OK`);
        setTimeout(() => fs.unlink(filepath).catch(() => {}), 3000);
    }

    async listAvailablePrinters() {
        const printers = await this.getPrinters();
        if (!printers || printers.length === 0) {
            log.warn('No se encontraron impresoras');
            return [];
        }
        printers.forEach((p, i) => log.info(`${i + 1}. "${p.name}"`));
        return printers;
    }
}

export default new PrinterService();