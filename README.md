# Registro como proveedor

Agente conversacional para preparar formularios de registro de proveedor desde los fixtures del reto.

## Requisitos

Node.js 20+ y npm.

## Ejecutar

```bash
cp .env.example .env
npm install
npm run dev
```

Configura `GEMINI_API_KEY` exclusivamente en `.env`. Abre la URL que imprime el servidor. Con la clave, el backend Gemini ejecuta el ciclo de funciones; sin clave conserva el flujo determinista de fixtures para la demo. La clave no llega al front, logs ni respuestas.

## Despliegue público

El repositorio incluye `Dockerfile` y `render.yaml`. En Render, crea un Web Service desde este repositorio, selecciona el Blueprint `render.yaml` y define el secreto `GEMINI_API_KEY` en el panel de variables. Nunca subas `.env`. Tras desplegar, registra la URL pública de la plataforma aquí antes de la defensa.

## Demo sin modelo

```bash
npm run demo
```

Limpia `out/`, ejecuta todos los casos y genera sus formularios y paquetes.

## API

- `POST /api/chat`: `{ sessionId?, message }`.
- `GET /api/sessions/:id`: historial de la sesión.
- `GET /api/health`: estado no sensible del servicio.

No hay URL pública desplegada en este repositorio; para la defensa, levanta el servicio localmente con el comando anterior.
