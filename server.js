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
    // Datos sacados directamente del Excel "Ventas AR" que Raul baja a
    // mano desde Mercado Libre (botón "Descargar Excel de ventas" en
    // la sección Ventas) y le manda al bot por Telegram. Mercado Libre
    // ya calcula ahí el monto final y si fue venta por publicidad, así
    // que en vez de tratar de recalcularlos por API (lento, con rate
    // limit, y con margen de error) el bot usa estos valores cuando
    // están disponibles. Clave = "# de venta" (pack_id), que es único
    // en toda Mercado Libre, no hace falta separar por cuenta.
    reporte_ventas_ml: {}, // { "2000015141422323": { monto, publicidad, cargadoFecha } }
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
    if (!migrado.reporte_ventas_ml) migrado.reporte_ventas_ml = {}; // datos guardados antes de este campo
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
  if (!message) return;

  // Si mandás por Telegram el Excel "Ventas AR" que bajás de Mercado
  // Libre (Ventas > "Descargar Excel de ventas"), el bot lo lee y
  // guarda el monto y "Venta por publicidad" de cada venta que
  // aparezca ahí, para usarlos en el próximo export en vez de
  // recalcularlos por API.
  if (message.document) {
    const nombreArchivo = message.document.file_name || 'archivo';
    try {
      const { data: fileInfo } = await axios.get(`${TELEGRAM_API}/getFile`, {
        params: { file_id: message.document.file_id },
      });
      const filePath = fileInfo.result.file_path;
      const respuestaArchivo = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`, {
        responseType: 'arraybuffer',
      });
      const resultado = await cargarReporteVentasML(Buffer.from(respuestaArchivo.data));
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: message.chat.id,
        text: `📊 Leí "${nombreArchivo}" y cargué ${resultado.cantidad} venta(s). El próximo Excel de ventas va a usar estos montos (los mismos que calcula Mercado Libre) para esas ventas.`,
      });
    } catch (err) {
      console.error('Error procesando reporte de ventas subido:', err.response?.data || err.message);
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: message.chat.id,
        text: `❌ No pude leer "${nombreArchivo}" como reporte de ventas de Mercado Libre (${err.message}). ¿Es el Excel de "Descargar Excel de ventas"?`,
      });
    }
    return;
  }

  if (!message.reply_to_message || !message.text) return;

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

// El "total_amount" de una orden es el VALOR DE VENTA del producto
// (lo que pagó el comprador), no lo que a vos te termina quedando: a
// eso Mercado Libre le descuenta su comisión, costo fijo e impuestos
// antes de depositártelo. La PRIMERA versión de este helper adivinaba
// a partir de orden.payments[], pero no daba el número correcto.
//
// Esta versión usa la API oficial de Facturación de Mercado Libre
// (GET /billing/integration/group/ML/order/details, la misma que
// arma tu reporte "Ventas AR") y se VERIFICÓ contra una venta real
// tuya (Laura Mariela Mendoza, orden 2000018552702348): con esta
// fórmula da $15.230,64, exactamente lo que vos me dijiste que era el
// monto real a recibir. La fórmula:
//   monto neto = transaction_amount (precio de venta)
//                - suma de todos los "charge_info.detail_amount" con
//                  detail_type "CHARGE" (cargo por unidad vendida,
//                  cargo por vender, costo de envío si lo hubiera, etc.)
//                - impuestos retenidos (payment_info[].tax_details[])
//
// OJO importante: Mercado Libre marca estos cargos como
// "legal_document_status: PROCESSING" (en proceso) hasta que cierra
// el documento de facturación del período - por eso el número puede
// ajustarse un poco en los días siguientes a la venta, aunque para el
// control del día a día esto es lo más preciso que se puede sacar.
// La "Bonificación por envío" (un crédito que Mercado Libre le devuelve
// al vendedor, visible en el detalle de la venta en la web de ML) NO
// aparece en ningún lado de billing/integration/group/ML/order/details
// (ni en charge_info ni en discount_info) - se confirmó comparando a
// mano contra un caso real (Sabrina, orden 2000018551812338: base
// 34931.25 - cargos 9229.68 = 25701.57, pero el Total real era
// 34691.57 - faltaban exactamente $8.990,00). Ese mismo número
// ($8.990,00, exacto al centavo) SÍ aparece en
// GET /shipments/{shipping_id}/costs, como receiver.discounts[].promoted_amount
// (el descuento de envío que ML le regaló al comprador y que se le
// compensa al vendedor). Por eso se sigue esa fuente para este
// componente.
// Mercado Libre le pone un límite bastante bajo a estos endpoints de
// facturación (se confirmó viendo un 429 real: "Rate limit exceeded: 5
// requests per minute"). Al procesar muchas ventas seguidas sin pausa
// (ej: /debug/test-excel-ventas con 46 ventas de las 3 cuentas) la
// mayoría terminaba pisando ese límite y cayendo al fallback
// (exacto:false), aunque el cálculo en sí esté bien - se confirmó
// pidiendo una de esas mismas órdenes sola, que anduvo perfecto. Este
// helper reintenta con espera creciente cuando la respuesta es 429,
// en vez de rendirse en el primer intento.
// El límite real de Mercado Libre para estos endpoints de facturación
// es MUY bajo (se vio literal "5 requests per minute" en un 429 real).
// Reintentar reactivamente con una espera corta no alcanza cuando el
// límite se resetea recién a los 60s - con 46 ventas x ~2 llamadas
// cada una, esperar y reintentar de a poco seguía dejando ~40% de las
// ventas sin poder calcularse. Por eso, en vez de solo reintentar,
// esto ADEMÁS frena proactivamente antes de cada llamada para nunca
// pasar de N llamadas por minuto (ventana deslizante), así se evita
// pisar el límite en primer lugar. Se comparte entre
// obtenerMontoNeto() y obtenerBonificacionEnvio() por las dudas de que
// compartan el mismo límite de cuota.
const historialLlamadasFacturacion = [];
const LIMITE_LLAMADAS_FACTURACION_POR_MINUTO = 4; // margen por debajo del límite real (5/min) visto en Mercado Libre
async function esperarTurnoFacturacion() {
  const ahora = Date.now();
  while (historialLlamadasFacturacion.length && ahora - historialLlamadasFacturacion[0] > 60000) {
    historialLlamadasFacturacion.shift();
  }
  if (historialLlamadasFacturacion.length >= LIMITE_LLAMADAS_FACTURACION_POR_MINUTO) {
    const espera = 60000 - (ahora - historialLlamadasFacturacion[0]) + 250;
    await new Promise((r) => setTimeout(r, espera));
    return esperarTurnoFacturacion();
  }
  historialLlamadasFacturacion.push(Date.now());
}

async function axiosGetConReintento(url, config, intentos = 5) {
  for (let intento = 0; intento < intentos; intento++) {
    await esperarTurnoFacturacion();
    try {
      return await axios.get(url, config);
    } catch (err) {
      const esRateLimit = err.response?.status === 429;
      if (!esRateLimit || intento === intentos - 1) throw err;
      const esperaHeader = Number(err.response?.headers?.['retry-after']);
      const espera = esperaHeader > 0 ? esperaHeader * 1000 : 65000;
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}

async function obtenerBonificacionEnvio(shippingId, token) {
  if (!shippingId) return 0;
  try {
    const { data: costos } = await axiosGetConReintento(`https://api.mercadolibre.com/shipments/${shippingId}/costs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const descuentos = costos?.receiver?.discounts || [];
    if (descuentos.length) {
      return descuentos.reduce((suma, d) => suma + (Number(d.promoted_amount) || 0), 0);
    }
    return Number(costos?.receiver?.save) || 0;
  } catch (err) {
    console.error(`(export) No se pudo traer costos de envío ${shippingId}:`, err.response?.data || err.message);
    return 0;
  }
}

async function obtenerMontoNeto(cuentaId, orden, token) {
  try {
    const { data: billing } = await axiosGetConReintento(
      'https://api.mercadolibre.com/billing/integration/group/ML/order/details',
      { params: { order_ids: orden.id, seller_id: cuentaId }, headers: { Authorization: `Bearer ${token}` } }
    );
    const resultado = (billing.results || [])[0];
    if (!resultado) return { monto: orden.total_amount, exacto: false };

    let base = null;
    let cargos = 0;
    for (const d of resultado.details || []) {
      const montoTransaccion = d.sales_info?.[0]?.transaction_amount;
      if (base === null && typeof montoTransaccion === 'number') base = montoTransaccion;
      if (d.charge_info?.detail_type === 'CHARGE' && typeof d.charge_info?.detail_amount === 'number') {
        cargos += d.charge_info.detail_amount;
      }
    }
    if (base === null) return { monto: orden.total_amount, exacto: false };

    let impuestos = 0;
    for (const pago of resultado.payment_info || []) {
      for (const tax of pago.tax_details || []) {
        impuestos += (Number(tax.original_amount) || 0) - (Number(tax.refunded_amount) || 0);
      }
    }

    const bonificacionEnvio = await obtenerBonificacionEnvio(orden.shipping?.id, token);

    return { monto: base - cargos - impuestos + bonificacionEnvio, exacto: true };
  } catch (err) {
    console.error(`(export) No se pudo traer facturación de la orden ${orden.id}:`, err.response?.data || err.message);
    return { monto: orden.total_amount, exacto: false };
  }
}

// ExcelJS arma la celda de fecha usando los componentes UTC del
// objeto Date que le pasás (getUTCFullYear, getUTCHours, etc.), NO la
// hora local del servidor ni ninguna zona horaria. Como Render corre
// en UTC y la hora de la venta viene en horario de Argentina
// (UTC-3), pasarle directo "new Date(orden.date_created)" hacía que
// Excel mostrara la hora en UTC en vez de en hora argentina (por eso
// se veía atrasada/adelantada varias horas). Este helper arma un Date
// "trucado" cuyos campos UTC son iguales a la hora LOCAL de
// Argentina, para que lo que ExcelJS escribe sea exactamente esa hora.
function fechaExcelAR(fechaISO) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(fechaISO));
  const p = {};
  for (const parte of partes) p[parte.type] = parte.value;
  const hora = Number(p.hour) === 24 ? 0 : Number(p.hour); // Intl a veces da "24" para medianoche
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hora, Number(p.minute), Number(p.second)));
}

// El nombre real de facturación NO viene en un campo plano
// (billing_info.name / billing_info.last_name, que es lo que se
// había asumido antes) - viene adentro de un array
// "additional_info": [{type: 'FIRST_NAME', value: '...'}, {type:
// 'LAST_NAME', value: '...'}, ...] (o BUSINESS_NAME para facturación
// a empresa/CUIT). Esto se confirmó con datos reales via
// /debug/ordenes-recientes - antes de este fix, esa condición nunca
// se cumplía y por eso siempre quedaba el nickname.
function extraerNombreFacturacion(billingInfo) {
  const info = {};
  for (const item of billingInfo?.additional_info || []) {
    if (item?.type && item.value !== undefined && item.value !== null) info[item.type] = item.value;
  }
  if (info.BUSINESS_NAME) return info.BUSINESS_NAME;
  const nombre = [info.FIRST_NAME, info.LAST_NAME].filter(Boolean).join(' ').trim();
  return nombre || null;
}

// Lee el Excel "Ventas AR" que Raul baja a mano desde Mercado Libre
// (Ventas > "Descargar Excel de ventas") y manda al bot por Telegram,
// y carga en data.reporte_ventas_ml el "Total (ARS)" y "Venta por
// publicidad" de cada venta que aparezca ahí, ya calculados por
// Mercado Libre. Busca la fila de encabezados buscando la celda "# de
// venta" (en vez de asumir un número de fila fijo, porque el archivo
// trae unas filas de avisos arriba que pueden variar) y arma un mapa
// de columna por nombre de encabezado (quedándose con la PRIMERA
// aparición de cada nombre, porque el archivo repite algunos
// encabezados como "Estado" o "Unidades" más adelante para otras
// secciones).
// ExcelJS no siempre da el valor de una celda como texto plano: la
// columna "# de venta" viene como un link ({text, hyperlink}), y
// alguna celda de texto puede venir como {richText:[...]}. Este
// helper normaliza cualquiera de esos casos a un string.
function textoCelda(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text !== undefined) return String(v.text).trim();
    if (v.result !== undefined) return String(v.result).trim();
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('').trim();
  }
  return String(v).trim();
}

// Cuando una compra de varios productos se divide en varias "órdenes"
// (se ve en el Excel como varias filas para la misma venta), Mercado
// Libre muestra en el TEXTO de cada fila el order_id individual (no
// el "# de venta" real), pero el LINK de esa celda sigue apuntando al
// detalle de la venta con el pack_id real - por eso acá se prioriza
// sacar el número del link, así todas las filas de una misma venta
// dividida quedan agrupadas bajo el mismo número (el que también usa
// el bot internamente como numeroVenta).
function numeroVentaCelda(cell) {
  const v = cell.value;
  if (v && typeof v === 'object' && v.hyperlink) {
    const m = String(v.hyperlink).match(/\/ventas\/(\d+)\//);
    if (m) return m[1];
  }
  return textoCelda(cell);
}

async function cargarReporteVentasML(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('El archivo no tiene ninguna hoja.');

  let filaEncabezado = null;
  for (let r = 1; r <= Math.min(20, ws.rowCount); r++) {
    if (textoCelda(ws.getCell(r, 1)) === '# de venta') {
      filaEncabezado = r;
      break;
    }
  }
  if (!filaEncabezado) {
    throw new Error('No encontré la columna "# de venta" en las primeras filas - ¿es el Excel de "Descargar Excel de ventas" de Mercado Libre?');
  }

  const columnas = {};
  ws.getRow(filaEncabezado).eachCell((cell, col) => {
    const texto = textoCelda(cell);
    if (texto && !(texto in columnas)) columnas[texto] = col;
  });

  const colVenta = columnas['# de venta'];
  const colTotal = columnas['Total (ARS)'];
  const colPublicidad = columnas['Venta por publicidad'];
  if (!colVenta || !colTotal) {
    throw new Error('No encontré las columnas "# de venta" / "Total (ARS)" esperadas en ese archivo.');
  }

  // Cuando una venta se dividió en varias filas (ver numeroVentaCelda
  // arriba), el monto final SOLO aparece completo en UNA de esas
  // filas (las demás quedan con "Total (ARS)" vacío/0, pero pueden
  // traer su propio "Venta por publicidad": Sí para ese producto en
  // particular). Por eso se arma primero un mapa combinando todas las
  // filas de cada venta, en vez de simplemente pisar con la última
  // fila leída (que podría ser una de las filas "vacías" y borrar el
  // monto bueno que ya se había leído).
  const combinado = {};
  for (let r = filaEncabezado + 1; r <= ws.rowCount; r++) {
    const numeroVenta = numeroVentaCelda(ws.getCell(r, colVenta));
    if (!numeroVenta) continue;
    const montoCelda = ws.getCell(r, colTotal).value;
    const montoNum = Number(typeof montoCelda === 'object' ? montoCelda?.result : montoCelda);
    const publicidadRaw = colPublicidad ? textoCelda(ws.getCell(r, colPublicidad)) : '';

    const previo = combinado[numeroVenta] || { monto: null, publicidad: '' };
    combinado[numeroVenta] = {
      monto: Number.isFinite(montoNum) && montoNum !== 0 ? montoNum : previo.monto,
      publicidad: publicidadRaw === 'Sí' ? 'Sí' : previo.publicidad,
    };
  }

  let cantidad = 0;
  const ahora = new Date().toISOString();
  for (const numeroVenta of Object.keys(combinado)) {
    const { monto, publicidad } = combinado[numeroVenta];
    if (monto === null) continue; // esta venta todavía no tiene el monto final en Mercado Libre - se sigue calculando por API
    data.reporte_ventas_ml[numeroVenta] = { monto, publicidad, cargadoFecha: ahora };
    cantidad++;
  }
  await saveData(data);
  return { cantidad };
}

// Igual que armarFilaPlanilla, pero para el export a Excel (feature
// aparte, no toca la planilla de Google Sheets). Trae el nombre y DNI
// reales de facturación (no el nickname de usuario de Mercado Libre) y
// el monto NETO (ver obtenerMontoNeto), no el bruto.
async function armarFilaVentaML(cuentaId, orden, token) {
  const productos = (orden.order_items || []).map((it) => it.item.title).join('; ');
  const unidades = (orden.order_items || []).reduce((suma, it) => suma + it.quantity, 0);

  let nombre = orden.buyer?.nickname || '';
  let dni = '';
  try {
    const { data: fact } = await axios.get(
      `https://api.mercadolibre.com/orders/${orden.id}/billing_info`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (fact?.billing_info?.doc_number) dni = fact.billing_info.doc_number;
    const nombreReal = extraerNombreFacturacion(fact?.billing_info);
    if (nombreReal) nombre = nombreReal;
  } catch (err) {
    console.error(`(export) No se pudo traer facturación de la orden ${orden.id}:`, err.response?.data || err.message);
  }

  let provincia = '';
  if (orden.shipping?.id) {
    try {
      const { data: envio } = await axios.get(`https://api.mercadolibre.com/shipments/${orden.shipping.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      provincia = envio.receiver_address?.state?.name || '';
    } catch (err) {
      console.error(`(export) No se pudo traer envío de la orden ${orden.id}:`, err.response?.data || err.message);
    }
  }

  const tipoEnvio = await obtenerTipoEnvio(token, orden.shipping?.id);

  // El "# de venta" que Mercado Libre te muestra en el panel y en el
  // reporte "Ventas AR" que bajás vos es el pack_id, NO el order_id
  // (confirmado con datos reales: pack_id 2000015149351417 = tu "#
  // de venta" de esa fila). Cuando una venta no forma parte de un
  // paquete de varios productos no tiene pack_id, y ahí sí se usa el
  // order_id. OJO: si una compra se dividió en 2+ "órdenes" dentro
  // de un mismo paquete, te va a aparecer el mismo número repetido
  // en 2 filas (cada una con sus propios productos) - así como
  // Mercado Libre las junta en 1 sola fila en su reporte.
  const numeroVenta = orden.pack_id || orden.id;

  // Si Raul ya subió (por Telegram) el Excel "Ventas AR" oficial que
  // se baja desde Mercado Libre y esta venta figura ahí, se usa ESE
  // monto y esa "Venta por publicidad" directamente - son los mismos
  // números que calcula Mercado Libre, así que son la única fuente
  // 100% confiable. Si la venta todavía no está en ningún reporte
  // subido, se cae al cálculo por API de siempre - pero OJO: ese
  // cálculo es una ESTIMACIÓN, no un valor exacto. Se probó a fondo y
  // Mercado Libre aplica ajustes caso a caso (cargo por vender, costo
  // fijo, bonificación de envío, costo de envío Flex a cargo del
  // vendedor, percepciones por provincia...) que no siempre están
  // todos disponibles/documentados vía API, así que por más que la
  // llamada a la API salga bien, el número puede no cerrar exacto.
  // Por eso `exacto` acá SIEMPRE da false salvo que venga del reporte
  // oficial - así esta fila cae en "Revisar a mano" y Raul la
  // chequea antes de pasarla a su planilla, en vez de confiar
  // ciegamente en el cálculo.
  const delReporteOficial = data.reporte_ventas_ml[String(numeroVenta)];
  let monto;
  let exacto;
  let publicidad;
  let fuenteMonto;
  if (delReporteOficial) {
    monto = delReporteOficial.monto;
    exacto = true;
    publicidad = delReporteOficial.publicidad || '';
    // "reporte": el monto ya es el TOTAL de toda la venta (Mercado
    // Libre lo da una sola vez por # de venta), a diferencia de
    // "api" donde cada orden trae su propia porción del total. Esto
    // importa al agrupar varias órdenes de una misma venta en una
    // sola fila (ver combinarFilasPorVenta): si viene de "reporte" NO
    // hay que sumarlo entre las órdenes del grupo, si viene de "api"
    // sí.
    fuenteMonto = 'reporte';
  } else {
    const resultado = await obtenerMontoNeto(cuentaId, orden, token);
    monto = resultado.monto;
    exacto = false; // estimación por API, siempre a revisar (ver comentario arriba)
    publicidad = '';
    fuenteMonto = 'api';
  }

  return {
    id: orden.id,
    numeroVenta,
    fechaHora: fechaExcelAR(orden.date_created),
    nombre,
    dni,
    provincia,
    monto,
    montoExacto: exacto,
    fuenteMonto,
    titulo: productos,
    unidades,
    envio: tipoEnvio,
    publicidad,
  };
}

// Cuando una compra de varios productos se divide en más de una
// "orden" del lado de Mercado Libre (mismo "# de venta"/pack_id, pero
// varios order_id), esto junta todas esas filas en UNA sola por
// venta - que es como Raul la ve y la quiere pasar a su planilla, en
// vez de que le aparezcan 2 o 3 filas separadas para la misma compra.
// Recibe un array de { filaML, unidadesPorColumna, manual,
// itemsSinResolver } (uno por cada orden ya procesada con
// armarFilaVentaML + resolverProductosOrden) y devuelve un array ya
// agrupado por numeroVenta.
function combinarFilasPorVenta(items) {
  const grupos = new Map();
  for (const item of items) {
    const clave = String(item.filaML.numeroVenta);
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(item);
  }

  const combinadas = [];
  for (const grupo of grupos.values()) {
    if (grupo.length === 1) {
      combinadas.push(grupo[0]);
      continue;
    }

    const base = grupo[0].filaML;
    // Si CUALQUIERA de las órdenes de esta venta trajo el monto del
    // reporte oficial, se usa ESE (una sola vez, no se suma - ver
    // comentario en fuenteMonto más arriba). Si ninguna lo tiene, se
    // suman las estimaciones por API de cada orden (cada una es una
    // porción real del total).
    const conReporte = grupo.find((it) => it.filaML.fuenteMonto === 'reporte');
    const monto = conReporte
      ? conReporte.filaML.monto
      : grupo.reduce((suma, it) => suma + (Number(it.filaML.monto) || 0), 0);
    const montoExacto = grupo.every((it) => it.filaML.montoExacto === true);
    const publicidad = grupo.some((it) => it.filaML.publicidad === 'Sí') ? 'Sí' : '';
    const titulo = grupo.map((it) => it.filaML.titulo).filter(Boolean).join('; ');
    const unidades = grupo.reduce((suma, it) => suma + (Number(it.filaML.unidades) || 0), 0);

    const unidadesPorColumna = {};
    let manual = false;
    let itemsSinResolver = [];
    for (const it of grupo) {
      if (it.manual) manual = true;
      if (it.itemsSinResolver?.length) itemsSinResolver = itemsSinResolver.concat(it.itemsSinResolver);
      for (const [columna, cantidad] of Object.entries(it.unidadesPorColumna || {})) {
        unidadesPorColumna[columna] = (unidadesPorColumna[columna] || 0) + cantidad;
      }
    }

    combinadas.push({
      filaML: { ...base, monto, montoExacto, publicidad, titulo, unidades },
      unidadesPorColumna,
      manual,
      itemsSinResolver,
    });
  }
  return combinadas;
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

function estilarEncabezado(fila, colorFondo) {
  fila.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  fila.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colorFondo } };
}

// Arma el archivo .xlsx del día con 3 hojas:
//  - "VentasSkin ML": mismas 14 columnas, en el mismo orden, que tu
//    solapa VentasSkin ML (ID | Fecha | Nombre | DNI | Teléfono |
//    Dirección | Monto | Título de la publicación | Unidades | Envío |
//    Flex $ | Flex # | (vacía) | Venta Publicidad).
//  - "VentasSkin": Fecha | Nombre | las 27 columnas de producto (mismo
//    orden que tu solapa VentasSkin) | Monto - una fila por venta,
//    lista para copiar y pegar debajo de tus datos ya cargados.
//  - "Revisar a mano": todo lo que el bot no pudo resolver solo, para
//    que no se pierda ni se cargue mal: productos sin mapear en
//    MAPEO_PRODUCTOS, y ventas donde no se pudo calcular con
//    confianza el monto neto (ver obtenerMontoNeto).
async function crearExcelVentas(filasML, filasVentas, filasRevisar) {
  const wb = new ExcelJS.Workbook();
  const formatoFechaHora = 'dd/mm/yyyy hh:mm';
  const formatoFecha = 'dd/mm/yyyy';

  const hojaML = wb.addWorksheet('VentasSkin ML');
  hojaML.columns = [
    { header: 'Cuenta', key: 'cuenta', width: 16 },
    { header: 'ID', key: 'id', width: 16 },
    { header: 'Fecha', key: 'fecha', width: 18 },
    { header: 'Nombre', key: 'nombre', width: 26 },
    { header: 'DNI', key: 'dni', width: 14 },
    { header: 'Teléfono', key: 'telefono', width: 14 },
    { header: 'Dirección', key: 'provincia', width: 16 },
    { header: 'Monto', key: 'monto', width: 14 },
    { header: 'Título de la publicación', key: 'titulo', width: 45 },
    { header: 'Unidades', key: 'unidades', width: 12 },
    { header: 'Envio', key: 'envio', width: 12 },
    { header: 'Flex $', key: 'flexMonto', width: 10 },
    { header: 'Flex #', key: 'flexNumero', width: 10 },
    { header: '', key: 'vacia', width: 6 },
    { header: 'Venta Publicidad', key: 'publicidad', width: 16 },
  ];
  estilarEncabezado(hojaML.getRow(1), 'FF1F3864');
  // Ordenada por cuenta y, dentro de cada cuenta, por fecha/hora.
  const filasMLOrdenadas = [...filasML].sort((a, b) => {
    const cuentaCmp = (a.cuenta || '').localeCompare(b.cuenta || '');
    if (cuentaCmp !== 0) return cuentaCmp;
    return a.fechaHora - b.fechaHora;
  });
  for (const f of filasMLOrdenadas) {
    hojaML.addRow({
      cuenta: f.cuenta,
      id: String(f.numeroVenta ?? f.id),
      fecha: f.fechaHora,
      nombre: f.nombre,
      dni: f.dni,
      telefono: '',
      provincia: f.provincia,
      monto: f.monto,
      titulo: f.titulo,
      unidades: f.unidades,
      envio: f.envio,
      flexMonto: '',
      flexNumero: '',
      vacia: '',
      publicidad: f.publicidad || '',
    });
  }
  hojaML.getColumn('fecha').numFmt = formatoFechaHora;

  const hojaVentas = wb.addWorksheet('VentasSkin');
  hojaVentas.columns = [
    { header: 'Fecha', key: 'fecha', width: 14 },
    { header: 'Nombre', key: 'nombre', width: 26 },
    ...CODES.map((c) => ({ header: c, key: c, width: 10 })),
    { header: 'Monto', key: 'monto', width: 14 },
  ];
  estilarEncabezado(hojaVentas.getRow(1), 'FF1F3864');
  for (const f of filasVentas) {
    const fila = { fecha: f.fechaHora, nombre: f.nombre, monto: f.monto };
    for (const c of CODES) fila[c] = f.unidadesPorColumna[c] || '';
    hojaVentas.addRow(fila);
  }
  hojaVentas.getColumn('fecha').numFmt = formatoFecha;

  const hojaRevisar = wb.addWorksheet('Revisar a mano');
  hojaRevisar.columns = [
    { header: 'Fecha', key: 'fecha', width: 18 },
    { header: 'Cuenta', key: 'cuenta', width: 16 },
    { header: 'N° de venta', key: 'id', width: 16 },
    { header: 'Tipo', key: 'tipo', width: 20 },
    { header: 'Detalle', key: 'detalle', width: 60 },
  ];
  estilarEncabezado(hojaRevisar.getRow(1), 'FFB45309');
  for (const f of filasRevisar) {
    for (const it of f.itemsSinResolver || []) {
      hojaRevisar.addRow({
        fecha: f.fechaHora,
        cuenta: f.cuenta,
        id: f.id,
        tipo: 'Producto sin mapear',
        detalle: `${it.titulo} (${it.item_id}${it.variation_id ? ':' + it.variation_id : ''}) - cantidad: ${it.cantidad}`,
      });
    }
    if (f.montoExacto === false) {
      hojaRevisar.addRow({
        fecha: f.fechaHora,
        cuenta: f.cuenta,
        id: f.id,
        tipo: 'Monto sin confirmar',
        detalle: `Se usó el monto bruto de la venta ($${f.monto}) porque no se pudo calcular el neto real con seguridad.`,
      });
    }
  }
  hojaRevisar.getColumn('fecha').numFmt = formatoFechaHora;

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

// Guarda el resultado de la última corrida que realmente se ejecutó
// (no las que se saltearon por "ya en curso" / "ya corrió hoy"), para
// poder consultarlo desde /debug/estado-corrida SIN disparar una
// corrida nueva. Fundamental para no tener que "probar en producción"
// cada vez que se quiere ver cómo salió algo.
let ultimoResultadoCorridaDiaria = null;

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
    const resultado = await ejecutarCorridaDiariaEtiquetasYVentas({ forzar, hoy });
    ultimoResultadoCorridaDiaria = { ...resultado, cuando: new Date().toISOString() };
    return resultado;
  } catch (err) {
    ultimoResultadoCorridaDiaria = {
      ok: false,
      error: err.response?.data || err.message,
      cuando: new Date().toISOString(),
    };
    throw err;
  } finally {
    etiquetasVentasEnCurso = false;
  }
}

// Procesa el export de ventas a Excel (lento, con rate-limit de la API
// de facturación de Mercado Libre) para las órdenes que ya se habían
// pedido en la primera pasada (una por cuenta). No manda nada por
// Telegram todavía - solo arma los datos.
async function procesarExportVentas(ordenesPorCuenta) {
  const filasML = [];
  const filasVentas = [];
  const filasRevisar = [];
  const marcasExportPendientes = [];
  let huboError = false;

  for (const [cuentaId, ordenesPendientes] of Object.entries(ordenesPorCuenta)) {
    const cuenta = data.cuentas[cuentaId];
    if (!cuenta) continue;
    try {
      const token = await getAccessToken(cuentaId);
      const itemsCuenta = [];
      for (const orden of ordenesPendientes) {
        if (cuenta.filas_export_cargadas.includes(orden.id)) continue;
        // Pausa chica entre ventas para no pisar el límite de la API
        // de facturación de Mercado Libre (ver comentario en
        // axiosGetConReintento).
        await new Promise((r) => setTimeout(r, 400));
        try {
          const filaML = await armarFilaVentaML(cuentaId, orden, token);
          const { unidadesPorColumna, manual, itemsSinResolver } = resolverProductosOrden(orden);
          itemsCuenta.push({ filaML, unidadesPorColumna, manual, itemsSinResolver });
          marcasExportPendientes.push({ cuenta, ordenId: orden.id });
        } catch (err) {
          console.error(`Error resolviendo productos del export (orden ${orden.id}):`, err.response?.data || err.message);
          huboError = true;
        }
      }

      // Si una compra se dividió en varias "órdenes" (mismo # de
      // venta), se juntan acá en una sola fila antes de agregarlas
      // al Excel - ver combinarFilasPorVenta.
      const cuentaNombre = cuenta.nombre || cuentaId;
      for (const { filaML, unidadesPorColumna, manual, itemsSinResolver } of combinarFilasPorVenta(itemsCuenta)) {
        filasML.push({ ...filaML, cuenta: cuentaNombre });
        filasVentas.push({
          fechaHora: filaML.fechaHora,
          nombre: filaML.nombre,
          monto: filaML.monto,
          unidadesPorColumna,
        });
        if (manual || filaML.montoExacto === false) {
          filasRevisar.push({
            id: filaML.numeroVenta,
            cuenta: cuentaNombre,
            fechaHora: filaML.fechaHora,
            monto: filaML.monto,
            montoExacto: filaML.montoExacto,
            itemsSinResolver,
          });
        }
      }
    } catch (err) {
      console.error(`Error procesando export de ventas de ${cuenta.nombre}:`, err.response?.data || err.message);
      huboError = true;
    }
  }

  return { filasML, filasVentas, filasRevisar, marcasExportPendientes, huboError };
}

// Arma el Excel con lo que devolvió procesarExportVentas() y lo manda
// por Telegram. Marca las órdenes como exportadas solo si el envío
// sale bien (mismo criterio que la planilla / etiquetas).
async function armarYMandarExcelVentas(resultado, hoy) {
  const { filasML, filasVentas, filasRevisar, marcasExportPendientes } = resultado || {};
  if (!filasVentas?.length && !filasRevisar?.length) return 0;
  const excelBuffer = await crearExcelVentas(filasML, filasVentas, filasRevisar);
  const avisoRevisar = filasRevisar.length
    ? ` ⚠️ ${filasRevisar.length} venta(s) para revisar a mano (producto sin mapear o monto sin confirmar).`
    : '';
  await enviarExcelPorTelegram(
    TELEGRAM_CHAT_ID,
    excelBuffer,
    `ventas_${hoy}.xlsx`,
    `🧾 Ventas del ${hoy} - ${filasVentas.length} fila(s) lista(s) para pegar en tu planilla.${avisoRevisar}`
  );
  for (const { cuenta, ordenId } of marcasExportPendientes) {
    cuenta.filas_export_cargadas.push(ordenId);
  }
  await saveData(data);
  return marcasExportPendientes.length;
}

async function ejecutarCorridaDiariaEtiquetasYVentas({ forzar, hoy }) {
  const buffersEtiquetas = [];
  const marcasEtiquetasPendientes = []; // { cuenta, shipmentId } - se confirman solo si el PDF se manda bien
  const filasPlanilla = [];
  const marcasPendientes = []; // { cuenta, ordenId } - se confirman solo si la planilla se escribe bien
  // El export de ventas a Excel es LENTO a propósito (respeta un
  // límite bajo de la API de facturación de Mercado Libre, con pausas
  // y reintentos de hasta 1 minuto). Las etiquetas, en cambio, son
  // urgentes: hay que imprimirlas y despachar los paquetes en
  // horario. La idea es mandar ambos juntos cuando se pueda (el
  // volumen diario habitual tarda unos minutos nomás), PERO las
  // etiquetas nunca esperan más de TIEMPO_MAXIMO_ESPERA_EXPORT_MS: si
  // el export se demora de más (muchas ventas ese día, muchos
  // reintentos por rate-limit de Mercado Libre), las etiquetas se
  // mandan igual y el Excel llega aparte apenas termine. Así no se
  // repite lo de hoy, que no llegó ni una cosa ni la otra.
  // "ordenesPorCuenta" guarda las órdenes ya pedidas en la primera
  // pasada, para no volver a pedirlas al procesar el export.
  const ordenesPorCuenta = {};
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

      // El export a Excel (lento, con rate-limit) se procesa DESPUÉS
      // de mandar las etiquetas - acá solo se guardan las órdenes de
      // esta cuenta para no volver a pedirlas en esa segunda pasada.
      if (EXPORT_VENTAS_ACTIVA) {
        ordenesPorCuenta[cuentaId] = ordenesPendientes;
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
          // OJO: acá NO marcamos todavía cuenta.etiquetas_generadas. Se
          // marca recién más abajo, después de que el PDF combinado de
          // TODAS las cuentas se haya mandado bien por Telegram. Antes
          // se marcaba acá mismo, apenas bajada - y si el proceso se
          // reiniciaba (o se colgaba en otra cuenta) antes de llegar al
          // envío final del PDF combinado, esa etiqueta quedaba
          // marcada como "ya generada" para siempre sin haberse
          // mandado nunca. Esto es justo lo que pasó hoy.
          grupo.forEach((id) => marcasEtiquetasPendientes.push({ cuenta, shipmentId: id }));
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

  // Arrancamos el export de ventas YA (en paralelo, sin esperarlo
  // todavía) para que, si termina a tiempo, las etiquetas y el Excel
  // se manden juntos. TIEMPO_MAXIMO_ESPERA_EXPORT_MS es el límite: si
  // el export no terminó para entonces, las etiquetas se mandan igual
  // (nunca esperan de más) y el Excel llega aparte apenas esté listo.
  const TIEMPO_MAXIMO_ESPERA_EXPORT_MS = 12 * 60 * 1000; // 12 minutos
  const exportPromise =
    EXPORT_VENTAS_ACTIVA && Object.keys(ordenesPorCuenta).length
      ? procesarExportVentas(ordenesPorCuenta).catch((err) => {
          console.error('Error inesperado procesando el export de ventas:', err.response?.data || err.message);
          return { filasML: [], filasVentas: [], filasRevisar: [], marcasExportPendientes: [], huboError: true };
        })
      : Promise.resolve(null);

  let resultadoExport = null;
  let exportListoATiempo = false;
  await Promise.race([
    exportPromise.then((r) => {
      resultadoExport = r;
      exportListoATiempo = true;
    }),
    new Promise((resolve) => setTimeout(resolve, TIEMPO_MAXIMO_ESPERA_EXPORT_MS)),
  ]);

  // Combinar y mandar las etiquetas por Telegram - nunca esperan más
  // de lo de arriba, sin importar cómo venga el export.
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
      // Recién ahora que el PDF combinado se mandó bien confirmamos
      // las etiquetas como "ya generadas" - mismo criterio que la
      // planilla y el export de ventas (ver comentario donde se arma
      // marcasEtiquetasPendientes).
      for (const { cuenta, shipmentId } of marcasEtiquetasPendientes) {
        cuenta.etiquetas_generadas.push(shipmentId);
      }
      await saveData(data);
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

  // Generar y mandar por Telegram el Excel de ventas del día (para
  // pegar a mano en la planilla local). Solo si el envío sale bien
  // marcamos las órdenes como "ya exportadas" - mismo criterio que la
  // planilla de Google Sheets, para no perder ventas si falla el envío.
  let ventasExportadas = 0;
  if (exportListoATiempo) {
    // El export terminó dentro del tiempo de espera: se manda el
    // Excel ahora, junto con las etiquetas de arriba.
    if (resultadoExport?.huboError) huboError = true;
    if (resultadoExport) {
      try {
        ventasExportadas = await armarYMandarExcelVentas(resultadoExport, hoy);
      } catch (err) {
        console.error('Error generando/mandando el Excel de ventas:', err.response?.data || err.message);
        huboError = true;
      }
    }
  } else if (EXPORT_VENTAS_ACTIVA && Object.keys(ordenesPorCuenta).length) {
    // El export se está demorando más de lo normal (más ventas que lo
    // habitual, o muchos reintentos por rate-limit de Mercado Libre).
    // No vamos a retener las etiquetas por eso - ya se mandaron arriba
    // - así que lo dejamos terminar solo en segundo plano y el Excel
    // se manda aparte apenas esté listo.
    exportPromise
      .then((resultado) => armarYMandarExcelVentas(resultado, hoy))
      .catch((err) => {
        console.error('Error generando/mandando el Excel de ventas (demorado):', err.response?.data || err.message);
      });
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
    ventasParaRevisar: resultadoExport?.filasRevisar?.length || 0,
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

// Solo LEE estado guardado - no llama a la API de Mercado Libre ni
// dispara ninguna corrida. Para ver qué pasó sin arriesgarse a
// disparar un proceso nuevo por accidente (a diferencia de
// /debug/run-etiquetas-ventas, que SIEMPRE arranca una corrida).
app.get('/debug/estado-corrida', (req, res) => {
  const cuentas = {};
  for (const [id, cuenta] of Object.entries(data.cuentas || {})) {
    cuentas[id] = {
      nombre: cuenta.nombre || id,
      etiquetas_generadas: (cuenta.etiquetas_generadas || []).length,
      filas_export_cargadas: (cuenta.filas_export_cargadas || []).length,
      filas_planilla_cargadas: (cuenta.filas_planilla_cargadas || []).length,
    };
  }
  res.json({
    ahora: new Date().toISOString(),
    horaAR: horaAhoraAR(),
    hoyAR: fechaHoyAR(),
    corridaEnCurso: etiquetasVentasEnCurso,
    etiquetas_ventas_ultima_fecha: data.etiquetas_ventas_ultima_fecha || null,
    EXPORT_VENTAS_ACTIVA,
    PLANILLA_ACTIVA,
    ultimaCorrida: ultimoResultadoCorridaDiaria,
    cuentas,
  });
});

// Rescate puntual para el bug de hoy (ya arreglado en el código, esto
// es para recuperar lo que quedó mal marcado ANTES del arreglo): si un
// reinicio del proceso interrumpía la corrida después de bajar una
// etiqueta pero antes de mandar el PDF combinado, esa etiqueta quedaba
// marcada como "ya generada" sin haberse mandado nunca, y no se
// volvía a intentar. Esta ruta, para UNA cuenta puntual (?cuenta=ID),
// vuelve a pedir sus ventas recientes y saca de la lista de
// "generadas" las que todavía están pendientes - así la corrida
// normal las vuelve a bajar y mandar. Solo toca ventas recientes
// (mismo criterio que la corrida diaria), no historial viejo.
app.get('/debug/liberar-etiquetas', async (req, res) => {
  try {
    const cuentaId = req.query.cuenta;
    if (!cuentaId || !data.cuentas[cuentaId]) {
      return res.status(400).json({
        error: 'Pasá ?cuenta=ID con un id válido.',
        cuentasDisponibles: Object.keys(data.cuentas || {}),
      });
    }
    const cuenta = data.cuentas[cuentaId];
    if (!Array.isArray(cuenta.etiquetas_generadas)) cuenta.etiquetas_generadas = [];

    const token = await getAccessToken(cuentaId);
    const { data: resp } = await axios.get('https://api.mercadolibre.com/orders/search', {
      params: { seller: cuentaId, 'order.status': 'paid', sort: 'date_desc', limit: 50 },
      headers: { Authorization: `Bearer ${token}` },
    });
    const ordenesRecientes = (resp.results || []).filter((o) => esVentaReciente(o.date_created));

    const liberadas = [];
    for (const orden of ordenesRecientes) {
      const shipmentId = orden.shipping?.id;
      if (!shipmentId) continue;
      const idx = cuenta.etiquetas_generadas.indexOf(shipmentId);
      if (idx !== -1) {
        cuenta.etiquetas_generadas.splice(idx, 1);
        liberadas.push(shipmentId);
      }
    }
    await saveData(data);

    res.json({
      ok: true,
      cuenta: cuenta.nombre || cuentaId,
      liberadas,
      cantidad: liberadas.length,
      mensaje:
        liberadas.length > 0
          ? 'Listo. Ahora corré /debug/run-etiquetas-ventas para que las vuelva a bajar y mandar.'
          : 'No había ninguna etiqueta marcada como generada entre las ventas recientes de esta cuenta.',
    });
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
// Guarda el resultado de la última prueba en memoria para poder
// consultarlo con /debug/ultimo-test-excel-ventas sin depender de que
// la conexión HTTP original siga abierta (con muchas ventas, el
// proceso puede tardar varios minutos por las pausas/reintentos del
// rate-limit de Mercado Libre, más de lo que aguanta una conexión
// HTTP normal).
let ultimoResultadoTestExcel = null;

app.get('/debug/test-excel-ventas', async (req, res) => {
  // Filtros opcionales para pruebas rápidas: ?cuenta=178600583 (una
  // sola cuenta) y/o ?limite=5 (solo las primeras N ventas de esa
  // cuenta/cuentas, para no esperar varios minutos).
  const cuentaFiltro = req.query.cuenta ? String(req.query.cuenta) : null;
  const limite = req.query.limite ? Number(req.query.limite) : null;

  // Se responde YA (no se espera a que termine el proceso) porque con
  // muchas ventas esto puede tardar varios minutos (pausas + reintentos
  // por el rate-limit de Mercado Libre) y una conexión HTTP normal
  // (o el proxy de Render) se corta antes de que termine. El
  // resultado real llega por Telegram, y también queda guardado para
  // consultarlo con /debug/ultimo-test-excel-ventas.
  res.json({ ok: true, mensaje: 'Arrancó en segundo plano. El Excel llega por Telegram; el resumen también queda en /debug/ultimo-test-excel-ventas.' });

  const filasML = [];
  const filasVentas = [];
  const filasRevisar = [];
  try {
    for (const cuentaId of Object.keys(data.cuentas || {})) {
      if (cuentaFiltro && cuentaId !== cuentaFiltro) continue;
      const cuenta = data.cuentas[cuentaId];
      if (!cuenta.refresh_token) continue;
      const token = await getAccessToken(cuentaId);

      const { data: resp } = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: { seller: cuentaId, 'order.status': 'paid', sort: 'date_desc', limit: 50 },
        headers: { Authorization: `Bearer ${token}` },
      });
      let ordenesPendientes = (resp.results || []).filter((o) => esVentaReciente(o.date_created));
      if (limite) ordenesPendientes = ordenesPendientes.slice(0, limite);
      const cuentaNombre = cuenta.nombre || cuentaId;

      const itemsCuenta = [];
      for (const orden of ordenesPendientes) {
        // Pausa chica entre ventas para no pisar el límite de la API
        // de facturación de Mercado Libre (ver comentario en
        // axiosGetConReintento).
        await new Promise((r) => setTimeout(r, 400));
        const filaML = await armarFilaVentaML(cuentaId, orden, token);
        const { unidadesPorColumna, manual, itemsSinResolver } = resolverProductosOrden(orden);
        itemsCuenta.push({ filaML, unidadesPorColumna, manual, itemsSinResolver });
      }

      // Si una compra se dividió en varias "órdenes" (mismo # de
      // venta), se juntan en una sola fila - ver combinarFilasPorVenta.
      for (const { filaML, unidadesPorColumna, manual, itemsSinResolver } of combinarFilasPorVenta(itemsCuenta)) {
        filasML.push({ ...filaML, cuenta: cuentaNombre });
        filasVentas.push({
          fechaHora: filaML.fechaHora,
          nombre: filaML.nombre,
          monto: filaML.monto,
          unidadesPorColumna,
        });
        if (manual || filaML.montoExacto === false) {
          filasRevisar.push({
            id: filaML.numeroVenta,
            cuenta: cuentaNombre,
            fechaHora: filaML.fechaHora,
            monto: filaML.monto,
            montoExacto: filaML.montoExacto,
            itemsSinResolver,
          });
        }
      }
    }

    const excelBuffer = await crearExcelVentas(filasML, filasVentas, filasRevisar);
    await enviarExcelPorTelegram(
      TELEGRAM_CHAT_ID,
      excelBuffer,
      `PRUEBA_ventas_${fechaHoyAR()}.xlsx`,
      `🧪 PRUEBA (no se marcó nada como exportado) - ${filasVentas.length} fila(s), ${filasRevisar.length} para revisar a mano.`
    );
    const porMontoFallido = filasRevisar.filter((f) => f.montoExacto === false);
    const porProductoSinMapear = filasRevisar.filter((f) => f.itemsSinResolver && f.itemsSinResolver.length);
    ultimoResultadoTestExcel = {
      ok: true,
      terminadoEn: new Date().toISOString(),
      filasVentas: filasVentas.length,
      filasRevisar: filasRevisar.length,
      porMontoFallido: porMontoFallido.length,
      porProductoSinMapear: porProductoSinMapear.length,
      ejemplosMontoFallido: porMontoFallido.slice(0, 5).map((f) => ({ id: f.id, cuenta: f.cuenta })),
      ejemplosProductoSinMapear: porProductoSinMapear.slice(0, 5).map((f) => ({ id: f.id, cuenta: f.cuenta, items: f.itemsSinResolver })),
    };
  } catch (err) {
    console.error('Error en /debug/test-excel-ventas:', err.response?.data || err.message);
    ultimoResultadoTestExcel = {
      ok: false,
      terminadoEn: new Date().toISOString(),
      error: err.response?.data || err.message,
      filasVentas: filasVentas.length,
      filasRevisar: filasRevisar.length,
    };
  }
});

app.get('/debug/ultimo-test-excel-ventas', (req, res) => {
  res.json(ultimoResultadoTestExcel || { ok: null, mensaje: 'Todavía no corrió ninguna prueba (o el servidor se reinició desde la última).' });
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

// Trae el detalle de FACTURACIÓN/COSTOS real de una orden puntual,
// usando el endpoint oficial de Mercado Libre pensado justo para esto
// (no el de /orders). Es el mismo dato de fondo que arma el reporte
// "Ventas AR" que se descarga desde el panel de vendedor (columna
// "Total (ARS)"): cargo por venta, costo fijo, envío, impuestos,
// descuentos, etc. Se usa para confirmar/ajustar obtenerMontoNeto().
app.get('/debug/orden-billing', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  const { orden, pack } = req.query;
  if (!orden && !pack) return res.status(400).json({ error: 'Falta el parámetro ?orden=ID_DE_LA_ORDEN o ?pack=ID_DEL_PAQUETE' });
  try {
    const token = await getAccessToken(cuentaId);
    const params = { seller_id: cuentaId };
    if (orden) params.order_ids = orden;
    if (pack) params.pack_id = pack;
    const { data: detalle } = await axios.get('https://api.mercadolibre.com/billing/integration/group/ML/order/details', {
      params,
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(detalle);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Trae el desglose de costos de un envío puntual - se usa para
// investigar de dónde sale el monto de "Descuentos y bonificaciones"
// que Mercado Libre muestra en el detalle de la venta (y que no
// aparece en /debug/orden-billing), por si es una bonificación de
// envío gratis atada al shipment y no a la orden.
app.get('/debug/envio-costos', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  const { shipping } = req.query;
  if (!shipping) return res.status(400).json({ error: 'Falta el parámetro ?shipping=ID_DEL_ENVIO' });
  try {
    const token = await getAccessToken(cuentaId);
    const { data: costos } = await axios.get(`https://api.mercadolibre.com/shipments/${shipping}/costs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json(costos);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Genera y descarga el mismo "reporte de conciliación" oficial que
// bajás vos a mano desde el panel de Mercado Libre (el que tiene
// "Total (ARS)", "Descuentos y bonificaciones" y "Venta por
// publicidad" ya calculados por Mercado Libre) - lo pide para el
// período de facturación vigente. Es un proceso en 3 pasos (generar,
// esperar a que esté listo, descargar), así que puede tardar unos
// segundos. Si todavía no está listo, avisa el estado para reintentar.
app.get('/debug/reporte-ventas-ml', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  try {
    const token = await getAccessToken(cuentaId);

    const { data: periodos } = await axios.get('https://api.mercadolibre.com/billing/integration/monthly/periods', {
      params: { group: 'ML', document_type: 'BILL' },
      headers: { Authorization: `Bearer ${token}` },
    });
    const periodo = (periodos.results || []).find((p) => p.period_status === 'OPEN') || periodos.results?.[0];
    if (!periodo) return res.status(404).json({ error: 'No se encontró ningún período de facturación.', periodos });

    const { data: gen } = await axios.post(
      `https://api.mercadolibre.com/billing/integration/periods/key/${periodo.key}/reports`,
      { group: 'ML', document_type: 'BILL', report_format: 'CSV' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const fileId = gen.fileId || gen.file_id;
    if (!fileId) return res.json({ ok: false, mensaje: 'No vino fileId en la respuesta de generación.', respuesta: gen });

    let estado = 'PROCESSING';
    for (let i = 0; i < 8 && estado === 'PROCESSING'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data: st } = await axios.get(`https://api.mercadolibre.com/billing/integration/reports/${fileId}/status`, {
        params: { document_type: 'BILL' },
        headers: { Authorization: `Bearer ${token}` },
      });
      estado = st.status;
    }
    if (estado !== 'READY') {
      return res.json({
        ok: false,
        estado,
        fileId,
        periodo: periodo.key,
        mensaje: 'El reporte todavía se está generando. Probá de nuevo en unos minutos con /debug/reporte-ventas-ml-descargar?cuenta=...&fileId=' + fileId,
      });
    }

    const { data: contenido } = await axios.get(`https://api.mercadolibre.com/billing/integration/reports/${fileId}`, {
      params: { document_type: 'BILL' },
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });
    const buffer = Buffer.from(contenido);
    // Si son los primeros bytes "PK" es un zip (xlsx/ods), no texto plano.
    const esBinario = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    if (req.query.base64) {
      res.type('text/plain').send(buffer.toString('base64'));
    } else if (esBinario) {
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="reporte_${cuentaId}_${fileId}.xlsx"`);
      res.send(buffer);
    } else {
      res.type('text/plain').send(buffer.toString('utf8').slice(0, 20000));
    }
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Descarga un reporte ya generado (por fileId) sin volver a pedirlo -
// para cuando /debug/reporte-ventas-ml avisó que todavía estaba
// PROCESSING y hay que esperar y reintentar la descarga sola.
// Agregá &base64=1 para recibirlo como texto base64 (útil para
// reconstruir el archivo binario fuera del navegador).
app.get('/debug/reporte-ventas-ml-descargar', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  const { fileId } = req.query;
  if (!fileId) return res.status(400).json({ error: 'Falta el parámetro ?fileId=...' });
  try {
    const token = await getAccessToken(cuentaId);
    const { data: contenido } = await axios.get(`https://api.mercadolibre.com/billing/integration/reports/${fileId}`, {
      params: { document_type: 'BILL' },
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });
    const buffer = Buffer.from(contenido);
    const esBinario = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    if (req.query.base64) {
      res.type('text/plain').send(buffer.toString('base64'));
    } else if (esBinario) {
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="reporte_${cuentaId}_${fileId}.xlsx"`);
      res.send(buffer);
    } else {
      res.type('text/plain').send(buffer.toString('utf8').slice(0, 20000));
    }
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Lista las últimas ventas pagadas de una cuenta con TODOS los IDs
// relacionados (order_id, pack_id, shipping_id) para poder comparar
// contra el "# de venta" que muestra el reporte "Ventas AR" de
// Mercado Libre y averiguar cuál de estos IDs es el que corresponde.
// De paso, prueba el llamado a billing_info (nombre real de
// facturación) para cada una y muestra si funciona o si falla (y por
// qué), para diagnosticar por qué seguían apareciendo nicknames.
app.get('/debug/ordenes-recientes', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  const limit = Math.min(Number(req.query.limit) || 15, 50);
  const offset = Number(req.query.offset) || 0;
  try {
    const token = await getAccessToken(cuentaId);
    const { data: resp } = await axios.get('https://api.mercadolibre.com/orders/search', {
      params: { seller: cuentaId, 'order.status': 'paid', sort: 'date_desc', limit, offset },
      headers: { Authorization: `Bearer ${token}` },
    });
    const resultado = [];
    for (const orden of resp.results || []) {
      let billingInfo = null;
      let errorBilling = null;
      try {
        const { data: fact } = await axios.get(`https://api.mercadolibre.com/orders/${orden.id}/billing_info`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        billingInfo = fact?.billing_info || fact;
      } catch (err) {
        errorBilling = err.response?.data || err.message;
      }
      resultado.push({
        order_id: orden.id,
        pack_id: orden.pack_id || null,
        shipping_id: orden.shipping?.id || null,
        fecha: orden.date_created,
        nickname_comprador: orden.buyer?.nickname || null,
        tags: orden.tags || null,
        context: orden.context || null,
        billing_info: billingInfo,
        error_billing_info: errorBilling,
      });
    }
    res.json({ cantidad: resultado.length, ordenes: resultado });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Trae el detalle COMPLETO (sin filtrar campos) de una orden puntual,
// y de paso el monto neto calculado con obtenerMontoNeto() (que usa
// la API de Facturación, ver más abajo) para poder comparar contra lo
// que muestra Mercado Libre en el detalle de la venta.
app.get('/debug/orden-detalle', async (req, res) => {
  const { id: cuentaId, error } = resolverCuentaId(req);
  if (error) return res.status(400).json({ error });
  const { orden } = req.query;
  if (!orden) return res.status(400).json({ error: 'Falta el parámetro ?orden=ID_DE_LA_ORDEN' });
  try {
    const token = await getAccessToken(cuentaId);
    const { data: detalle } = await axios.get(`https://api.mercadolibre.com/orders/${orden}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { monto, exacto } = await obtenerMontoNeto(cuentaId, detalle, token);
    res.json({
      total_amount: detalle.total_amount,
      monto_neto_calculado: monto,
      exacto,
      payments: detalle.payments,
      orden_completa: detalle,
    });
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
