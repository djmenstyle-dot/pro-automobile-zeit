export function fmtMin(min: number) {
  const h = Math.floor(min / 60);
  const r = min % 60;
  return (h > 0 ? `${h}h ` : "") + `${r}min`;
}

export function toLocal(iso?: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

export function durationMinutes(startIso: string, endIso?: string | null) {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  return Math.max(0, Math.round((end - start) / 60000));
}
