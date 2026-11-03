import { Hono } from "hono";

type ToolCall = { name: string; args: Record<string, unknown>; result: { ok: boolean; data?: unknown; error?: string } };
type Session = { messages: { role: "user" | "assistant"; content: string; toolCalls?: ToolCall[]; needsConfirmation?: boolean }[]; pending?: string };
type Env = { ASSETS: { fetch(request: Request): Promise<Response> } };

const sessions = new Map<string, Session>();
const app = new Hono<{ Bindings: Env }>();
const cases = ["co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo"];
const appData = {
  "co-industrias-delta": { filled: 13, missing: [], confirmations: [], blocked: ["camara_comercio (vencido)"] },
  "ec-corp-andina": { filled: 13, missing: ["Número de contribuyente especial"], confirmations: ["RUC"], blocked: ["camara_comercio (vencido)", "certificado_cumplimiento_tributario (ausente)"] },
  "hn-agroexport-sula": { filled: 10, missing: ["Referencias comerciales"], confirmations: ["RTN"], blocked: ["rut (sin soporte local verificable)", "parafiscales (vencido)"] },
  "pa-logistica-istmo": { filled: 8, missing: [], confirmations: ["RUC"], blocked: ["camara_comercio (vencido)"] },
} as const;

const caseFrom = (text: string): keyof typeof appData | undefined => cases.find((item): item is keyof typeof appData => text.includes(item));
const respond = (sessionId: string, reply: string, toolCalls: ToolCall[] = [], needsConfirmation = false) => {
  const session = sessions.get(sessionId) ?? { messages: [] };
  session.messages.push({ role: "assistant", content: reply, toolCalls, needsConfirmation });
  sessions.set(sessionId, session);
  return { sessionId, reply, toolCalls, needsConfirmation, mode: "demo" };
};

app.get("/api/health", (context) => context.json({ ok: true, provider: "deterministic-tools", model: "not-configured", deployment: "cloudflare-workers" }));
app.get("/api/sessions/:id", (context) => context.json({ id: context.req.param("id"), messages: sessions.get(context.req.param("id"))?.messages ?? [] }));
app.post("/api/chat", async (context) => {
  const body = await context.req.json<{ sessionId?: string; message?: string }>();
  const message = body.message?.trim();
  if (!message) return context.json({ error: "Solicitud de chat inválida." }, 400);
  const sessionId = body.sessionId ?? crypto.randomUUID();
  const session = sessions.get(sessionId) ?? { messages: [] };
  session.messages.push({ role: "user", content: message }); sessions.set(sessionId, session);
  const caseId = caseFrom(message);
  if (session.pending && /^(sí|si|confirmo|confirmar|de acuerdo)$/i.test(message)) {
    const pending = session.pending; session.pending = undefined;
    return context.json(respond(sessionId, "Se creó el envío simulado. No se envió ningún correo real.", [{ name: "proveedor_simular_envio", args: { caso: pending, confirmado: true }, result: { ok: true, data: { ruta: `out/${pending}/ENVIO-SIMULADO.md` } } }]));
  }
  if (/\b(envía|envia|enviar)\b/i.test(message)) return context.json(respond(sessionId, "En la demostración pública no se simulan envíos porque todos los paquetes de fixtures están bloqueados por soportes vencidos o ausentes."));
  if (!caseId) return context.json(respond(sessionId, "Indica un caso para procesar: co-industrias-delta, ec-corp-andina, hn-agroexport-sula o pa-logistica-istmo."));
  const data = appData[caseId];
  const format = caseId === "pa-logistica-istmo" ? "Formato no soportado; se prepararían valores listos para copiar al portal." : "Formulario preparado en el formato solicitado.";
  const calls: ToolCall[] = [
    { name: "proveedor_leer_solicitud", args: { caso: caseId }, result: { ok: true, data: { formato: caseId === "pa-logistica-istmo" ? "portal" : caseId === "ec-corp-andina" ? "pdf" : "xlsx" } } },
    { name: "proveedor_mapear_campos", args: { caso: caseId }, result: { ok: true, data: { llenos: data.filled, faltantes: data.missing, requiere_confirmacion: data.confirmations } } },
    { name: "proveedor_generar_formulario", args: { caso: caseId }, result: { ok: true, data: { formato: caseId === "pa-logistica-istmo" ? "portal" : "archivo" } } },
    { name: "proveedor_armar_paquete", args: { caso: caseId }, result: { ok: true, data: { listo_para_firma: false, checklist: data.blocked } } },
  ];
  const reply = [`Caso **${caseId}** procesado en modo demostración.`, format, `Campos llenos: **${data.filled}**.`, `Faltantes: ${data.missing.length ? data.missing.join(", ") : "ninguno"}.`, `Requieren confirmación: ${data.confirmations.length ? data.confirmations.join(", ") : "ninguno"}.`, `Paquete bloqueado por: ${data.blocked.join(", ")}.`, "No se ejecutan envíos ni se usan credenciales en esta publicación."].join("\n\n");
  return context.json(respond(sessionId, reply, calls));
});

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));
export default app;
