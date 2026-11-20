/**
 * PII masking at the tool boundary. get_customer never returns a full email or phone number,
 * so no prompt, log or trace downstream can contain one, whatever the model is told.
 * See docs/adr/0003-pii-at-the-boundary.md.
 */

/** "asha.sharma1@example.com" -> "a***1@example.com". The domain is kept; it is rarely identifying. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const tail = local.length > 2 ? local.slice(-1) : "";
  return `${local[0]}***${tail}@${domain}`;
}

/** "+91 9107654321" -> "+91 ******4321". Only the country code and last four digits survive. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  const country =
    phone.trim().startsWith("+") && digits.length > 10 ? `+${digits.slice(0, -10)} ` : "";
  return `${country}${"*".repeat(national.length - 4)}${digits.slice(-4)}`;
}
