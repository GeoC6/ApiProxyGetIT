import express from 'express';
import axios from 'axios';
import { db } from '../database.js';
import { log } from '../services/logger.js';

const router = express.Router();
const ODOO_URL = process.env.ODOO_URL || 'https://litz.posgo.cl';

let lastSync = null;          // hora de la última sync EXITOSA (respaldo si no hay endpoint de versión)
let lastVersion = null;       // versión de res_partner de la última sync EXITOSA
let ultimoIntento = 0;        // último intento, haya salido bien o mal
let syncEnCurso = null;       // promesa de la sincronización en vuelo
let ultimaComprobacionVersion = 0; // último chequeo de versión (haya cambiado o no)
const SYNC_TTL = 60 * 60 * 1000;   // respaldo: si no hay /customers_data_version en Odoo, TTL ciego de 1h
const REINTENTO_MIN = 30 * 1000;   // espera mínima entre intentos fallidos
const CHEQUEO_VERSION_MIN = 30 * 1000; // no consultar la versión en cada tecla

// UNA sola sincronización a la vez.
//
// La búsqueda dispara con cada tecla y `lastSync`/`lastVersion` solo se marcan
// al terminar, así que antes cada tecla lanzaba su propia sincronización
// completa: un DELETE de toda la tabla más la reinserción de todos los
// clientes, varias en paralelo sobre el mismo SQLite. Se atascaban entre
// ellas y la búsqueda se quedaba cargando para siempre.
const sincronizar = () => {
    if (syncEnCurso) return syncEnCurso;
    // Con Odoo caído, cada intento cuesta los 30 segundos del timeout de axios.
    // Sin esta pausa, cada tecla volvía a pagarlos.
    if (ultimoIntento && Date.now() - ultimoIntento < REINTENTO_MIN) {
        return Promise.resolve(0);
    }
    ultimoIntento = Date.now();
    syncEnCurso = syncFromOdoo()
        .catch((e) => { log.warn(`Sync de clientes fallido: ${e.message}`); return 0; })
        .finally(() => { syncEnCurso = null; });
    return syncEnCurso;
};

const contarClientes = () => new Promise((resolve) => {
    db.get('SELECT COUNT(*) AS n FROM customers', (err, row) => {
        resolve(err ? 0 : (row?.n || 0));
    });
});

// Versión liviana de res_partner en Odoo (hash de max(write_date)+count),
// vía /customers_data_version — mismo patrón que pos_data_version para el
// catálogo. Ese endpoint puede no existir todavía en este Odoo (módulo
// compartido, no se toca desde acá): si falla por lo que sea, devuelve null
// y el llamador cae de vuelta al TTL ciego de 1h, igual que antes.
const getRemoteVersion = async () => {
    try {
        const response = await axios.get(`${ODOO_URL}/customers_data_version`, { timeout: 8000 });
        return response.data?.version || null;
    } catch {
        return null;
    }
};

const syncFromOdoo = async () => {
    const response = await axios.get(`${ODOO_URL}/get_customers`, { timeout: 30000 });
    const customers = response.data?.customers || [];

    // En Odoo el nombre de un contacto PUEDE venir vacío (pasa con los que son
    // solo una dirección). La columna es NOT NULL, así que sin esto sqlite
    // reventaba... y como el stmt.run no llevaba callback, la excepción no la
    // atrapaba nadie: se caía el proceso principal y con él TODA la caja, no
    // solo la búsqueda de clientes.
    // OJO: Odoo manda `false`/`null` (no "") en los campos vacíos. Sin esto,
    // String(false) da "false" y el cliente se guardaba llamándose así.
    const texto = (v) => (v === false || v === null || v === undefined ? '' : String(v).trim());

    const nombreDe = (c) => {
        const n = texto(c?.name);
        if (n) return n;
        const vat = texto(c?.vat);
        return vat ? `(sin nombre) ${vat}` : '';
    };

    let guardados = 0;
    let omitidos = 0;

    await new Promise((resolve, reject) => {
        db.run('DELETE FROM customers', (err) => {
            if (err) return reject(err);
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO customers (id, name, vat, email, phone, street, city, giro, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);

            for (const c of customers) {
                const nombre = nombreDe(c);
                // Sin nombre ni RUT no hay forma de buscarlo ni de emitirle un
                // documento: no sirve de nada guardarlo.
                if (!c?.id || !nombre) { omitidos++; continue; }

                // El callback importa: un contacto malo se salta y se registra,
                // en vez de tumbar la sincronización entera.
                stmt.run(
                    c.id, nombre, c.vat || null, c.email || null, c.phone || null,
                    c.street || '', c.city || '', c.giro || '',
                    (e) => { if (e) { omitidos++; log.warn(`[clientes] se omitió ${c.id}: ${e.message}`); } }
                );
                guardados++;
            }

            stmt.finalize((err) => err ? reject(err) : resolve());
        });
    });

    lastSync = Date.now();
    lastVersion = await getRemoteVersion();
    log.info(`Clientes sincronizados: ${guardados}${omitidos ? ` (${omitidos} omitidos por venir sin nombre)` : ''}`);
    return guardados;
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

        // Solo se ESPERA la sincronización cuando no hay nada local que
        // mostrar. Si ya hay clientes guardados se contesta con ellos de
        // inmediato y la sincronización sigue por detrás: que el listado quede
        // una búsqueda desactualizado es mucho mejor que dejar al cajero
        // mirando el spinner mientras se bajan todos los contactos de Odoo.
        const hayDatos = await contarClientes();
        if (!hayDatos) {
            await sincronizar();
        } else if (Date.now() - ultimaComprobacionVersion > CHEQUEO_VERSION_MIN) {
            // Sin await: corre en background, nunca bloquea esta búsqueda.
            // Y no se repite en cada tecla, máximo una vez cada 30s.
            ultimaComprobacionVersion = Date.now();
            getRemoteVersion().then((remoteVersion) => {
                if (remoteVersion) {
                    // Odoo tiene /customers_data_version: solo re-sincroniza
                    // si realmente cambió algo.
                    if (remoteVersion !== lastVersion) sincronizar();
                } else if (!lastSync || Date.now() - lastSync > SYNC_TTL) {
                    // No hay endpoint de versión (módulo no actualizado aún)
                    // → respaldo: TTL ciego de 1h, igual que antes de este fix.
                    sincronizar();
                }
            }).catch(() => {});
        }

        const term = `%${q.toLowerCase()}%`;

        const customers = await new Promise((resolve, reject) => {
            const vatTerm = `%${q.replace(/[.\-]/g, '')}%`;
            db.all(`
                SELECT id, name, vat, email, phone, street, city, giro FROM customers
                WHERE LOWER(name) LIKE ?
                OR LOWER(REPLACE(REPLACE(vat, '.', ''), '-', '')) LIKE LOWER(?)
                ORDER BY name LIMIT 20
            `, [term, vatTerm], (err, rows) => {
                if (err) { log.error(`[customers/search] SQL error: ${err.message}`); return reject(err); }
                resolve(rows || []);
            });
        });

        res.json({ success: true, customers });
    } catch (error) {
        log.error('Error buscando clientes:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
