export const ADMIN_SESSION_KEY = "proauto_admin_until";

export function nowMs() {
  return Date.now();
}

export function isAdmin() {
  if (typeof window === "undefined") return false;
  const until = Number(localStorage.getItem(ADMIN_SESSION_KEY) || "0");
  return until > nowMs();
}

/**
 * Optional: returns entered pin or null.
 * Some older code imports this – so we keep it exported to avoid build errors.
 */
export function promptAdminPin(_expectedPin?: string): string | null {
  if (typeof window === "undefined") return null;
  const p = prompt("Chef PIN eingeben:");
  if (!p) return null;
  return p.trim() || null;
}

/**
 * Fragt PIN ab und setzt Chef-Modus (24h).
 * Returns true wenn Chef-Modus aktiv ist.
 */
export function ensureAdmin(adminPin: string): boolean {
  if (typeof window === "undefined") return false;

  if (!adminPin) {
    alert("Admin PIN fehlt (NEXT_PUBLIC_ADMIN_PIN in Vercel setzen).");
    return false;
  }

  if (isAdmin()) return true;

  const p = promptAdminPin(adminPin);
  if (!p) return false;

  if (p !== adminPin) {
    alert("PIN falsch");
    return false;
  }

  localStorage.setItem(ADMIN_SESSION_KEY, String(nowMs() + 24 * 60 * 60 * 1000));
  alert("✅ Chef-Modus aktiv (24h)");
  return true;
}

export function logoutAdmin() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ADMIN_SESSION_KEY);
}
