import Anthropic from "@anthropic-ai/sdk";

export const MODELO = "claude-haiku-4-5";
export const MAX_TOKENS_RESPUESTA = 600;
export const MAX_LARGO_MENSAJE = 2000;
export const MAX_MENSAJES_HISTORIAL = 12;

export interface MensajeAgente {
  role: "user" | "assistant";
  content: string;
}

const CONTENIDO_NORTIA = `Eres el asistente virtual de NortIA, un estudio de desarrollo de software con sede en Santa Cruz, Sexta Región, Chile.

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
- No inventes precios, plazos ni funcionalidades que no estén aquí. Si preguntan por un precio exacto, explica que depende del alcance y se define en la propuesta, tras el diagnóstico gratuito.
- No entregues datos de contacto de los clientes reales mencionados arriba (Alcántara, Don Rorro, Mella, etc.) — solo la información de contacto de NortIA.`;

export type CanalAgente = "web" | "whatsapp";

export function systemPrompt(canal: CanalAgente): string {
  const cierre =
    canal === "whatsapp"
      ? "Ya estás conversando con el visitante por WhatsApp: si muestra interés real en cotizar o agendar, ayúdalo directamente aquí mismo, pídele los datos que falten (qué necesita, nombre de su empresa) y coméntale que el equipo de NortIA revisa y responde dentro de 24 horas hábiles."
      : "Si el visitante muestra interés real en cotizar, agendar o avanzar, invítalo a escribir por WhatsApp o dejar sus datos en el formulario de contacto de la página.";
  return `${CONTENIDO_NORTIA}\n${cierre}`;
}

/** Llama a Claude con el historial dado y devuelve el texto de la respuesta. Lanza si falla la API. */
export async function generarRespuesta(historial: MensajeAgente[], canal: CanalAgente): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no está configurada.");

  const client = new Anthropic({ apiKey });
  const respuesta = await client.messages.create({
    model: MODELO,
    max_tokens: MAX_TOKENS_RESPUESTA,
    system: systemPrompt(canal),
    messages: historial.map((m) => ({ role: m.role, content: m.content })),
  });

  const bloqueTexto = respuesta.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return bloqueTexto?.text?.trim() || "No pude generar una respuesta.";
}

/** Rate limit en memoria por clave (IP o teléfono) — best-effort, no persiste entre cold starts ni instancias. */
export function crearLimitador(limite: number, ventanaMs: number) {
  const contador = new Map<string, { conteo: number; inicio: number }>();
  return function estaLimitado(clave: string): boolean {
    const ahora = Date.now();
    const entrada = contador.get(clave);
    if (!entrada || ahora - entrada.inicio > ventanaMs) {
      contador.set(clave, { conteo: 1, inicio: ahora });
      return false;
    }
    entrada.conteo += 1;
    return entrada.conteo > limite;
  };
}
