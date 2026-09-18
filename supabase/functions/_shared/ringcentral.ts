// ============================================================
// Código compartido entre taxicaller-webhook y retry-message.
// No es una función en sí misma, solo funciones auxiliares.
// ============================================================

// ------------------------------------------------------------
// Arma la lista de teléfonos candidatos a probar, uno por cada
// código de país configurado, porque TaxiCaller manda el teléfono
// sin código de país y no hay forma de saber a cuál corresponde.
// ------------------------------------------------------------
export function buildCandidatePhones(phoneRaw: string | null, countryCodesRaw: string | null) {
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
// RingCentral: obtener access token (JWT bearer flow)
// ------------------------------------------------------------
export async function getRingCentralToken(settings: any) {
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
// RingCentral: enviar el SMS
// ------------------------------------------------------------
export async function sendSms(
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
// Intenta mandar un SMS probando cada código de país candidato en
// orden, hasta que uno funcione. Devuelve el resultado final.
// ------------------------------------------------------------
export async function trySendSms(
  settings: any,
  phoneRaw: string,
  messageText: string,
) {
  const phoneCandidates = buildCandidatePhones(phoneRaw, settings.phone_country_code);

  if (phoneCandidates.length === 0) {
    return {
      ok: false,
      phone: phoneRaw,
      error:
        `El teléfono "${phoneRaw}" no tiene código de país y falta configurar ` +
        `al menos un prefijo en el campo "Código de país" del panel (ej: +1, +52, +58).`,
    };
  }

  const accessToken = await getRingCentralToken(settings);
  const attempts: { phone: string; data: any }[] = [];

  for (const candidate of phoneCandidates) {
    const { ok, data } = await sendSms(settings, accessToken, candidate, messageText);
    attempts.push({ phone: candidate, data });
    if (ok) {
      return { ok: true, phone: candidate, error: null };
    }
  }

  return {
    ok: false,
    phone: phoneCandidates[0],
    error:
      `Se probaron ${attempts.length} prefijo(s) y ninguno funcionó: ` +
      JSON.stringify(attempts),
  };
}
