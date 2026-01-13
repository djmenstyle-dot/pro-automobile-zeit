export const ADMIN_SESSION_KEY = "proauto_admin_until";

export function nowMs() {
  return Date.now();
}

export function isAdmin() {
  if (typeof window === "undefined") return false;
  const until = Number(localStorage.getItem(ADMIN_SESSION_KEY) || "0");
  return until > nowMs();
}

export function ensureAdmin(adminPinEnv: string): boolean {
  if (typeof window === "undefined") return false;

  if (!adminPinEnv) {
    alert("Admin PIN fehlt (NEXT_PUBLIC_ADMIN_PIN in Vercel setzen).");
    return false;
  }

  if (isAdmin()) return true;

  const p = prompt("Chef PIN eingeben:");
  if (!p) return false;

  if (p.trim() !== adminPinEnv.trim()) {
    alert("PIN falsch");
    return false;
  }

  // 24h gültig
  localStorage.setItem(ADMIN_SESSION_KEY, String(nowMs() + 24 * 60 * 60 * 1000));
  alert("✅ Chef-Modus aktiv (24h)");
  return true;
}

/** Für Server-Aktionen (z.B. Löschen via API): wir brauchen den PIN wieder als String */
export function promptAdminPin(): string | null {
  const p = prompt("Chef PIN eingeben:");
  if (!p) return null;
  return p.trim();
}

export function logoutAdmin() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ADMIN_SESSION_KEY);
}
