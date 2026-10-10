import { fakeResendClient, fakesEnabled } from "../../e2e/fakes";
import { Resend } from "resend";

let client: Resend | null = null;

export function isEmailConfigured(): boolean {
  if (fakesEnabled()) return true;
  return !!(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM?.trim());
}

export function getResendClient(): Resend | null {
  if (fakesEnabled()) return fakeResendClient() as unknown as Resend;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  if (!client) client = new Resend(apiKey);
  return client;
}

export function getFromAddress(): string | null {
  if (fakesEnabled()) return "Xevo E2E <e2e@xevo.test>";
  const from = process.env.RESEND_FROM?.trim();
  if (from) return from;
  if (process.env.RESEND_API_KEY?.trim()) return "Xevo <notifications@axevo.ai>";
  return null;
}
