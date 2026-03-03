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

let CATALOGO_CACHE = null;
let MENUS_ARRAY = []; // Array normalizado de menús para búsquedas internas

const MODELOS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

// --- NÚMEROS QUE EL BOT DEBE IGNORAR COMPLETAMENTE (sin +, sin espacios) ---
const NUMEROS_IGNORADOS = new Set([
  "59175143385", // personal de delivery — no atender por bot
]);

// Prefijo para que el operador registre ventas manualmente
const PREFIJO_PEDIDO = "!pedido"; // cambialo si querés otro prefijo

// Contactos a los que ya se les envió el mensaje de bienvenida
const contactosBienvenidos = new Set();

// Sesiones: solo se usan para guardar el carrito durante !pedido
const sesiones = {};

// Quita el sufijo @s.whatsapp.net / @lid / @g.us para comparaciones
function normJid(jid) {
  return jid ? jid.replace(/@.*$/, "") : "";
}

// Wrapper de sock.sendMessage
async function botSend(sock, jid, content) {
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
    id_usuario: 5,
    fecha: new Date().toISOString().split("T")[0],
    id_sucursal: SUCURSAL_ID,
    monto_efectivo: 0,
    monto_qr: totalVenta,
    total: totalVenta,
    estado: "ENTREGADO",
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
        console.error(`❌ Gemini no pudo interpretar el pedido: ${dataJson.error}`);
        return;
      }

      if (!sesiones[clienteJid])
        sesiones[clienteJid] = { carrito: { items: [] } };
      sesiones[clienteJid].carrito.items = dataJson.items;

      const exito = await enviarPedidoALaravel(clienteJid);
      if (exito) {
        console.log(`✅ Pedido registrado para ${clienteJid}.`);
      } else {
        console.error(`❌ Falló el registro en Laravel para ${clienteJid}.`);
      }
      return;
    } catch (error) {
      if (error.message.includes("429") || error.message.includes("quota") ||
          error.message.includes("503") || error.message.includes("Service Unavailable")) {
        console.warn(`⚠️ Modelo ${nombreModelo} no disponible, probando siguiente...`);
        continue;
      }
      console.error("❌ Error en interpretarPedidoManual:", error.message);
      return;
    }
  }
  console.error("❌ Todos los modelos de Gemini fallaron para el pedido manual.");
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
    if (m.type !== "notify") return; // ignorar sync inicial

    const msg = m.messages[0];
    if (!msg.message) return;

    // Ignorar mensajes de más de 2 minutos (replay al reconectar)
    const msgTimestamp = (msg.messageTimestamp || 0) * 1000;
    if (Date.now() - msgTimestamp > 2 * 60 * 1000) return;

    const sender = msg.key.remoteJid;
    if (sender?.endsWith("@g.us")) return;    // ignorar grupos
    if (sender === "status@broadcast") return; // ignorar estados
    if (NUMEROS_IGNORADOS.has(normJid(sender))) return; // ignorar delivery

    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    console.log(`📩 fromMe:${msg.key.fromMe} | de:${sender} | "${texto.substring(0, 60)}"`);

    // --- Mensajes enviados por el operador (fromMe) ---
    if (msg.key.fromMe) {
      if (texto.toLowerCase().startsWith(PREFIJO_PEDIDO.toLowerCase())) {
        const desc = texto.slice(PREFIJO_PEDIDO.length).trim();
        console.log(`🛒 !pedido para ${sender}: "${desc}"`);
        if (desc) await interpretarPedidoManual(sender, desc, sock);
      }
      return; // ignorar todos los demás mensajes del operador
    }

    // --- Mensajes de clientes: solo enviar bienvenida la primera vez ---
    if (!contactosBienvenidos.has(sender)) {
      contactosBienvenidos.add(sender);
      const bienvenida =
        "¡Hola! Bienvenido a *Shellfruty* 🍓\n\n" +
        "Gracias por contactarnos. En breve te atendemos.";
      try {
        await botSend(sock, sender, { text: bienvenida });
      } catch (e) {
        console.error("Error enviando bienvenida:", e.message);
      }
    }
    // Resto de mensajes del cliente: ignorar silenciosamente
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
