import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";

const MODELO = "claude-haiku-4-5";
const MAX_TOKENS_RESPUESTA = 600;
const MAX_LARGO_MENSAJE = 2000;
const MAX_MENSAJES_HISTORIAL = 12;

// Rate limit en memoria por IP — se reinicia en cada cold start y no se
// comparte entre instancias concurrentes. Es una protección básica contra
// abuso puntual, no una garantía dura; suficiente para un widget de landing
// de bajo tráfico sin agregar infraestructura adicional (Redis/KV).
const LIMITE_MENSAJES = 12;
const VENTANA_MS = 5 * 60 * 1000;
const contadorPorIp = new Map<string, { conteo: number; inicio: number }>();

function estaLimitado(ip: string): boolean {
  const ahora = Date.now();
  const entrada = contadorPorIp.get(ip);
  if (!entrada || ahora - entrada.inicio > VENTANA_MS) {
    contadorPorIp.set(ip, { conteo: 1, inicio: ahora });
    return false;
  }
  entrada.conteo += 1;
  return entrada.conteo > LIMITE_MENSAJES;
}

const SYSTEM_PROMPT = `Eres el asistente virtual de NortIA, un estudio de desarrollo de software con sede en Santa Cruz, Sexta Región, Chile.

NortIA construye sistemas a medida — desarrollo web, apps, automatización de procesos e inteligencia artificial — principalmente para empresas de Agro y Logística, aunque también atiende otros rubros.

CÓMO TRABAJAN (proceso en 4 etapas):
1. Diagnóstico — reunión sin costo para entender la operación del cliente y su mayor cuello de botella.
2. Propuesta — alcance, plazos y precio por escrito, con hitos definidos y sin letra chica.
3. Desarrollo — construcción por etapas, con avances demostrables cada 1-2 semanas.
4. Entrega — puesta en producción, capacitación al equipo del cliente y garantía técnica.

CASOS REALES EN PRODUCCIÓN (puedes mencionarlos si preguntan por ejemplos o resultados):
- Fundo Alcántara: sistema de gestión agrícola completo (riego, fertilización, tarjas de trabajo, órdenes de compra, arriendo de maquinaria, sensores en vivo).
- Paltas Don Rorro: panel de compras y ventas para una pyme de compra y venta de paltas, con ranking de clientes y reportes exportables.
- Asesorías Mella: escritorio contable con gestión de clientes, cobranza y una bóveda cifrada de claves.
- Importadora La Santa Cruz: sitio de catálogo industrial (conectores, mangueras, válvulas) con cotización directa por WhatsApp.
- Vista Hermosa: dashboard de gasto común y consumo eléctrico para un condominio de 52 lotes.

CONTACTO:
- WhatsApp: +56 9 3430 4097 (enlace: https://wa.me/56934304097)
- Correo: joaquinmarinay@gmail.com
- El diagnóstico inicial es siempre sin costo ni compromiso. Responden dentro de 24 horas hábiles.

ESTILO DE RESPUESTA:
- Responde siempre en español de Chile, de forma breve, cercana y profesional — normalmente 2 a 4 oraciones, sin listas largas salvo que el visitante pida detalle.
- Si preguntan algo totalmente ajeno a NortIA, sus servicios o sus casos, redirige amablemente la conversación hacia cómo NortIA puede ayudarles, sin sonar brusco.
- Si el visitante muestra interés real en cotizar, agendar o avanzar, invítalo a escribir por WhatsApp o dejar sus datos en el formulario de contacto de la página.
- No inventes precios, plazos ni funcionalidades que no estén aquí. Si preguntan por un precio exacto, explica que depende del alcance y se define en la propuesta, tras el diagnóstico gratuito.
- No entregues datos de contacto de los clientes reales mencionados arriba (Alcántara, Don Rorro, Mella, etc.) — solo la información de contacto de NortIA.`;

interface MensajeEntrada {
  role: "user" | "assistant";
  content: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido." });
    return;
  }

  const ipHeader = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(ipHeader) ? ipHeader[0] : ipHeader)?.split(",")[0]?.trim() || req.socket.remoteAddress || "desconocida";

  if (estaLimitado(ip)) {
    res.status(429).json({ error: "Demasiados mensajes seguidos. Espera unos minutos o escríbenos por WhatsApp." });
    return;
  }

  const cuerpo = req.body as { messages?: MensajeEntrada[] };
  if (!Array.isArray(cuerpo?.messages) || cuerpo.messages.length === 0) {
    res.status(400).json({ error: "Falta el mensaje." });
    return;
  }

  const historial = cuerpo.messages.slice(-MAX_MENSAJES_HISTORIAL);
  for (const m of historial) {
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || m.content.trim().length === 0) {
      res.status(400).json({ error: "Mensaje inválido." });
      return;
    }
    if (m.content.length > MAX_LARGO_MENSAJE) {
      res.status(400).json({ error: "El mensaje es demasiado largo." });
      return;
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY no está configurada.");
    res.status(500).json({ error: "El asistente no está disponible en este momento." });
    return;
  }

  try {
    const client = new Anthropic({ apiKey });
    const respuesta = await client.messages.create({
      model: MODELO,
      max_tokens: MAX_TOKENS_RESPUESTA,
      system: SYSTEM_PROMPT,
      messages: historial.map((m) => ({ role: m.role, content: m.content })),
    });

    const bloqueTexto = respuesta.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const texto = bloqueTexto?.text?.trim() || "No pude generar una respuesta. Intenta de nuevo o escríbenos por WhatsApp.";

    res.status(200).json({ reply: texto });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      console.error("Rate limit de Anthropic alcanzado:", err.message);
      res.status(429).json({ error: "El asistente está muy solicitado ahora mismo. Intenta en un momento." });
    } else if (err instanceof Anthropic.APIError) {
      console.error("Error de la API de Claude:", err.status, err.message);
      res.status(502).json({ error: "No pude responder en este momento. Escríbenos por WhatsApp y te ayudamos." });
    } else {
      console.error("Error inesperado en /api/chat:", err);
      res.status(500).json({ error: "Ocurrió un error inesperado." });
    }
  }
}
