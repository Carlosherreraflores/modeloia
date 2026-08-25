// Módulo de lógica de negocio para gestión de reservas via WhatsApp.
// Maneja sesiones de conversación, historial, cotización y persistencia en DB MySQL.

import { query } from './db.js';

// ─────────────────────────────────────────────
// SESIONES DE CONVERSACIÓN
// ─────────────────────────────────────────────

/**
 * Obtiene o crea la sesión activa de un contacto.
 * @param {string} jid - WhatsApp JID del contacto
 * @returns {object} fila de sesiones_bot
 */
export async function obtenerSesion(jid) {
    await query(
        `INSERT INTO sesiones_bot (whatsapp_jid, etapa, datos_temp)
         VALUES (?, 'inicio', JSON_OBJECT())
         ON DUPLICATE KEY UPDATE actualizado_en = NOW()`,
        [jid]
    );
    const result = await query(
        `SELECT * FROM sesiones_bot WHERE whatsapp_jid = ?`,
        [jid]
    );
    const sesion = result.rows[0];
    if (sesion && typeof sesion.datos_temp === 'string') {
        try {
            sesion.datos_temp = JSON.parse(sesion.datos_temp);
        } catch {
            sesion.datos_temp = {};
        }
    }
    return sesion;
}

/**
 * Actualiza la etapa y/o los datos temporales de una sesión.
 * @param {string} jid
 * @param {string} etapa
 * @param {object} datoTemp - objeto JSON a mezclar con datos_temp existentes
 */
export async function actualizarSesion(jid, etapa, datoTemp = null) {
    if (datoTemp) {
        await query(
            `UPDATE sesiones_bot
             SET etapa = ?,
                 datos_temp = JSON_MERGE_PATCH(COALESCE(datos_temp, JSON_OBJECT()), ?),
                 actualizado_en = NOW()
             WHERE whatsapp_jid = ?`,
            [etapa, JSON.stringify(datoTemp), jid]
        );
    } else {
        await query(
            `UPDATE sesiones_bot
             SET etapa = ?,
                 actualizado_en = NOW()
             WHERE whatsapp_jid = ?`,
            [etapa, jid]
        );
    }
}

/**
 * Vincula una reserva creada a la sesión del contacto.
 */
export async function vincularReservaASesion(jid, reservaId) {
    await query(
        `UPDATE sesiones_bot SET reserva_id = ?, actualizado_en = NOW()
         WHERE whatsapp_jid = ?`,
        [reservaId, jid]
    );
}

/**
 * Reinicia la sesión de un contacto (útil al finalizar un flujo o cancelar).
 */
export async function resetearSesion(jid) {
    await query(
        `UPDATE sesiones_bot
         SET etapa = 'inicio', datos_temp = JSON_OBJECT(), reserva_id = NULL, actualizado_en = NOW()
         WHERE whatsapp_jid = ?`,
        [jid]
    );
}

// ─────────────────────────────────────────────
// HISTORIAL DE CONVERSACIÓN
// ─────────────────────────────────────────────

/**
 * Guarda un mensaje en el historial de conversaciones_bot.
 * @param {string} jid
 * @param {'user'|'assistant'} rol
 * @param {string} mensaje
 * @param {string|null} reservaId
 */
export async function guardarMensaje(jid, rol, mensaje, reservaId = null) {
    await query(
        `INSERT INTO conversaciones_bot (whatsapp_jid, rol, mensaje, reserva_id)
         VALUES (?, ?, ?, ?)`,
        [jid, rol, mensaje, reservaId]
    );
}

/**
 * Recupera los últimos N mensajes de un contacto para dar contexto a la IA.
 * @param {string} jid
 * @param {number} limite - cuántos mensajes recuperar (default 20)
 * @returns {Array<{rol, mensaje}>}
 */
export async function obtenerHistorial(jid, limite = 20) {
    const result = await query(
        `SELECT rol, mensaje FROM conversaciones_bot
         WHERE whatsapp_jid = ?
         ORDER BY creado_en DESC
         LIMIT ?`,
        [jid, Number(limite)]
    );
    // Devolver en orden cronológico (más antiguo primero)
    return result.rows.reverse();
}

// ─────────────────────────────────────────────
// COTIZACIÓN
// ─────────────────────────────────────────────

/**
 * Calcula el total de una estadía.
 * Todas las noches tienen la misma tarifa según la cabaña.
 *
 * @param {string} checkIn  - Fecha ISO 'YYYY-MM-DD'
 * @param {string} checkOut - Fecha ISO 'YYYY-MM-DD'
 * @param {number} cabanaId - 1-7: $60.000/noche  |  8: $100.000/noche
 * @returns {{ noches, precioBase, total, abono, saldo, detalle }}
 */
export function calcularCotizacion(checkIn, checkOut, cabanaId) {
    const PRECIO_BASE = cabanaId === 8 ? 100000 : 60000;

    const inicio = new Date(checkIn + 'T12:00:00');
    const fin    = new Date(checkOut + 'T12:00:00');
    const noches = Math.round((fin - inicio) / (1000 * 60 * 60 * 24));

    let totalBase = 0;
    let detalle   = [];

    for (let i = 0; i < noches; i++) {
        const dia = new Date(inicio);
        dia.setDate(dia.getDate() + i);
        const diaSemana = dia.getDay(); // 0=Dom, 6=Sab

        const precio = PRECIO_BASE;
        totalBase += precio;

        const yyyy = dia.getFullYear();
        const mm = String(dia.getMonth() + 1).padStart(2, '0');
        const dd = String(dia.getDate()).padStart(2, '0');

        detalle.push({
            fecha: `${yyyy}-${mm}-${dd}`,
            diaSemana: ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][diaSemana],
            precio,
            esFinSemana: diaSemana === 0 || diaSemana === 6,
        });
    }

    const abono = Math.round(totalBase * 0.20);
    const saldo = totalBase - abono;

    return {
        noches,
        precioBase: PRECIO_BASE,
        total: totalBase,
        abono,       // 20% a pagar para reservar
        saldo,       // 80% a pagar al check-in
        detalle,
    };
}

/**
 * Formatea una cotización como texto legible para enviar por WhatsApp.
 */
export function formatearCotizacion(cotizacion, checkIn, checkOut, cabanaId) {
    const { noches, total, abono, saldo, detalle } = cotizacion;
    const nombreCabana = `Cabaña ${cabanaId}`;
    const fmt = (n) => n.toLocaleString('es-CL');

    let lineas = [
        `🏡 *Cotización ${nombreCabana}*`,
        `📅 ${checkIn} → ${checkOut} (${noches} ${noches === 1 ? 'noche' : 'noches'})`,
        '',
    ];

    detalle.forEach(d => {
        lineas.push(`  • ${d.diaSemana} ${d.fecha}: $${fmt(d.precio)}`);
    });

    lineas.push('');
    lineas.push(`💰 *Total estadía:* $${fmt(total)}`);
    lineas.push(`🔒 *Abono para reservar (20%):* $${fmt(abono)}`);
    lineas.push(`🔑 *Saldo al check-in (80%):* $${fmt(saldo)}`);

    return lineas.join('\n');
}

// ─────────────────────────────────────────────
// DISPONIBILIDAD
// ─────────────────────────────────────────────

/**
 * Retorna qué cabañas están disponibles para el rango de fechas dado.
 * Considera confirmadas y también las pendientes para evitar solapamiento optimista.
 */
export async function obtenerCabanasDisponibles(checkIn, checkOut) {
    const result = await query(
        `SELECT c.id, c.nombre, c.capacidad
         FROM cabanas c
         WHERE c.activa = TRUE
           AND c.id NOT IN (
             SELECT r.cabana_id FROM reservas r
             WHERE r.estado IN ('pendiente', 'confirmada')
               AND r.check_in  < ?
               AND r.check_out > ?
           )
         ORDER BY c.id`,
        [checkOut, checkIn]
    );
    return result.rows;
}

// ─────────────────────────────────────────────
// CREAR RESERVA
// ─────────────────────────────────────────────

/**
 * Genera un ID de reserva único con prefijo 'r' + timestamp + random.
 */
function generarIdReserva() {
    const ts   = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `r${ts}${rand}`;
}

/**
 * Crea una reserva en estado 'pendiente' y dispara una notificación al admin.
 *
 * @param {object} datos
 * @param {string} datos.jid           - WhatsApp JID del cliente
 * @param {number} datos.cabanaId
 * @param {string} datos.checkIn       - 'YYYY-MM-DD'
 * @param {string} datos.checkOut      - 'YYYY-MM-DD'
 * @param {string} datos.nombreHuesped
 * @param {string} datos.telefono
 * @param {number} datos.personas
 * @param {string} [datos.notas]
 * @returns {object} reserva creada
 */
export async function crearReserva(datos) {
    const { jid, cabanaId, checkIn, checkOut, nombreHuesped, telefono, personas, notas } = datos;
    const id = generarIdReserva();

    await query(
        `INSERT INTO reservas
           (id, cabana_id, check_in, check_out, nombre_huesped, telefono,
            whatsapp_jid, personas, notas, origen, estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp', 'pendiente')`,
        [id, cabanaId, checkIn, checkOut, nombreHuesped, telefono,
         jid, personas, notas || null]
    );

    // Calcular cotización para incluirla en la notificación al admin
    const cotizacion = calcularCotizacion(checkIn, checkOut, cabanaId);

    const mensajeAdmin =
        `📋 *Nueva solicitud de reserva via WhatsApp*\n` +
        `ID: ${id}\n` +
        `Huésped: ${nombreHuesped}\n` +
        `Teléfono/WA: ${telefono} | ${jid}\n` +
        `Cabaña: ${cabanaId} | Personas: ${personas}\n` +
        `Check-in: ${checkIn} | Check-out: ${checkOut}\n` +
        `Noches: ${cotizacion.noches} | Total: $${cotizacion.total.toLocaleString('es-CL')}\n` +
        `Abono esperado (20%): $${cotizacion.abono.toLocaleString('es-CL')}\n` +
        (notas ? `Notas: ${notas}\n` : '') +
        `\nPor favor confirma o rechaza esta reserva en el sistema.`;

    await query(
        `INSERT INTO notificaciones_admin (tipo, reserva_id, whatsapp_jid, mensaje)
         VALUES ('nueva_reserva', ?, ?, ?)`,
        [id, jid, mensajeAdmin]
    );

    // Actualizar la sesión del contacto
    await actualizarSesion(jid, 'esperando_confirmacion_admin');
    await vincularReservaASesion(jid, id);

    return { id, ...datos, cotizacion };
}

// ─────────────────────────────────────────────
// NOTIFICACIONES PENDIENTES (para el admin)
// ─────────────────────────────────────────────

/**
 * Devuelve todas las notificaciones no resueltas para el administrador.
 */
export async function obtenerNotificacionesPendientes() {
    const result = await query(
        `SELECT n.id, n.tipo, n.reserva_id, n.whatsapp_jid, n.mensaje, n.creado_en
         FROM notificaciones_admin n
         WHERE n.resuelta = FALSE
         ORDER BY n.creado_en ASC`
    );
    return result.rows;
}
