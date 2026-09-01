import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';
import { getSystemInstruction } from './prompt.js';
import { testConnection } from './db.js';
import {
    obtenerSesion,
    actualizarSesion,
    resetearSesion,
    guardarMensaje,
    obtenerHistorial,
    obtenerResumenUsuario,
    guardarResumenUsuario,
    obtenerCabanasDisponibles,
    calcularCotizacion,
    formatearCotizacion,
    crearReserva,
    formatearHoraChile,
    obtenerReservasPorRecordar,
    marcarRecordatorioEnviado,
    obtenerReservasExpiradas,
    expirarReserva,
} from './reservas.js';
import 'dotenv/config';

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

// ─────────────────────────────────────────────
// PROCESAMIENTO DE MENSAJES
// ─────────────────────────────────────────────

/**
 * Analiza la respuesta de la IA buscando un bloque JSON de acción.
 * La IA puede incluir al final de su respuesta un bloque:
 *   %%ACTION%%{ "accion": "...", ... }%%END%%
 * Si lo encuentra, lo extrae y devuelve por separado.
 */
function extraerAccion(texto) {
    const regex = /%%ACTION%%(\{[\s\S]*?\})%%END%%/;
    const match = texto.match(regex);
    if (!match) return { textoLimpio: texto, accion: null };

    try {
        const accion = JSON.parse(match[1]);
        const textoLimpio = texto.replace(regex, '').trim();
        return { textoLimpio, accion };
    } catch {
        return { textoLimpio: texto, accion: null };
    }
}

/**
 * Detecta y extrae imágenes del formato [IMG:url] en el texto de la IA.
 * Retorna el texto limpio y un array de URLs de imágenes con sus captions.
 */
function extraerImagenes(texto) {
    const regex = /\[IMG:(https?:\/\/[^\]]+)\]/g;
    const imagenes = [];
    let match;
    let textoLimpio = texto;

    while ((match = regex.exec(texto)) !== null) {
        // Tomar el texto inmediatamente anterior como caption (línea que precede al tag)
        const antes = texto.slice(0, match.index).trimEnd();
        const ultimaLinea = antes.split('\n').pop().trim();
        imagenes.push({ url: match[1], caption: ultimaLinea });
    }

    // Eliminar los tags [IMG:...] del texto
    textoLimpio = texto.replace(/\[IMG:(https?:\/\/[^\]]+)\]/g, '').replace(/\n{3,}/g, '\n\n').trim();

    return { textoLimpio, imagenes };
}

/**
 * Detecta si el mensaje es de un tipo no soportado (imagen, video, audio, etc.)
 * y retorna una descripción amigable del tipo, o null si es texto normal.
 */
function detectarTipoMensaje(message) {
    if (!message) return null;
    if (message.imageMessage)    return 'imágenes 🖼️';
    if (message.videoMessage)    return 'videos 🎥';
    if (message.audioMessage)    return 'audios 🎵';
    if (message.documentMessage) return 'documentos 📄';
    if (message.stickerMessage)  return 'stickers';
    if (message.locationMessage) return 'ubicaciones 📍';
    if (message.contactMessage)  return 'contactos';
    return null;
}

function construirContents(historial, mensajeActual) {
    const contents = historial.map(h => ({
        role: h.rol === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.mensaje }],
    }));
    contents.push({ role: 'user', parts: [{ text: mensajeActual }] });
    return contents;
}

/**
 * Genera la respuesta del asistente usando el proveedor configurado (Gemini u Ollama local).
 * Configurado mediante la variable de entorno AI_PROVIDER ('gemini' | 'ollama').
 * @param {Array} historial - mensajes previos de la sesión actual
 * @param {string} mensajeActual - mensaje del usuario
 * @param {string|null} resumenUsuario - resumen de conversaciones anteriores del usuario
 */
async function generarRespuestaIA(historial, mensajeActual, resumenUsuario = null) {
    const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
    const systemPrompt = getSystemInstruction(resumenUsuario);
    const t0 = Date.now();

    if (provider === 'ollama') {
        const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
        const model = process.env.OLLAMA_MODEL || 'gemma4:e2b';

        console.log(`⏳ [OLLAMA] Enviando consulta al modelo '${model}' en ${host}...`);

        // Formatear mensajes para la API de Ollama
        const messages = [
            { role: 'system', content: systemPrompt },
            ...historial.map(h => ({
                role: h.rol === 'assistant' ? 'assistant' : 'user',
                content: h.mensaje,
            })),
            { role: 'user', content: mensajeActual },
        ];

        try {
            // Timeout de 60 segundos para evitar que se quede esperando indefinidamente
            const res = await fetch(`${host}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(90000), // 90 segundos para modelos locales
                body: JSON.stringify({
                    model,
                    messages,
                    stream: false,
                    options: {
                        temperature: 0.2,
                    },
                }),
            });

            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(`HTTP ${res.status} de Ollama: ${errorText}`);
            }

            const data = await res.json();
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`✅ [OLLAMA] Respuesta generada exitosamente en ${elapsed}s`);

            return data.message?.content || '';
        } catch (err) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.error(`❌ [OLLAMA ERROR] (${elapsed}s):`, err.message);
            throw err;
        }

    } else {
        // Proveedor: GEMINI
        if (!ai) {
            throw new Error('GEMINI_API_KEY no está configurada en el archivo .env');
        }

        const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
        console.log(`⏳ [GEMINI] Enviando consulta al modelo '${model}'...`);

        const contents = construirContents(historial, mensajeActual);

        try {
            const response = await ai.models.generateContent({
                model,
                config: { systemInstruction: systemPrompt },
                contents,
            });

            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`✅ [GEMINI] Respuesta generada exitosamente en ${elapsed}s`);

            return response.text;
        } catch (err) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.error(`❌ [GEMINI ERROR] (${elapsed}s):`, err.message);
            throw err;
        }
    }
}

/**
 * Usa la IA para generar un resumen conciso de la conversación y lo guarda en la BD.
 * Se llama antes de resetear la sesión para preservar el contexto del usuario.
 * @param {string} jid
 */
async function generarResumenConIA(jid) {
    try {
        const historial = await obtenerHistorial(jid, 40);
        if (historial.length < 3) return; // No vale la pena resumir conversaciones muy cortas

        const conversacionTexto = historial
            .map(h => `${h.rol === 'user' ? 'Cliente' : 'Bot'}: ${h.mensaje}`)
            .join('\n');

        const promptResumen =
            `Analiza la siguiente conversación entre un cliente y el bot de Cabañas Amanda. ` +
            `Genera un resumen breve (máximo 5 líneas) con los datos clave del cliente que serían útiles ` +
            `para personalizar futuras conversaciones. Incluye: nombre (si lo mencionó), fechas de interés, ` +
            `cabaña preferida, cantidad de personas, si tiene mascotas, si hizo reserva y su número, y cualquier ` +
            `preferencia relevante. Sé conciso y directo, sin saludos ni explicaciones.\n\n` +
            `CONVERSACIÓN:\n${conversacionTexto}`;

        const resumen = await generarRespuestaIA([], promptResumen);
        if (resumen && resumen.trim().length > 10) {
            await guardarResumenUsuario(jid, resumen.trim());
            console.log(`📝 [Resumen] Resumen guardado para ${jid}`);
        }
    } catch (err) {
        console.error('⚠️ [Resumen] No se pudo generar el resumen:', err.message);
        // No lanzamos el error: el reset debe continuar aunque falle el resumen
    }
}

/**
 * Ejecuta una acción detectada en la respuesta de la IA.
 * Retorna un mensaje adicional para enviar al cliente, o null.
 */
async function ejecutarAccion(accion, jid, sock) {
    switch (accion.accion) {

        case 'VERIFICAR_DISPONIBILIDAD': {
            const { check_in, check_out, personas, cabana_id } = accion;
            if (!check_in || !check_out) return null;

            const disponibles = await obtenerCabanasDisponibles(check_in, check_out);
            const aptas = disponibles.filter(c => c.capacidad >= parseInt(personas || 1));

            if (aptas.length === 0) {
                await actualizarSesion(jid, 'inicio');
                return '😔 Lo siento, no hay disponibilidad para esas fechas con esa cantidad de personas. ¿Quieres intentar con otras fechas?';
            }

            // Guardar fechas y disponibilidad en la sesión
            const cabanaElegida = cabana_id
                ? aptas.find(c => c.id === parseInt(cabana_id)) || aptas[0]
                : aptas[0];

            await actualizarSesion(jid, 'confirmacion_datos', {
                check_in,
                check_out,
                personas: parseInt(personas || 1),
                cabana_id: cabanaElegida.id,
                cabanas_disponibles: aptas.map(c => c.id),
            });

            const cotizacion = calcularCotizacion(check_in, check_out, cabanaElegida.id);
            return formatearCotizacion(cotizacion, check_in, check_out, cabanaElegida.id);
        }

        case 'CREAR_RESERVA': {
            const { nombre, check_in, check_out, personas, cabana_id, notas } = accion;
            
            // Guardamos el identificador (ya sea número normal o LID)
            const idContacto = jid.split('@')[0];
            
            if (!nombre || !check_in || !check_out || !cabana_id) return null;

            try {
                const reserva = await crearReserva({
                    jid,
                    cabanaId:      parseInt(cabana_id),
                    checkIn:       check_in,
                    checkOut:      check_out,
                    nombreHuesped: nombre,
                    telefono:      idContacto, // Guardamos el ID que nos da WhatsApp
                    personas:      parseInt(personas || 1),
                    notas,
                });

                // 1. NOTIFICACIÓN AL ADMINISTRADOR (CON MENCIÓN CLICKABLE)
                const adminJid = process.env.ADMIN_WHATSAPP_JID;
                if (adminJid && sock) {
                    const cotizacion = reserva.cotizacion;
                    const msgAdmin =
                        `🔔 *Nueva solicitud de reserva*\n\n` +
                        `📋 ID: \`${reserva.id}\`\n` +
                        `👤 Huésped: ${nombre}\n` +
                        `📱 Contacto: @${idContacto}\n` + // <-- Mención al usuario
                        `🏡 Cabaña: ${cabana_id} | 👥 Personas: ${personas}\n` +
                        `📅 Check-in: ${check_in}\n` +
                        `📅 Check-out: ${check_out}\n` +
                        `💰 Total: $${cotizacion.total.toLocaleString('es-CL')}\n` +
                        `🔒 Abono 20%: $${cotizacion.abono.toLocaleString('es-CL')}\n` +
                        `⏳ Plazo límite: ${reserva.horaLimiteChile} hrs (${reserva.horasExpiracion}h de retención)\n` +
                        (notas ? `📝 Notas: ${notas}\n` : '') +
                        `\n_👉 Toca el contacto en azul (@) arriba para enviarle un mensaje._`;

                    await sock.sendMessage(adminJid, { 
                        text: msgAdmin,
                        mentions: [jid] // <-- ¡ESTO ES CLAVE! Hace que el contacto sea un enlace azul para el admin
                    });
                }

                // 2. RESPUESTA AL USUARIO MAYOR (CON LINK MÁGICO)
                // Preparamos un mensaje que ellos le enviarán al administrador sin escribir nada
                const textoPredefinido = encodeURIComponent(`Hola, soy ${nombre} y mi reserva es la número ${reserva.id}. Quiero coordinar mi abono.`);
                // Tu número de administrador real
                const numeroAdminReal = "56951307009";
                const linkAdmin = `https://wa.me/${numeroAdminReal}?text=${textoPredefinido}`;

                const mensajeConfirmacion =
                    `✅ *¡Solicitud registrada exitosamente, ${nombre}!*\n\n` +
                    `Tu número de reserva es: \`${reserva.id}\`\n\n` +
                    `⏳ *Plazo de retención:* Tienes *${reserva.horasExpiracion} hora(s)* (hasta las *${reserva.horaLimiteChile} hrs*) para transferir el 20% del abono y asegurar tu cabaña. Pasado este plazo, las fechas se liberarán automáticamente.\n\n` +
                    `📌 Para coordinar tu abono fácilmente, *toca el siguiente enlace azul*:\n\n` +
                    `👉 ${linkAdmin} 👈\n\n` +
                    `🧺 Recuerda traer tus *sábanas personales* el día de tu llegada. ¡Nos vemos pronto! 🌊`;

                // Enviar también los datos de transferencia en mensaje separado y limpio
                const datosBancarios =
                    `CARLOS HERRERA\n` +
                    `16.121.937-1\n` +
                    `Banco Bci\n` +
                    `Cuenta Corriente\n` +
                    `46488782\n` +
                    `carlosherreraflores@gmail.com`;

                await sock.sendMessage(jid, { text: mensajeConfirmacion });
                await sock.sendMessage(jid, { text: datosBancarios });
                return null;
            } catch (err) {
                console.error('Error al crear reserva:', err.message);
                return '❌ Hubo un problema al registrar tu solicitud. Por favor contacta al administrador al +56951307009.';
            }
        }
        case 'RESETEAR_SESION': {
            // Generar y guardar resumen ANTES de limpiar la sesión
            await generarResumenConIA(jid);
            await resetearSesion(jid);
            return null;
        }

        default:
            return null;
    }
}

// ─────────────────────────────────────────────
// VERIFICACIÓN INICIAL DE OLLAMA
// ─────────────────────────────────────────────

async function verificarOllama() {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'gemma4:e2b';

    try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) {
            console.warn(`⚠️ [OLLAMA] Servidor respondió con estado HTTP ${res.status}`);
            return;
        }
        const data = await res.json();
        const modelosDisponibles = (data.models || []).map(m => m.name);
        const existe = modelosDisponibles.some(m => m === model || m.startsWith(model + ':') || model.startsWith(m));

        if (existe) {
            console.log(`✅ [OLLAMA] Servidor conectado y modelo '${model}' verificado.`);
        } else {
            console.warn(`⚠️ [OLLAMA] El modelo '${model}' NO se encontró en la lista local de Ollama: [${modelosDisponibles.join(', ')}]`);
        }
    } catch (err) {
        console.error(`❌ [OLLAMA] No se pudo conectar a ${host}. ¿Está corriendo el servicio de Ollama? Detalle: ${err.message}`);
    }
}

// ─────────────────────────────────────────────
// MONITOR DE EXPIRACIÓN Y RECORDATORIOS
// ─────────────────────────────────────────────

let monitorIntervalId = null;

function detenerMonitorReservas() {
    if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
        monitorIntervalId = null;
        console.log('⏹️ [Monitor Reservas] Detenido.');
    }
}

function iniciarMonitorReservas(sock) {
    detenerMonitorReservas();

    const intervaloMinutos = parseFloat(process.env.RESERVA_CHECK_INTERVALO_MINUTOS || '1');
    const intervaloMs = Math.max(0.5, intervaloMinutos) * 60 * 1000;

    console.log(`⏱️ [Monitor Reservas] Activo (revisión cada ${intervaloMinutos} min)`);

    // Verificación inicial inmediata
    verificarExpiracionYRecordatorios(sock);

    monitorIntervalId = setInterval(() => {
        verificarExpiracionYRecordatorios(sock);
    }, intervaloMs);
}

async function verificarExpiracionYRecordatorios(sock) {
    if (!sock) return;

    try {
        const notificarRecordatorio = process.env.RESERVA_NOTIFICAR_RECORDATORIO !== 'false';
        const notificarExpiracion   = process.env.RESERVA_NOTIFICAR_EXPIRACION !== 'false';
        const minutosRecordatorio   = parseInt(process.env.RESERVA_RECORDATORIO_MINUTOS || '30');
        const adminJid              = process.env.ADMIN_WHATSAPP_JID;
        const numeroAdminReal       = "56951307009";

        // 1. GESTIÓN DE RECORDATORIOS
        if (notificarRecordatorio) {
            const porRecordar = await obtenerReservasPorRecordar(minutosRecordatorio);
            for (const r of porRecordar) {
                try {
                    const horaLimiteChile = formatearHoraChile(r.expira_en);
                    const textoPredefinido = encodeURIComponent(`Hola, soy ${r.nombre_huesped} y mi reserva es ${r.id}. Quiero coordinar mi abono.`);
                    const linkAdmin = `https://wa.me/${numeroAdminReal}?text=${textoPredefinido}`;

                    const mensajeRecordatorio =
                        `⏰ *Recordatorio de Solicitud de Reserva*\n\n` +
                        `Hola *${r.nombre_huesped}*, te recordamos que tu solicitud de reserva \`${r.id}\` para la *Cabaña ${r.cabana_id}* vencerá pronto (a las *${horaLimiteChile} hrs*).\n\n` +
                        `Para asegurar tu cabaña y no perder la fecha, por favor realiza el abono del 20% y coordina con nuestro administrador:\n\n` +
                        `👉 ${linkAdmin} 👈\n\n` +
                        `_Si ya realizaste la transferencia o necesitas más tiempo, por favor avísanos._`;

                    if (r.whatsapp_jid) {
                        await sock.sendMessage(r.whatsapp_jid, { text: mensajeRecordatorio });
                        await guardarMensaje(r.whatsapp_jid, 'assistant', mensajeRecordatorio, r.id);
                    }
                    await marcarRecordatorioEnviado(r.id);
                    console.log(`🔔 [Monitor] Recordatorio enviado a ${r.whatsapp_jid} para reserva ${r.id}`);
                } catch (errRec) {
                    console.error(`❌ [Monitor] Error enviando recordatorio para reserva ${r.id}:`, errRec.message);
                }
            }
        }

        // 2. GESTIÓN DE EXPIRACIONES
        const expiradas = await obtenerReservasExpiradas();
        for (const r of expiradas) {
            try {
                await expirarReserva(r.id);
                if (r.whatsapp_jid) {
                    await resetearSesion(r.whatsapp_jid);
                }
                console.log(`⏳ [Monitor] Reserva ${r.id} expirada y cabaña ${r.cabana_id} liberada.`);

                // Notificar al cliente si está habilitado
                if (notificarExpiracion && r.whatsapp_jid) {
                    const mensajeExpiracion =
                        `⏳ *Solicitud de Reserva Liberada*\n\n` +
                        `Hola *${r.nombre_huesped}*, el plazo para confirmar tu solicitud de reserva \`${r.id}\` para la Cabaña ${r.cabana_id} ha finalizado y las fechas han sido liberadas para otros huéspedes.\n\n` +
                        `Si aún deseas alojarte con nosotros, puedes volver a escribirnos para verificar si las fechas siguen disponibles. ¡Estaremos encantados de recibirte! 🌊`;

                    await sock.sendMessage(r.whatsapp_jid, { text: mensajeExpiracion });
                    await guardarMensaje(r.whatsapp_jid, 'assistant', mensajeExpiracion, r.id);
                }

                // Notificar al admin
                if (adminJid) {
                    const msgAdminExp =
                        `⚠️ *Reserva Expirada Automáticamente*\n\n` +
                        `📋 ID: \`${r.id}\`\n` +
                        `👤 Huésped: ${r.nombre_huesped}\n` +
                        `🏡 Cabaña: ${r.cabana_id}\n` +
                        `📅 Fechas: ${r.check_in} al ${r.check_out}\n\n` +
                        `_La cabaña ha quedado liberada en el sistema._`;

                    await sock.sendMessage(adminJid, { text: msgAdminExp });
                }
            } catch (errExp) {
                console.error(`❌ [Monitor] Error procesando expiración de reserva ${r.id}:`, errExp.message);
            }
        }

    } catch (err) {
        console.error('❌ [Monitor] Error en ciclo de verificación:', err.message);
    }
}

// ─────────────────────────────────────────────
// BOT PRINCIPAL
// ─────────────────────────────────────────────

async function startBot() {
    // Verificar conexión a la base de datos antes de iniciar
    await testConnection();

    const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
    const modelName = provider === 'ollama' ? (process.env.OLLAMA_MODEL || 'gemma4:e2b') : (process.env.GEMINI_MODEL || 'gemini-3.6-flash');
    console.log(`🤖 Proveedor de IA activo: [${provider.toUpperCase()}] usando modelo '${modelName}'`);

    if (provider === 'ollama') {
        await verificarOllama();
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_auth');

    const sock = makeWASocket({ auth: state });

    sock.ev.on('creds.update', saveCreds);

    // Rechazar llamadas entrantes y avisar al usuario que solo se atiende por chat
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer') {
                console.log(`📵 [Llamada] Rechazando llamada entrante de ${call.from}`);
                try {
                    await sock.rejectCall(call.id, call.from);
                } catch (_) { /* algunos clientes no admiten reject, ignorar */ }
                await sock.sendMessage(call.from, {
                    text: '📵 No puedo atender llamadas. Por favor escríbeme tu consulta por *chat* y te respondo enseguida. 😊'
                });
            }
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            detenerMonitorReservas();
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot conectado a WhatsApp correctamente');
            iniciarMonitorReservas(sock);
        }
    });

    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe || !msg.message) continue;

            const textMsg = msg.message.conversation || msg.message.extendedTextMessage?.text;

            // Normalizar el JID
            const rawJid = msg.key.remoteJid || '';
            let jid = rawJid;

            // Si es un grupo (@g.us) o un ID interno (@lid), el remitente real está en participant
            if ((rawJid.endsWith('@g.us') || rawJid.endsWith('@lid')) && msg.key.participant) {
                jid = msg.key.participant;
            }

            const remitente = jid.split('@')[0];
            console.log(`\n📩 [WhatsApp] Mensaje recibido de ${remitente}: "${textMsg}"`);

            try {
                // Obtener sesión, historial y resumen de conversaciones previas
                const sesion         = await obtenerSesion(jid);
                const historial      = await obtenerHistorial(jid, 20);
                const resumenUsuario = await obtenerResumenUsuario(jid);

                if (resumenUsuario) {
                    console.log(`🧠 [Resumen] Contexto previo cargado para ${remitente}`);
                }

                // Guardar mensaje del usuario en el historial
                await guardarMensaje(jid, 'user', textMsg, sesion.reserva_id || null);

                // Generar respuesta con la IA (Gemini u Ollama según AI_PROVIDER)
                const respuestaIA = await generarRespuestaIA(historial, textMsg, resumenUsuario);

                // Extraer acción embebida si la IA la incluyó
                const { textoLimpio: textoSinAccion, accion } = extraerAccion(respuestaIA);

                // Extraer imágenes embebidas [IMG:url] del texto
                const { textoLimpio, imagenes } = extraerImagenes(textoSinAccion);

                // Enviar texto principal (si tiene contenido)
                if (textoLimpio) {
                    console.log(`📤 [WhatsApp] Enviando respuesta a ${remitente}...`);
                    await sock.sendMessage(jid, { text: textoLimpio });
                    await guardarMensaje(jid, 'assistant', textoLimpio, sesion.reserva_id || null);
                }

                // Enviar imágenes como mensajes de imagen con caption
                for (const img of imagenes) {
                    try {
                        console.log(`🖼️ [WhatsApp] Enviando imagen adjunta: ${img.url}`);
                        await sock.sendMessage(jid, {
                            image: { url: img.url },
                            caption: img.caption || '',
                        });
                    } catch (imgErr) {
                        console.error('Error al enviar imagen:', img.url, imgErr.message);
                    }
                }

                // Ejecutar acción si existe (puede generar un mensaje adicional)
                if (accion) {
                    console.log(`⚙️ [Acción detectada]: ${accion.accion}`);
                    const mensajeExtra = await ejecutarAccion(accion, jid, sock);
                    if (mensajeExtra) {
                        await sock.sendMessage(jid, { text: mensajeExtra });
                        await guardarMensaje(jid, 'assistant', mensajeExtra, sesion.reserva_id || null);
                    }
                }

            } catch (error) {
                console.error('❌ Error al procesar mensaje:', error.message);
                await sock.sendMessage(jid, {
                    text: 'Lo siento, tuve un problema técnico. Por favor intenta de nuevo o contacta al administrador al +56951307009 🙏',
                });
            }
        }
    });
}

startBot();
