require("dotenv").config(); // Cargar variables de entorno desde .env (si existe)

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const http = require("http");
const { Server } = require("socket.io"); // WebSocket para notificar al frontend

// --- CONFIGURACIÓN ---

// Clave de Gemini: se lee desde variable de entorno.
// En Koyeb debes crear una env var llamada "GEMINI_API_KEY" con tu clave real.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error(
    "❌ Falta la variable de entorno GEMINI_API_KEY. Configúrala en Koyeb (o en tu entorno local) antes de ejecutar el bot.",
  );
  process.exit(1);
}

const SUCURSAL_ID = 1;
// Base de la API pública en línea
// Si quieres cambiarla en el futuro, puedes crear también una env var API_BASE_URL.
const API_BASE_URL =
  process.env.API_BASE_URL ||
  "https://shellfruty.sistemastarija.com/public/api/v1";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const sesiones = {};
let CATALOGO_CACHE = null;
let MENUS_ARRAY = []; // Array normalizado de menús para búsquedas internas
// --- Buffers y temporizadores para agrupar mensajes por usuario ---
const buffers = {}; // { sender: [mensajes] }
const timers = {}; // { sender: timeoutId }
const BUFFER_TIMEOUT_MS = 12000; // 10 segundos

const MODELOS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

// --- TAKEOVER POR OPERADOR ---
const PREFIJO_PEDIDO = "!pedido";             // cambialo si querés otro prefijo
const TAKEOVER_MS = 30 * 60 * 1000;            // 30 min de silencio tras mensaje del operador
const TAKEOVER_BIENVENIDA_MS = 45 * 60 * 1000; // más de 45 min: vuelve a dar bienvenida
const operadorActivo = {};  // { jid: timestamp } — cuándo tomó control el operador
const botJidsActivos = new Set(); // JIDs normalizados donde el bot acaba de enviar

// Quita el sufijo @s.whatsapp.net / @lid / @g.us para comparaciones
function normJid(jid) {
  return jid ? jid.replace(/@.*$/, "") : "";
}

// Wrapper de sock.sendMessage que registra el JID como "enviado por el bot"
// para que el handler fromMe no lo confunda con mensaje del operador
async function botSend(sock, jid, content) {
  const n = normJid(jid);
  botJidsActivos.add(n);
  setTimeout(() => botJidsActivos.delete(n), 12000);
  return sock.sendMessage(jid, content);
}

// --- FUNCIONES DE SOPORTE ---

async function cargarCatalogo() {
  try {
    // Catálogo completo con reglas de personalización.
    const res = await axios.get(`${API_BASE_URL}/bot/catalogo`);
    CATALOGO_CACHE = res.data;
    // Normalizar el array de menús sin importar la estructura del API
    if (Array.isArray(CATALOGO_CACHE)) {
      MENUS_ARRAY = CATALOGO_CACHE;
    } else if (Array.isArray(CATALOGO_CACHE.menus)) {
      MENUS_ARRAY = CATALOGO_CACHE.menus;
    } else if (Array.isArray(CATALOGO_CACHE.data)) {
      MENUS_ARRAY = CATALOGO_CACHE.data;
    } else {
      // Buscar el primer array en el objeto como último recurso
      const primerArray = Object.values(CATALOGO_CACHE).find((v) =>
        Array.isArray(v),
      );
      MENUS_ARRAY = primerArray || [];
    }
    console.log(
      `✅ Catálogo cargado de Laravel con éxito — ${MENUS_ARRAY.length} menús disponibles`,
    );
  } catch (error) {
    console.error("❌ Error cargando catálogo:", error.message);
  }
}

async function enviarPedidoALaravel(sender) {
  const session = sesiones[sender];
  if (
    !session.carrito ||
    !session.carrito.items ||
    session.carrito.items.length === 0
  ) {
    console.log("⚠️ Intento de envío con carrito vacío");
    return false;
  }
  let totalVenta = 0;

  const detallesVenta = session.carrito.items
    .map((item) => {
      const idMenu = item.id_menu || item.id;
      const menuInfo = MENUS_ARRAY.find((m) => m.id === idMenu);

      if (!menuInfo) return null;

      let precioBase = parseFloat(menuInfo.precio_base);
      let costoExtrasPorUnidad = 0;

      if (item.personalizaciones) {
        item.personalizaciones.forEach((p) => {
          menuInfo.reglas.forEach((regla) => {
            const ing = regla.ingredientes.find(
              (i) => i.id === p.id_ingrediente,
            );
            if (ing) {
              costoExtrasPorUnidad +=
                parseFloat(ing.extra || 0) * (p.cantidad || 1);
            }
          });
        });
      }

      const subTotalItem = (precioBase + costoExtrasPorUnidad) * item.cantidad;
      totalVenta += subTotalItem;

      return {
        id_menu: idMenu,
        cantidad: item.cantidad,
        precio: precioBase,
        sub_total: subTotalItem,
        personalizaciones: item.personalizaciones || [],
      };
    })
    .filter((d) => d !== null);

  const payload = {
    id_usuario: 3,
    fecha: new Date().toISOString().split("T")[0],
    id_sucursal: SUCURSAL_ID,
    monto_efectivo: 0.0,
    monto_qr: totalVenta,
    total: totalVenta,
    estado: "PENDIENTE",
    detalles: detallesVenta,
  };

  try {
    console.log(
      "📤 Enviando pedido a Laravel:",
      JSON.stringify(payload, null, 2),
    );
    const res = await axios.post(`${API_BASE_URL}/venta`, payload);
    const idVenta = res.data.id_venta || null;
    console.log(`✅ Pedido guardado en Laravel. ID Venta: ${idVenta || "OK"}`);
    // Notificar al frontend en tiempo real
    io.emit("nueva_venta", {
      origen: "bot",
      id_venta: idVenta,
      total: totalVenta,
      fecha: payload.fecha,
      id_sucursal: payload.id_sucursal,
      detalles: detallesVenta,
    });
    return true;
  } catch (error) {
    console.error(
      "❌ Error POST Laravel:",
      error.response?.data || error.message,
    );
    return false;
  }
}

// Interpreta un pedido en lenguaje natural escrito por el operador y lo registra en Laravel
async function interpretarPedidoManual(clienteJid, descripcion, sock) {
  if (!CATALOGO_CACHE) await cargarCatalogo();
  console.log(`👤 Pedido manual para ${clienteJid}: "${descripcion}"`);

  for (const nombreModelo of MODELOS) {
    try {
      const genModel = genAI.getGenerativeModel({
        model: nombreModelo,
        systemInstruction: `Eres un intérprete de pedidos para Shellfruty. Convertís texto en lenguaje natural a JSON de carrito.

=== CATÁLOGO CON IDs ===
${JSON.stringify(CATALOGO_CACHE)}

=== INSTRUCCIONES ===
- Mapeá cada producto al id_menu correcto según nombre/precio.
- Usá los id_ingrediente exactos del catálogo para personalizaciones.
- Si un ingrediente no existe en el menú, ignorálo.
- Respondé SOLO el JSON, sin texto, sin markdown.

Formato requerido:
{"items": [{"id_menu": ID, "cantidad": N, "personalizaciones": [{"id_ingrediente": ID, "cantidad": 1}]}]}

Si no podés mapear el pedido respondé:
{"error": "motivo"}`,
      });

      const result = await genModel.generateContent(descripcion);
      const respuesta = result.response.text().trim()
        .replace(/```json/g, "").replace(/```/g, "").trim();
      const dataJson = JSON.parse(respuesta);

      if (dataJson.error) {
        await botSend(sock, clienteJid, { text: `❌ No pude interpretar el pedido: ${dataJson.error}` });
        return;
      }

      if (!sesiones[clienteJid])
        sesiones[clienteJid] = { historial: [], carrito: { items: [] }, saludado: true };
      sesiones[clienteJid].carrito.items = dataJson.items;

      const exito = await enviarPedidoALaravel(clienteJid);
      if (exito) {
        operadorActivo[clienteJid] = Date.now(); // extiende takeover 30 min más
        console.log(`✅ Pedido manual registrado para ${clienteJid}. Takeover extendido.`);
      } else {
        await botSend(sock, clienteJid, { text: `❌ Error al registrar el pedido en el sistema.` });
      }
      return;
    } catch (error) {
      if (error.message.includes("429") || error.message.includes("quota") ||
          error.message.includes("503") || error.message.includes("Service Unavailable")) {
        console.warn(`⚠️ Modelo ${nombreModelo} no disponible en pedido manual, probando siguiente...`);
        continue;
      }
      console.error("❌ Error en interpretarPedidoManual:", error.message);
      await botSend(sock, clienteJid, { text: `❌ Error procesando el pedido. Intentá de nuevo.` });
      return;
    }
  }
}

async function llamarIA(sender, mensajeCliente) {
  if (!CATALOGO_CACHE) await cargarCatalogo();
  if (!sesiones[sender]) {
    sesiones[sender] = { historial: [], carrito: { items: [] } };
  }

  for (const nombreModelo of MODELOS) {
    try {
      const genModel = genAI.getGenerativeModel({
        model: nombreModelo,
        systemInstruction: `Eres el recepcionista de Shellfruty, tienda de Fresas con Crema en Tarija. Trato amable, chapaco, directo. Sin relleno ni texto de más.

=== CATÁLOGO COMPLETO CON REGLAS ===
${JSON.stringify(CATALOGO_CACHE)}

=== CÓMO INTERPRETAR LAS REGLAS DE CADA MENÚ ===
Cada menú tiene un array "reglas". Cada regla es una CATEGORÍA (ej: Cobertura, Crema, Topping, Fruta).
- "gratis": cuántos ingredientes puede elegir sin costo extra.
- "precio_extra_regla": costo fijo si elige más que "gratis" (solo cuando permite_combinar: false).
- "permite_combinar: true": puede mezclar varios, solo ahi nos olvidamos del costo extra.
- "permite_combinar: false": solo puede elegir hasta "gratis" en total; si quiere más paga "precio_extra_regla".
- "extra" del ingrediente: costo adicional de ese ingrediente específico.

=== REGLA DE ORO — PERSONALIZACIÓN OBLIGATORIA ===
Cuando el cliente pide un menú que tiene categorías con MÁS DE UN ingrediente disponible, DEBES preguntar cuál elige ANTES de agregar al carrito. NO puedes asumir ni saltar esa pregunta.
Ejemplo: Vaso Pequeño tiene categoría Cobertura con 2 opciones → OBLIGATORIO preguntar cuál cobertura quiere.
ÚNICA EXCEPCIÓN: Si la categoría tiene exactamente 1 ingrediente, se asume ese sin preguntar.
Si el menú tiene reglas vacías (reglas: []), se puede agregar directo sin preguntar nada.

=== LÍMITES ESTRICTOS ===
1. NUNCA ofrezcas ingredientes que no existan en las reglas del menú elegido.
2. Si permite_combinar es false, el cliente NO puede elegir más de "gratis" ingredientes de esa categoría.
3. Si permite_combinar es true, puede combinar.
4. SIEMPRE informa el precio total actualizado cuando cambies algo.
5. MONEDA: Bs.
6. CANTIDAD EXACTA OBLIGATORIA: Si una categoría tiene "gratis": N, el cliente DEBE elegir EXACTAMENTE N ingredientes. Si elige menos, NO avances. Pregúntale que complete los restantes: puede elegir otro diferente o repetir uno ya elegido (doble). Ejemplo: gratis: 3 y elige 2 → "Te falta 1 topping, ¿cuál más querés o repetimos alguno en doble?".

=== FLUJO OBLIGATORIO ===
1. Cliente pide un menú → revisa sus reglas inmediatamente.
2. Si tiene categorías con múltiples opciones → pregunta cuál elige (puedes agrupar las preguntas).
3. Con TODAS las categorías completadas → muestra resumen con precio y pide confirmación.
4. Cliente confirma → envía [DATA] con finalizado: true.

=== FORMATO DEL CARRITO (REGLAS ESTRICTAS) ===
1. NUNCA uses markdown ni bloques de código.
2. SIEMPRE incluye el carrito completo al final de CADA respuesta con este tag exacto:
[DATA:{"items": [{"id_menu": ID, "cantidad": N, "personalizaciones": [{"id_ingrediente": ID, "cantidad": 1}]}], "finalizado": false}]
3. Cuando el cliente confirme definitivamente cambia a "finalizado": true.
4. Si el carrito está vacío igual incluye: [DATA:{"items": [], "finalizado": false}]
5. El tag [DATA:...] va SIEMPRE al final, sin texto después.`,
      });

      const chat = genModel.startChat({ history: sesiones[sender].historial });
      const result = await chat.sendMessage(mensajeCliente);
      const respuestaTexto = result.response.text();

      sesiones[sender].historial.push({
        role: "user",
        parts: [{ text: mensajeCliente }],
      });
      sesiones[sender].historial.push({
        role: "model",
        parts: [{ text: respuestaTexto }],
      });
      if (sesiones[sender].historial.length > 10)
        sesiones[sender].historial.splice(0, 2);

      return respuestaTexto;
    } catch (error) {
      if (error.message.includes("429") || error.message.includes("quota") || error.message.includes("503") || error.message.includes("Service Unavailable")) {
        console.warn(
          `⚠️ Modelo ${nombreModelo} agotado, probando el siguiente...`,
        );
        continue;
      }
      throw error;
    }
  }
}

async function connectToWhatsApp() {
  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState("auth_info_baileys"));
  } catch (err) {
    console.error("❌ Error leyendo sesión:", err.message);
    setTimeout(() => connectToWhatsApp(), 10000);
    return;
  }

  let waVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    console.log(`📲 Usando WhatsApp Web v${version.join(".")}`);
  } catch {
    waVersion = [2, 3000, 1015901307]; // fallback conocido
    console.warn("⚠️ No se pudo obtener versión WA, usando fallback.");
  }

  const sock = makeWASocket({
    version: waVersion,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    printQRInTerminal: false,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("📱 Escanea el QR con tu WhatsApp:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `🔌 Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`,
      );

      if (statusCode === DisconnectReason.multideviceMismatch) {
        // Sesión incompatible: borrar credenciales y reconectar con QR fresco
        console.log(
          "⚠️  Multidevice mismatch — limpiando sesión y reconectando en 15 segundos...",
        );
        const fs = require("fs");
        const path = require("path");
        const authDir = path.join(__dirname, "auth_info_baileys");
        if (fs.existsSync(authDir)) {
          fs.readdirSync(authDir).forEach((f) =>
            fs.unlinkSync(path.join(authDir, f)),
          );
        }
        setTimeout(() => connectToWhatsApp(), 15000);
      } else if (statusCode === 405) {
        // WhatsApp bloqueó la IP temporalmente por demasiados intentos
        // Esperar 2 minutos antes de reintentar
        console.log(
          "🚫 WhatsApp rechazó la conexión (405). Esperando 2 minutos antes de reintentar...",
        );
        setTimeout(() => connectToWhatsApp(), 120000);
      } else if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 5000);
      }
    } else if (connection === "open") {
      console.log("🚀 Shellfruty Bot Conectado - Sucursal " + SUCURSAL_ID);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const sender = msg.key.remoteJid;

    // --- Mensajes enviados desde este número (bot o el operador manualmente) ---
    if (msg.key.fromMe) {
      if (!botJidsActivos.has(normJid(sender))) {
        // No fue el bot: es el operador escribiendo manualmente
        const textoOp = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        operadorActivo[sender] = Date.now();
        console.log(`👤 Operador activo en ${sender}`);
        if (textoOp.toLowerCase().startsWith(PREFIJO_PEDIDO.toLowerCase())) {
          const desc = textoOp.slice(PREFIJO_PEDIDO.length).trim();
          if (desc) await interpretarPedidoManual(sender, desc, sock);
        }
      }
      return;
    }

    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text;
    const esUbicacion = !!msg.message.locationMessage;
    if (!text && !esUbicacion) return;

    // --- Bienvenida y control de sesión ---
    if (!sesiones[sender]) {
      sesiones[sender] = {
        historial: [],
        carrito: { items: [] },
        saludado: false,
      };
    }

    // --- Takeover por operador: bot silenciado mientras el personal atiende ---
    if (operadorActivo[sender]) {
      const elapsed = Date.now() - operadorActivo[sender];
      if (elapsed < TAKEOVER_MS) return; // aún dentro del takeover
      // Expiró:
      if (elapsed >= TAKEOVER_BIENVENIDA_MS) {
        sesiones[sender] = { historial: [], carrito: { items: [] }, saludado: false };
      } else if (sesiones[sender]) {
        sesiones[sender].saludado = true; // retoma sin bienvenida
      }
      delete operadorActivo[sender];
    }

    // --- Pedido ya finalizado: ignorar mensajes por 30 minutos ---
    if (sesiones[sender].pedidoFinalizado) {
      const elapsed = Date.now() - sesiones[sender].pedidoFinalizado;
      const SILENCIO_MS = 30 * 60 * 1000; // 30 minutos
      if (elapsed < SILENCIO_MS) return;
      // Pasó el tiempo: resetear sesión para que pueda volver a pedir
      sesiones[sender] = { historial: [], carrito: { items: [] }, saludado: true };
    }

    // --- Esperando ubicación post-pedido ---
    if (sesiones[sender].esperandoUbicacion) {
      sesiones[sender].esperandoUbicacion = false;
      sesiones[sender].pedidoFinalizado = Date.now();
      await botSend(sock, sender, {
        text: "¡Listo! Ya tenemos tu ubicación 📍\n\nEn breve te mandamos el QR para el pago. ¡Gracias por tu pedido en Shellfruty! 🍓",
      });
      return;
    }

    if (!sesiones[sender].saludado) {
      // Enviar bienvenida solo la primera vez
      const bienvenida =
        "¡Hola Case! Bienvenido a Shellfruty 🍓\n\n" +
        "Para hacer tu pedido, por favor envía:\n" +
        "1️⃣ *Tamaño del vaso*\n" +
        "🍫 *Cobertura*\n" +
        "🍬 *Topping*\n" +
        "🥛 *Tipo de crema*\n" +
        "🍓 *Frutas*\n\n" +
        "📍 *Incluye tu ubicación en tiempo actual para la entrega*.";
      try {
        await botSend(sock, sender, { text: bienvenida });
        await botSend(sock, sender, { image: { url: "./menu_imgs/menu1.jpg" } });
      } catch (e) {
        console.error("Error enviando bienvenida o imágenes:", e.message);
      }
      sesiones[sender].saludado = true;
      return; // No llamamos a la IA en el primer mensaje
    }

    // --- Buffer y temporizador por usuario ---
    if (!buffers[sender]) buffers[sender] = [];
    buffers[sender].push(text);

    // Si ya hay un temporizador, lo reiniciamos
    if (timers[sender]) {
      clearTimeout(timers[sender]);
    }

    timers[sender] = setTimeout(async () => {
      const mensajesAgrupados = buffers[sender].join("\n");
      buffers[sender] = [];
      delete timers[sender];

      try {
        const aiResponse = await llamarIA(sender, mensajesAgrupados);

        // --- NUEVA LÓGICA DE EXTRACCIÓN ROBUSTA ---
        const tagInicio = "[DATA:";
        let textoParaCliente = aiResponse;
        let jsonExtraido = null;

        if (aiResponse.includes(tagInicio)) {
          const partes = aiResponse.split(tagInicio);
          textoParaCliente = partes[0].trim(); // Todo lo que está antes del tag

          // Intentamos capturar el contenido del tag hasta el último "]"
          const resto = partes[1];
          const finIndex = resto.lastIndexOf("]");
          if (finIndex !== -1) {
            jsonExtraido = resto.substring(0, finIndex).trim();
          }
        }

        // Limpiamos cualquier residuo de markdown o tags que la IA haya puesto por error
        textoParaCliente = textoParaCliente
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .replace(/\[DATA:.*\]/s, "")
          .trim();

        // Enviar mensaje limpio al cliente
        await botSend(sock, sender, { text: textoParaCliente });

        // Procesar el JSON si se extrajo correctamente
        if (jsonExtraido) {
          try {
            const dataJson = JSON.parse(jsonExtraido);

            if (dataJson.items) {
              sesiones[sender].carrito.items = dataJson.items;
            }

            if (dataJson.finalizado === true) {
              const exito = await enviarPedidoALaravel(sender);
              if (exito) {
                sesiones[sender].esperandoUbicacion = true;
                await botSend(sock, sender, {
                  text: "¡Perfecto Case! Tu pedido ya está en cocina 🍓\n\nUna cosita más: mandanos tu *ubicación en tiempo real* para la entrega 📍",
                });
              }
            }
          } catch (e) {
            console.error("❌ Error parseando JSON de la IA:", e.message);
            console.log("JSON que falló:", jsonExtraido);
          }
        }
      } catch (error) {
        console.error("Error:", error);
        await botSend(sock, sender, {
          text: "Ay No, me dio un calambre en el sistema. ¿Me lo puedes repetir?",
        });
      }
    }, BUFFER_TIMEOUT_MS);
  });
}

// --- SERVIDOR HTTP DE HEALTHCHECK ---
// Koyeb (y otros servicios) esperan que la app escuche en un puerto.
// Usamos este mini servidor para responder rápidamente a /health
// y al mismo tiempo mantener el bot activo.

const PORT = process.env.PORT || 3000;
const SOCKET_PORT = process.env.SOCKET_PORT || 3001;

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

// --- SERVIDOR SOCKET.IO (puerto separado para el frontend) ---
const socketServer = http.createServer();
const io = new Server(socketServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  console.log(`🔌 Frontend conectado vía Socket.io: ${socket.id}`);
  socket.on("disconnect", () =>
    console.log(`🔌 Frontend desconectado: ${socket.id}`),
  );
});

socketServer.listen(SOCKET_PORT, () => {
  console.log(`📡 Socket.io escuchando en puerto ${SOCKET_PORT}`);
});

// Capturar errores no manejados para ver qué está crasheando
process.on("unhandledRejection", (reason) => {
  console.error("❌ UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err);
});

server.listen(PORT, async () => {
  console.log(`🌐 HTTP healthcheck server escuchando en puerto ${PORT}`);
  // Cargamos el catálogo UNA sola vez al inicio
  await cargarCatalogo();
  // Iniciamos el bot de WhatsApp — envuelto en try/catch para que
  // un error de arranque no mate el proceso y cause restart loop en Koyeb.
  try {
    connectToWhatsApp();
  } catch (err) {
    console.error("❌ Error arrancando WhatsApp bot:", err.message);
    setTimeout(() => connectToWhatsApp(), 10000);
  }
});
