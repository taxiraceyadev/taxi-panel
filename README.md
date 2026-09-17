# Panel de notificaciones — TaxiCaller → RingCentral

Guía completa, paso a paso, sin dar nada por sabido.

## Qué es cada cosa

```
taxi-panel/
├── frontend/
│   └── public/                  ← esto es lo que se sube a Render (el panel)
│       ├── index.html             Login + feed en vivo + configuración
│       └── config.js              URL y anon key de Supabase (se completa en el paso 6)
├── supabase/
│   ├── schema.sql                  Tablas + seguridad (se corre en Supabase, paso 1)
│   └── functions/
│       └── taxicaller-webhook/
│           └── index.ts             Función que recibe el webhook y manda el SMS (paso 3)
└── README.md                       Este archivo
```

Cómo funciona, en criollo: **TaxiCaller le pega a la función de Supabase → esa función
guarda el dato y manda el SMS por RingCentral → el panel en Render solo muestra lo que
ya se guardó.** Vos nunca tocás las credenciales de RingCentral en el navegador.

No hace falta tocar ni entender el código para que esto funcione. Seguí los pasos en orden.

---

## Paso 0 — Herramientas que necesitás instaladas

- **Node.js** (trae `npm`): [nodejs.org](https://nodejs.org) → bajá la versión LTS, instalá con
  las opciones por defecto. Después de instalar, **cerrá la terminal y abrí una nueva**.
- **CLI de Supabase**: con la terminal (PowerShell) abierta, corré:
  ```
  npm install -g supabase
  ```
  Si te tira un error de "running scripts is disabled", abrí PowerShell **como administrador**
  y corré `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`, confirmá con "S", y reintentá.
- Una cuenta en [supabase.com](https://supabase.com) y otra en [render.com](https://render.com)
  (las dos tienen plan gratuito, alcanza para esto).
- Un repositorio en GitHub (si no sabés crear uno, avisame y te lo explico también).

---

## Paso 1 — Crear el proyecto en Supabase y las tablas

1. Entrá a [supabase.com](https://supabase.com) → **New project**. Elegí nombre, contraseña de
   base de datos (guardala en algún lado) y región. Esperá a que termine de crearse (1-2 min).
2. En el menú de la izquierda, andá a **SQL Editor** → **New query**.
3. Abrí el archivo `supabase/schema.sql` de esta carpeta, copiá **todo** el contenido, pegalo
   en el editor de Supabase, y apretá **Run**. Tiene que decir "Success. No rows returned".
4. Andá a **Authentication → Users → Add user**. Ese email/contraseña van a ser tu login
   para entrar al panel (no el de tu cuenta de Supabase, uno nuevo que vos elijas).

---

## Paso 2 — Conectar la terminal con tu proyecto

Abrí PowerShell en la carpeta `taxi-panel` que te bajaste (la que tiene `frontend/` y
`supabase/` adentro) y corré, uno por uno:

```
supabase login
```
Te va a abrir el navegador para que confirmes. Después:

```
supabase link --project-ref TU-PROJECT-REF
```
El `TU-PROJECT-REF` lo sacás de la URL de tu proyecto en Supabase, algo como
`https://ABCDEFGHIJK.supabase.co` → el `ABCDEFGHIJK` es el project-ref.

---

## Paso 3 — Desplegar la función que recibe el webhook

Parado en la misma carpeta `taxi-panel`, corré:

```
supabase functions deploy taxicaller-webhook --no-verify-jwt
```

Si te tira un warning de "Docker is not running", abrí Docker Desktop (si no lo tenés,
bajalo de [docker.com](https://www.docker.com/products/docker-desktop/)) y reintentá el comando.

Cuando termine bien, tu URL del webhook va a ser:
```
https://TU-PROJECT-REF.supabase.co/functions/v1/taxicaller-webhook
```
Guardala, la vas a pegar en TaxiCaller más adelante.

### Ajustar qué datos lee del webhook de TaxiCaller

TaxiCaller no tiene un formato fijo y documentado para este webhook, así que hay que
verlo en la práctica:

1. Configurá el webhook en TaxiCaller con la URL de arriba.
2. Forzá que una unidad se ponga "en espera" en TaxiCaller.
3. En Supabase, andá a **Edge Functions → taxicaller-webhook → Logs** y buscá la línea
   `Payload crudo de TaxiCaller: {...}` — ahí vas a ver el JSON real que manda.
4. Si algo no coincide (por ejemplo no te llega el teléfono o la placa), decime qué JSON
   te llegó y te ajusto el archivo `index.ts` para que lo lea bien. Después volvés a correr
   el comando de deploy de este paso.

---

## Paso 4 — Cargar RingCentral (esto se hace después, desde el panel, no ahora)

Vas a necesitar crear una app en RingCentral. Cuando llegues a este paso avisame y te guío
con capturas de qué apretar. Resumen de lo que vas a sacar de ahí:

- Server URL, Client ID, Client Secret, JWT Credential, número que envía los SMS, y
  opcionalmente una Extension ID.

Estos datos **no se cargan por código**: se cargan desde la tuerquita del panel una vez que
esté desplegado (paso 6).

---

## Paso 5 — Subir el proyecto a GitHub

1. Entrá a [github.com](https://github.com) → **New repository** → ponele un nombre (por
   ejemplo `taxi-panel`) → **Create repository**.
2. En esa misma carpeta `taxi-panel` en tu PC, corré en la terminal:
   ```
   git init
   git add .
   git commit -m "primer commit"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/taxi-panel.git
   git push -u origin main
   ```
   (Si te pide login de GitHub, seguí las instrucciones que te muestre la terminal.)

---

## Paso 6 — Desplegar el panel en Render

1. Antes de subir, completá `frontend/public/config.js` con los datos de tu proyecto:
   en Supabase, andá a **Project Settings → API**, copiá **Project URL** y la clave
   **anon public**, y pegalas en ese archivo (reemplazando los textos de ejemplo).
   Volvé a hacer `git add . && git commit -m "config" && git push`.
2. En [render.com](https://render.com) → **New → Static Site** → conectá tu cuenta de
   GitHub y elegí el repo `taxi-panel`.
3. Configurá:
   - **Build command**: dejalo **vacío** (no hay nada que compilar).
   - **Publish directory**: `frontend/public`
4. **Create Static Site**. Cuando termine el deploy te da una URL tipo
   `https://taxi-panel-xxxx.onrender.com` — esa es tu panel.
5. Entrá con el usuario/contraseña que creaste en el Paso 1.4.

---

## Cómo funciona la deduplicación

Cada unidad se identifica por su id de TaxiCaller. Mientras esa unidad siga marcada como
"en espera", webhooks repetidos **no generan un SMS nuevo**, solo actualizan la hora.
Cuando la unidad se libera y después vuelve a ponerse en espera, ahí sí es un evento nuevo
y dispara otro SMS — como corresponde, porque para el cliente es una espera distinta.

## Seguridad de las credenciales

- `CLIENT_SECRET` y `JWT_CREDENTIAL` viven en una tabla que **el panel no puede leer
  directamente**, ni siquiera estando logueado.
- El panel solo ve un estado enmascarado ("configurado / no configurado" + últimos 4
  caracteres del Client ID) y solo puede escribir valores nuevos, nunca releerlos.
- La función que manda los SMS lee la tabla real con una clave especial que nunca sale
  de Supabase.

---

## Si algo falla

Pegame el mensaje de error completo (una captura sirve) y seguimos desde ahí.
