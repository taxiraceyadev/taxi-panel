// ============================================================
// Edge Function: taxicaller-webhook
//
// Recibe los webhooks de TaxiCaller (configurados a mano en TaxiCaller
// para 4 eventos: Waiting for passenger, Canceled: By company,
// Job marked as delivered, Passenger on board) y manda el SMS que
// corresponda por RingCentral.
//
// Deploy:
//   supabase functions deploy taxicaller-webhook --no-verify-jwt
//
// Secrets necesarios (Supabase los inyecta automático):
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
// El "event" de cada webhook lo escribimos NOSOTROS a mano en la
// plantilla del body, en el Admin Panel de TaxiCaller (Settings ->
// Notifications -> Webhooks). Los valores usados son:
//   waiting_for_passenger, canceled_by_company, delivered, passenger_on_board
//
// La placa (vehicle_plate) se usa como identificador único de la
// unidad para la deduplicación del estado "en espera".
// ------------------------------------------------------------
function parseTaxiCallerPayload(body: any) {
  const plate = body?.vehicle_plate || null;
  const vehicleId = plate; // identificador único de la unidad (puede ser null si no había unidad asignada)

  const vehicleMake = body?.vehicle_make || "";
  const vehicleColor = body?.vehicle_color || "";
  const phoneRaw =
    body?.passenger_phone ?? body?.job?.passenger?.phone ?? body?.phone ?? null;
  const fareRaw = body?.fare ?? null;

  const event = String(body?.event ?? body?.event_type ?? body?.status ?? "").trim();
  const eventId = body?.job_id ?? body?.event_id ?? body?.id ?? crypto.randomUUID();

  return { event, vehicleId, plate, vehicleMake, vehicleColor, phoneRaw, fareRaw, eventId };
}

// ------------------------------------------------------------
// Textos de los mensajes, bilingües, tal como los tenías en TaxiCaller.
// ------------------------------------------------------------
function buildVehicleDesc(make: string, color: string, plate: string | null) {
  return [make, color, plate].filter(Boolean).join(", ") || "su unidad asignada";
}

const MESSAGE_BUILDERS: Record<string, (d: ReturnType<typeof parseTaxiCallerPayload>) => string> = {
  waiting_for_passenger: (d) => {
    const desc = buildVehicleDesc(d.vehicleMake, d.vehicleColor, d.plate);
    return (
      `Su vehículo ${desc} le está esperando afuera. / ` +
      `Your driver ${desc} is waiting for you outside.`
    );
  },
  canceled_by_company: () =>
    `Su servicio ha sido cancelado. / Your service has been cancelled.`,
  delivered: (d) => {
    const desc = buildVehicleDesc(d.vehicleMake, d.vehicleColor, d.plate);
    const fare = d.fareRaw ?? "N/D";
    return (
      `¡Su servicio realizado por la Unidad ${desc} fue completado con éxito! ` +
      `El cobro fue de $${fare}. / Your service made by Unit ${desc} has been ` +
      `successfully completed, the charge was $${fare}.`
    );
  },
};

// Eventos que marcan a la unidad como "en espera" (dispara la deduplicación
// por unidad). Cualquier otro evento reconocido libera la unidad.
const ON_HOLD_EVENTS = new Set(["waiting_for_passenger"]);

// ------------------------------------------------------------
// Arma la lista de teléfonos candidatos a probar, uno por cada
// código de país configurado, porque TaxiCaller manda el teléfono
// sin código de país y no hay forma de saber a cuál corresponde.
// El campo "Código de país" del panel admite varios separados por
// coma o espacio, ej: "+1, +52, +58"
// ------------------------------------------------------------
function buildCandidatePhones(phoneRaw: string | null, countryCodesRaw: string | null) {
  if (!phoneRaw) return [];
  const digitsOnly = phoneRaw.replace(/[^\d+]/g, "");
  if (digitsOnly.startsWith("+")) return [digitsOnly];

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
// Manda el SMS probando cada código de país candidato, y guarda
// el resultado en messages_log. Se usa para los 3 eventos que
// mandan mensaje (waiting, canceled, delivered).
// ------------------------------------------------------------
async function sendAndLog(
  settings: any,
  vehicleLabel: string,
  plate: string | null,
  phoneRaw: string,
  eventId: string,
  messageText: string,
) {
  const phoneCandidates = buildCandidatePhones(phoneRaw, settings.phone_country_code);

  if (phoneCandidates.length === 0) {
    await supabase.from("messages_log").insert({
      vehicle_label: vehicleLabel,
      plate,
      phone: phoneRaw,
      message_body: messageText,
      status: "failed",
      error_detail:
        `El teléfono "${phoneRaw}" no tiene código de país y falta configurar ` +
        `al menos un prefijo en el campo "Código de país" del panel (ej: +1, +52, +58).`,
      taxicaller_event_id: eventId,
    });
    return;
  }

  try {
    const accessToken = await getRingCentralToken(settings);
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
  }
}

// ------------------------------------------------------------
// Handler principal
// ------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

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

  const { event, vehicleId, plate, vehicleMake, vehicleColor, phoneRaw, eventId } =
    parseTaxiCallerPayload(rawBody);
  const parsed = parseTaxiCallerPayload(rawBody);

  if (!event) {
    return new Response(JSON.stringify({ ok: true, action: "ignored_no_event" }), {
      status: 200,
    });
  }

  const isOnHoldEvent = ON_HOLD_EVENTS.has(event);

  // --- Llevar el estado de la unidad (vehicles_on_hold) ---
  if (isOnHoldEvent && vehicleId) {
    // Deduplicación: si ya estaba on_hold, no mandamos mensaje de nuevo.
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

    await supabase.from("vehicles_on_hold").upsert(
      {
        taxicaller_vehicle_id: vehicleId,
        vehicle_label: vehicleMake,
        plate,
        status: "on_hold",
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "taxicaller_vehicle_id" },
    );
  } else if (!isOnHoldEvent && vehicleId) {
    // Cualquier otro evento reconocido libera la unidad.
    await supabase
      .from("vehicles_on_hold")
      .update({ status: "cleared", last_seen_at: new Date().toISOString() })
      .eq("taxicaller_vehicle_id", vehicleId);
  }

  // --- ¿Este evento manda SMS? ---
  const buildMessage = MESSAGE_BUILDERS[event];
  if (!buildMessage) {
    // Evento reconocido para liberar la unidad, pero sin mensaje asociado
    // (ej: passenger_on_board).
    return new Response(JSON.stringify({ ok: true, action: "no_message_for_event" }), {
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

  const { data: settings, error: settingsError } = await supabase
    .from("settings")
    .select("*")
    .eq("id", 1)
    .single();

  if (settingsError || !settings?.server_url || !settings?.client_id) {
    await supabase.from("messages_log").insert({
      vehicle_label: vehicleMake,
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

  const messageText = buildMessage(parsed);
  await sendAndLog(settings, vehicleMake, plate, phoneRaw, eventId, messageText);

  return new Response(JSON.stringify({ ok: true, action: "message_attempted" }), {
    status: 200,
  });
});
