const { GoogleGenerativeAI } = require("@google/generative-ai");

// Pon tu clave aquí directo para probar
const genAI = new GoogleGenerativeAI("AIzaSyAzm_QmgkEJRAuV3FslbBOJnkXGvWth05E");

async function test() {
    try {
        // Probamos con el modelo más básico disponible
        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
        const result = await model.generateContent("Hola, ¿estás activo?");
        console.log("Respuesta de la IA:", result.response.text());
        console.log("✅ ¡Tu API Key funciona perfectamente!");
    } catch (e) {
        console.error("❌ Error en el test:", e.message);
        if(e.message.includes("404")) {
            console.log("Sugerencia: Revisa en Google AI Studio qué modelos te aparecen habilitados.");
        }
    }
}

test();