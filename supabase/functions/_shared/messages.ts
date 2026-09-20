// ============================================================
// Textos de los 3 mensajes. Compartido entre taxicaller-webhook
// y send-test-message, para no tener la misma lógica en dos lados.
// ============================================================

export interface MessageData {
  vehicleMake: string;
  vehicleColor: string;
  plate: string | null;
  fareRaw?: string | null;
}

// El color puede venir bilingüe de TaxiCaller, ej: "Negro / Black".
// Nos quedamos con la parte en español.
function splitBilingualColor(colorRaw: string) {
  const parts = (colorRaw ?? "").split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { es: parts[0], en: parts[1] };
  if (parts.length === 1) return { es: parts[0], en: parts[0] };
  return { es: "", en: "" };
}

export const MESSAGE_BUILDERS: Record<string, (d: MessageData) => string> = {
  waiting_for_passenger: (d) => {
    const color = splitBilingualColor(d.vehicleColor);
    return `Su vehículo ${d.vehicleMake}, color ${color.es}, placa ${d.plate ?? ""}, le está esperando afuera.`;
  },
  canceled_by_company: () => `Su servicio ha sido cancelado.`,
  delivered: (d) => {
    const fare = d.fareRaw ?? "N/D";
    return (
      `Su servicio realizado por la unidad ${d.vehicleMake} fue completado con éxito! ` +
      `El cobro fue de $${fare}.`
    );
  },
};

// Eventos que marcan a la unidad como "en espera". Cualquier otro
// evento reconocido libera la unidad.
export const ON_HOLD_EVENTS = new Set(["waiting_for_passenger"]);

export const EVENT_LABELS: Record<string, string> = {
  waiting_for_passenger: "En espera",
  canceled_by_company: "Cancelado",
  delivered: "Entregado",
};
