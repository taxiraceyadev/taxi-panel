// ============================================================
// Edge Function: send-test-message
//
// Manda un SMS de prueba (con datos que el admin elige a mano) sin
// necesidad de forzar un evento real en TaxiCaller. Igual que
// retry-message, requiere sesión válida y rol admin.
//
// Deploy:
//   supabase functions deploy send-test-message
//   (SIN --no-verify-jwt, a propósito)
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { trySendSms } from "../_shared/ringcentral.ts";
import { MESSAGE_BUILDERS, EVENT_LABELS } from "../_shared/messages.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, reason: "method_not_allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ ok: false, reason: "sin token" }, 401);
  }
  const token = authHeader.replace("Bearer ", "");

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, reason: "token inválido" }, 401);
  }
  const userId = userData.user.id;
  const userEmail = userData.user.email ?? null;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (profileError || profile?.role !== "admin") {
    return jsonResponse({ ok: false, reason: "no autorizado, se requiere rol admin" }, 403);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, reason: "JSON inválido" }, 400);
  }

  const eventType = String(body?.event_type ?? "");
  const buildMessage = MESSAGE_BUILDERS[eventType];
  if (!buildMessage) {
    return jsonResponse(
      { ok: false, reason: `Tipo de evento inválido: "${eventType}"` },
      400,
    );
  }

  const phone = String(body?.phone ?? "").trim();
  if (!phone) {
    return jsonResponse({ ok: false, reason: "falta el teléfono de prueba" }, 400);
  }

  const vehicleMake = String(body?.vehicle_make ?? "Unidad de prueba").trim();
  const vehicleColor = String(body?.vehicle_color ?? "").trim();
  const plate = String(body?.plate ?? "TEST123").trim();
  const fareRaw = body?.fare ? String(body.fare).trim() : null;

  const { data: settings, error: settingsError } = await supabaseAdmin
    .from("settings")
    .select("*")
    .eq("id", 1)
    .single();

  if (settingsError || !settings?.server_url || !settings?.client_id) {
    return jsonResponse({ ok: false, reason: "configuración de RingCentral incompleta" }, 400);
  }

  const messageText = buildMessage({ vehicleMake, vehicleColor, plate, fareRaw });

  try {
    const result = await trySendSms(settings, phone, messageText);

    await supabaseAdmin.from("messages_log").insert({
      vehicle_label: vehicleMake,
      plate,
      phone: result.phone,
      message_body: messageText,
      status: result.ok ? "sent" : "failed",
      event_type: eventType,
      error_detail: result.ok ? null : result.error,
      taxicaller_event_id: `test-${crypto.randomUUID()}`,
      is_test: true,
    });

    await supabaseAdmin.from("admin_actions").insert({
      actor_id: userId,
      actor_email: userEmail,
      action: "Envió SMS de prueba",
      detail: `${EVENT_LABELS[eventType] ?? eventType} → ${phone} (${result.ok ? "enviado" : "falló"})`,
    });

    return jsonResponse({ ok: result.ok, phone: result.phone, error: result.error, message: messageText });
  } catch (err) {
    await supabaseAdmin.from("messages_log").insert({
      vehicle_label: vehicleMake,
      plate,
      phone,
      message_body: messageText,
      status: "failed",
      event_type: eventType,
      error_detail: String(err),
      taxicaller_event_id: `test-${crypto.randomUUID()}`,
      is_test: true,
    });
    return jsonResponse({ ok: false, reason: String(err) }, 500);
  }
});
