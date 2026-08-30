import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { crearLimitador, generarRespuesta, MAX_MENSAJES_HISTORIAL, type MensajeAgente } from "../lib/nortiaAgent";

const GRAPH_API_VERSION = "v21.0";

// Historial de conversación en memoria por teléfono — igual que el rate
// limit, es "best effort": no persiste entre cold starts ni instancias
// concurrentes, pero da continuidad razonable dentro de una conversación
// activa sin agregar una base de datos.
const TTL_HISTORIAL_MS = 30 * 60 * 1000;
const historiales = new Map<string, { mensajes: MensajeAgente[]; actualizado: number }>();

function obtenerHistorial(telefono: string): MensajeAgente[] {
  const entrada = historiales.get(telefono);
  if (!entrada || Date.now() - entrada.actualizado > TTL_HISTORIAL_MS) return [];
  return entrada.mensajes;
}

function guardarHistorial(telefono: string, mensajes: MensajeAgente[]) {
  historiales.set(telefono, { mensajes: mensajes.slice(-MAX_MENSAJES_HISTORIAL), actualizado: Date.now() });
}

const estaLimitado = crearLimitador(20, 10 * 60 * 1000);

async function enviarMensajeWhatsapp(telefono: string, texto: string): Promise<void> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.error("Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID.");
    return;
  }

  const resp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: telefono,
      type: "text",
      text: { body: texto },
    }),
  });

  if (!resp.ok) {
    const detalle = await resp.text().catch(() => "");
    console.error("Error enviando mensaje de WhatsApp:", resp.status, detalle);
  }
}

async function procesarMensaje(telefono: string, texto: string): Promise<void> {
  try {
    const previo = obtenerHistorial(telefono);
    const historial: MensajeAgente[] = [...previo, { role: "user", content: texto }];
    const respuesta = await generarRespuesta(historial, "whatsapp");
    guardarHistorial(telefono, [...historial, { role: "assistant", content: respuesta }]);
    await enviarMensajeWhatsapp(telefono, respuesta);
  } catch (err) {
    console.error("Error procesando mensaje de WhatsApp:", err);
    await enviarMensajeWhatsapp(
      telefono,
      "Tuvimos un problema respondiendo automáticamente. En breve te contacta alguien del equipo de NortIA.",
    ).catch(() => {});
  }
}

interface EntradaWebhook {
  entry?: {
    changes?: {
      value?: {
        messages?: { from: string; type: string; text?: { body?: string } }[];
      };
    }[];
  }[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verificación del webhook — Meta llama esto una vez al configurarlo.
  if (req.method === "GET") {
    const modo = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (modo === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(String(challenge ?? ""));
    } else {
      res.status(403).send("Forbidden");
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  // Responder de inmediato: Meta reintenta el webhook si tarda demasiado en
  // recibir un 200, y una reintento duplicaría la respuesta del asistente.
  // El procesamiento real (llamar a Claude y enviar la respuesta) sigue
  // corriendo en segundo plano vía waitUntil.
  res.status(200).json({ status: "ok" });

  try {
    const cuerpo = req.body as EntradaWebhook;
    const mensaje = cuerpo?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!mensaje || mensaje.type !== "text") return;

    const telefono = mensaje.from;
    const texto = mensaje.text?.body?.trim();
    if (!telefono || !texto) return;

    if (estaLimitado(telefono)) {
      waitUntil(enviarMensajeWhatsapp(telefono, "Recibimos varios mensajes seguidos — dame un momento y seguimos 🙂"));
      return;
    }

    waitUntil(procesarMensaje(telefono, texto));
  } catch (err) {
    console.error("Error en webhook de WhatsApp:", err);
  }
}
