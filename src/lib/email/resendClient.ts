import { Resend } from "resend";

let client: Resend | null = null;

export function isEmailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM?.trim());
}

export function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  if (!client) client = new Resend(apiKey);
  return client;
}

export function getFromAddress(): string | null {
  const from = process.env.RESEND_FROM?.trim();
  return from || null;
}
