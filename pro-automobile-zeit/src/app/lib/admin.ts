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
 * Frontend Chef-Modus (24h)
 */
export function ensureAdmin(adminPinEnv: string): boolean {
  if (typeof window === "undefined") return false;

  if (!adminPinEnv) {
    alert("Admin PIN fehlt (NEXT_PUBLIC_ADMIN_PIN in Vercel setzen).");
    return false;
  }

  if (isAdmin()) return true;

  const p = prompt("Chef PIN eingeben:");
  if (!p) return false;

  if (p.trim() !== adminPinEnv) {
    alert("PIN falsch");
    return false;
  }

  // 24h gültig
  localStorage.setItem(ADMIN_SESSION_KEY, String(nowMs() + 24 * 60 * 60 * 1000));
  alert("✅ Chef-Modus aktiv (24h)");
  return true;
}

/**
 * PIN Abfrage (für Server-Delete etc.)
 */
export function promptAdminPin(adminPinEnv: string): string | null {
  if (typeof window === "undefined") return null;
  if (!adminPinEnv) {
    alert("Admin PIN fehlt (NEXT_PUBLIC_ADMIN_PIN in Vercel setzen).");
    return null;
  }
  const p = prompt("Chef PIN eingeben:");
  if (!p) return null;
  if (p.trim() !== adminPinEnv) {
    alert("PIN falsch");
    return null;
  }
  return p.trim();
}

export function logoutAdmin() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ADMIN_SESSION_KEY);
}
