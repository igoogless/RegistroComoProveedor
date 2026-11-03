import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { GeminiAdapter } from "./llm/gemini.js";
import type { LlmAdapter, ToolDefinition, ToolRequest } from "./llm/adapter.js";
import { tools } from "./tools/proveedor.js";
import type { ToolContext } from "./tools/proveedor.js";

type ToolResult = { ok: boolean; data?: unknown; error?: string };
type ToolCall = { name: string; args: Record<string, unknown>; result: ToolResult };
type SessionMessage = { role: "user" | "assistant"; content: string; toolCalls?: ToolCall[]; needsConfirmation?: boolean };
type Session = { id: string; messages: SessionMessage[]; nativeHistory: unknown[]; tokensUsed: number; pendingConfirmation?: { caso: string; turn: number }; readyCases: Set<string> };
type AgentResponse = { calls: ToolCall[]; reply: string; needsConfirmation: boolean; tokens: number; nativeHistory?: unknown[] };

const directory = process.cwd();
const maxIterations = Number(process.env.MAX_AGENT_ITERATIONS ?? 12);
const maxSessionTokens = Number(process.env.MAX_SESSION_TOKENS ?? 40000);
const sessions = new Map<string, Session>();
const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(directory, "web")));

const chatSchema = z.object({ sessionId: z.string().optional(), message: z.string().min(1).max(4000) });
const toolDefinitions: ToolDefinition[] = Object.entries(tools).map(([name, tool]) => ({
  name,
  description: tool.description,
  inputSchema: { type: "object", properties: Object.fromEntries(Object.entries(tool.args).map(([key, schema]) => [key, zodToJsonSchema(schema)])), required: Object.keys(tool.args) },
}));

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const description = schema.description;
  if (schema instanceof z.ZodString) return { type: "string", ...(description ? { description } : {}) };
  if (schema instanceof z.ZodBoolean) return { type: "boolean", ...(description ? { description } : {}) };
  if (schema instanceof z.ZodNumber) return { type: "number", ...(description ? { description } : {}) };
  if (schema instanceof z.ZodArray) return { type: "array", items: zodToJsonSchema(schema.element), ...(description ? { description } : {}) };
  if (schema instanceof z.ZodObject) return { type: "object", properties: Object.fromEntries(Object.entries(schema.shape).map(([key, child]) => [key, zodToJsonSchema(child as z.ZodTypeAny)])), required: Object.keys(schema.shape), ...(description ? { description } : {}) };
  return { type: "string", ...(description ? { description } : {}) };
}

const toolCall = async (name: keyof typeof tools, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolCall> => {
  const tool = tools[name];
  const validated = z.object(tool.args).safeParse(args);
  const raw = validated.success
    ? await tool.execute(validated.data as never, ctx)
    : JSON.stringify({ ok: false, error: validated.error.issues.map((issue) => issue.message).join(", ") });
  return { name, args, result: JSON.parse(raw) as ToolResult };
};

const extractCase = (message: string) => message.match(/["“]([a-z]{2}-[a-z0-9-]+)["”]/i)?.[1] ?? message.match(/\b(?:co|ec|hn|pa)-[a-z0-9-]+\b/i)?.[0];
const isConfirmation = (message: string) => /^(sí|si|confirmo|confirmar|de acuerdo)$/i.test(message.trim());
const isSendIntent = (message: string) => /\b(envía|envia|enviar)\b/i.test(message);

async function deterministicProcess(caso: string, ctx: ToolContext): Promise<AgentResponse> {
  const calls: ToolCall[] = [];
  calls.push(await toolCall("proveedor_leer_solicitud", { caso }, ctx));
  const request = calls[0].result.data as { campos: { etiqueta: string }[] } | undefined;
  if (!calls[0].result.ok || !request) return { calls, reply: `No pude procesar el caso **${caso}**. Revisa el detalle de la herramienta.`, needsConfirmation: false, tokens: 0 };
  calls.push(await toolCall("proveedor_mapear_campos", { caso, campos: request.campos }, ctx));
  const mapping = calls[1].result.data;
  if (calls[1].result.ok && mapping) calls.push(await toolCall("proveedor_generar_formulario", { caso, mapeo: mapping }, ctx));
  calls.push(await toolCall("proveedor_armar_paquete", { caso }, ctx));
  const mapData = mapping as { llenos: unknown[]; faltantes: { etiqueta: string }[]; requiere_confirmacion: { etiqueta: string }[] } | undefined;
  const packageData = calls.at(-1)?.result.data as { listo_para_firma: boolean; checklist: { tipo: string; estado: string }[] } | undefined;
  const pending = packageData?.checklist.filter((item) => item.estado !== "presente").map((item) => `${item.tipo} (${item.estado})`) ?? [];
  const portal = calls.find((call) => call.name === "proveedor_generar_formulario")?.result.data as { estado?: string } | undefined;
  return { calls, needsConfirmation: false, tokens: 0, reply: [`Caso **${caso}** procesado.`, portal?.estado ? `Formato: **${portal.estado}**; se generaron valores listos para copiar.` : "", `Campos llenos: **${mapData?.llenos.length ?? 0}**.`, `Faltantes: ${mapData?.faltantes.length ? mapData.faltantes.map((item) => item.etiqueta).join(", ") : "ninguno"}.`, `Requieren confirmación: ${mapData?.requiere_confirmacion.length ? mapData.requiere_confirmacion.map((item) => item.etiqueta).join(", ") : "ninguno"}.`, `Paquete: **${packageData?.listo_para_firma ? "listo para firma" : "bloqueado"}**.`, `Soportes por actualizar: ${pending.length ? pending.join(", ") : "ninguno"}.`, "No enviaré nada sin tu confirmación explícita."].filter(Boolean).join("\n\n") };
}

async function runGeminiAgent(adapter: LlmAdapter, session: Session, message: string, ctx: ToolContext): Promise<AgentResponse> {
  const history: unknown[] = [...session.nativeHistory, { role: "user", parts: [{ text: message }] }];
  let turn = await adapter.enviar(history, toolDefinitions);
  let tokens = turn.tokens;
  const calls: ToolCall[] = [];
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    history.push(turn.nativeResponse);
    if (turn.toolRequests.length === 0) return { calls, reply: turn.text || "No obtuve una respuesta del modelo.", needsConfirmation: false, tokens, nativeHistory: history };
    const results: { id: string; name: string; response: Record<string, unknown> }[] = [];
    for (const request of turn.toolRequests) {
      const call = await executeRequestedTool(request, ctx);
      calls.push(call);
      results.push({ id: request.id, name: request.name, response: call.result });
    }
    const responseContent = { role: "user", parts: results.map((result) => ({ functionResponse: { id: result.id, name: result.name, response: result.response } })) };
    turn = await adapter.responderHerramientas(history, results, toolDefinitions);
    tokens += turn.tokens;
    history.push(responseContent);
    if (session.tokensUsed + tokens >= maxSessionTokens) return { calls, reply: "Se alcanzó el presupuesto de tokens de la sesión. Inicia una nueva sesión para continuar.", needsConfirmation: false, tokens, nativeHistory: history };
  }
  return { calls, reply: "Alcancé el límite de iteraciones. Revisa las herramientas ejecutadas para continuar.", needsConfirmation: false, tokens, nativeHistory: history };
}

async function executeRequestedTool(request: ToolRequest, ctx: ToolContext): Promise<ToolCall> {
  if (!(request.name in tools)) return { name: request.name, args: request.input, result: { ok: false, error: "Herramienta no disponible." } };
  if (request.name === "proveedor_simular_envio") return { name: request.name, args: request.input, result: { ok: false, error: "La simulación requiere confirmación humana y la gestiona el servidor." } };
  return toolCall(request.name as keyof typeof tools, request.input, ctx);
}

function configuredAdapter(prompt: string): LlmAdapter | undefined {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  return apiKey ? new GeminiAdapter(apiKey, process.env.GEMINI_MODEL ?? "gemini-3.8-flash", prompt) : undefined;
}

function markReadyCases(session: Session, calls: ToolCall[], caso?: string) {
  for (const call of calls) {
    if (call.name === "proveedor_armar_paquete" && call.result.ok && (call.result.data as { listo_para_firma?: boolean }).listo_para_firma && caso) session.readyCases.add(caso);
  }
}

function providerErrorMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : "Error desconocido del proveedor.";
  if (detail.includes("billing") || detail.includes("PERMISSION_DENIED")) return "Gemini rechazó la solicitud porque el proyecto no tiene facturación habilitada. Configura la facturación del proyecto Gemini e inténtalo de nuevo.";
  if (detail.includes("NOT_FOUND") || detail.includes("no longer available")) return "El modelo Gemini configurado no está disponible. Actualiza GEMINI_MODEL e inténtalo de nuevo.";
  return "Gemini no respondió correctamente. Puedes reintentar; la sesión sigue disponible.";
}

app.post("/api/chat", async (req, res) => {
  const body = chatSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Solicitud de chat inválida." }); return; }
  const session = sessions.get(body.data.sessionId ?? "") ?? { id: body.data.sessionId ?? randomUUID(), messages: [], nativeHistory: [], tokensUsed: 0, readyCases: new Set<string>() };
  const message = body.data.message.trim(); const ctx = { directory, sessionId: session.id };
  let response: AgentResponse;
  const pending = session.pendingConfirmation;
  if (pending && isConfirmation(message) && pending.turn === session.messages.length) {
    const call = await toolCall("proveedor_simular_envio", { caso: pending.caso, confirmado: true }, ctx);
    session.pendingConfirmation = undefined;
    response = call.result.ok ? { calls: [call], reply: "Se creó el envío simulado. No se envió ningún correo real.", needsConfirmation: false, tokens: 0 } : { calls: [call], reply: call.result.error ?? "No fue posible simular el envío.", needsConfirmation: false, tokens: 0 };
  } else if (isSendIntent(message)) {
    session.pendingConfirmation = undefined;
    const caso = extractCase(message);
    if (!caso) response = { calls: [], reply: "Indica el caso que deseas enviar.", needsConfirmation: false, tokens: 0 };
    else if (!session.readyCases.has(caso)) response = { calls: [], reply: `El caso **${caso}** no está listo para firma. Procesa el caso y corrige los soportes bloqueantes antes de simular un envío.`, needsConfirmation: false, tokens: 0 };
    else { session.pendingConfirmation = { caso, turn: session.messages.length + 1 }; response = { calls: [], reply: `¿Confirmas la simulación de envío del caso **${caso}**? Responde “sí” en tu siguiente mensaje para continuar.`, needsConfirmation: true, tokens: 0 }; }
  } else if (session.tokensUsed >= maxSessionTokens) {
    response = { calls: [], reply: "Se alcanzó el presupuesto de tokens de la sesión. Inicia una nueva sesión para continuar.", needsConfirmation: false, tokens: 0 };
  } else {
    session.pendingConfirmation = undefined;
    const caso = extractCase(message);
    const [prompt, knowledge] = await Promise.all([readFile(path.join(directory, "agent", "prompt.md"), "utf8"), readFile(path.join(directory, "src", "knowledge", "registro-proveedor.md"), "utf8")]);
    const adapter = configuredAdapter(`${prompt}\n\n${knowledge}`);
    try {
      response = adapter ? await runGeminiAgent(adapter, session, message, ctx) : caso ? await deterministicProcess(caso, ctx) : { calls: [], reply: "Configura GEMINI_API_KEY para conversación libre o indica un caso, por ejemplo: Procesa el caso \"ec-corp-andina\".", needsConfirmation: false, tokens: 0 };
    } catch (error) {
      response = { calls: [], reply: providerErrorMessage(error), needsConfirmation: false, tokens: 0 };
    }
    markReadyCases(session, response.calls, caso);
  }
  session.tokensUsed += response.tokens;
  if (response.nativeHistory) session.nativeHistory = response.nativeHistory;
  session.messages.push({ role: "user", content: message });
  session.messages.push({ role: "assistant", content: response.reply, toolCalls: response.calls, needsConfirmation: response.needsConfirmation });
  sessions.set(session.id, session);
  res.json({ sessionId: session.id, reply: response.reply, toolCalls: response.calls, needsConfirmation: response.needsConfirmation, maxIterations, tokensUsed: session.tokensUsed, maxSessionTokens });
});

app.get("/api/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  res.json(session ? { id: session.id, messages: session.messages, readyCases: [...session.readyCases], tokensUsed: session.tokensUsed, maxSessionTokens } : { id: req.params.id, messages: [] });
});
app.get("/api/health", (_req, res) => res.json({ ok: true, provider: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "gemini" : "deterministic-tools", model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash" }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Registro como proveedor disponible en http://localhost:${port}`));
