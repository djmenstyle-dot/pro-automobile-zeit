export const ADMIN_SESSION_KEY = "proauto_admin_until";

function nowMs() {
  return Date.now();
}

/**
 * Chef-Modus aktiv? (24h Session im localStorage)
 */
export function isAdmin(): boolean {
  if (typeof window === "undefined") return false;
  const until = Number(localStorage.getItem(ADMIN_SESSION_KEY) || "0");
  return until > nowMs();
}

/**
 * Fragt Chef-PIN ab und setzt Chef-Modus 24h aktiv.
 * adminPin kommt aus NEXT_PUBLIC_ADMIN_PIN.
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

  // 24h gültig
  localStorage.setItem(ADMIN_SESSION_KEY, String(nowMs() + 24 * 60 * 60 * 1000));
  alert("✅ Chef-Modus aktiv (24h)");
  return true;
}

export function logoutAdmin() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ADMIN_SESSION_KEY);
}
