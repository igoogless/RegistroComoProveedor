import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos } from "./src/tools/proveedor.js";

const directory = process.cwd();
const ctx = { directory, sessionId: "demo" };
const casesDirectory = path.join(directory, "reto-01", "casos");
const cases = (await readdir(casesDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

await rm(path.join(directory, "out"), { recursive: true, force: true });
for (const caso of cases) {
  const request = JSON.parse(await leer_solicitud.execute({ caso }, ctx)) as { ok: boolean; data?: { campos: { etiqueta: string }[] } };
  if (!request.ok || !request.data) { console.log(`${caso}: error al leer solicitud`); continue; }
  const mapping = JSON.parse(await mapear_campos.execute({ caso, campos: request.data.campos }, ctx)) as { ok: boolean; data?: unknown };
  if (!mapping.ok || !mapping.data) { console.log(`${caso}: error al mapear`); continue; }
  const form = JSON.parse(await generar_formulario.execute({ caso, mapeo: mapping.data as never }, ctx)) as { ok: boolean; data?: { ruta: string } };
  const packageResult = JSON.parse(await armar_paquete.execute({ caso }, ctx)) as { ok: boolean; data?: { listo_para_firma: boolean } };
  console.log(`${caso}: formulario=${form.data?.ruta ?? "no generado"}; listo_para_firma=${packageResult.data?.listo_para_firma ?? false}`);
}
