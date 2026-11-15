// =====================================================================
// DASHBOARD DE VENTAS (página /dashboard)
// Junta, para las cuentas conectadas, el último año de ventas, visitas,
// publicaciones y reputación, y lo deja armado en memoria. Se recalcula
// cada 2 horas y cuando se aprieta "Actualizar" en la página.
// La página y sus datos piden la misma clave que el resto del bot
// (?key=BOT_API_KEY).
// =====================================================================

const path = require('path');

const DIAS = 365;
const CADA_MS = 2 * 60 * 60 * 1000;
const ESPERA_MINIMA_MS = 5 * 60 * 1000; // entre actualizaciones manuales

function registrarDashboard(app, { mlGet, getCuentas, zonaHoraria }) {
  const fechaAR = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: zonaHoraria }).format(d);
  const sumarDias = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const estado = { datos: null, enCurso: false, inicio: null, error: null };

  // Corre fn sobre cada elemento, de a "n" a la vez. Si uno falla, queda null.
  async function enParalelo(lista, n, fn) {
    const out = new Array(lista.length).fill(null);
    let i = 0;
    const trabajador = async () => {
      while (i < lista.length) {
        const k = i++;
        try { out[k] = await fn(lista[k]); } catch (e) { out[k] = null; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, lista.length) }, trabajador));
    return out;
  }

  // ML da visitas diarias de a 150 días como máximo: pedimos en tramos.
  async function visitasDiarias(cuentaId, base, hasta) {
    const out = {};
    let fin = hasta;
    let faltan = DIAS;
    while (faltan > 0) {
      const n = Math.min(150, faltan);
      try {
        const r = await mlGet(cuentaId, `${base}/time_window?last=${n}&unit=day&ending=${fin}`);
        for (const x of r.results || []) out[x.date.slice(0, 10)] = x.total;
      } catch (e) { /* sin visitas para ese tramo */ }
      fin = sumarDias(fin, -n);
      faltan -= n;
    }
    return out;
  }

  async function ordenesDelAnio(cuentaId, desde) {
    const ordenes = [];
    for (let offset = 0; ; offset += 50) {
      const r = await mlGet(cuentaId, `/orders/search?seller=${cuentaId}&order.date_created.from=${desde}T00:00:00.000-03:00&sort=date_desc&limit=50&offset=${offset}`);
      ordenes.push(...(r.results || []));
      if (!r.results?.length || offset + 50 >= (r.paging?.total || 0)) break;
    }
    return ordenes;
  }

  async function idsActivos(cuentaId) {
    const ids = [];
    let scroll = null;
    for (;;) {
      const r = await mlGet(cuentaId, `/users/${cuentaId}/items/search?status=active&search_type=scan&limit=100${scroll ? `&scroll_id=${scroll}` : ''}`);
      if (!r.results?.length) break;
      ids.push(...r.results);
      scroll = r.scroll_id;
      if (!scroll) break;
    }
    return [...new Set(ids)];
  }

  async function datosDeCuenta(cuentaId, nombre, desde, hasta) {
    const [usuario, preguntas, ordenes, activos] = await Promise.all([
      mlGet(cuentaId, `/users/${cuentaId}`).catch(() => ({})),
      mlGet(cuentaId, `/questions/search?seller_id=${cuentaId}&status=UNANSWERED&limit=1`).catch(() => ({})),
      ordenesDelAnio(cuentaId, desde),
      idsActivos(cuentaId),
    ]);
    const visitasCuenta = await visitasDiarias(cuentaId, `/users/${cuentaId}/items_visits`, hasta);

    const activosSet = new Set(activos);
    const vendidos = [...new Set(ordenes.flatMap((o) => (o.order_items || []).map((it) => it.item.id)))].filter((id) => !activosSet.has(id));

    const detalle = async (id, activo) => {
      let d = null;
      try { d = await mlGet(cuentaId, `/items/${id}`); } catch (e) { d = null; }
      // Los productos de Mercado Pago (links de pago) no son publicaciones de ML.
      if (activo && d && d.channels && !d.channels.includes('marketplace')) return null;
      return {
        id, activo, titulo: d?.title || null, precio: d?.price ?? null, stock: d?.available_quantity ?? null,
        link: d?.permalink || null, envio: d?.shipping?.logistic_type || null,
        visitas: await visitasDiarias(cuentaId, `/items/${id}/visits`, hasta),
      };
    };
    const items = (await enParalelo([...activos.map((id) => [id, true]), ...vendidos.map((id) => [id, false])], 5, ([id, a]) => detalle(id, a))).filter(Boolean);

    const rep = usuario.seller_reputation || {};
    return { cuentaId, nombre, nickname: usuario.nickname, rep, preguntas, ordenes, items, visitasCuenta };
  }

  // Arma las mismas tablas que usa la página.
  function agregar(cuentas, desde, hasta) {
    const dias = [];
    for (let d = desde; d <= hasta; d = sumarDias(d, 1)) dias.push(d);
    const ventas_diarias = [];
    const prodMes = new Map();
    const fila = (mes, cuenta, id, titulo) => {
      const k = `${mes}|${cuenta}|${id}`;
      if (!prodMes.has(k)) prodMes.set(k, { mes, cuenta, item_id: id, titulo, ordenes: 0, unidades: 0, facturacion: 0, visitas: 0 });
      return prodMes.get(k);
    };
    const cuentasOut = [];
    const catalogo = [];

    for (const c of cuentas) {
      const porDia = {};
      for (const o of c.ordenes) {
        const dia = fechaAR(new Date(o.date_created));
        const d = (porDia[dia] = porDia[dia] || { ordenes: 0, unidades: 0, facturacion: 0, canceladas: 0 });
        if (!['paid', 'partially_refunded'].includes(o.status)) {
          if (o.status === 'cancelled') d.canceladas++;
          continue;
        }
        d.ordenes++;
        for (const it of o.order_items || []) {
          const monto = it.quantity * it.unit_price;
          d.unidades += it.quantity;
          d.facturacion += monto;
          const p = fila(dia.slice(0, 7), c.nombre, it.item.id, it.item.title);
          p.ordenes++; p.unidades += it.quantity; p.facturacion += monto;
        }
      }
      for (const dia of dias) {
        const d = porDia[dia] || { ordenes: 0, unidades: 0, facturacion: 0, canceladas: 0 };
        ventas_diarias.push({ fecha: dia, cuenta: c.nombre, ordenes: d.ordenes, unidades: d.unidades,
          facturacion: Math.round(d.facturacion * 100) / 100, canceladas: d.canceladas, visitas: c.visitasCuenta[dia] || 0 });
      }
      for (const it of c.items) {
        const porMes = {};
        for (const [dia, v] of Object.entries(it.visitas)) {
          if (dia < desde || dia > hasta) continue;
          porMes[dia.slice(0, 7)] = (porMes[dia.slice(0, 7)] || 0) + v;
        }
        for (const [mes, v] of Object.entries(porMes)) fila(mes, c.nombre, it.id, it.titulo).visitas = v;
        catalogo.push({ cuenta: c.nombre, item_id: it.id, titulo: it.titulo, precio: it.precio, stock: it.stock,
          estado: it.activo ? 'activa' : (it.titulo ? 'inactiva' : 'borrada'), envio: it.envio, link: it.link });
      }
      const m = c.rep.metrics || {};
      cuentasOut.push({ cuenta: c.nombre, nickname: c.nickname, reputacion: c.rep.level_id || null, mercadolider: c.rep.power_seller_status || null,
        reclamos: m.claims?.rate ?? null, cancelaciones: m.cancellations?.rate ?? null, demoras: m.delayed_handling_time?.rate ?? null,
        preguntas_sin_responder: typeof c.preguntas.total === 'number' ? c.preguntas.total : (c.preguntas.paging?.total ?? null),
        publicaciones_activas: c.items.filter((i) => i.activo).length });
    }
    const productos_mes = [...prodMes.values()].map((p) => ({ ...p, facturacion: Math.round(p.facturacion * 100) / 100 }));
    return { ventas_diarias, productos_mes, cuentas: cuentasOut, catalogo };
  }

  async function actualizar() {
    if (estado.enCurso) return;
    estado.enCurso = true;
    estado.inicio = Date.now();
    try {
      const hasta = fechaAR(new Date());
      const desde = sumarDias(hasta, -DIAS);
      const cuentas = [];
      for (const [id, c] of Object.entries(getCuentas())) {
        if (!c.refresh_token) continue;
        cuentas.push(await datosDeCuenta(id, c.nombre || id, desde, hasta));
      }
      estado.datos = { generado: new Date().toISOString(), desde, hasta, ...agregar(cuentas, desde, hasta) };
      estado.error = null;
      console.log(`📊 Dashboard actualizado en ${Math.round((Date.now() - estado.inicio) / 1000)} s`);
    } catch (err) {
      estado.error = err.response?.data?.message || err.message;
      console.error('📊 Error armando el dashboard:', estado.error);
    } finally {
      estado.enCurso = false;
    }
  }

  app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

  app.get('/dashboard/datos', (req, res) => {
    if (!estado.datos) {
      if (!estado.enCurso) actualizar();
      return res.status(202).json({ calculando: true, desde: estado.inicio, error: estado.error });
    }
    res.json({ ...estado.datos, actualizando: estado.enCurso, error: estado.error });
  });

  app.post('/dashboard/actualizar', (req, res) => {
    const ultima = estado.datos ? Date.parse(estado.datos.generado) : 0;
    if (!estado.enCurso && Date.now() - ultima > ESPERA_MINIMA_MS) actualizar();
    res.json({ actualizando: estado.enCurso });
  });

  return {
    iniciar() {
      setTimeout(actualizar, 2 * 60 * 1000); // 2 minutos después de arrancar
      setInterval(actualizar, CADA_MS);
    },
  };
}

module.exports = { registrarDashboard };
