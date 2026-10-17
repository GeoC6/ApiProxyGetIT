// Fechas de venta y de boleta.
//
// - La orden en Odoo debe quedar con la hora REAL de la venta, no con la hora en que
//   la cola del ApiProxy logra subirla (si sube tarde, una venta del 13 quedaba del 14).
//   Odoo guarda date_order en UTC con formato "YYYY-MM-DD HH:MM:SS".
// - La fecha de emisión de la boleta (FchEmis) es la fecha en Chile del momento de la
//   venta. new Date().toISOString() da la fecha UTC: desde las 21:00 hora Chile ya es
//   el día siguiente y la boleta salía con fecha de mañana.

const TZ_CHILE = 'America/Santiago';

// Hora actual en UTC, en el formato que Odoo espera para date_order.
export function ahoraUtcOdoo(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Fecha "YYYY-MM-DD" en hora Chile. Acepta un Date o un string UTC de Odoo
// ("YYYY-MM-DD HH:MM:SS"); sin valor usa el momento actual.
export function fechaChile(valor) {
    let date = new Date();
    if (valor instanceof Date) {
        date = valor;
    } else if (valor) {
        const parsed = new Date(`${String(valor).replace(' ', 'T')}Z`);
        if (!Number.isNaN(parsed.getTime())) date = parsed;
    }
    try {
        // en-CA formatea como YYYY-MM-DD
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: TZ_CHILE, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(date);
    } catch {
        // Sin datos de zona horaria: fecha local del equipo (las cajas están en Chile)
        const p = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    }
}
