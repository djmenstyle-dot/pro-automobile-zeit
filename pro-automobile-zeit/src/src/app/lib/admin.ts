export function isAdminPinOk(pin?: string) {
  const adminPin = process.env.NEXT_PUBLIC_ADMIN_PIN;
  if (!adminPin) return false;
  if (!pin) return false;
  return pin === adminPin;
}
