export const ADMIN_PIN = process.env.NEXT_PUBLIC_ADMIN_PIN || "";

export function askAdminPin(): boolean {
  if (!ADMIN_PIN) {
    alert("Admin-PIN ist nicht gesetzt (Vercel Env fehlt: NEXT_PUBLIC_ADMIN_PIN).");
    return false;
  }
  const pin = prompt("Chef PIN eingeben:");
  if (!pin) return false;

  if (pin !== ADMIN_PIN) {
    alert("❌ Falscher PIN");
    return false;
  }
  return true;
}
