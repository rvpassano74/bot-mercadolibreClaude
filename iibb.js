// =====================================================================
// REPORTE DE INGRESOS BRUTOS (comando /iibb en Telegram y GET /api/iibb)
// Por cuenta y para un mes calendario:
//  - Ventas: órdenes cerradas en el mes (hora argentina). Bruto = total
//    de cada orden; devoluciones = lo reembolsado en sus pagos (o el
//    total si quedó cancelada sin reembolso registrado); neto = bruto − devoluciones.
//  - Percepciones: las de las facturas que ML emitió en ese mes (fecha de
//    factura dentro del mes), separadas en CABA, Buenos Aires, IVA y Otras.
//    ML factura por período (ej. 08/09 al 07/10), no por mes calendario,
//    por eso se informa el período usado.
// =====================================================================

const sinAcentos = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function clasificarPercepcion(texto) {
  const d = sinAcentos(texto);
  if (/valor agregado|\biva\b/.test(d)) return 'IVA';
  if (/caba|capital federal|ciudad autonoma|ciudad de buenos aires|agip/.test(d)) return 'CABA';
  if (/buenos aires|bs\.? ?as|arba/.test(d)) return 'Buenos Aires';
  return 'Otras';
}

const JURIS = ['CABA', 'Buenos Aires', 'IVA', 'Otras'];
const r2 = (x) => Math.round(x * 100) / 100;

function mesAnteriorAR(zonaHoraria) {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: zonaHoraria }).format(new Date());
  const [y, m] = hoy.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function registrarIIBB(app, { mlGet, getCuentas, zonaHoraria }) {
  async function ventasDelMes(cuentaId, mes) {
    const [y, m] = mes.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const desde = `${mes}-01T00:00:00.000-03:00`;
    const hasta = `${mes}-${String(ultimo).padStart(2, '0')}T23:59:59.999-03:00`;
    const r = { ordenes: 0, bruto: 0, devoluciones: 0, neto: 0, conDevolucion: [] };
    for (let offset = 0; ; offset += 50) {
      const q = new URLSearchParams({ seller: cuentaId, 'order.date_closed.from': desde, 'order.date_closed.to': hasta, sort: 'date_asc', limit: '50', offset: String(offset) });
      const pagina = await mlGet(cuentaId, `/orders/search?${q}`);
      for (const o of pagina.results || []) {
        const reembolsado = (o.payments || []).reduce((s, p) => s + (p.transaction_amount_refunded || 0), 0);
        let dev = Math.min(o.total_amount, reembolsado);
        if (o.status === 'cancelled' && dev === 0) dev = o.total_amount;
        r.ordenes++;
        r.bruto += o.total_amount;
        r.devoluciones += dev;
        if (dev > 0) r.conDevolucion.push({ id: o.id, estado: o.status, total: o.total_amount, devuelto: r2(dev) });
      }
      if (!pagina.results?.length || offset + 50 >= (pagina.paging?.total || 0)) break;
    }
    r.bruto = r2(r.bruto); r.devoluciones = r2(r.devoluciones); r.neto = r2(r.bruto - r.devoluciones);
    return r;
  }

  // La API de facturación pide consultas de a una y espaciadas: si responde 429
  // (demasiados pedidos) esperamos y reintentamos.
  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
  async function billingGet(cuentaId, path) {
    for (let intento = 1; ; intento++) {
      await pausa(1500);
      try {
        return await mlGet(cuentaId, path);
      } catch (e) {
        // ML a veces devuelve el límite como 400 con el texto "429".
        const limite = e.response?.status === 429 || /429|rate.?limit/i.test(JSON.stringify(e.response?.data || ''));
        if (!limite || intento >= 4) throw e;
        await pausa(15000 * intento);
      }
    }
  }

  async function percepcionesDelMes(cuentaId, mes) {
    const per = await billingGet(cuentaId, '/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=12');
    const periodos = (per.results || []).map((p) => ({ key: p.key, desde: p.period.date_from, hasta: p.period.date_to, estado: p.period_status }));
    // La factura de un período sale el día en que cierra (fecha de factura = último día del período).
    const candidatos = periodos.filter((p) => p.hasta.slice(0, 7) === mes);
    const lineas = [];
    const usados = [];
    for (const p of candidatos) {
      const r = await billingGet(cuentaId, `/billing/integration/periods/key/${p.key}/perceptions/summary?group=ML&currency=ARS`);
      const delMes = (r.summary || []).filter((x) => String(x.bill_date || '').slice(0, 7) === mes);
      if (delMes.length) usados.push(p);
      for (const x of delMes) {
        lineas.push({
          // A veces la descripción del régimen es solo un código (ej. MLA_RE_IVA): usamos la del impuesto.
          descripcion: (/\s/.test(x.regimen_tax_type_description || '') ? x.regimen_tax_type_description : x.tax_type_description) || x.tax_type,
          codigo: x.tax_type,
          jurisdiccion: clasificarPercepcion(`${x.regimen_tax_type_description || ''} ${x.tax_type_description || ''}`),
          base: x.taxable_amount, alicuota: x.aliquot, monto: x.amount,
          fecha: x.bill_date, factura: x.legal_document_number, estado: x.status,
        });
      }
    }
    const totales = Object.fromEntries(JURIS.map((j) => [j, r2(lineas.filter((l) => l.jurisdiccion === j).reduce((s, l) => s + l.monto, 0))]));
    return { periodos: usados, totales, lineas };
  }

  async function armarReporte(mes) {
    const cuentas = [];
    for (const [id, c] of Object.entries(getCuentas())) {
      if (!c.refresh_token) continue;
      const fila = { cuentaId: id, cuenta: c.nombre || id };
      try { fila.ventas = await ventasDelMes(id, mes); } catch (e) { fila.errorVentas = e.response?.data?.message || e.message; }
      try { fila.percepciones = await percepcionesDelMes(id, mes); } catch (e) {
        const st = e.response?.status;
        fila.errorPercepciones = st === 403 ? 'sin permiso de facturación (habría que volver a autorizar la cuenta)' : (e.response?.data?.message || e.message);
      }
      cuentas.push(fila);
    }
    const tot = { ordenes: 0, bruto: 0, devoluciones: 0, neto: 0, ...Object.fromEntries(JURIS.map((j) => [j, 0])) };
    for (const c of cuentas) {
      if (c.ventas) for (const k of ['ordenes', 'bruto', 'devoluciones', 'neto']) tot[k] += c.ventas[k];
      if (c.percepciones) for (const j of JURIS) tot[j] += c.percepciones.totales[j];
    }
    for (const k of Object.keys(tot)) tot[k] = r2(tot[k]);
    return { mes, generado: new Date().toISOString(), cuentas, totales: tot };
  }

  const pesos = (x) => `$ ${Number(x || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const ddmm = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

  function texto(rep) {
    const [y, m] = rep.mes.split('-');
    const nombreMes = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(+y, +m - 1, 1)));
    const out = [`🧾 Ingresos Brutos — ${nombreMes}`, ''];
    for (const c of rep.cuentas) {
      out.push(`▪️ ${c.cuenta}`);
      if (c.ventas) {
        out.push(`Ventas: ${c.ventas.ordenes}`, `Bruto: ${pesos(c.ventas.bruto)}`, `Devoluciones/cancelaciones: ${pesos(c.ventas.devoluciones)} (${c.ventas.conDevolucion.length} órdenes)`, `Neto: ${pesos(c.ventas.neto)}`);
      } else out.push(`Ventas: no se pudieron leer (${c.errorVentas})`);
      if (c.percepciones) {
        const p = c.percepciones;
        out.push(`Percepciones (facturas ${p.periodos.length ? p.periodos.map((x) => `período ${ddmm(x.desde)} al ${ddmm(x.hasta)}`).join(', ') : 'ninguna emitida en el mes'}):`);
        out.push(`  IIBB CABA: ${pesos(p.totales.CABA)}`, `  IIBB Buenos Aires: ${pesos(p.totales['Buenos Aires'])}`, `  IVA: ${pesos(p.totales.IVA)}`, `  Otras: ${pesos(p.totales.Otras)}`);
        for (const l of p.lineas.filter((x) => x.jurisdiccion === 'Otras')) out.push(`    · ${l.descripcion}: ${pesos(l.monto)}`);
      } else out.push(`Percepciones: no se pudieron leer (${c.errorPercepciones})`);
      out.push('');
    }
    const t = rep.totales;
    out.push('➕ TOTAL', `Bruto: ${pesos(t.bruto)}`, `Devoluciones: ${pesos(t.devoluciones)}`, `Neto: ${pesos(t.neto)}`,
      `IIBB CABA: ${pesos(t.CABA)} · IIBB Bs. As.: ${pesos(t['Buenos Aires'])} · IVA: ${pesos(t.IVA)} · Otras: ${pesos(t.Otras)}`,
      '', 'Ventas por fecha de cierre de la orden. Percepciones de las facturas de ML emitidas en el mes.');
    return out.join('\n');
  }

  const mesValido = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');

  // El dashboard pide el mismo mes muchas veces: guardamos cada reporte 1 hora
  // (y compartimos el cálculo si llegan dos pedidos a la vez). Si salió con
  // errores no se guarda.
  const cache = new Map();
  const UNA_HORA = 60 * 60 * 1000;
  function reporteConCache(mes, { nuevo = false } = {}) {
    const c = cache.get(mes);
    if (c && !nuevo && (c.calculando || Date.now() - c.at < UNA_HORA)) return c.promesa;
    const promesa = armarReporte(mes);
    const entrada = { at: Date.now(), promesa, calculando: true };
    cache.set(mes, entrada);
    promesa.then((rep) => {
      entrada.calculando = false;
      entrada.at = Date.now();
      if (rep.cuentas.some((x) => x.errorVentas || x.errorPercepciones) && cache.get(mes) === entrada) cache.delete(mes);
    }, () => { if (cache.get(mes) === entrada) cache.delete(mes); });
    return promesa;
  }

  // GET /api/iibb?month=2026-10 (protegido con la misma clave que /api/*). &nuevo=1 recalcula.
  app.get('/api/iibb', async (req, res) => {
    const mes = req.query.month || mesAnteriorAR(zonaHoraria);
    if (!mesValido(mes)) return res.status(400).json({ error: 'month tiene que ser AAAA-MM, por ejemplo 2026-10.' });
    try { res.json(await reporteConCache(mes, { nuevo: req.query.nuevo === '1' })); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Devuelve el texto para Telegram a partir de lo que escribió el usuario ("/iibb" o "/iibb 2026-10").
  async function responderComando(textoMensaje) {
    const arg = textoMensaje.trim().split(/\s+/)[1];
    const mes = arg || mesAnteriorAR(zonaHoraria);
    if (!mesValido(mes)) return 'Usá /iibb para el mes anterior, o /iibb AAAA-MM (por ejemplo /iibb 2026-10).';
    return texto(await reporteConCache(mes, { nuevo: true }));
  }

  return { armarReporte, responderComando };
}

module.exports = { registrarIIBB, clasificarPercepcion };
