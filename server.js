require('dotenv').config();
const express = require('express');
const axios = require('axios');

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
  return { cuentas: {}, pending: {} };
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

        const texto =
          `🏪 Cuenta: ${cuenta.nombre}\n\n` +
          `💰 ¡Nueva venta!\n\n` +
          `🧾 Orden: ${orden.id}\n` +
          `👤 Comprador: ${comprador}\n` +
          `📦 Producto(s):\n${productos}\n\n` +
          `💵 Total: ${total}`;

        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatDe(cuenta), text: texto });

        // Además del aviso en el chat propio de la cuenta, mandamos una
        // línea corta al chat de resumen combinado (si está configurado),
        // para tener ahí el total de ventas de todas las cuentas juntas.
        if (TELEGRAM_CHAT_ID_RESUMEN) {
          const textoResumen = `💰 Venta en ${cuenta.nombre}: ${total} (orden ${orden.id})`;
          await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID_RESUMEN, text: textoResumen });
        }

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

async function revisarTodo() {
  await revisarPreguntasNuevas();
  await revisarVentasNuevas();
  await revisarReclamosNuevos();
  await revisarStockBajo();
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
    const cuenta = data.cuentas[cuentaId];
    const texto =
      `🏪 Cuenta: ${cuenta.nombre}\n\n` +
      `💰 ¡Nueva venta! (prueba)\n\n` +
      `🧾 Orden: ${orden.id}\n` +
      `👤 Comprador: ${comprador}\n` +
      `📦 Producto(s):\n${productos}\n\n` +
      `💵 Total: ${total}`;
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatDe(cuenta), text: texto });

    if (TELEGRAM_CHAT_ID_RESUMEN) {
      const textoResumen = `💰 Venta en ${cuenta.nombre}: ${total} (orden ${orden.id}) (prueba)`;
      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID_RESUMEN, text: textoResumen });
    }

    res.json({ ok: true });
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

async function start() {
  data = await loadData();
  await saveData(data); // por si se acaba de migrar del formato viejo
  app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
  setInterval(revisarTodo, 60 * 1000); // cada 1 minuto
  revisarTodo(); // y una vez apenas arranca
}

start();
