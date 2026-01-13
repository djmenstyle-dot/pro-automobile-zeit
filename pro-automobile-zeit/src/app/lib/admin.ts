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
 * Aktiviert Chef-Modus (24h) per PIN-Check.
 * expectedPin kommt aus NEXT_PUBLIC_ADMIN_PIN
 */
export function ensureAdmin(expectedPin: string): boolean {
  if (typeof window === "undefined") return false;

  if (!expectedPin) {
    alert("Admin PIN fehlt (NEXT_PUBLIC_ADMIN_PIN in Vercel setzen).");
    return false;
  }

  if (isAdmin()) return true;

  const p = prompt("Chef PIN eingeben:");
  if (!p) return false;

  if (p.trim() !== expectedPin.trim()) {
    alert("PIN falsch");
    return false;
  }

  // 24h gültig
  localStorage.setItem(ADMIN_SESSION_KEY, String(nowMs() + 24 * 60 * 60 * 1000));
  alert("✅ Chef-Modus aktiv (24h)");
  return true;
}

/**
 * Nur PIN abfragen (für API Calls wie Foto löschen).
 * expectedPin ist der richtige PIN (NEXT_PUBLIC_ADMIN_PIN)
 */
export function promptAdminPin(expectedPin: string): string | null {
  if (typeof window === "undefined") return null;

  if (!expectedPin) {
    alert("Admin PIN fehlt (NEXT_PUBLIC_ADMIN_PIN in Vercel setzen).");
    return null;
  }

  const p = prompt("Chef PIN eingeben:");
  if (!p) return null;

  if (p.trim() !== expectedPin.trim()) {
    alert("PIN falsch");
    return null;
  }

  return p.trim();
}

export function logoutAdmin() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ADMIN_SESSION_KEY);
}
