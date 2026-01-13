export const ADMIN_SESSION_KEY = "proauto_admin_until";

function nowMs() {
  return Date.now();
}

export function isAdmin() {
  if (typeof window === "undefined") return false;
  const until = Number(localStorage.getItem(ADMIN_SESSION_KEY) || "0");
  return until > nowMs();
}

/**
 * Client: prüft Pin und merkt sich Chef-Modus 24h.
 */
export function ensureAdmin(adminPin: string): boolean {
  if (typeof window === "undefined") return false;

  if (!adminPin) {
    alert("Admin PIN fehlt (NEXT_PUBLIC_ADMIN_PIN in Vercel setzen).");
    return false;
  }

  if (isAdmin()) return true;

  const p = prompt("Chef PIN eingeben:");
  if (!p) return false;

  if (p.trim() !== adminPin) {
    alert("PIN falsch");
    return false;
  }

  localStorage.setItem(ADMIN_SESSION_KEY, String(nowMs() + 24 * 60 * 60 * 1000));
  alert("✅ Chef-Modus aktiv (24h)");
  return true;
}

/**
 * Für Server-Aktionen (Löschen / Admin-API):
 * -> fragt PIN ab und gibt ihn zurück, wenn korrekt.
 */
export function promptAdminPin(adminPin: string): string | null {
  if (typeof window === "undefined") return null;

  if (!adminPin) {
    alert("Admin PIN fehlt (NEXT_PUBLIC_ADMIN_PIN in Vercel setzen).");
    return null;
  }

  const p = prompt("Chef PIN eingeben:");
  if (!p) return null;

  if (p.trim() !== adminPin) {
    alert("PIN falsch");
    return null;
  }
  return p.trim();
}

export function logoutAdmin() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ADMIN_SESSION_KEY);
}
