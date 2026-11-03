# Registro como proveedor

Agente conversacional para preparar formularios de registro de proveedor desde los fixtures del reto.

## Link de prueba

- Publicación temporal gratuita: `https://registro-como-proveedor.woolen-principle.workers.dev`
- Esta publicación funciona en **modo demostración**: no usa claves, no envía correos ni firma documentos. Procesa los cuatro fixtures y muestra las llamadas de herramientas.
- La URL temporal debe reclamarse en Cloudflare para conservarla. Si expira, despliega una nueva siguiendo la sección de Cloudflare.

## Requisitos locales

Node.js 20+ y npm.

## Ejecutar localmente

```bash
cp .env.example .env
npm install
npm run dev
```

Abre la URL indicada por la consola. Configura `GEMINI_API_KEY` solo en `.env` para habilitar el ciclo Gemini. Sin clave, el flujo determinista permite demostrar los fixtures. La clave no llega al front, logs ni respuestas.

## Demo sin modelo

```bash
npm run demo
```

Limpia `out/`, descubre todos los casos de `reto-01/casos/`, ejecuta las herramientas y genera formularios y paquetes.

## Publicación gratuita con Cloudflare Workers

La versión pública gratuita usa `src/worker.ts` y los activos de `web/`; no requiere que el computador permanezca encendido.

```bash
npm run deploy:cloudflare
```

1. Autentica Wrangler con `npx wrangler login`.
2. Autoriza Cloudflare en el navegador.
3. Ejecuta el comando anterior. La consola mostrará una URL `workers.dev` pública.

Para una publicación temporal sin iniciar sesión:

```bash
npx wrangler deploy --temporary
```

Cloudflare entrega una URL pública y un enlace de reclamación válido por 60 minutos. Reclámalo en la cuenta Cloudflare para conservar el Worker.

## Despliegue persistente con contenedor

El repositorio conserva `Dockerfile` y `render.yaml` para plataformas compatibles con contenedores. Define `GEMINI_API_KEY`, `GEMINI_MODEL`, `MAX_AGENT_ITERATIONS` y `MAX_SESSION_TOKENS` como secretos de plataforma; nunca subas `.env`.

## API

- `POST /api/chat`: `{ sessionId?, message }`.
- `GET /api/sessions/:id`: historial completo de la sesión.
- `GET /api/health`: estado no sensible del servicio.

## Verificación

```bash
npm run typecheck
npm run lint
npm run demo
```
