require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { PDFDocument } = require('pdf-lib');
const FormData = require('form-data');
const ExcelJS = require('exceljs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log temporal de diagnóstico: anota en los Logs de Render CUALQUIER
// pedido que llegue al servidor, venga de donde venga.
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.path}`);
  next();
});

const {
  ML_CLIENT_ID,
  ML_CLIENT_SECRET,
  ML_REDIRECT_URI,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  TELEGRAM_CHAT_ID_RESUMEN,
  PORT = 3000,
} = process.env;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const STOCK_MINIMO = 2; // avisar cuando quedan esta cantidad o menos

// ---------------------------------------------------------------------
// "Memoria" del bot: se guarda en Upstash (una base de datos externa
// gratuita) en vez de un archivo local, para que no se pierda cada vez
// que Render reinicia el servidor.
//
// Estructura de datos, ahora que soportamos VARIAS cuentas de Mercado
// Libre a la vez:
//
// data = {
//   cuentas: {
//     "<user_id_de_ML>": {
//       nombre: "apodo de la cuenta",
//       access_token, refresh_token, expires_at,
//       notificadas: [],            // preguntas ya avisadas
//       ventas_notificadas: [],     // ventas ya avisadas
//       ventas_inicializado: false,
//       reclamos_notificados: [],   // reclamos ya avisados
//       reclamos_inicializado: false,
//       stock_alertado: {},         // qué publicaciones están en alerta
//     },
//     ...
//   },
//   pending: { "<id_de_mensaje_de_telegram>": { cuentaId, questionId } }
// }
// ---------------------------------------------------------------------

const upstashHeaders = { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` };

function datosVacios() {
  return {
    cuentas: {},
    pending: {},
    resumen_periodo: { totales: {}, flex: 0, normal: 0, otros: 0 },
    resumen_ultima_fecha_enviada: null,
    ventas_por_dia: {}, // { "2026-09-21": 45000, ... } - todas las cuentas juntas
  };
}

const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';

function fechaHoyAR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date()); // "YYYY-MM-DD"
}

function nombreMes(mesStr) {
  if (!mesStr) return '';
  const [year, month] = mesStr.split('-');
  const fecha = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(fecha);
}

// Convierte una fecha (la de creación de la orden, en formato ISO) a
// su día calendario en horario argentino, tipo "2026-09-21".
function fechaDeAR(fechaISO) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date(fechaISO));
}

// Suma una venta al total de SU día (el día en que se generó la
// orden), para poder después armar comparaciones "mes a la fecha".
function agregarVentaPorDia(fechaISO, monto) {
  if (!data.ventas_por_dia) data.ventas_por_dia = {};
  const dia = fechaDeAR(fechaISO);
  data.ventas_por_dia[dia] = (data.ventas_por_dia[dia] || 0) + monto;
  limpiarVentasPorDiaViejas();
}

// No hace falta guardar más de ~65 días (nos alcanza para comparar el
// mes actual contra el anterior), así que vamos borrando lo más viejo.
function limpiarVentasPorDiaViejas() {
  const limite = new Date();
  limite.setDate(limite.getDate() - 65);
  const limiteStr = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(limite);
  for (const dia of Object.keys(data.ventas_por_dia)) {
    if (dia < limiteStr) delete data.ventas_por_dia[dia];
  }
}

// Suma las ventas del día 1 hasta "hoy" (o hasta el mismo número de
// día, si se pide un mes anterior) de un mes dado. offsetMeses: 0 =
// este mes, -1 = el mes anterior, a la misma altura.
function acumuladoMesHastaHoy(offsetMeses) {
  const partesHoy = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const anioHoy = Number(partesHoy.find((p) => p.type === 'year').value);
  const mesHoy = Number(partesHoy.find((p) => p.type === 'month').value); // 1-12
  const diaHoy = Number(partesHoy.find((p) => p.type === 'day').value);

  let mesObjetivo = mesHoy + offsetMeses;
  let anioObjetivo = anioHoy;
  if (mesObjetivo < 1) {
    mesObjetivo += 12;
    anioObjetivo -= 1;
  }

  const ultimoDiaDelMes = new Date(Date.UTC(anioObjetivo, mesObjetivo, 0)).getUTCDate();
  const diaTope = Math.min(diaHoy, ultimoDiaDelMes); // por si el mes anterior tiene menos días (ej: febrero)

  let total = 0;
  for (let d = 1; d <= diaTope; d++) {
    const diaStr = `${anioObjetivo}-${String(mesObjetivo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    total += (data.ventas_por_dia && data.ventas_por_dia[diaStr]) || 0;
  }

  return { total, mes: `${anioObjetivo}-${String(mesObjetivo).padStart(2, '0')}`, diaTope };
}

function horaAhoraAR() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA_HORARIA,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date()); // "HH:MM"
}

// Si lo que hay guardado es del formato viejo (una sola cuenta, sin la
// clave "cuentas"), lo convertimos al formato nuevo automáticamente,
// para no perder la conexión que ya tenías hecha.
function migrarSiHaceFalta(d) {
  if (d.cuentas) return d; // ya está en el formato nuevo, no hay nada que hacer
  if (!d.refresh_token) return datosVacios(); // no había ninguna cuenta conectada

  const cuentaId = d.user_id ? String(d.user_id) : 'cuenta_1';
  console.log(`🔄 Migrando datos viejos al formato nuevo (cuenta ${cuentaId})...`);

  return {
    cuentas: {
      [cuentaId]: {
        nombre: `Cuenta ${cuentaId}`,
        chat_id: null,
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_at: d.expires_at,
        notificadas: d.notificadas || [],
        ventas_notificadas: d.ventas_notificadas || [],
        ventas_inicializado: d.ventas_inicializado || false,
        reclamos_notificados: d.reclamos_notificados || [],
        reclamos_inicializado: d.reclamos_inicializado || false,
        stock_alertado: d.stock_alertado || {},
      },
    },
    pending: {}, // los "pendientes de responder" viejos no son compatibles; se descartan
  };
}

async function loadData() {
  try {
    const res = await axios.get(`${UPSTASH_REDIS_REST_URL}/get/botdata`, { headers: upstashHeaders });
    if (!res.data.result) return datosVacios();
    const migrado = migrarSiHaceFalta(JSON.parse(res.data.result));
    return migrado;
  } catch (err) {
    console.error('Error leyendo memoria del bot:', err.response?.data || err.message);
    return datosVacios();
  }
}

async function saveData(d) {
  try {
    await axios.post(`${UPSTASH_REDIS_REST_URL}/set/botdata`, JSON.stringify(d), {
      headers: { ...upstashHeaders, 'Content-Type': 'text/plain' },
    });
  } catch (err) {
    console.error('Error guardando memoria del bot:', err.response?.data || err.message);
  }
}

// Se carga una vez al arrancar el servidor. A partir de ahí, cada vez
// que algo cambia se actualiza acá Y se guarda en Upstash.
let data = datosVacios();

function cuentaVacia(nombre) {
  return {
    nombre,
    chat_id: null, // si no se configura, se usa TELEGRAM_CHAT_ID (el chat "general")
    access_token: null,
    refresh_token: null,
    expires_at: 0,
    notificadas: [],
    ventas_notificadas: [],
    ventas_inicializado: false,
    reclamos_notificados: [],
    reclamos_inicializado: false,
    stock_alertado: {},
  };
}

// Devuelve a qué chat de Telegram hay que mandarle los avisos de esta
// cuenta: el suyo propio si se configuró, o el chat general si no.
function chatDe(cuenta) {
  return cuenta.chat_id || TELEGRAM_CHAT_ID;
}

// =====================================================================
// PASO A: Conectar una cuenta de Mercado Libre. Se puede repetir con
// distintas cuentas: cada una queda guardada por separado, identificada
// por su propio ID de usuario de Mercado Libre.
// =====================================================================

app.get('/', (req, res) => {
  if (!ML_CLIENT_ID || !ML_REDIRECT_URI) {
    return res.send('Faltan variables de entorno ML_CLIENT_ID / ML_REDIRECT_URI. Revisá la configuración.');
  }
  const authUrl = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}&scope=${encodeURIComponent('offline_access read write')}`;

  const cuentas = Object.entries(data.cuentas || {});
  const listaCuentas = cuentas.length
    ? cuentas
        .map(
          ([id, c]) => `
          <div style="border:1px solid #ccc; padding:10px; margin-bottom:10px;">
            <b>${c.nombre}</b> (ID ${id}) ${c.refresh_token ? '✅' : '❌'}<br>
            <form method="POST" action="/cuentas/${id}/chat" style="margin-top:6px;">
              Chat de Telegram para esta cuenta:
              <input type="text" name="chat_id" value="${c.chat_id || ''}" placeholder="ej: -1001234567890 (vacío = chat general)">
              <button type="submit">Guardar</button>
            </form>
          </div>`
        )
        .join('')
    : '<p>Todavía no conectaste ninguna cuenta.</p>';

  res.send(`
    <h2>Bot Mercado Libre + Telegram</h2>
    <p>Cuentas conectadas:</p>
    ${listaCuentas}
    <p><a href="${authUrl}">Conectar una cuenta nueva de Mercado Libre</a></p>
    <p style="color:#666">Para agregar otra cuenta, cerrá sesión en Mercado Libre desde el navegador
    (o usá una ventana privada), volvé a hacer click en el link de arriba, e iniciá sesión con la otra cuenta.</p>
    <p style="color:#666">Si dejás el "Chat de Telegram" vacío para una cuenta, sus avisos van al chat
    general (TELEGRAM_CHAT_ID). Si le asignás un chat propio (el ID de un grupo donde agregaste el bot),
    sus avisos van a ir ahí en vez de al chat general.</p>
  `);
});

// Guarda a qué chat de Telegram hay que mandarle los avisos de esta
// cuenta puntual (dejar vacío = usar el chat general).
app.post('/cuentas/:id/chat', async (req, res) => {
  const cuenta = data.cuentas[req.params.id];
  if (!cuenta) return res.status(404).send('Esa cuenta no existe.');
  const chatId = (req.body.chat_id || '').trim();
  cuenta.chat_id = chatId || null;
  await saveData(data);
  res.redirect('/');
});

// Mercado Libre te redirige acá después de que autorizás una cuenta.
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta el parámetro "code" en la URL.');
  try {
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code,
        redirect_uri: ML_REDIRECT_URI,
      },
    });

    if (!response.data.refresh_token) {
      console.error('Mercado Libre no devolvió refresh_token. Respuesta completa:', response.data);
      return res.status(500).send(
        '⚠️ Mercado Libre no envió el "refresh_token" (revisá que el flujo Refresh Token esté habilitado en tu app). Volvé a la URL principal e intentá conectar de nuevo.'
      );
    }

    const accessToken = response.data.access_token;
    const { data: usuario } = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const cuentaId = String(usuario.id);
    const nombre = usuario.nickname || `Cuenta ${cuentaId}`;

    const existente = data.cuentas[cuentaId] || cuentaVacia(nombre);
    data.cuentas[cuentaId] = {
      ...existente,
      nombre,
      access_token: accessToken,
      refresh_token: response.data.refresh_token,
      expires_at: Date.now() + response.data.expires_in * 1000,
    };
    await saveData(data);

    console.log(`Cuenta conectada: ${nombre} (${cuentaId})`);
    res.send(
      `✅ ¡Listo! Se conectó la cuenta <b>${nombre}</b>. Ya podés cerrar esta pestaña, o volver a la URL principal para conectar otra cuenta distinta.`
    );
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('❌ Hubo un error al conectar con Mercado Libre. Revisá los datos en el archivo .env');
  }
});

// Mercado Libre da tokens que vencen cada 6 horas. Esta función los
// renueva sola, para la cuenta indicada.
async function getAccessToken(cuentaId) {
  const cuenta = data.cuentas[cuentaId];
  if (!cuenta || !cuenta.refresh_token) {
    throw new Error(`La cuenta ${cuentaId} no está conectada.`);
  }
  if (Date.now() < cuenta.expires_at - 60000) {
    return cuenta.access_token;
  }
  const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: cuenta.refresh_token,
    },
  });
  cuenta.access_token = response.data.access_token;
  cuenta.refresh_token = response.data.refresh_token;
  cuenta.expires_at = Date.now() + response.data.expires_in * 1000;
  await saveData(data);
  return cuenta.access_token;
}

// Elige a qué cuenta se refiere un pedido de diagnóstico: si el pedido
// trae ?cuenta=ID lo usamos; si solo hay una cuenta conectada, la
// usamos por defecto; si hay varias y no se especificó, avisamos.
function resolverCuentaId(req) {
  const ids = Object.keys(data.cuentas || {});
  if (req.query.cuenta) return { id: req.query.cuenta };
  if (ids.length === 1) return { id: ids[0] };
  if (ids.length === 0) return { error: 'Todavía no conectaste ninguna cuenta.' };
  return {
    error: `Tenés varias cuentas conectadas, especificá cuál con ?cuenta=ID. Cuentas disponibles: ${ids
      .map((id) => `${id} (${data.cuentas[id].nombre})`)
      .join(', ')}`,
  };
}

// =====================================================================
// PREGUNTAS
// =====================================================================

// Procesa una pregunta de una cuenta puntual y la manda a Telegram.
async function procesarPregunta(cuentaId, resource, { ignorarEstado = false } = {}) {
  const cuenta = data.cuentas[cuentaId];
  const token = await getAccessToken(cuentaId);

  const { data: question } = await axios.get(`https://api.mercadolibre.com${resource}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (question.status !== 'UNANSWERED' && !ignorarEstado) {
    return { ok: false, motivo: `La pregunta ya tiene estado "${question.status}", no está pendiente de responder.` };
  }

  const { data: item } = await axios.get(`https://api.mercadolibre.com/items/${question.item_id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const texto =
    `🏪 Cuenta: ${cuenta.nombre}\n\n` +
    `❓ Nueva pregunta\n\n` +
    `🛒 Producto: ${item.title}\n\n` +
    `💬 Pregunta: ${question.text}\n\n` +
    `Respondé este mensaje (con "Responder" / "Reply") con el texto que querés enviar al comprador.`;

  const tgResponse = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatDe(cuenta),
    text: texto,
  });

  const sentMessageId = tgResponse.data.result.message_id;
  data.pending[sentMessageId] = { cuentaId, questionId: question.id };
  await saveData(data);

  return { ok: true };
}

async function revisarPreguntasNuevas() {
  for (const cuentaId of Object.keys(data.cuentas || {})) {
    const cuenta = data.cuentas[cuentaId];
    if (!cuenta.refresh_token) continue;

    try {
      const token = await getAccessToken(cuentaId);
      const response = await axios.get('https://api.mercadolibre.com/my/received_questions/search', {
        headers: { Authorization: `Bearer ${token}` },
      });

      const preguntas = response.data.questions || [];
      if (!Array.isArray(cuenta.notificadas)) cuenta.notificadas = [];

      const nuevas = preguntas.filter(
        (q) => q.status === 'UNANSWERED' && !cuenta.notificadas.includes(q.id)
      );

      for (const q of nuevas) {
        const resultado = await procesarPregunta(cuentaId, `/questions/${q.id}`, { ignorarEstado: true });
        if (resultado.ok) cuenta.notificadas.push(q.id);
      }

      if (nuevas.length > 0) {
        await saveData(data);
        console.log(`🔎 [${cuenta.nombre}] se avisaron ${nuevas.length} pregunta(s) nueva(s).`);
      }
    } catch (err) {
      console.error(`Error revisando preguntas de ${cuenta.nombre}:`, err.response?.data || err.message);
    }
  }
}

// =====================================================================
// VENTAS
// =====================================================================

function formatearMoneda(monto, moneda) {
  return `${moneda === 'ARS' ? '$' : moneda + ' '}${Number(monto).toLocaleString('es-AR')}`;
}

// Consulta si un envío es "Flex" (self_service) o "Normal" (cualquier
// otro tipo de logística de Mercado Envíos).
async function obtenerTipoEnvio(token, shippingId) {
  if (!shippingId) return 'Sin envío';
  try {
    const { data: envio } = await axios.get(`https://api.mercadolibre.com/shipments/${shippingId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return envio.logistic_type === 'self_service' ? 'Flex' : 'Normal';
  } catch (err) {
    console.error('Error consultando tipo de envío:', err.response?.data || err.message);
    return 'Desconocido';
  }
}

async function revisarVentasNuevas() {
  for (const cuentaId of Object.keys(data.cuentas || {})) {
    const cuenta = data.cuentas[cuentaId];
    if (!cuenta.refresh_token) continue;

    try {
      const token = await getAccessToken(cuentaId);

      const response = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: { seller: cuentaId, 'order.status': 'paid', sort: 'date_desc', limit: 20 },
        headers: { Authorization: `Bearer ${token}` },
      });

      const ordenes = response.data.results || [];
      if (!Array.isArray(cuenta.ventas_notificadas)) cuenta.ventas_notificadas = [];

      if (!cuenta.ventas_inicializado) {
        cuenta.ventas_notificadas = ordenes.map((o) => o.id);
        cuenta.ventas_inicializado = true;
        await saveData(data);
        console.log(`💰 [${cuenta.nombre}] primer barrido: ${ordenes.length} venta(s) existentes sin avisar.`);
        continue;
      }

      const nuevas = ordenes.filter((o) => !cuenta.ventas_notificadas.includes(o.id)).reverse();

      for (const orden of nuevas) {
        const productos = (orden.order_items || [])
          .map((it) => `• ${it.quantity} x ${it.item.title}`)
          .join('\n');
        const comprador = orden.buyer?.nickname || 'Comprador';
        const total = formatearMoneda(orden.total_amount, orden.currency_id);
        const tipoEnvio = await obtenerTipoEnvio(token, orden.shipping?.id);

        const texto =
          `🏪 Cuenta: ${cuenta.nombre}\n\n` +
          `💰 ¡Nueva venta!\n\n` +
          `🧾 Orden: ${orden.id}\n` +
          `👤 Comprador: ${comprador}\n` +
          `📦 Producto(s):\n${productos}\n\n` +
          `🚚 Envío: ${tipoEnvio}\n` +
          `💵 Total: ${total}`;

        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatDe(cuenta), text: texto });

        // Ya NO mandamos una línea por venta al chat de resumen: ahí solo
        // va el informe combinado una vez al día (ver revisarResumenDiario).
        // Acá solo acumulamos los datos para ese informe.
        if (!data.resumen_periodo) data.resumen_periodo = { totales: {}, flex: 0, normal: 0, otros: 0 };
        data.resumen_periodo.totales[cuentaId] =
          (data.resumen_periodo.totales[cuentaId] || 0) + Number(orden.total_amount);
        if (tipoEnvio === 'Flex') data.resumen_periodo.flex++;
        else if (tipoEnvio === 'Normal') data.resumen_periodo.normal++;
        else data.resumen_periodo.otros++;

        agregarVentaPorDia(orden.date_created, Number(orden.total_amount));

        cuenta.ventas_notificadas.push(orden.id);
      }

      if (nuevas.length > 0) {
        await saveData(data);
        console.log(`💰 [${cuenta.nombre}] se avisaron ${nuevas.length} venta(s) nueva(s).`);
      }
    } catch (err) {
      console.error(`Error revisando ventas de ${cuenta.nombre}:`, err.response?.data || err.message);
    }
  }
}

// =====================================================================
// RECLAMOS
// =====================================================================

async function revisarReclamosNuevos() {
  for (const cuentaId of Object.keys(data.cuentas || {})) {
    const cuenta = data.cuentas[cuentaId];
    if (!cuenta.refresh_token) continue;

    try {
      const token = await getAccessToken(cuentaId);
      const response = await axios.get('https://api.mercadolibre.com/marketplace/v2/claims/search', {
        params: { user_id: cuentaId, status: 'opened', sort: 'last_updated:desc' },
        headers: { Authorization: `Bearer ${token}` },
      });

      const reclamos = response.data.data || [];
      if (!Array.isArray(cuenta.reclamos_notificados)) cuenta.reclamos_notificados = [];

      if (!cuenta.reclamos_inicializado) {
        cuenta.reclamos_notificados = reclamos.map((r) => r.id);
        cuenta.reclamos_inicializado = true;
        await saveData(data);
        console.log(`⚠️ [${cuenta.nombre}] primer barrido: ${reclamos.length} reclamo(s) existentes sin avisar.`);
        continue;
      }

      const nuevos = reclamos.filter((r) => !cuenta.reclamos_notificados.includes(r.id)).reverse();

      for (const reclamo of nuevos) {
        const texto =
          `🏪 Cuenta: ${cuenta.nombre}\n\n` +
          `⚠️ Nuevo reclamo\n\n` +
          `🆔 Reclamo: ${reclamo.id}\n` +
          `📄 Tipo: ${reclamo.type}\n` +
          `🧾 Orden relacionada: ${reclamo.resource_id}\n` +
          `📌 Estado: ${reclamo.status}${reclamo.stage ? ' (' + reclamo.stage + ')' : ''}\n\n` +
          `Entrá a Mercado Libre > Reclamos para ver el detalle y responder.`;

        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatDe(cuenta), text: texto });
        cuenta.reclamos_notificados.push(reclamo.id);
      }

      if (nuevos.length > 0) {
        await saveData(data);
        console.log(`⚠️ [${cuenta.nombre}] se avisaron ${nuevos.length} reclamo(s) nuevo(s).`);
      }
    } catch (err) {
      console.error(`Error revisando reclamos de ${cuenta.nombre}:`, err.response?.data || err.message);
    }
  }
}

// =====================================================================
// STOCK BAJO
// =====================================================================

function partirEnGrupos(lista, tamano) {
  const grupos = [];
  for (let i = 0; i < lista.length; i += tamano) {
    grupos.push(lista.slice(i, i + tamano));
  }
  return grupos;
}

async function revisarStockBajo() {
  for (const cuentaId of Object.keys(data.cuentas || {})) {
    const cuenta = data.cuentas[cuentaId];
    if (!cuenta.refresh_token) continue;

    try {
      const token = await getAccessToken(cuentaId);

      const { data: idsResponse } = await axios.get(
        `https://api.mercadolibre.com/users/${cuentaId}/items/search`,
        { params: { status: 'active', limit: 100 }, headers: { Authorization: `Bearer ${token}` } }
      );
      const itemIds = idsResponse.results || [];
      if (!cuenta.stock_alertado || typeof cuenta.stock_alertado !== 'object') cuenta.stock_alertado = {};

      let huboAlerta = false;

      for (const grupo of partirEnGrupos(itemIds, 20)) {
        const { data: items } = await axios.get('https://api.mercadolibre.com/items', {
          params: { ids: grupo.join(','), attributes: 'id,title,available_quantity' },
          headers: { Authorization: `Bearer ${token}` },
        });

        for (const { body: item } of items) {
          if (!item) continue;
          const yaAlertado = !!cuenta.stock_alertado[item.id];

          if (item.available_quantity <= STOCK_MINIMO && !yaAlertado) {
            const texto =
              `🏪 Cuenta: ${cuenta.nombre}\n\n` +
              `📦 Stock bajo\n\n` +
              `🛒 Producto: ${item.title}\n` +
              `🔢 Quedan: ${item.available_quantity} unidad(es)\n\n` +
              `Considerá reponer stock pronto.`;
            await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatDe(cuenta), text: texto });
            cuenta.stock_alertado[item.id] = true;
            huboAlerta = true;
          } else if (item.available_quantity > STOCK_MINIMO && yaAlertado) {
            cuenta.stock_alertado[item.id] = false;
            huboAlerta = true;
          }
        }
      }

      if (huboAlerta) {
        await saveData(data);
        console.log(`📦 [${cuenta.nombre}] sondeo de stock: se actualizaron alertas.`);
      }
    } catch (err) {
      console.error(`Error revisando stock de ${cuenta.nombre}:`, err.response?.data || err.message);
    }
  }
}

// =====================================================================
// RESUMEN DIARIO: una sola vez al día, a las 12:00 (hora Argentina),
// manda al chat de resumen el total facturado por cada cuenta en las
// últimas 24hs (de 12:00 a 12:00), más cuántas ventas fueron con envío
// Flex y cuántas con envío Normal.
// =====================================================================

const HORA_DE_CORTE = '12:00';

function resumenPeriodoVacio() {
  return { totales: {}, flex: 0, normal: 0, otros: 0 };
}

function armarTextoResumenPeriodo(resumen) {
  const entradas = Object.entries(resumen.totales || {});
  const totalCombinado = entradas.reduce((suma, [, total]) => suma + total, 0);
  const totalVentas = resumen.flex + resumen.normal + resumen.otros;

  const lineas = entradas.length
    ? entradas.map(([cuentaId, total]) => {
        const nombre = data.cuentas[cuentaId]?.nombre || `Cuenta ${cuentaId}`;
        return `• ${nombre}: ${formatearMoneda(total, 'ARS')}`;
      })
    : ['Sin ventas en las últimas 24hs.'];

  let textoEnvios = `🚚 Envíos (todas las cuentas): ${resumen.flex} Flex / ${resumen.normal} Normal`;
  if (resumen.otros > 0) textoEnvios += ` / ${resumen.otros} otros`;

  return (
    `📊 Resumen de ventas (últimas 24hs, corte ${HORA_DE_CORTE})\n\n` +
    `${lineas.join('\n')}\n\n` +
    `💰 Total combinado: ${formatearMoneda(totalCombinado, 'ARS')}\n` +
    (totalVentas > 0 ? textoEnvios + '\n\n' : '\n') +
    textoComparativaMensual()
  );
}

// Texto con "cuánto llevo facturado este mes hasta hoy" comparado con
// "cuánto llevaba facturado a la misma altura el mes pasado" (todas
// las cuentas juntas).
function textoComparativaMensual() {
  const actual = acumuladoMesHastaHoy(0);
  const anterior = acumuladoMesHastaHoy(-1);

  let texto = `📅 ${nombreMes(actual.mes)}, acumulado al día ${actual.diaTope}: ${formatearMoneda(actual.total, 'ARS')}`;
  texto += `\n📈 ${nombreMes(anterior.mes)} a la misma altura (día ${anterior.diaTope}): ${formatearMoneda(anterior.total, 'ARS')}`;

  if (anterior.total > 0) {
    const variacion = ((actual.total - anterior.total) / anterior.total) * 100;
    const signo = variacion >= 0 ? '+' : '';
    texto += `\n${variacion >= 0 ? '🟢' : '🔴'} ${signo}${variacion.toFixed(1)}% respecto al mes anterior a esta altura`;
  }

  return texto;
}

async function revisarResumenDiario() {
  if (!TELEGRAM_CHAT_ID_RESUMEN) return;
  const hoy = fechaHoyAR();
  if (data.resumen_ultima_fecha_enviada === hoy) return; // ya se mandó hoy
  if (horaAhoraAR() < HORA_DE_CORTE) return; // todavía no es la hora

  const texto = armarTextoResumenPeriodo(data.resumen_periodo || resumenPeriodoVacio());
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID_RESUMEN, text: texto });

  data.resumen_periodo = resumenPeriodoVacio(); // arrancamos de cero para las próximas 24hs
  data.resumen_ultima_fecha_enviada = hoy;
  await saveData(data);
  console.log('📊 Resumen diario enviado.');
}

async function revisarTodo() {
  await revisarPreguntasNuevas();
  await revisarVentasNuevas();
  await revisarReclamosNuevos();
  await revisarStockBajo();
  await revisarResumenDiario();
  await revisarEtiquetasYVentas();
}

// =====================================================================
// Recibir la respuesta que el vendedor escribe en Telegram, y
// publicarla en la cuenta de Mercado Libre correspondiente.
// =====================================================================

app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200);

  const message = req.body.message;
  if (!message || !message.reply_to_message || !message.text) return;

  const repliedId = message.reply_to_message.message_id;
  const pendiente = data.pending[repliedId];
  if (!pendiente) return;

  const { cuentaId, questionId } = pendiente;

  try {
    const token = await getAccessToken(cuentaId);

    await axios.post(
      'https://api.mercadolibre.com/answers',
      { question_id: questionId, text: message.text },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    delete data.pending[repliedId];
    await saveData(data);

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: message.chat.id,
      text: '✅ Respuesta enviada correctamente a Mercado Libre.',
    });
  } catch (err) {
    console.error('Error respondiendo pregunta:', err.response?.data || err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: message.chat.id,
      text: '❌ Hubo un error al enviar la respuesta a Mercado Libre. Probá de nuevo en un momento.',
    });
  }
});

// (Ya no usamos webhooks de Mercado Libre para nada, pero dejamos esta
// ruta por si en el futuro se quiere volver a usar / probar.)
app.post('/ml/notifications', async (req, res) => {
  res.sendStatus(200);
  console.log('📩 Notificación recibida de Mercado Libre:', JSON.stringify(req.body));
});

// =====================================================================
// HERRAMIENTAS DE DIAGNÓSTICO
// =====================================================================

app.get('/debug/accounts', (req, res) => {
  const cuentas = Object.entries(data.cuentas || {}).map(([id, c]) => ({
    id,
    nombre: c.nombre,
    conectada: !!c.refresh_token,
  }));
  res.json(cuentas);
});

app.get('/debug/state', async (req, res) => {
  const fresh = await loadData();
  const resumen = (d) =>
    Object.entries(d.cuentas || {}).map(([id, c]) => ({
      id,
      nombre: c.nombre,
      tiene_refresh_token: !!c.refresh_token,
      expira_en_minutos: Math.round((c.expires_at - Date.now()) / 60000),
    }));
  res.json({
    en_memoria_del_servidor: resumen(data),
    guardado_en_upstash: resumen(fresh),
  });
});

app.get('/debug/list-questions', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  try {
    const token = await getAccessToken(cuentaId);
    const response = await axios.get('https://api.mercadolibre.com/my/received_questions/search', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const preguntas = (response.data.questions || []).map((q) => ({ id: q.id, estado: q.status, texto: q.text }));
    res.json(preguntas);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get('/debug/simulate-question', async (req, res) => {
  const { id } = req.query;
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  if (!id) return res.status(400).send('Falta el parámetro id. Ejemplo: /debug/simulate-question?id=5036111111&cuenta=123');
  try {
    const resultado = await procesarPregunta(cuentaId, `/questions/${id}`, { ignorarEstado: true });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get('/debug/list-orders', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  try {
    const token = await getAccessToken(cuentaId);
    const response = await axios.get('https://api.mercadolibre.com/orders/search', {
      params: { seller: cuentaId, 'order.status': 'paid', sort: 'date_desc', limit: 10 },
      headers: { Authorization: `Bearer ${token}` },
    });
    const ordenes = (response.data.results || []).map((o) => ({
      id: o.id,
      comprador: o.buyer?.nickname,
      total: o.total_amount,
      fecha: o.date_created,
    }));
    res.json(ordenes);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get('/debug/simulate-order', async (req, res) => {
  const { id } = req.query;
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  if (!id) return res.status(400).send('Falta el parámetro id. Ejemplo: /debug/simulate-order?id=2000018126310134&cuenta=123');
  try {
    const token = await getAccessToken(cuentaId);
    const { data: orden } = await axios.get(`https://api.mercadolibre.com/orders/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const productos = (orden.order_items || []).map((it) => `• ${it.quantity} x ${it.item.title}`).join('\n');
    const comprador = orden.buyer?.nickname || 'Comprador';
    const total = formatearMoneda(orden.total_amount, orden.currency_id);
    const tipoEnvio = await obtenerTipoEnvio(token, orden.shipping?.id);
    const cuenta = data.cuentas[cuentaId];
    const texto =
      `🏪 Cuenta: ${cuenta.nombre}\n\n` +
      `💰 ¡Nueva venta! (prueba)\n\n` +
      `🧾 Orden: ${orden.id}\n` +
      `👤 Comprador: ${comprador}\n` +
      `📦 Producto(s):\n${productos}\n\n` +
      `🚚 Envío: ${tipoEnvio}\n` +
      `💵 Total: ${total}`;
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatDe(cuenta), text: texto });

    if (!data.resumen_periodo) data.resumen_periodo = resumenPeriodoVacio();
    data.resumen_periodo.totales[cuentaId] = (data.resumen_periodo.totales[cuentaId] || 0) + Number(orden.total_amount);
    if (tipoEnvio === 'Flex') data.resumen_periodo.flex++;
    else if (tipoEnvio === 'Normal') data.resumen_periodo.normal++;
    else data.resumen_periodo.otros++;
    agregarVentaPorDia(orden.date_created, Number(orden.total_amount));
    await saveData(data);

    res.json({ ok: true, tipoEnvio });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Prueba directa del chat de resumen combinado, sin pasar por ninguna
// venta. Sirve para confirmar si la variable TELEGRAM_CHAT_ID_RESUMEN
// está bien cargada y el bot puede mandarle mensajes a ese chat.
app.get('/debug/test-resumen', async (req, res) => {
  if (!TELEGRAM_CHAT_ID_RESUMEN) {
    return res.status(400).json({ error: 'La variable TELEGRAM_CHAT_ID_RESUMEN no está configurada en Render.' });
  }
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID_RESUMEN,
      text: '✅ Prueba: este mensaje debería aparecer en el grupo de resumen combinado.',
    });
    res.json({ ok: true, chat_id_usado: TELEGRAM_CHAT_ID_RESUMEN });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Muestra (sin mandar nada a Telegram) cómo va el acumulado del
// período actual (desde el último resumen enviado).
app.get('/debug/resumen-diario', (req, res) => {
  res.json({
    periodo_actual: data.resumen_periodo || resumenPeriodoVacio(),
    ultima_fecha_enviada: data.resumen_ultima_fecha_enviada,
    hora_de_corte: HORA_DE_CORTE,
    hora_actual_argentina: horaAhoraAR(),
  });
});

// Manda el resumen a Telegram ahora mismo, sin esperar a las 12:00,
// para poder ver cómo queda el mensaje. OJO: esto NO reinicia el
// acumulado ni marca el día como "ya enviado" (es solo una previsualización).
app.get('/debug/test-resumen-diario', async (req, res) => {
  if (!TELEGRAM_CHAT_ID_RESUMEN) {
    return res.status(400).json({ error: 'La variable TELEGRAM_CHAT_ID_RESUMEN no está configurada en Render.' });
  }
  const texto = armarTextoResumenPeriodo(data.resumen_periodo || resumenPeriodoVacio());
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID_RESUMEN, text: `${texto}\n\n(prueba manual, no reinicia el acumulado)` });
  res.json({ ok: true });
});

// Muestra el acumulado del mes en curso a la fecha, y el del mes
// anterior a la misma altura.
app.get('/debug/mes-actual', (req, res) => {
  res.json({
    este_mes_a_la_fecha: acumuladoMesHastaHoy(0),
    mes_anterior_a_la_misma_fecha: acumuladoMesHastaHoy(-1),
  });
});

// Muestra el detalle día por día que el bot tiene guardado.
app.get('/debug/ventas-por-dia', (req, res) => {
  res.json(data.ventas_por_dia || {});
});

app.get('/debug/list-claims', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  try {
    const token = await getAccessToken(cuentaId);
    const response = await axios.get('https://api.mercadolibre.com/marketplace/v2/claims/search', {
      params: { user_id: cuentaId, status: 'opened', sort: 'last_updated:desc' },
      headers: { Authorization: `Bearer ${token}` },
    });
    const reclamos = (response.data.data || []).map((r) => ({
      id: r.id,
      tipo: r.type,
      estado: r.status,
      etapa: r.stage,
      orden: r.resource_id,
    }));
    res.json(reclamos);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get('/debug/list-stock', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  try {
    const token = await getAccessToken(cuentaId);
    const { data: idsResponse } = await axios.get(
      `https://api.mercadolibre.com/users/${cuentaId}/items/search`,
      { params: { status: 'active', limit: 100 }, headers: { Authorization: `Bearer ${token}` } }
    );
    const itemIds = idsResponse.results || [];
    const resultado = [];
    for (const grupo of partirEnGrupos(itemIds, 20)) {
      const { data: items } = await axios.get('https://api.mercadolibre.com/items', {
        params: { ids: grupo.join(','), attributes: 'id,title,available_quantity' },
        headers: { Authorization: `Bearer ${token}` },
      });
      for (const { body: item } of items) {
        if (!item) continue;
        resultado.push({
          id: item.id,
          titulo: item.title,
          stock: item.available_quantity,
          en_alerta: !!(data.cuentas[cuentaId].stock_alertado && data.cuentas[cuentaId].stock_alertado[item.id]),
        });
      }
    }
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get('/debug/feeds', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  try {
    const token = await getAccessToken(cuentaId);
    const response = await axios.get('https://api.mercadolibre.com/missed_feeds', {
      params: { app_id: ML_CLIENT_ID },
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Las cuentas migradas del formato viejo quedaron con un nombre
// genérico ("Cuenta 12345"), porque en ese momento no teníamos forma
// de saber su apodo real. Lo buscamos una sola vez.
async function corregirNombresGenericos() {
  for (const cuentaId of Object.keys(data.cuentas || {})) {
    const cuenta = data.cuentas[cuentaId];
    if (cuenta.nombre !== `Cuenta ${cuentaId}`) continue; // ya tiene un nombre real
    try {
      const token = await getAccessToken(cuentaId);
      const { data: usuario } = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      cuenta.nombre = usuario.nickname || cuenta.nombre;
      await saveData(data);
      console.log(`✏️ Nombre actualizado para la cuenta ${cuentaId}: ${cuenta.nombre}`);
    } catch (err) {
      console.error(`No se pudo actualizar el nombre de la cuenta ${cuentaId}:`, err.response?.data || err.message);
    }
  }
}

// =====================================================================
// ETIQUETAS + PLANILLA DE VENTAS (agregado)
// =====================================================================

const {
  GOOGLE_SERVICE_ACCOUNT_B64,
  GOOGLE_SHEET_ID,
  GOOGLE_SHEET_TAB = 'Hoja 1',
  HORA_ETIQUETAS_VENTAS = '09:00',
  DIAS_VENTANA_ETIQUETAS_VENTAS = '3',
  PLANILLA_VENTAS_ACTIVA,
  EXPORT_VENTAS_ACTIVA: EXPORT_VENTAS_ACTIVA_RAW,
} = process.env;

const VENTANA_DIAS = Number(DIAS_VENTANA_ETIQUETAS_VENTAS) || 3;

// Interruptor para pausar SOLO la carga automática a la planilla de
// Google Sheets, sin tocar nada de las etiquetas (que siguen andando
// igual). Por defecto queda APAGADA: hay que poner la variable de
// entorno PLANILLA_VENTAS_ACTIVA=si en Render para volver a prenderla
// más adelante.
const PLANILLA_ACTIVA = ['si', 'sí', 'true', '1'].includes(
  (PLANILLA_VENTAS_ACTIVA || '').toLowerCase().trim()
);

// =====================================================================
// EXPORT DIARIO DE VENTAS A EXCEL (para pegar a mano en la planilla
// local de control de stock) - equivalencias revisadas y aprobadas
// por el usuario.
// =====================================================================

// Interruptor para prender el export diario de ventas a Excel por
// Telegram. Por defecto queda APAGADO: hay que poner la variable de
// entorno EXPORT_VENTAS_ACTIVA=si en Render cuando se confirme que
// /debug/test-excel-ventas da un archivo correcto. Esto no toca para
// nada la planilla de Google Sheets (PLANILLA_ACTIVA) ni las
// etiquetas: es un feature aparte y completamente independiente.
const EXPORT_VENTAS_ACTIVA = ['si', 'sí', 'true', '1'].includes(
  (EXPORT_VENTAS_ACTIVA_RAW || '').toLowerCase().trim()
);

// Orden exacto de las 27 columnas de producto en la planilla local
// del usuario (VentasSkin, columnas C a AC). Tiene que coincidir
// EXACTAMENTE con ese orden para que el export se pueda pegar tal
// cual sin tener que reacomodar columnas a mano.
const CODES = [
  '30G', '32G', '34G', 'Jeringa', 'C Nano', 'C 12', 'C 24', 'C 36', 'C 42', 'C 25/50',
  'C 22/50', 'C 22/70', 'C 23/50', 'C 23/70', 'Can23/50 S', 'C 27/38', 'C18/50', 'C16/100',
  'MN 34g', 'Nokor', 'Butt 21G', 'Butt 22G', 'But23G', 'MasK', 'DrPen', '2Vias', '12P',
];

// Tabla de equivalencias publicación/variación de Mercado Libre →
// columna de la planilla local + cuántas unidades reales baja del
// stock cada "1 venta" de ese listado (packs). Armada a partir del
// listado completo de las 3 cuentas y revisada y corregida a mano por
// el usuario (versión aprobada: "esta perfecta").
//
// Clave: "ITEM_ID" para publicaciones sin variantes, o
// "ITEM_ID:VARIATION_ID" para publicaciones con variantes.
// { manual: true } = no es un insumo mapeable automáticamente (por
// ejemplo, un link de pago de Mercado Pago) - esas ventas quedan
// siempre en la hoja "Revisar a mano" del export.
const MAPEO_PRODUCTOS = {
  'MLA2415985134': { columna: 'C 23/50', pack: 5 },
  'MLA2141605102': { columna: 'Jeringa', pack: 100 },
  'MLA2141553436': { columna: '34G', pack: 100 },
  'MLA2141553908:197707086961': { columna: 'C18/50', pack: 20 },
  'MLA2141553908:188657353129': { columna: 'C 22/70', pack: 20 },
  'MLA2141553908:188657353131': { columna: 'C 22/50', pack: 20 },
  'MLA2141553908:188657353133': { columna: 'C 23/50', pack: 20 },
  'MLA2141553908:188657353135': { columna: 'C 25/50', pack: 20 },
  'MLA2141553908:201116672175': { columna: 'C 27/38', pack: 20 },
  'MLA2141205686': { columna: '32G', pack: 100 },
  'MLA2161024258:188836181241': { columna: 'C 36', pack: 10 },
  'MLA2161024258:197009243101': { columna: 'C 12', pack: 10 },
  'MLA2161024258:188836181243': { columna: 'C 42', pack: 10 },
  'MLA2161024258:188836181239': { columna: 'C 24', pack: 10 },
  'MLA2161024258:197009243103': { columna: 'C Nano', pack: 10 },
  'MLA1512311255': { columna: '30G', pack: 100 },
  'MLA1510172985': { columna: 'C 23/70', pack: 50 },
  'MLA1510097825': { columna: 'C 23/70', pack: 20 },
  'MLA2413123784': { columna: 'C 22/50', pack: 5 },
  'MLA1516475975:197650190241': { columna: 'C18/50', pack: 50 },
  'MLA1516475975:189987343961': { columna: 'C 22/50', pack: 50 },
  'MLA1516475975:189987343957': { columna: 'C 22/70', pack: 50 },
  'MLA1516475975:189987343959': { columna: 'C 23/50', pack: 50 },
  'MLA1516475975:189987343963': { columna: 'C 25/50', pack: 50 },
  'MLA1516475975:201128292043': { columna: 'C 27/38', pack: 50 },
  'MLA2416116974': { columna: 'C 22/50', pack: 10 },
  'MLA2416101852': { columna: 'C 25/50', pack: 5 },
  'MLA2180199320': { columna: 'C 23/70', pack: 100 },
  'MLA2415989012': { columna: '30G', pack: 10 },
  'MLA2416013372': { columna: 'C 22/70', pack: 10 },
  'MLA2416143484': { columna: 'C 23/70', pack: 10 },
  'MLA2416062938': { columna: 'C 22/70', pack: 5 },
  'MLA2416052324': { columna: 'C 23/50', pack: 10 },
  'MLA1568067257': { columna: '32G', pack: 10 },
  'MLA1561950289': { columna: 'Butt 22G', pack: 10 },
  'MLA2998760688': { columna: 'C18/50', pack: 5 },
  'MLA2964207626': { columna: 'MN 34g', pack: 5 },
  'MLA2470199678': { columna: 'Butt 21G', pack: 10 },
  'MLA2424512590': { columna: 'Butt 21G', pack: 100 },
  'MLA2424822464': { columna: 'Butt 22G', pack: 100 },
  'MLA1561941139': { columna: 'Nokor', pack: 10 },
  'MLA3011828862': { columna: 'C16/100', pack: 10 },
  'MLA2470238340': { columna: 'But23G', pack: 50 },
  'MLA1687003747': { columna: 'MN 34g', pack: 10 },
  'MLA2470084364': { columna: 'But23G', pack: 10 },
  'MLA3011906406': { columna: 'C16/100', pack: 5 },
  'MLA1568041407': { columna: '34G', pack: 10 },
  'MLA2470277284': { columna: 'Butt 21G', pack: 50 },
  'MLA2424641412': { columna: 'But23G', pack: 100 },
  'MLA2999163142': { columna: 'C18/50', pack: 10 },
  'MLA2496547346': { columna: 'Nokor', pack: 12 },
  'MLA1561950235': { columna: 'Butt 22G', pack: 50 },
  'MLA1595904783': { columna: 'MasK', pack: 5 },
  'MLA1810228721': { columna: 'C 25/50', pack: 10 },
  'MLA1810335647': { columna: 'C 23/50', pack: 10 },
  'MLA1810335649': { columna: 'C 22/50', pack: 10 },
  'MLA1726305315': { columna: 'C 36', pack: 5 },
  'MLA3392749642': { columna: 'C 27/38', pack: 5 },
  'MLA3273596172': { columna: 'Jeringa', pack: 10 },
  'MLA3250189400': { columna: 'C 27/38', pack: 5 },
  'MLA3250176474': { columna: 'C 27/38', pack: 10 },
  'MLA3392251534': { columna: 'C18/50', pack: 10 },
  'MLA1810303075': { columna: 'C 22/50', pack: 5 },
  'MLA3392749644': { columna: 'C 25/50', pack: 5 },
  'MLA1810327667': { columna: 'C 22/70', pack: 5 },
  'MLA1810322791': { columna: 'C 27/38', pack: 10 },
  'MLA3118250768': { columna: 'C 24', pack: 5 },
  'MLA3118239220': { columna: 'C 42', pack: 5 },
  'MLA1726304917': { columna: 'C 12', pack: 5 },
  'MLA1810297991': { columna: 'C 22/70', pack: 10 },
  'MLA3118197410': { columna: 'C Nano', pack: 5 },
  'MLA1810303073': { columna: 'C 23/50', pack: 5 },
  'MLA1810326859': { columna: 'C18/50', pack: 5 },
  'MLA3898110116': { columna: '12P', pack: 5 },
  'MLA2052019001': { columna: '2Vias', pack: 4 },
  'MLA2052019291': { columna: '2Vias', pack: 8 },
  'MLA3592586320': { columna: 'MasK', pack: 5 },
  'MLA3971339976': { columna: 'DrPen', pack: 1 },
  'MLA3897984406': { columna: '12P', pack: 1 },
  'MLA2341199946': { manual: true },
  'MLA2141643736': { columna: '32G', pack: 100 },
  'MLA2341251846': { manual: true },
  'MLA2341239088': { columna: 'C 23/70', pack: 20 },
  'MLA2341277942': { columna: '32G', pack: 100 },
  'MLA1508863369': { columna: '34G', pack: 100 },
  'MLA2340941506': { columna: '30G', pack: 100 },
  'MLA2340941498': { columna: '34G', pack: 100 },
  'MLA3029905850': { columna: 'Butt 22G', pack: 50 },
  'MLA3118199112': { columna: 'C 24', pack: 10 },
  'MLA3118199330': { columna: 'C 36', pack: 10 },
  'MLA3118247562': { columna: 'C Nano', pack: 10 },
  'MLA2406711990': { columna: '30G', pack: 100 },
  'MLA3064997222': { columna: '34G', pack: 10 },
  'MLA3118253116': { columna: 'C 42', pack: 10 },
  'MLA1648703271': { columna: 'Butt 22G', pack: 100 },
  'MLA2881093632': { columna: 'C 12', pack: 10 },
  'MLA1648881451': { columna: 'But23G', pack: 100 },
  'MLA1648945581': { columna: 'Butt 21G', pack: 100 },
  'MLA1707927305': { columna: '32G', pack: 10 },
  'MLA3029843806': { columna: 'But23G', pack: 50 },
  'MLA3064404608': { columna: '30G', pack: 10 },
  'MLA3249147600': { columna: 'Butt 21G', pack: 50 },
  'MLA3631411530': { columna: 'But23G', pack: 10 },
  'MLA3631411532': { columna: 'C18/50', pack: 20 },
  'MLA3631411550': { columna: '34G', pack: 100 },
  'MLA3631411552': { columna: 'MasK', pack: 5 },
  'MLA3631411536': { columna: 'C 23/50', pack: 5 },
  'MLA3631411522': { columna: 'C 12', pack: 5 },
  'MLA3631411570': { columna: 'MN 34g', pack: 5 },
  'MLA3631411512': { columna: 'Butt 21G', pack: 50 },
  'MLA3631411538': { columna: '30G', pack: 10 },
  'MLA3631411542': { columna: 'C18/50', pack: 5 },
  'MLA1906041691': { columna: 'C18/50', pack: 10 },
  'MLA3631411568': { columna: 'C 22/70', pack: 10 },
  'MLA3631411558': { columna: 'C 36', pack: 5 },
  'MLA3631411544': { columna: 'Butt 22G', pack: 10 },
  'MLA3631411560': { columna: 'C 22/70', pack: 5 },
  'MLA3631411510': { columna: 'But23G', pack: 100 },
  'MLA3631411528': { columna: 'C 22/50', pack: 5 },
  'MLA3631411516': { columna: '30G', pack: 100 },
  'MLA1906041693': { columna: 'Butt 21G', pack: 10 },
  'MLA1905871791': { columna: '32G', pack: 100 },
  'MLA1906041649': { columna: '34G', pack: 10 },
  'MLA1905871759': { columna: 'C 25/50', pack: 5 },
  'MLA1905871777': { columna: 'Nokor', pack: 10 },
  'MLA1905871773': { columna: 'C 27/38', pack: 5 },
  'MLA1905871781': { columna: 'C 27/38', pack: 10 },
  'MLA1906041687': { columna: 'Butt 22G', pack: 50 },
  'MLA1906041677': { columna: 'C 23/70', pack: 10 },
  'MLA1906041671': { columna: '32G', pack: 10 },
  'MLA1905871805': { columna: 'C16/100', pack: 10 },
  'MLA1905871779': { columna: 'Butt 21G', pack: 100 },
  'MLA1906041665': { columna: 'But23G', pack: 50 },
  'MLA1905871761': { columna: 'Jeringa', pack: 10 },
  'MLA1906041673': { columna: 'C18/50', pack: 5 },
  'MLA1906041663': { columna: 'C 22/50', pack: 10 },
  'MLA1906041679': { columna: 'C 24', pack: 5 },
  'MLA1906041647': { columna: 'C 42', pack: 5 },
  'MLA1906041653': { columna: 'C18/50', pack: 10 },
  'MLA1905871785': { columna: 'C16/100', pack: 5 },
  'MLA1905871771': { columna: 'Jeringa', pack: 100 },
  'MLA3635812634': { columna: 'C 23/50', pack: 10 },
  'MLA3636238676': { columna: 'Butt 22G', pack: 100 },
  'MLA1907796821': { columna: 'C 22/50', pack: 10 },
  'MLA1907850203': { columna: 'C 22/50', pack: 20 },
  'MLA3635556580': { columna: 'C 12', pack: 10 },
  'MLA1905871749': { columna: 'C 23/50', pack: 10 },
  'MLA1905871753': { columna: 'MN 34g', pack: 10 },
  'MLA3635543256': { columna: 'C 36', pack: 10 },
  'MLA3635540728': { columna: 'C Nano', pack: 5 },
  'MLA1907795419': { columna: 'C 27/38', pack: 20 },
  'MLA1907848909': { columna: 'C 22/70', pack: 5 },
  'MLA1907808399': { columna: 'C 22/70', pack: 20 },
  'MLA1907848905': { columna: 'C 25/50', pack: 5 },
  'MLA1907850201': { columna: 'C 23/50', pack: 20 },
  'MLA1907848907': { columna: 'C 22/50', pack: 5 },
  'MLA1907794117': { columna: 'C 23/50', pack: 5 },
  'MLA1907795417': { columna: 'C 25/50', pack: 20 },
  'MLA3635812636': { columna: 'C 27/38', pack: 10 },
  'MLA1907806991': { columna: 'C 27/38', pack: 5 },
  'MLA1907797663': { columna: 'C 25/50', pack: 10 },
  'MLA2051999525': { columna: '2Vias', pack: 4 },
  'MLA2052019989': { columna: '2Vias', pack: 8 },
  'MLA2106882457': { columna: 'DrPen', pack: 1 },
  'MLA3898136142': { columna: '12P', pack: 1 },
  'MLA3898112004': { columna: '12P', pack: 5 },
  'MLA1907715929': { columna: 'C Nano', pack: 10 },
  'MLA1907784769': { columna: 'C 22/70', pack: 10 },
  'MLA1907714467': { columna: 'C 42', pack: 10 },
  'MLA1907715179': { columna: 'C 24', pack: 10 },
};

// A partir de una orden de Mercado Libre, resuelve cuántas unidades
// reales hay que descontar de cada columna de producto (ya aplicando
// el tamaño de pack: si vendió 1 "pack x5", descuenta 5, no 1).
// Si algún item de la orden no está en MAPEO_PRODUCTOS (publicación
// nueva todavía no mapeada) o está marcado { manual: true }, la orden
// entera se marca para revisar a mano, PERO los demás items que sí se
// pudieron resolver igual se suman normalmente.
function resolverProductosOrden(orden) {
  const unidadesPorColumna = {};
  let manual = false;
  const itemsSinResolver = [];

  for (const it of orden.order_items || []) {
    const itemId = it.item?.id;
    const variationId = it.item?.variation_id;
    const clave = variationId ? `${itemId}:${variationId}` : itemId;
    const mapeo = MAPEO_PRODUCTOS[clave];

    if (!mapeo || mapeo.manual) {
      manual = true;
      itemsSinResolver.push({
        item_id: itemId || '',
        variation_id: variationId || '',
        titulo: it.item?.title || '',
        cantidad: it.quantity,
      });
      continue;
    }

    const unidadesReales = it.quantity * (mapeo.pack || 1);
    unidadesPorColumna[mapeo.columna] = (unidadesPorColumna[mapeo.columna] || 0) + unidadesReales;
  }

  return { unidadesPorColumna, manual, itemsSinResolver };
}

// Ventas de hasta VENTANA_DIAS días atrás (para agarrar las que
// llegaron tarde ayer), pero sin traer historial viejo de semanas.
function esVentaReciente(fechaISO) {
  const limite = new Date();
  limite.setDate(limite.getDate() - VENTANA_DIAS);
  return new Date(fechaISO) >= limite;
}

// ---------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------

function credencialesGoogle() {
  if (!GOOGLE_SERVICE_ACCOUNT_B64) return null;
  const json = Buffer.from(GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
  return JSON.parse(json);
}

async function clienteSheets() {
  const credentials = credencialesGoogle();
  if (!credentials) {
    throw new Error('Falta la variable de entorno GOOGLE_SERVICE_ACCOUNT_B64 en Render.');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// Agrega filas al final de la planilla general, respetando EXACTAMENTE
// las 14 columnas (A a N) tal como están hoy:
// ID | Fecha | Nombre | DNI | Teléfono | Dirección(provincia) | Monto |
// Título de la publicación | Unidades | Envío | Flex $ | Flex # | (vacía) | Venta Publicidad
//
// Teléfono, Flex $, Flex # y la columna sin título quedan siempre
// vacías (según lo charlado: no se cargan por API).
async function agregarFilasAPlanilla(filas) {
  if (!filas.length) return;
  const sheets = await clienteSheets();
  const values = filas.map((f) => [
    `'${f.id}`, // el ' al principio obliga a Sheets a guardarlo como texto,
    // así no redondea los últimos dígitos de números de venta largos
    f.fecha,
    f.nombre,
    f.dni,
    '', // Teléfono - no disponible vía API
    f.provincia,
    f.monto,
    f.titulo,
    f.unidades,
    f.envio,
    '', // Flex $
    '', // Flex #
    '', // columna sin título
    f.publicidad,
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${GOOGLE_SHEET_TAB}!A:N`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

// ---------------------------------------------------------------------
// Armar una fila de planilla a partir de una orden de Mercado Libre
// ---------------------------------------------------------------------

async function armarFilaPlanilla(orden, token) {
  const productos = (orden.order_items || []).map((it) => it.item.title).join('; ');
  const unidades = (orden.order_items || []).reduce((suma, it) => suma + it.quantity, 0);

  let nombre = orden.buyer?.nickname || '';
  let dni = '';
  try {
    // Datos de facturación (nombre real / DNI), si la cuenta tiene
    // permiso de "Facturación al comprador". Si falla, seguimos sin
    // frenar el resto del proceso.
    const { data: fact } = await axios.get(
      `https://api.mercadolibre.com/orders/${orden.id}/billing_info`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (fact?.billing_info?.doc_number) dni = fact.billing_info.doc_number;
    if (fact?.billing_info?.name) {
      nombre = `${fact.billing_info.name} ${fact.billing_info.last_name || ''}`.trim();
    }
  } catch (err) {
    console.error(`(planilla) No se pudo traer facturación de la orden ${orden.id}:`, err.response?.data || err.message);
  }

  let provincia = '';
  if (orden.shipping?.id) {
    try {
      const { data: envio } = await axios.get(`https://api.mercadolibre.com/shipments/${orden.shipping.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      provincia = envio.receiver_address?.state?.name || '';
    } catch (err) {
      console.error(`(planilla) No se pudo traer envío de la orden ${orden.id}:`, err.response?.data || err.message);
    }
  }

  const tipoEnvio = await obtenerTipoEnvio(token, orden.shipping?.id);

  return {
    id: orden.id,
    fecha: new Intl.DateTimeFormat('es-AR', {
      timeZone: ZONA_HORARIA,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(orden.date_created)),
    nombre,
    dni,
    provincia,
    monto: orden.total_amount,
    titulo: productos,
    unidades,
    envio: tipoEnvio,
    // Mercado Libre no expone de forma confiable si una venta vino de
    // publicidad; queda vacío a propósito en vez de adivinar.
    publicidad: '',
  };
}

// ---------------------------------------------------------------------
// Etiquetas: bajar y combinar en un solo PDF
// ---------------------------------------------------------------------

async function combinarPDFs(buffers) {
  const pdfFinal = await PDFDocument.create();
  for (const buf of buffers) {
    const pdf = await PDFDocument.load(buf);
    const paginas = await pdfFinal.copyPages(pdf, pdf.getPageIndices());
    paginas.forEach((p) => pdfFinal.addPage(p));
  }
  return Buffer.from(await pdfFinal.save());
}

async function enviarPDFPorTelegram(chatId, buffer, nombreArchivo, caption) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('document', buffer, { filename: nombreArchivo, contentType: 'application/pdf' });
  await axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders() });
}

// ---------------------------------------------------------------------
// Export de ventas a Excel (listo para pegar a mano en la planilla local)
// ---------------------------------------------------------------------

async function enviarExcelPorTelegram(chatId, buffer, nombreArchivo, caption) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('document', buffer, {
    filename: nombreArchivo,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  await axios.post(`${TELEGRAM_API}/sendDocument`, form, { headers: form.getHeaders() });
}

// Arma el archivo .xlsx del día: una hoja "Ventas" ya en el mismo
// orden de columnas que la planilla local del usuario (lista para
// copiar y pegar), y una hoja "Revisar a mano" con las órdenes que
// tienen algún item sin mapear (publicación nueva, o el link de pago
// de Mercado Pago), para que esas no se pierdan ni se carguen mal.
async function crearExcelVentas(filasVentas, filasRevisar) {
  const wb = new ExcelJS.Workbook();

  const hojaVentas = wb.addWorksheet('Ventas');
  hojaVentas.columns = [
    { header: 'Fecha', key: 'fecha', width: 18 },
    { header: 'Cuenta', key: 'cuenta', width: 16 },
    { header: 'Nombre', key: 'nombre', width: 22 },
    ...CODES.map((c) => ({ header: c, key: c, width: 10 })),
    { header: 'Monto', key: 'monto', width: 12 },
    { header: 'N° de venta', key: 'id', width: 16 },
  ];
  hojaVentas.getRow(1).font = { bold: true };
  hojaVentas.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F3864' },
  };
  hojaVentas.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const f of filasVentas) {
    const fila = { fecha: f.fecha, cuenta: f.cuenta, nombre: f.nombre, monto: f.monto, id: f.id };
    for (const c of CODES) fila[c] = f.unidadesPorColumna[c] || '';
    hojaVentas.addRow(fila);
  }

  const hojaRevisar = wb.addWorksheet('Revisar a mano');
  hojaRevisar.columns = [
    { header: 'Fecha', key: 'fecha', width: 18 },
    { header: 'Cuenta', key: 'cuenta', width: 16 },
    { header: 'N° de venta', key: 'id', width: 16 },
    { header: 'Publicación (item_id)', key: 'item_id', width: 18 },
    { header: 'Variación', key: 'variation_id', width: 16 },
    { header: 'Título', key: 'titulo', width: 45 },
    { header: 'Cantidad vendida', key: 'cantidad', width: 16 },
  ];
  hojaRevisar.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hojaRevisar.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB45309' } };

  for (const f of filasRevisar) {
    for (const it of f.itemsSinResolver) {
      hojaRevisar.addRow({
        fecha: f.fecha,
        cuenta: f.cuenta,
        id: f.id,
        item_id: it.item_id,
        variation_id: it.variation_id,
        titulo: it.titulo,
        cantidad: it.cantidad,
      });
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ---------------------------------------------------------------------
// Corrida diaria: recorre las 3 cuentas, arma la planilla y las etiquetas
// ---------------------------------------------------------------------

// Candado para que nunca haya dos corridas al mismo tiempo (por
// ejemplo el chequeo automático de cada 1 minuto solapándose con una
// prueba manual desde /debug/run-etiquetas-ventas). Sin esto, dos
// corridas en simultáneo pueden terminar escribiendo las mismas
// ventas dos veces en la planilla.
let etiquetasVentasEnCurso = false;

async function corridaDiariaEtiquetasYVentas({ forzar = false } = {}) {
  const hoy = fechaHoyAR();
  if (!forzar && data.etiquetas_ventas_ultima_fecha === hoy) {
    return { ok: true, motivo: 'Ya se había corrido hoy.', filas: 0, etiquetas: 0 };
  }
  if (etiquetasVentasEnCurso) {
    return { ok: true, motivo: 'Ya hay una corrida en curso, se saltea esta.', filas: 0, etiquetas: 0 };
  }
  etiquetasVentasEnCurso = true;

  try {
    return await ejecutarCorridaDiariaEtiquetasYVentas({ forzar, hoy });
  } finally {
    etiquetasVentasEnCurso = false;
  }
}

async function ejecutarCorridaDiariaEtiquetasYVentas({ forzar, hoy }) {
  const buffersEtiquetas = [];
  const filasPlanilla = [];
  const marcasPendientes = []; // { cuenta, ordenId } - se confirman solo si la planilla se escribe bien
  const filasExport = []; // filas para la hoja "Ventas" del Excel del día
  const filasRevisar = []; // órdenes con algún item sin mapear, para la hoja "Revisar a mano"
  const marcasExportPendientes = []; // { cuenta, ordenId } - se confirman solo si el Excel se manda bien
  let huboError = false;

  for (const cuentaId of Object.keys(data.cuentas || {})) {
    const cuenta = data.cuentas[cuentaId];
    if (!cuenta.refresh_token) continue;
    if (!Array.isArray(cuenta.etiquetas_generadas)) cuenta.etiquetas_generadas = [];
    if (!Array.isArray(cuenta.filas_planilla_cargadas)) cuenta.filas_planilla_cargadas = [];
    // Tracking PROPIO para el export a Excel, separado a propósito de
    // filas_planilla_cargadas (que es del feature viejo de Google
    // Sheets, hoy pausado) para que un feature no contamine al otro.
    if (!Array.isArray(cuenta.filas_export_cargadas)) cuenta.filas_export_cargadas = [];

    try {
      const token = await getAccessToken(cuentaId);

      const { data: resp } = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: { seller: cuentaId, 'order.status': 'paid', sort: 'date_desc', limit: 50 },
        headers: { Authorization: `Bearer ${token}` },
      });
      // Ya no filtramos "solo las ventas de HOY" (para no perder una
      // venta que llegó tarde a la noche), pero tampoco traemos
      // historial viejo sin límite: nos quedamos con los últimos
      // VENTANA_DIAS días. Lo que evita repetir una misma venta ya
      // procesada es que su ID está guardado en
      // filas_planilla_cargadas / etiquetas_generadas, no la fecha.
      const ordenesPendientes = (resp.results || []).filter((o) => esVentaReciente(o.date_created));

      // --- Filas nuevas para la planilla ---
      // OJO: acá NO marcamos todavía la orden como "ya cargada". Se
      // marca recién más abajo, después de que agregarFilasAPlanilla()
      // haya escrito bien en Google Sheets. Si el guardado en la
      // planilla falla, estas ventas quedan pendientes y se
      // reintentan solas en la corrida siguiente, en vez de perderse
      // en silencio (esto es justo lo que pasó: las etiquetas se
      // generaron pero la planilla falló, y las ventas quedaban
      // marcadas como "hechas" igual).
      if (PLANILLA_ACTIVA) {
        for (const orden of ordenesPendientes) {
          if (cuenta.filas_planilla_cargadas.includes(orden.id)) continue;
          try {
            const fila = await armarFilaPlanilla(orden, token);
            filasPlanilla.push(fila);
            marcasPendientes.push({ cuenta, ordenId: orden.id });
          } catch (err) {
            console.error(`Error armando fila de planilla (orden ${orden.id}):`, err.response?.data || err.message);
            huboError = true;
          }
        }
      }

      // --- Filas nuevas para el export a Excel (feature nuevo, ---
      // --- independiente de la planilla de Google Sheets) ---
      // Igual que con la planilla, no se marca la orden como "ya
      // exportada" acá: se marca más abajo, solo si el Excel se llega
      // a mandar bien por Telegram. Si falla el envío, estas ventas
      // quedan pendientes y se reintentan solas en la corrida
      // siguiente.
      if (EXPORT_VENTAS_ACTIVA) {
        for (const orden of ordenesPendientes) {
          if (cuenta.filas_export_cargadas.includes(orden.id)) continue;
          try {
            const { unidadesPorColumna, manual, itemsSinResolver } = resolverProductosOrden(orden);
            const filaBase = {
              id: orden.id,
              cuenta: cuenta.nombre || cuentaId,
              fecha: new Intl.DateTimeFormat('es-AR', {
                timeZone: ZONA_HORARIA,
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              }).format(new Date(orden.date_created)),
              nombre: orden.buyer?.nickname || '',
              monto: orden.total_amount,
            };
            if (Object.keys(unidadesPorColumna).length) {
              filasExport.push({ ...filaBase, unidadesPorColumna });
            }
            if (manual) {
              filasRevisar.push({ ...filaBase, itemsSinResolver });
            }
            marcasExportPendientes.push({ cuenta, ordenId: orden.id });
          } catch (err) {
            console.error(`Error resolviendo productos del export (orden ${orden.id}):`, err.response?.data || err.message);
            huboError = true;
          }
        }
      }

      // --- Etiquetas nuevas para imprimir ---
      // Antes de meter una etiqueta en el PDF del día, le preguntamos a
      // Mercado Libre si ese envío ya figura como "printed" (impreso).
      // Esto pasa también si la imprimiste vos a mano desde la web de
      // Mercado Libre, no solo si la bajó el bot — así evitamos
      // repetirla al día siguiente. Si la consulta falla por algún
      // motivo, la incluimos igual: mejor una etiqueta de más que
      // perder una de verdad.
      const candidatos = ordenesPendientes.filter(
        (o) => o.shipping?.id && !cuenta.etiquetas_generadas.includes(o.shipping.id)
      );

      const shipmentIdsNuevos = [];
      for (const orden of candidatos) {
        const shipmentId = orden.shipping.id;
        try {
          const { data: envio } = await axios.get(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (envio.substatus === 'printed') {
            // Ya estaba impresa (por el bot antes, o a mano en Mercado
            // Libre). La marcamos como generada pero no la volvemos a
            // bajar ni a meter en el PDF.
            cuenta.etiquetas_generadas.push(shipmentId);
            continue;
          }
        } catch (err) {
          console.error(
            `(etiquetas) No se pudo consultar el estado del envío ${shipmentId}:`,
            err.response?.data || err.message
          );
        }
        shipmentIdsNuevos.push(shipmentId);
      }

      for (const grupo of partirEnGrupos(shipmentIdsNuevos, 20)) {
        try {
          const resp2 = await axios.get('https://api.mercadolibre.com/shipment_labels', {
            params: { shipment_ids: grupo.join(','), response_type: 'pdf' },
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'arraybuffer',
          });
          buffersEtiquetas.push(Buffer.from(resp2.data));
          grupo.forEach((id) => cuenta.etiquetas_generadas.push(id));
        } catch (err) {
          console.error(`Error bajando etiquetas de ${cuenta.nombre}:`, err.response?.data || err.message);
          huboError = true;
        }
      }

      await saveData(data);
    } catch (err) {
      console.error(`Error en corrida diaria de ${cuenta.nombre}:`, err.response?.data || err.message);
      huboError = true;
    }
  }

  // Guardar filas en la planilla de Google Sheets. Solo si esto sale
  // bien confirmamos las marcas de "ya cargada" — así, si falla, se
  // reintenta solo en la próxima corrida en vez de perder esas ventas.
  let filasGuardadas = 0;
  if (filasPlanilla.length) {
    try {
      await agregarFilasAPlanilla(filasPlanilla);
      for (const { cuenta, ordenId } of marcasPendientes) {
        cuenta.filas_planilla_cargadas.push(ordenId);
      }
      filasGuardadas = filasPlanilla.length;
      await saveData(data);
    } catch (err) {
      console.error('Error escribiendo en la planilla de Google Sheets:', err.response?.data || err.message);
      huboError = true;
    }
  }

  // Generar y mandar por Telegram el Excel de ventas del día (para
  // pegar a mano en la planilla local). Solo si el envío sale bien
  // marcamos las órdenes como "ya exportadas" - mismo criterio que la
  // planilla de Google Sheets, para no perder ventas si falla el envío.
  let ventasExportadas = 0;
  if (EXPORT_VENTAS_ACTIVA && (filasExport.length || filasRevisar.length)) {
    try {
      const excelBuffer = await crearExcelVentas(filasExport, filasRevisar);
      const avisoRevisar = filasRevisar.length
        ? ` ⚠️ ${filasRevisar.length} venta(s) con algún producto sin mapear - revisar hoja "Revisar a mano".`
        : '';
      await enviarExcelPorTelegram(
        TELEGRAM_CHAT_ID,
        excelBuffer,
        `ventas_${hoy}.xlsx`,
        `🧾 Ventas del ${hoy} - ${filasExport.length} fila(s) lista(s) para pegar en tu planilla.${avisoRevisar}`
      );
      for (const { cuenta, ordenId } of marcasExportPendientes) {
        cuenta.filas_export_cargadas.push(ordenId);
      }
      ventasExportadas = marcasExportPendientes.length;
      await saveData(data);
    } catch (err) {
      console.error('Error generando/mandando el Excel de ventas:', err.response?.data || err.message);
      huboError = true;
    }
  }

  // Combinar y mandar las etiquetas por Telegram
  let pdfEnviado = false;
  if (buffersEtiquetas.length) {
    try {
      const combinado = await combinarPDFs(buffersEtiquetas);
      const avisoPlanilla = !PLANILLA_ACTIVA
        ? 'La carga automática a la planilla está pausada por ahora.'
        : filasGuardadas === filasPlanilla.length
        ? `${filasGuardadas} venta(s) cargada(s) en la planilla.`
        : `⚠️ Ojo: la planilla de Google Sheets falló al guardar (revisar Logs de Render). Las etiquetas sí están OK.`;
      await enviarPDFPorTelegram(
        TELEGRAM_CHAT_ID,
        combinado,
        `etiquetas_${hoy}.pdf`,
        `📦 Etiquetas del ${hoy} — ${avisoPlanilla}`
      );
      pdfEnviado = true;
    } catch (err) {
      console.error('Error combinando/mandando el PDF de etiquetas:', err.response?.data || err.message);
      huboError = true;
    }
  } else if (!forzar && data.etiquetas_ventas_aviso_vacio_fecha !== hoy) {
    // Se avisa una sola vez por día (aunque el proceso se reintente
    // varias veces por algún error en la planilla), para no repetir
    // el mismo mensaje de Telegram cada 1 minuto.
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: `📦 No hay etiquetas nuevas para imprimir hoy (${hoy}).`,
    });
    data.etiquetas_ventas_aviso_vacio_fecha = hoy;
  }

  if (!huboError) data.etiquetas_ventas_ultima_fecha = hoy;
  await saveData(data);

  return {
    ok: !huboError,
    filas: filasGuardadas,
    filasIntentadas: filasPlanilla.length,
    etiquetas: buffersEtiquetas.length,
    pdfEnviado,
    ventasExportadas,
    ventasParaRevisar: filasRevisar.length,
  };
}

// Se llama cada 1 minuto (enganchado desde revisarTodo). Solo actúa
// una vez que pasó la hora configurada, y una sola vez por día.
async function revisarEtiquetasYVentas() {
  if (horaAhoraAR() < HORA_ETIQUETAS_VENTAS) return;
  try {
    const resultado = await corridaDiariaEtiquetasYVentas();
    if (resultado.motivo) return; // ya se había corrido hoy, no hay nada que loguear
    console.log(`📦🧾 Corrida diaria de etiquetas/ventas:`, resultado);
  } catch (err) {
    console.error('Error en revisarEtiquetasYVentas:', err.response?.data || err.message);
  }
}

// ---------------------------------------------------------------------
// Rutas de diagnóstico (etiquetas + planilla)
// ---------------------------------------------------------------------

// Corre todo el proceso ahora mismo (sin esperar a la hora configurada
// ni al chequeo de "ya corrió hoy").
app.get('/debug/run-etiquetas-ventas', async (req, res) => {
  try {
    const resultado = await corridaDiariaEtiquetasYVentas({ forzar: true });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Prueba el export de ventas a Excel SIN tocar ningún estado guardado
// (no marca ninguna orden como "ya exportada", así se puede correr
// las veces que haga falta mientras se revisa que el archivo salga
// bien, antes de prender EXPORT_VENTAS_ACTIVA=si en Render). Junta las
// ventas pagadas de los últimos VENTANA_DIAS días de las 3 cuentas,
// arma el Excel y lo manda por Telegram.
app.get('/debug/test-excel-ventas', async (req, res) => {
  const filasExport = [];
  const filasRevisar = [];
  try {
    for (const cuentaId of Object.keys(data.cuentas || {})) {
      const cuenta = data.cuentas[cuentaId];
      if (!cuenta.refresh_token) continue;
      const token = await getAccessToken(cuentaId);

      const { data: resp } = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: { seller: cuentaId, 'order.status': 'paid', sort: 'date_desc', limit: 50 },
        headers: { Authorization: `Bearer ${token}` },
      });
      const ordenesPendientes = (resp.results || []).filter((o) => esVentaReciente(o.date_created));

      for (const orden of ordenesPendientes) {
        const { unidadesPorColumna, manual, itemsSinResolver } = resolverProductosOrden(orden);
        const filaBase = {
          id: orden.id,
          cuenta: cuenta.nombre || cuentaId,
          fecha: new Intl.DateTimeFormat('es-AR', {
            timeZone: ZONA_HORARIA,
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(orden.date_created)),
          nombre: orden.buyer?.nickname || '',
          monto: orden.total_amount,
        };
        if (Object.keys(unidadesPorColumna).length) filasExport.push({ ...filaBase, unidadesPorColumna });
        if (manual) filasRevisar.push({ ...filaBase, itemsSinResolver });
      }
    }

    const excelBuffer = await crearExcelVentas(filasExport, filasRevisar);
    await enviarExcelPorTelegram(
      TELEGRAM_CHAT_ID,
      excelBuffer,
      `PRUEBA_ventas_${fechaHoyAR()}.xlsx`,
      `🧪 PRUEBA (no se marcó nada como exportado) - ${filasExport.length} fila(s), ${filasRevisar.length} para revisar a mano.`
    );
    res.json({ ok: true, filasExport: filasExport.length, filasRevisar: filasRevisar.length });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message, filasExport: filasExport.length, filasRevisar: filasRevisar.length });
  }
});

// Prueba solo el acceso a la planilla, escribiendo una fila de prueba.
app.get('/debug/test-sheet', async (req, res) => {
  try {
    await agregarFilasAPlanilla([
      {
        id: 'TEST',
        fecha: new Intl.DateTimeFormat('es-AR', { timeZone: ZONA_HORARIA, dateStyle: 'short', timeStyle: 'short' }).format(new Date()),
        nombre: 'Prueba',
        dni: '',
        provincia: 'Buenos Aires',
        monto: 1000,
        titulo: 'Producto de prueba',
        unidades: 1,
        envio: 'Flex',
        publicidad: '',
      },
    ]);
    res.json({ ok: true, mensaje: 'Se agregó una fila de prueba a la planilla. Revisala y despues borrala a mano.' });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Borra la lista de ventas "ya cargadas" de una cuenta. Efecto
// práctico: la próxima corrida vuelve a mirar los últimos 3 días de
// ventas pagadas y carga en la planilla las que todavía no estén ahí.
// Pensado para usar después de vaciar a mano lo que el bot haya
// escrito de más en la planilla.
app.get('/debug/reset-planilla', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  const cuenta = data.cuentas[cuentaId];
  const cantidadAntes = (cuenta.filas_planilla_cargadas || []).length;
  cuenta.filas_planilla_cargadas = [];
  await saveData(data);
  res.json({
    ok: true,
    cuenta: cuenta.nombre,
    marcas_borradas: cantidadAntes,
    aviso: 'La próxima corrida ya va a cargar en la planilla las ventas de los últimos 3 días que todavía no estén ahí.',
  });
});

// Diagnóstico: muestra, tal cual los tiene guardados el bot en su
// memoria (sin pasar por Google Sheets), los números de venta que ya
// marcó como "cargados" para una cuenta. Sirve para comparar contra lo
// que aparece escrito en la planilla y detectar si algún número quedó
// mal guardado en Sheets.
app.get('/debug/ids-cargados', (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  const cuenta = data.cuentas[cuentaId];
  if (!cuenta) return res.status(404).json({ error: 'No encontré esa cuenta.' });
  res.json({
    cuenta: cuenta.nombre || cuentaId,
    cantidad: (cuenta.filas_planilla_cargadas || []).length,
    ids: cuenta.filas_planilla_cargadas || [],
  });
});

// Lista todas las publicaciones activas de las 3 cuentas (ID + título),
// para armar a mano la tabla de equivalencias con las columnas de
// productos de la planilla de stock.
app.get('/debug/listado-publicaciones', async (req, res) => {
  const resultado = [];
  try {
    for (const cuentaId of Object.keys(data.cuentas || {})) {
      const cuenta = data.cuentas[cuentaId];
      if (!cuenta.refresh_token) continue;
      const token = await getAccessToken(cuentaId);

      const { data: idsResponse } = await axios.get(
        `https://api.mercadolibre.com/users/${cuentaId}/items/search`,
        { params: { status: 'active', limit: 100 }, headers: { Authorization: `Bearer ${token}` } }
      );
      const itemIds = idsResponse.results || [];

      for (const grupo of partirEnGrupos(itemIds, 20)) {
        const { data: items } = await axios.get('https://api.mercadolibre.com/items', {
          params: { ids: grupo.join(','), attributes: 'id,title,available_quantity,variations' },
          headers: { Authorization: `Bearer ${token}` },
        });
        for (const { body: item } of items) {
          if (!item) continue;
          if (Array.isArray(item.variations) && item.variations.length) {
            for (const v of item.variations) {
              const atributos = (v.attribute_combinations || [])
                .map((a) => a.value_name)
                .filter(Boolean)
                .join(' / ');
              resultado.push({
                cuenta: cuenta.nombre || cuentaId,
                item_id: item.id,
                variation_id: v.id,
                titulo: item.title,
                variacion: atributos,
                stock_disponible: v.available_quantity,
              });
            }
          } else {
            resultado.push({
              cuenta: cuenta.nombre || cuentaId,
              item_id: item.id,
              variation_id: '',
              titulo: item.title,
              variacion: '',
              stock_disponible: item.available_quantity,
            });
          }
        }
      }
    }
    res.json({ cantidad: resultado.length, publicaciones: resultado });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message, parcial: resultado });
  }
});

// Trae el detalle COMPLETO (sin filtrar campos) de una publicación
// puntual, para diagnosticar casos raros: si está pausada/cerrada, el
// link público real, y si tiene variantes cargadas de verdad.
app.get('/debug/item-detalle', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  const { item } = req.query;
  if (!item) return res.status(400).json({ error: 'Falta el parámetro ?item=ID_DE_LA_PUBLICACION' });
  try {
    const token = await getAccessToken(cuentaId);
    const { data: detalle } = await axios.get(`https://api.mercadolibre.com/items/${item}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(detalle);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

async function start() {
  data = await loadData();
  await saveData(data); // por si se acaba de migrar del formato viejo
  await corregirNombresGenericos();
  app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
  setInterval(revisarTodo, 60 * 1000); // cada 1 minuto
  revisarTodo(); // y una vez apenas arranca
}

start();
