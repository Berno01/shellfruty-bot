require("dotenv").config(); // Cargar variables de entorno desde .env (si existe)

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const http = require("http"); // Pequeño server HTTP para healthcheck

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
// --- Buffers y temporizadores para agrupar mensajes por usuario ---
const buffers = {}; // { sender: [mensajes] }
const timers = {}; // { sender: timeoutId }
const BUFFER_TIMEOUT_MS = 12000; // 10 segundos

const MODELOS = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

// --- FUNCIONES DE SOPORTE ---

async function cargarCatalogo() {
  try {
    // Catálogo en línea: usamos la ruta /menu sobre la base configurada arriba.
    const res = await axios.get(`${API_BASE_URL}/menu`);
    CATALOGO_CACHE = res.data;
    console.log("✅ Catálogo cargado de Laravel con éxito");
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
      const menuInfo = CATALOGO_CACHE.menus.find((m) => m.id === idMenu);

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
    console.log(
      `✅ Pedido guardado en Laravel. ID Venta: ${res.data.id_venta || "OK"}`,
    );
    return true;
  } catch (error) {
    console.error(
      "❌ Error POST Laravel:",
      error.response?.data || error.message,
    );
    return false;
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
        systemInstruction: `Eres el recepcionista virtual de Shellfruty una tienda de Fresas con Crema en Tarija. 
                Tu trato es amable pero no cargoso y Tarijeño pero nada exagerado LO mas importante es no hablar mucho, ser directo con el pedido del cliente, no escribir tanto texto ni relleno, directo a tomar el pedido y explicar bien cuando notes que no estan haciendo bien el pedido.

                REGLAS CRÍTICAS DE FIEL CUMPLIMIENTO:
                1. CATÁLOGO REAL: ${JSON.stringify(CATALOGO_CACHE)}
                2. PROHIBIDO HACER EXCEPCIONES. Si un ingrediente o categoría no está en el JSON de reglas del menú elegido, NO EXISTE. No lo ofrezcas.
                
                3. SIEMPRE incluye el estado COMPLETO del carrito en el JSON de [DATA].
                4. MULTI-PEDIDO: Si piden varios productos o el mismo varias veces, agrúpalos en el array de items con su respectiva 'cantidad'.
                5. Si el cliente confirma definitivamente, incluye "finalizado": true en el JSON.
                6. MONEDA: Usa "Bs.".
                7. INGREDIENTES PREMIUM: Si "extra" > 0, suma el monto al total e infórmalo.
                8. LÍMITES ESTRICTOS: Si "permite_combinar" es false y "precio_extra_regla" es 0, el cliente NO puede elegir más de la cantidad "gratis".
                9. Trato: Amable, chapaco, directo y CERO flexible con las reglas.
                10. En caso de que un menu tenga mas de un ingrediente por elegir en una categoria es obligatorio que arme su personalizacion, en caso de solo contar con un solo ingrediente en una categoria entonces no es necesario hacerle elegir o seleccionar explicitamente, se sobreentiende
                REGLAS DE FORMATO (ESTRICTAS):
                1. NUNCA uses bloques de código markdown (como \\\`json).
                2. Para datos internos usa EXCLUSIVAMENTE el tag: [DATA:{"items": [{"id_menu": ID, "cantidad": N, "personalizaciones": [{"id_ingrediente": ID, "cantidad": 1}]}], "finalizado": boolean}]
                3. Ese tag [DATA:...] debe ir al final de tu respuesta, sin espacios extra.`,
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
      if (error.message.includes("429") || error.message.includes("quota")) {
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

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 60000,
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
      console.log(`🔌 Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.multideviceMismatch) {
        // Sesión incompatible: borrar credenciales y reconectar con QR fresco
        console.log("⚠️  Multidevice mismatch — limpiando sesión y reconectando en 15 segundos...");
        const fs = require("fs");
        const path = require("path");
        const authDir = path.join(__dirname, "auth_info_baileys");
        if (fs.existsSync(authDir)) {
          fs.readdirSync(authDir).forEach(f => fs.unlinkSync(path.join(authDir, f)));
        }
        setTimeout(() => connectToWhatsApp(), 15000);
      } else if (statusCode === 405) {
        // WhatsApp bloqueó la IP temporalmente por demasiados intentos
        // Esperar 2 minutos antes de reintentar
        console.log("🚫 WhatsApp rechazó la conexión (405). Esperando 2 minutos antes de reintentar...");
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
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    // --- Bienvenida y control de sesión ---
    if (!sesiones[sender]) {
      sesiones[sender] = {
        historial: [],
        carrito: { items: [] },
        saludado: false,
      };
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
        await sock.sendMessage(sender, { text: bienvenida });
        // Enviar las dos imágenes del menú
        await sock.sendMessage(sender, {
          image: { url: "./menu_imgs/menu1.jpg" },
          caption: "Menú 1",
        });
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
        await sock.sendMessage(sender, { text: textoParaCliente });

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
                await sock.sendMessage(sender, {
                  text: "¡Listo Case! Ya mandé tu pedido a cocina. Ahora necesitamos El comprobante del pago en QR y te lo enviamos. 😉",
                });
                delete sesiones[sender];
              }
            }
          } catch (e) {
            console.error("❌ Error parseando JSON de la IA:", e.message);
            console.log("JSON que falló:", jsonExtraido);
          }
        }
      } catch (error) {
        console.error("Error:", error);
        await sock.sendMessage(sender, {
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

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
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
