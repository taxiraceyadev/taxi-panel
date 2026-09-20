// ============================================================
// Edge Function: admin-create-user
//
// Crea un usuario nuevo de Supabase Auth (email + contraseña) desde
// el panel, sin tener que ir al Dashboard de Supabase. Solo admins.
//
// Deploy:
//   supabase functions deploy admin-create-user
//   (SIN --no-verify-jwt, a propósito)
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

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

  const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(token);
  if (callerError || !callerData?.user) {
    return jsonResponse({ ok: false, reason: "token inválido" }, 401);
  }
  const callerId = callerData.user.id;

  const { data: callerProfile, error: callerProfileError } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", callerId)
    .single();

  if (callerProfileError || callerProfile?.role !== "admin") {
    return jsonResponse({ ok: false, reason: "no autorizado, se requiere rol admin" }, 403);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, reason: "JSON inválido" }, 400);
  }

  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  const displayName = String(body?.display_name ?? "").trim();
  const role = String(body?.role ?? "viewer");
  const phone = String(body?.phone ?? "").trim();
  const description = String(body?.description ?? "").trim();

  if (!email || !password) {
    return jsonResponse({ ok: false, reason: "faltan email o contraseña" }, 400);
  }
  if (password.length < 6) {
    return jsonResponse({ ok: false, reason: "la contraseña necesita al menos 6 caracteres" }, 400);
  }
  if (!["admin", "viewer"].includes(role)) {
    return jsonResponse({ ok: false, reason: `rol inválido: ${role}` }, 400);
  }

  const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // no hace falta que confirme el mail para poder entrar
  });

  if (createError || !newUser?.user) {
    return jsonResponse({ ok: false, reason: createError?.message ?? "no se pudo crear el usuario" }, 400);
  }

  // El trigger on_auth_user_created ya le crea el perfil como 'viewer'.
  // Acá lo actualizamos con el rol, nombre, teléfono y descripción elegidos.
  const { error: profileError } = await supabaseAdmin
    .from("profiles")
    .update({
      role,
      display_name: displayName || null,
      phone: phone || null,
      description: description || null,
    })
    .eq("id", newUser.user.id);

  if (profileError) {
    console.error("ERROR al actualizar perfil del usuario nuevo:", JSON.stringify(profileError));
  }

  await supabaseAdmin.from("admin_actions").insert({
    actor_id: callerId,
    actor_email: callerData.user.email ?? null,
    action: "Creó un usuario",
    detail: `${email} (${role})`,
  });

  return jsonResponse({ ok: true, user_id: newUser.user.id });
});
