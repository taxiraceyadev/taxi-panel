// ============================================================
// Edge Function: taxicaller-webhook
//
// Recibe el webhook de TaxiCaller cuando una unidad se pone
// "en espera", evita reprocesar la misma unidad mientras sigue
// en ese estado, y dispara un SMS por RingCentral al cliente.
//
// Deploy:
//   supabase functions deploy taxicaller-webhook --no-verify-jwt
//
// Secrets necesarios (Supabase los inyecta automático, no hace
// falta configurarlos a mano):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Opcional, para verificar que el webhook viene de TaxiCaller:
//   supabase secrets set TAXICALLER_WEBHOOK_SECRET=xxxx
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const webhookSecret = Deno.env.get("TAXICALLER_WEBHOOK_SECRET"); // opcional

const supabase = createClient(supabaseUrl, serviceRoleKey);

// ------------------------------------------------------------
// 1) MAPEO DEL PAYLOAD DE TAXICALLER
//
// Confirmado con webhooks reales, el payload de esta cuenta viene así:
//   {"event":"waiting_for_passenger","job_id":"327474472",
//    "vehicle_make":"R142 Kia Spectra 2008","vehicle_color":"Azul / Blue",
//    "vehicle_plate":"ABM6PI","passenger_phone":"404963673"}
//
// No manda un ID de vehículo aparte, así que usamos la PLACA como
// identificador único de la unidad para la deduplicación.
//
// TaxiCaller tiene una lista fija de estados posibles (ver Admin Panel ->
// Settings -> Notifications -> Customer): cancelado, callout, esperando
// pasajero, pasajero a bordo, entregado. En vez de adivinar el nombre
// exacto de cada uno, tratamos CUALQUIER evento que no sea
// "waiting_for_passenger" como que la unidad dejó de estar en espera.
// ------------------------------------------------------------
function parseTaxiCallerPayload(body: any) {
  const plate = body?.vehicle_plate ?? body?.vehicle?.plate ?? "Sin placa";

  // Usamos la placa como identificador único de la unidad (no hay otro id).
  const vehicleId = plate !== "Sin placa" ? plate : null;

  const vehicleLabel = body?.vehicle_make ?? body?.vehicle?.label ?? "Unidad sin nombre";

  const phoneRaw =
    body?.passenger_phone ?? body?.job?.passenger?.phone ?? body?.phone ?? null;

  const rawStatus = body?.event ?? body?.event_type ?? body?.status ?? "";
  const isOnHold = /waiting_for_passenger|hold|wait|espera/i.test(String(rawStatus));
  // Cualquier evento presente que NO sea "en espera" libera la unidad.
  const isCleared = !!rawStatus && !isOnHold;

  const eventId = body?.job_id ?? body?.event_id ?? body?.id ?? crypto.randomUUID();

  return {
    vehicleId,
    vehicleLabel,
    plate,
    phoneRaw,
    isOnHold,
    isCleared,
    eventId,
  };
}

// ------------------------------------------------------------
// Arma la lista de teléfonos candidatos a probar, uno por cada
// código de país configurado, porque TaxiCaller manda el teléfono
// sin código de país y no hay forma de saber a cuál corresponde
// (ej: "404963673" podría ser +1, +52, +58, etc.). La función va
// a probarlos en orden hasta que RingCentral acepte uno.
//
// El campo "Código de país" del panel admite varios separados por
// coma o espacio, ej: "+1, +52, +58"
// ------------------------------------------------------------
function buildCandidatePhones(phoneRaw: string | null, countryCodesRaw: string | null) {
  if (!phoneRaw) return [];
  const digitsOnly = phoneRaw.replace(/[^\d+]/g, "");
  if (digitsOnly.startsWith("+")) return [digitsOnly]; // ya viene completo, no hay nada que probar

  const prefixes = (countryCodesRaw ?? "")
    .split(/[,\s]+/)
    .map((p) => p.replace(/[^\d+]/g, ""))
    .filter((p) => p.length > 0);

  const base = digitsOnly.replace(/^0+/, "");
  return prefixes.map((prefix) => `${prefix}${base}`);
}

// ------------------------------------------------------------
// 2) RingCentral: obtener access token (JWT bearer flow)
// ------------------------------------------------------------
async function getRingCentralToken(settings: any) {
  const res = await fetch(`${settings.server_url}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + btoa(`${settings.client_id}:${settings.client_secret}`),
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: settings.jwt_credential,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`RingCentral auth error: ${JSON.stringify(data)}`);
  }
  return data.access_token as string;
}

// ------------------------------------------------------------
// 3) RingCentral: enviar el SMS
// ------------------------------------------------------------
async function sendSms(
  settings: any,
  accessToken: string,
  toPhone: string,
  text: string,
) {
  const extensionPath = settings.extension_id
    ? `/restapi/v1.0/account/~/extension/${settings.extension_id}/sms`
    : `/restapi/v1.0/account/~/extension/~/sms`;

  const res = await fetch(`${settings.server_url}${extensionPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      from: { phoneNumber: settings.from_number },
      to: [{ phoneNumber: toPhone }],
      text,
    }),
  });

  const data = await res.json();
  return { ok: res.ok, data };
}

// ------------------------------------------------------------
// Handler principal
// ------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Verificación opcional del webhook
  if (webhookSecret) {
    const provided =
      req.headers.get("x-webhook-secret") ??
      new URL(req.url).searchParams.get("secret");
    if (provided !== webhookSecret) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let rawBody: any;
  try {
    rawBody = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  console.log("Payload crudo de TaxiCaller:", JSON.stringify(rawBody));

  const { vehicleId, vehicleLabel, plate, phoneRaw, isOnHold, isCleared, eventId } =
    parseTaxiCallerPayload(rawBody);

  // Si el evento es "se liberó", solo actualizamos el estado y salimos.
  if (isCleared && vehicleId) {
    await supabase
      .from("vehicles_on_hold")
      .update({ status: "cleared", last_seen_at: new Date().toISOString() })
      .eq("taxicaller_vehicle_id", vehicleId);
    return new Response(JSON.stringify({ ok: true, action: "cleared" }), {
      status: 200,
    });
  }

  if (!isOnHold) {
    // Evento que no nos interesa (no es "en espera" ni "liberado")
    return new Response(JSON.stringify({ ok: true, action: "ignored" }), {
      status: 200,
    });
  }

  if (!phoneRaw) {
    console.log("Webhook sin teléfono de cliente, no se puede notificar.");
    return new Response(
      JSON.stringify({ ok: false, reason: "sin teléfono en el payload" }),
      { status: 200 },
    );
  }

  // --- Deduplicación ---
  // Si la unidad ya está marcada como on_hold, no generamos una fila
  // nueva ni un SMS nuevo: solo actualizamos last_seen_at.
  const { data: existing } = await supabase
    .from("vehicles_on_hold")
    .select("id,status")
    .eq("taxicaller_vehicle_id", vehicleId)
    .maybeSingle();

  if (existing?.status === "on_hold") {
    await supabase
      .from("vehicles_on_hold")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", existing.id);
    return new Response(JSON.stringify({ ok: true, action: "duplicate_ignored" }), {
      status: 200,
    });
  }

  // Registrar (o reactivar) la unidad como on_hold
  await supabase.from("vehicles_on_hold").upsert(
    {
      taxicaller_vehicle_id: vehicleId,
      vehicle_label: vehicleLabel,
      plate,
      status: "on_hold",
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "taxicaller_vehicle_id" },
  );

  // --- Cargar configuración de RingCentral ---
  const { data: settings, error: settingsError } = await supabase
    .from("settings")
    .select("*")
    .eq("id", 1)
    .single();

  if (settingsError || !settings?.server_url || !settings?.client_id) {
    await supabase.from("messages_log").insert({
      vehicle_label: vehicleLabel,
      plate,
      phone: phoneRaw,
      status: "failed",
      error_detail: "Configuración de RingCentral incompleta (revisar panel)",
      taxicaller_event_id: eventId,
    });
    return new Response(
      JSON.stringify({ ok: false, reason: "settings incompletos" }),
      { status: 200 },
    );
  }

  const phoneCandidates = buildCandidatePhones(phoneRaw, settings.phone_country_code);

  if (phoneCandidates.length === 0) {
    await supabase.from("messages_log").insert({
      vehicle_label: vehicleLabel,
      plate,
      phone: phoneRaw,
      status: "failed",
      error_detail:
        `El teléfono "${phoneRaw}" no tiene código de país y falta configurar ` +
        `al menos un prefijo en el campo "Código de país" del panel (ej: +1, +52, +58).`,
      taxicaller_event_id: eventId,
    });
    return new Response(
      JSON.stringify({ ok: false, reason: "falta configurar código de país" }),
      { status: 200 },
    );
  }

  const messageText =
    `Hola, tu unidad ${vehicleLabel} (patente ${plate}) está en espera. ` +
    `Ante cualquier consulta, comunicate con nosotros.`;

  try {
    const accessToken = await getRingCentralToken(settings);

    // Probamos cada candidato en orden. Nos quedamos con el primero
    // que RingCentral acepte; si ninguno funciona, logueamos todos
    // los intentos para poder diagnosticar.
    const attempts: { phone: string; data: any }[] = [];
    let success: { phone: string; data: any } | null = null;

    for (const candidate of phoneCandidates) {
      const { ok, data } = await sendSms(settings, accessToken, candidate, messageText);
      attempts.push({ phone: candidate, data });
      if (ok) {
        success = { phone: candidate, data };
        break;
      }
    }

    await supabase.from("messages_log").insert({
      vehicle_label: vehicleLabel,
      plate,
      phone: success ? success.phone : phoneCandidates[0],
      message_body: messageText,
      status: success ? "sent" : "failed",
      error_detail: success
        ? null
        : `Se probaron ${attempts.length} prefijo(s) y ninguno funcionó: ` +
          JSON.stringify(attempts),
      taxicaller_event_id: eventId,
    });

    return new Response(
      JSON.stringify({ ok: !!success, attempts, success }),
      { status: 200 },
    );
  } catch (err) {
    await supabase.from("messages_log").insert({
      vehicle_label: vehicleLabel,
      plate,
      phone: phoneCandidates[0],
      message_body: messageText,
      status: "failed",
      error_detail: String(err),
      taxicaller_event_id: eventId,
    });
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 200,
    });
  }
});
