require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const {
  ML_CLIENT_ID,
  ML_CLIENT_SECRET,
  ML_REDIRECT_URI,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  PORT = 3000,
} = process.env;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ---------------------------------------------------------------------
// "Memoria" del bot: en vez de guardar un archivo en el servidor (que
// se borra cada vez que Render lo reinicia), la guardamos en una base
// de datos gratuita externa (Upstash). Así el bot nunca "se olvida"
// de que ya conectaste tu cuenta.
// ---------------------------------------------------------------------

const upstashHeaders = { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` };

async function loadData() {
  const empty = { access_token: null, refresh_token: null, expires_at: 0, pending: {} };
  try {
    const res = await axios.get(`${UPSTASH_REDIS_REST_URL}/get/botdata`, { headers: upstashHeaders });
    if (!res.data.result) return empty;
    return JSON.parse(res.data.result);
  } catch (err) {
    console.error('Error leyendo memoria del bot:', err.response?.data || err.message);
    return empty;
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
// que algo cambia (se conecta la cuenta, llega una pregunta, se
// renueva el token) se actualiza acá Y se guarda en Upstash.
let data = { access_token: null, refresh_token: null, expires_at: 0, pending: {} };

// =====================================================================
// PASO A: Conectar tu cuenta de Mercado Libre (solo se hace una vez)
// =====================================================================

// Si entrás a la URL principal de tu servidor, te va a mostrar un link
// para autorizar tu cuenta de Mercado Libre. Hacé click ahí una sola vez.
app.get('/', (req, res) => {
  if (!ML_CLIENT_ID || !ML_REDIRECT_URI) {
    return res.send('Faltan variables de entorno ML_CLIENT_ID / ML_REDIRECT_URI. Revisá la configuración.');
  }
  const authUrl = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}`;
  res.send(`
    <h2>Bot Mercado Libre + Telegram</h2>
    <p>Estado de la conexión con Mercado Libre: <b>${data.refresh_token ? 'Conectado ✅' : 'No conectado ❌'}</b></p>
    <p><a href="${authUrl}">Conectar / reconectar mi cuenta de Mercado Libre</a></p>
  `);
});

// Mercado Libre te redirige acá después de que autorizás tu cuenta.
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
    data.access_token = response.data.access_token;
    data.refresh_token = response.data.refresh_token;
    data.expires_at = Date.now() + response.data.expires_in * 1000;
    saveData(data);
    res.send('✅ ¡Listo! Tu cuenta de Mercado Libre quedó conectada. Ya podés cerrar esta pestaña.');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('❌ Hubo un error al conectar con Mercado Libre. Revisá los datos en el archivo .env');
  }
});

// Mercado Libre da tokens que vencen cada 6 horas. Esta función los
// renueva sola, así vos no tenés que hacer nada manualmente.
async function getAccessToken() {
  if (!data.refresh_token) {
    throw new Error('Todavía no conectaste tu cuenta de Mercado Libre. Entrá a la URL principal del servidor y hacé click en el link.');
  }
  if (Date.now() < data.expires_at - 60000) {
    return data.access_token;
  }
  const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: data.refresh_token,
    },
  });
  data.access_token = response.data.access_token;
  data.refresh_token = response.data.refresh_token;
  data.expires_at = Date.now() + response.data.expires_in * 1000;
  saveData(data);
  return data.access_token;
}

// =====================================================================
// PASO B: Recibir avisos de Mercado Libre cuando llega una pregunta
// =====================================================================

app.post('/ml/notifications', async (req, res) => {
  // Mercado Libre exige una respuesta rápida (200 OK), así que contestamos
  // de inmediato y procesamos el resto por atrás.
  res.sendStatus(200);

  const { topic, resource } = req.body || {};
  if (topic !== 'questions') return; // Por ahora solo manejamos preguntas

  try {
    const token = await getAccessToken();

    const { data: question } = await axios.get(`https://api.mercadolibre.com${resource}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (question.status !== 'UNANSWERED') return; // Ya fue respondida (por ej. desde la app de ML)

    const { data: item } = await axios.get(`https://api.mercadolibre.com/items/${question.item_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const texto =
      `❓ Nueva pregunta\n\n` +
      `🛒 Producto: ${item.title}\n\n` +
      `💬 Pregunta: ${question.text}\n\n` +
      `Respondé este mensaje (con "Responder" / "Reply") con el texto que querés enviar al comprador.`;

    const tgResponse = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: texto,
    });

    // Guardamos a qué pregunta corresponde este mensaje de Telegram,
    // para saber qué hacer cuando el vendedor responda.
    const sentMessageId = tgResponse.data.result.message_id;
    data.pending[sentMessageId] = question.id;
    saveData(data);
  } catch (err) {
    console.error('Error procesando pregunta:', err.response?.data || err.message);
  }
});

// =====================================================================
// PASO C: Recibir la respuesta que el vendedor escribe en Telegram
// =====================================================================

app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200);

  const message = req.body.message;
  // Solo nos interesa cuando el vendedor RESPONDE (reply) a un mensaje del bot
  if (!message || !message.reply_to_message || !message.text) return;

  const repliedId = message.reply_to_message.message_id;
  const questionId = data.pending[repliedId];
  if (!questionId) return; // No corresponde a ninguna pregunta pendiente

  try {
    const token = await getAccessToken();

    await axios.post(
      'https://api.mercadolibre.com/answers',
      { question_id: questionId, text: message.text },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    delete data.pending[repliedId];
    saveData(data);

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: '✅ Respuesta enviada correctamente a Mercado Libre.',
    });
  } catch (err) {
    console.error('Error respondiendo pregunta:', err.response?.data || err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: '❌ Hubo un error al enviar la respuesta a Mercado Libre. Probá de nuevo en un momento.',
    });
  }
});

async function start() {
  data = await loadData();
  app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
}

start();
