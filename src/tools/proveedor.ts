import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { z } from "zod";

export type ToolContext = { directory: string; sessionId: string };
type Solicitud = { pais: string; cliente: string; formato: "xlsx" | "pdf" | "portal"; adjuntos: string[] };
type PlantillaCampo = { etiqueta: string; obligatorio?: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string };
type MapeoItem = { etiqueta: string; ruta?: string; valor?: unknown; confianza?: number; nota?: string };
type CampoSolicitud = { etiqueta: string; obligatorio: boolean; estado?: "solicitado" | "requiere_confirmacion"; equivalente_pais?: string; nota?: string };
type Mapeo = { llenos: MapeoItem[]; faltantes: MapeoItem[]; requiere_confirmacion: MapeoItem[] };
type Soporte = { tipo: string; archivo: string; vigencia_hasta: string | null; pais_emisor: string; descripcion: string };

const resultado = (data: unknown) => JSON.stringify({ ok: true, data });
const error = (message: string) => JSON.stringify({ ok: false, error: message });
const caseSchema = z.string().min(1).describe("Nombre de la carpeta del caso en reto-01/casos/");
const mapeoSchema = z.object({
  llenos: z.array(z.object({ etiqueta: z.string(), ruta: z.string().optional(), valor: z.unknown().optional(), confianza: z.number().optional(), nota: z.string().optional() })),
  faltantes: z.array(z.object({ etiqueta: z.string(), ruta: z.string().optional(), valor: z.unknown().optional(), confianza: z.number().optional(), nota: z.string().optional() })),
  requiere_confirmacion: z.array(z.object({ etiqueta: z.string(), ruta: z.string().optional(), valor: z.unknown().optional(), confianza: z.number().optional(), nota: z.string().optional() })), 
});

const resolveCase = (directory: string, caso: string) => path.join(directory, "reto-01", "casos", caso);
const outCase = (directory: string, caso: string) => path.join(directory, "out", caso);
const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8")) as T;
const getPath = (source: unknown, route: string): unknown => route.split(".").reduce<unknown>((current, segment) => current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined, source);
const serializableValue = (value: unknown): string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value);

async function log(ctx: ToolContext, caso: string, herramienta: string, ok: boolean, resumen: string) {
  try {
    const target = outCase(ctx.directory, caso);
    const entry = `${JSON.stringify({ ts: new Date().toISOString(), sessionId: ctx.sessionId, caso, herramienta, ok, resumen })}\n`;
    await mkdir(target, { recursive: true });
    await mkdir(path.join(ctx.directory, "out"), { recursive: true });
    await Promise.all([
      writeFile(path.join(target, "log.jsonl"), entry, { flag: "a" }),
      writeFile(path.join(ctx.directory, "out", "log.jsonl"), entry, { flag: "a" }),
    ]);
  } catch {
    return;
  }
}

async function requestData(ctx: ToolContext, caso: string) {
  const folder = resolveCase(ctx.directory, caso);
  const solicitud = await json<Solicitud>(path.join(folder, "solicitud.json"));
  const soportes = await json<string[]>(path.join(folder, "soportes-exigidos.json"));
  const templateFile = solicitud.formato === "xlsx" ? "plantilla-celdas.json" : solicitud.formato === "pdf" ? "plantilla-campos.json" : "plantilla-campos.json";
  const campos = solicitud.formato === "portal" ? await json<PlantillaCampo[]>(path.join(folder, templateFile)) : await json<PlantillaCampo[]>(path.join(folder, templateFile));
  return { folder, solicitud, soportes, campos };
}

function countryIdentifier(pais: string) { return ({ CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" } as Record<string, string>)[pais] ?? "NIT"; }
function isTaxId(label: string) { return ["nit", "ruc", "rtn", "identificación tributaria", "número de identificación fiscal"].includes(label.toLowerCase()); }
function isAmbiguousTaxLabel(label: string) { return ["identificación tributaria", "número de identificación fiscal"].includes(label.toLowerCase()); }
function normalizeLabel(label: string) { return label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function mappingConfidence(label: string, pais: string, glosario: Record<string, string>) {
  if (isAmbiguousTaxLabel(label) || (isTaxId(label) && pais !== "CO")) return 0.7;
  const normalized = normalizeLabel(label);
  const exact = Object.keys(glosario).some((candidate) => normalizeLabel(candidate) === normalized);
  if (exact) return 1;
  const partial = Object.keys(glosario).some((candidate) => {
    const normalizedCandidate = normalizeLabel(candidate);
    return normalized.includes(normalizedCandidate) || normalizedCandidate.includes(normalized);
  });
  return partial ? 0.7 : 0;
}

export const leer_solicitud = {
  description: "Lee una solicitud y devuelve país, formato, campos y soportes exigidos.",
  args: { caso: caseSchema },
  async execute(args: { caso: string }, ctx: ToolContext) {
    try {
      const { solicitud, soportes, campos } = await requestData(ctx, args.caso);
      const fields: CampoSolicitud[] = campos.map(({ etiqueta, obligatorio }) => isAmbiguousTaxLabel(etiqueta)
        ? { etiqueta, obligatorio: obligatorio ?? true, estado: "requiere_confirmacion", equivalente_pais: countryIdentifier(solicitud.pais), nota: `Confirme que esta etiqueta corresponde a ${countryIdentifier(solicitud.pais)}.` }
        : { etiqueta, obligatorio: obligatorio ?? true, estado: "solicitado" });
      const data = { pais: solicitud.pais, cliente: solicitud.cliente, formato: solicitud.formato, campos: fields, soportes };
      await log(ctx, args.caso, "proveedor_leer_solicitud", true, `${campos.length} campos y ${soportes.length} soportes`);
      return resultado(data);
    } catch {
      const message = `No fue posible leer el caso "${args.caso}". Verifica que exista y que sus archivos JSON sean válidos.`;
      await log(ctx, args.caso, "proveedor_leer_solicitud", false, message);
      return error(message);
    }
  },
};

export const mapear_campos = {
  description: "Cruza campos solicitados contra el maestro y reporta valores trazables, faltantes y confirmaciones.",
  args: { caso: caseSchema, campos: z.array(z.object({ etiqueta: z.string().describe("Etiqueta solicitada por el cliente") })).describe("Campos devueltos por proveedor_leer_solicitud") },
  async execute(args: { caso: string; campos: { etiqueta: string }[] }, ctx: ToolContext) {
    try {
      const [glosario, maestro, solicitud] = await Promise.all([
        json<Record<string, string>>(path.join(ctx.directory, "reto-01", "glosario-campos.json")),
        json<Record<string, unknown>>(path.join(ctx.directory, "reto-01", "repositorio", "maestro.json")),
        json<Solicitud>(path.join(resolveCase(ctx.directory, args.caso), "solicitud.json")),
      ]);
      const mapped: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] };
      for (const field of args.campos) {
        const route = glosario[field.etiqueta];
        if (!route) {
          const confidence = mappingConfidence(field.etiqueta, solicitud.pais, glosario);
          const similar = Object.keys(glosario).find((candidate) => {
            const normalized = normalizeLabel(field.etiqueta); const normalizedCandidate = normalizeLabel(candidate);
            return normalized.includes(normalizedCandidate) || normalizedCandidate.includes(normalized);
          });
          if (similar) mapped.requiere_confirmacion.push({ etiqueta: field.etiqueta, ruta: glosario[similar], confianza: confidence, nota: `Equivalencia propuesta: "${similar}". Confirme el mapeo.` });
          else mapped.faltantes.push({ etiqueta: field.etiqueta, confianza: confidence, nota: "Etiqueta sin equivalencia en el glosario" });
          continue;
        }
        const value = getPath(maestro, route);
        if (value === undefined || value === null || value === "") { mapped.faltantes.push({ etiqueta: field.etiqueta, ruta: route }); continue; }
        const confidence = mappingConfidence(field.etiqueta, solicitud.pais, glosario);
        const item = { etiqueta: field.etiqueta, ruta: route, valor: value, confianza: confidence };
        if (confidence < 0.8) {
          const note = isTaxId(field.etiqueta) && solicitud.pais !== "CO"
            ? `Se entrega NIT colombiano; confirme el identificador extranjero (${countryIdentifier(solicitud.pais)}).`
            : `Etiqueta tributaria ambigua; confirme si corresponde a ${countryIdentifier(solicitud.pais)}.`;
          mapped.requiere_confirmacion.push({ ...item, nota: note });
        } else mapped.llenos.push(item);
      }
      await log(ctx, args.caso, "proveedor_mapear_campos", true, `${mapped.llenos.length} llenos, ${mapped.faltantes.length} faltantes, ${mapped.requiere_confirmacion.length} por confirmar`);
      return resultado(mapped);
    } catch {
      const message = `No fue posible mapear los campos del caso "${args.caso}".`;
      await log(ctx, args.caso, "proveedor_mapear_campos", false, message);
      return error(message);
    }
  },
};

async function generatePdf(destination: string, fields: PlantillaCampo[], values: Map<string, unknown>) {
  await new Promise<void>((resolve, reject) => {
    const document = new PDFDocument({ margin: 50 });
    const stream = createWriteStream(destination);
    stream.on("finish", resolve); stream.on("error", reject);
    document.pipe(stream);
    document.fontSize(18).text("Formulario de registro como proveedor").moveDown();
    for (const field of fields) document.fontSize(11).fillColor("#111827").text(`${field.etiqueta}${field.obligatorio ? " *" : ""}`).fillColor("#2563eb").text(String(values.get(field.etiqueta) ?? "PENDIENTE"), { indent: 16 }).moveDown(0.6);
    document.end();
  });
}

export const generar_formulario = {
  description: "Genera un formulario XLSX, PDF o valores para portal usando un mapeo validado.",
  args: { caso: caseSchema, mapeo: mapeoSchema.describe("Resultado de proveedor_mapear_campos") },
  async execute(args: { caso: string; mapeo: Mapeo }, ctx: ToolContext) {
    try {
      const { solicitud, campos } = await requestData(ctx, args.caso);
      const destination = outCase(ctx.directory, args.caso);
      await mkdir(destination, { recursive: true });
      const values = new Map(args.mapeo.llenos.concat(args.mapeo.requiere_confirmacion).map((item) => [item.etiqueta, item.valor]));
      if (solicitud.formato === "xlsx") {
        const workbook = new ExcelJS.Workbook();
        for (const field of campos) {
          const cellField = field as Required<Pick<PlantillaCampo, "hoja" | "celda_etiqueta" | "celda_valor">> & PlantillaCampo;
          if (!cellField.hoja || !cellField.celda_etiqueta || !cellField.celda_valor) throw new Error("plantilla de celdas incompleta");
          const sheet = workbook.getWorksheet(cellField.hoja) ?? workbook.addWorksheet(cellField.hoja);
          sheet.getCell(cellField.celda_etiqueta).value = cellField.etiqueta;
          sheet.getCell(cellField.celda_valor).value = serializableValue(values.get(cellField.etiqueta) ?? "PENDIENTE");
          sheet.getColumn(cellField.celda_etiqueta.replace(/\d/g, "")).width = 32;
          sheet.getColumn(cellField.celda_valor.replace(/\d/g, "")).width = 46;
        }
        const ruta = path.join(destination, "formulario.xlsx"); await workbook.xlsx.writeFile(ruta);
        await log(ctx, args.caso, "proveedor_generar_formulario", true, "formulario.xlsx generado"); return resultado({ ruta: path.relative(ctx.directory, ruta), formato: "xlsx" });
      }
      if (solicitud.formato === "pdf") {
        const ruta = path.join(destination, "formulario.pdf"); await generatePdf(ruta, campos, values);
        await log(ctx, args.caso, "proveedor_generar_formulario", true, "formulario.pdf generado"); return resultado({ ruta: path.relative(ctx.directory, ruta), formato: "pdf" });
      }
      const ruta = path.join(destination, "valores-portal.md");
      await writeFile(ruta, `# Valores para portal\n\n${campos.map((field) => `- **${field.etiqueta}:** ${String(values.get(field.etiqueta) ?? "PENDIENTE")}`).join("\n")}\n`);
      await log(ctx, args.caso, "proveedor_generar_formulario", true, "valores-portal.md generado; formato no soportado");
      return resultado({ ruta: path.relative(ctx.directory, ruta), formato: "portal", estado: "formato no soportado" });
    } catch {
      const message = `No fue posible generar el formulario del caso "${args.caso}". La plantilla puede estar incompleta o corrupta.`;
      await log(ctx, args.caso, "proveedor_generar_formulario", false, message);
      return error(message);
    }
  },
};

export const armar_paquete = {
  description: "Crea el paquete para firma con formulario, soportes, checklist y borrador de correo.",
  args: { caso: caseSchema },
  async execute(args: { caso: string }, ctx: ToolContext) {
    try {
      const { solicitud, soportes: exigidos } = await requestData(ctx, args.caso);
      const caseOut = outCase(ctx.directory, args.caso); const packagePath = path.join(caseOut, "paquete");
      await mkdir(packagePath, { recursive: true });
      const index = await json<Soporte[]>(path.join(ctx.directory, "reto-01", "repositorio", "soportes", "index.json"));
      const statuses = await Promise.all(exigidos.map(async (tipo) => {
        const support = index.find((item) => item.tipo === tipo);
        if (!support) return { tipo, estado: "ausente", archivo: null };
        const expired = support.vigencia_hasta !== null && support.vigencia_hasta < new Date().toISOString().slice(0, 10);
        await cp(path.join(ctx.directory, "reto-01", "repositorio", "soportes", support.archivo), path.join(packagePath, support.archivo));
        return { tipo, estado: expired ? "vencido" : "presente", archivo: support.archivo, vigencia_hasta: support.vigencia_hasta };
      }));
      const sourceForm = solicitud.formato === "xlsx" ? "formulario.xlsx" : solicitud.formato === "pdf" ? "formulario.pdf" : "valores-portal.md";
      await cp(path.join(caseOut, sourceForm), path.join(packagePath, sourceForm)).catch(() => undefined);
      const ready = statuses.every((item) => item.estado === "presente");
      const checklist = `# Checklist de soportes\n\n${statuses.map((item) => `- [${item.estado === "presente" ? "x" : " "}] **${item.tipo}** — ${item.estado}${item.archivo ? ` (${item.archivo})` : ""}${"vigencia_hasta" in item && item.vigencia_hasta ? `; vigencia: ${item.vigencia_hasta}` : ""}`).join("\n")}\n\nEstado: **${ready ? "listo para firma" : "bloqueado"}**.\n`;
      await writeFile(path.join(packagePath, "checklist.md"), checklist);
      await writeFile(path.join(packagePath, "borrador-correo.md"), `Asunto: Registro como proveedor — ${solicitud.cliente}\n\nHola,\n\nAdjuntamos el formulario de registro y los soportes disponibles para su revisión y firma del representante legal.\n\nSaludos,\nEquipo administrativo\n`);
      await log(ctx, args.caso, "proveedor_armar_paquete", true, ready ? "paquete listo para firma" : "paquete bloqueado por soportes");
      return resultado({ ruta: path.relative(ctx.directory, packagePath), listo_para_firma: ready, checklist: statuses });
    } catch {
      const message = `No fue posible armar el paquete del caso "${args.caso}".`;
      await log(ctx, args.caso, "proveedor_armar_paquete", false, message);
      return error(message);
    }
  },
};

export const simular_envio = {
  description: "Simula el envío del paquete solamente después de una confirmación explícita.",
  args: { caso: caseSchema, confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente en el turno anterior") },
  async execute(args: { caso: string; confirmado: boolean }, ctx: ToolContext) {
    if (!args.confirmado) return error("requiere confirmación explícita");
    try {
      const ruta = path.join(outCase(ctx.directory, args.caso), "ENVIO-SIMULADO.md"); await mkdir(path.dirname(ruta), { recursive: true });
      await writeFile(ruta, `# Envío simulado\n\nCaso: ${args.caso}\nFecha: ${new Date().toISOString()}\nNo se envió ningún correo real.\n`);
      await log(ctx, args.caso, "proveedor_simular_envio", true, "envío simulado creado"); return resultado({ ruta: path.relative(ctx.directory, ruta) });
    } catch { return error(`No fue posible simular el envío del caso "${args.caso}".`); }
  },
};

export const tools = { proveedor_leer_solicitud: leer_solicitud, proveedor_mapear_campos: mapear_campos, proveedor_generar_formulario: generar_formulario, proveedor_armar_paquete: armar_paquete, proveedor_simular_envio: simular_envio };
