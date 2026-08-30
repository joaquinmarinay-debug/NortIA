import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { crearLimitador, generarRespuesta, MAX_LARGO_MENSAJE, MAX_MENSAJES_HISTORIAL, type MensajeAgente } from "../lib/nortiaAgent";

// Rate limit en memoria por IP — se reinicia en cada cold start y no se
// comparte entre instancias concurrentes. Es una protección básica contra
// abuso puntual, no una garantía dura; suficiente para un widget de landing
// de bajo tráfico sin agregar infraestructura adicional (Redis/KV).
const estaLimitado = crearLimitador(12, 5 * 60 * 1000);

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

  const cuerpo = req.body as { messages?: MensajeAgente[] };
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

  try {
    const texto = await generarRespuesta(historial, "web");
    res.status(200).json({ reply: texto });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      console.error("Rate limit de Anthropic alcanzado:", err.message);
      res.status(429).json({ error: "El asistente está muy solicitado ahora mismo. Intenta en un momento." });
    } else if (err instanceof Anthropic.APIError) {
      console.error("Error de la API de Claude:", err.status, err.message);
      res.status(502).json({ error: "No pude responder en este momento. Escríbenos por WhatsApp y te ayudamos." });
    } else if (err instanceof Error && err.message.includes("ANTHROPIC_API_KEY")) {
      console.error(err.message);
      res.status(500).json({ error: "El asistente no está disponible en este momento." });
    } else {
      console.error("Error inesperado en /api/chat:", err);
      res.status(500).json({ error: "Ocurrió un error inesperado." });
    }
  }
}
