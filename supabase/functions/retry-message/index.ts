// ============================================================
// Edge Function: retry-message
//
// Reintenta mandar un SMS que quedó marcado como 'failed' en
// messages_log, usando el mismo texto y teléfono que ya tenía.
//
// A diferencia de taxicaller-webhook, esta función SÍ verifica el
// token de sesión de Supabase Auth (no se despliega con
// --no-verify-jwt), así que solo alguien logueado en el panel puede
// llamarla. Además, adentro chequeamos que sea específicamente un
// usuario con rol 'admin' (no un 'viewer').
//
// Deploy:
//   supabase functions deploy retry-message
//   (SIN --no-verify-jwt, a propósito)
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { trySendSms } from "../_shared/ringcentral.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Cliente con permisos totales, para leer/escribir sin restricciones
// una vez que ya confirmamos que quien llama es admin.
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

// El panel llama a esta función directo desde el navegador (fetch),
// así que necesita headers CORS explícitos, o el navegador la bloquea
// antes de que nuestro código llegue a correr.
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

  // El gateway de Supabase ya validó que el JWT sea válido (porque
  // desplegamos esta función SIN --no-verify-jwt). Igual extraemos el
  // usuario para saber quién es y chequear su rol.
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

  const messageId = body?.message_id;
  if (!messageId) {
    return jsonResponse({ ok: false, reason: "falta message_id" }, 400);
  }

  const { data: message, error: messageError } = await supabaseAdmin
    .from("messages_log")
    .select("*")
    .eq("id", messageId)
    .single();

  if (messageError || !message) {
    return jsonResponse({ ok: false, reason: "mensaje no encontrado" }, 404);
  }

  if (!message.phone || !message.message_body) {
    return jsonResponse(
      { ok: false, reason: "el mensaje no tiene teléfono o texto guardado, no se puede reintentar" },
      400,
    );
  }

  const { data: settings, error: settingsError } = await supabaseAdmin
    .from("settings")
    .select("*")
    .eq("id", 1)
    .single();

  if (settingsError || !settings?.server_url || !settings?.client_id) {
    return jsonResponse({ ok: false, reason: "configuración de RingCentral incompleta" }, 400);
  }

  try {
    // Usamos el teléfono tal como ya quedó guardado (ya viene completo,
    // con código de país, de un intento anterior). trySendSms igual
    // sabe manejarlo si por algún motivo viniera sin "+".
    const result = await trySendSms(settings, message.phone, message.message_body);

    const { error: updateError } = await supabaseAdmin
      .from("messages_log")
      .update({
        phone: result.phone,
        status: result.ok ? "sent" : "failed",
        error_detail: result.ok ? null : result.error,
        retried_at: new Date().toISOString(),
        retried_by: userId,
      })
      .eq("id", messageId);

    if (updateError) {
      console.error("ERROR al actualizar messages_log tras reintento:", JSON.stringify(updateError));
      return jsonResponse({ ok: false, reason: "no se pudo guardar el resultado del reintento" }, 500);
    }

    return jsonResponse({ ok: result.ok, phone: result.phone, error: result.error });
  } catch (err) {
    await supabaseAdmin
      .from("messages_log")
      .update({
        status: "failed",
        error_detail: String(err),
        retried_at: new Date().toISOString(),
        retried_by: userId,
      })
      .eq("id", messageId);
    return jsonResponse({ ok: false, reason: String(err) }, 500);
  }
});
