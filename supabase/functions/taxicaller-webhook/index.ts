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
// TaxiCaller no publica un esquema fijo para este webhook, así
// que esta función guarda el payload crudo en los logs de la
// función (Supabase Dashboard -> Edge Functions -> Logs) la
// primera vez que llegue algo. Ajustá las rutas de abajo una vez
// que veas la forma real del JSON que te manda tu cuenta.
// ------------------------------------------------------------
function parseTaxiCallerPayload(body: any) {
  // TODO: ajustar estas rutas según el payload real.
  // Dejo varias alternativas comentadas a modo de guía.
  const vehicleId =
    body?.vehicle?.id ?? body?.meta?.resource_id ?? body?.vehicle_id ?? null;

  const vehicleLabel =
    body?.vehicle?.callsign ??
    body?.vehicle?.label ??
    body?.vehicle?.name ??
    body?.vehicle_label ??
    "Unidad sin nombre";

  const plate =
    body?.vehicle?.plate ??
    body?.vehicle?.license_plate ??
    body?.plate ??
    "Sin placa";

  const phone =
    body?.job?.passenger?.phone ??
    body?.passenger?.phone ??
    body?.customer_phone ??
    body?.phone ??
    null;

  // Estado del evento: distinguí "se puso en espera" de "se liberó",
  // para no reenviar el SMS cada vez que llega el mismo estado.
  const rawStatus =
    body?.event_type ?? body?.status ?? body?.vehicle?.status ?? "";
  const isOnHold = /hold|wait|espera/i.test(String(rawStatus));
  const isCleared = /clear|active|available|libre/i.test(String(rawStatus));

  const eventId = body?.event_id ?? body?.id ?? crypto.randomUUID();

  return { vehicleId, vehicleLabel, plate, phone, isOnHold, isCleared, eventId };
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

  const { vehicleId, vehicleLabel, plate, phone, isOnHold, isCleared, eventId } =
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

  if (!phone) {
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
      phone,
      status: "failed",
      error_detail: "Configuración de RingCentral incompleta (revisar panel)",
      taxicaller_event_id: eventId,
    });
    return new Response(
      JSON.stringify({ ok: false, reason: "settings incompletos" }),
      { status: 200 },
    );
  }

  const messageText =
    `Hola, tu unidad ${vehicleLabel} (patente ${plate}) está en espera. ` +
    `Ante cualquier consulta, comunicate con nosotros.`;

  try {
    const accessToken = await getRingCentralToken(settings);
    const { ok, data } = await sendSms(settings, accessToken, phone, messageText);

    await supabase.from("messages_log").insert({
      vehicle_label: vehicleLabel,
      plate,
      phone,
      message_body: messageText,
      status: ok ? "sent" : "failed",
      error_detail: ok ? null : JSON.stringify(data),
      taxicaller_event_id: eventId,
    });

    return new Response(JSON.stringify({ ok, ringcentral: data }), {
      status: 200,
    });
  } catch (err) {
    await supabase.from("messages_log").insert({
      vehicle_label: vehicleLabel,
      plate,
      phone,
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
