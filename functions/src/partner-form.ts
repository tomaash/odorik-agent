import { onRequest } from "firebase-functions/v2/https";
import { Resend } from "resend";
import { resendApiKey } from "./teams.js";
import {
  isThrottled,
  partnerFormSchema,
  partnerFormSubject,
  renderPartnerFormEmail,
} from "./partner-form-message.js";

const recipient = "tomas.holas@gmail.com";
const sender = "Agent Erik <onboarding@resend.dev>";

export const sendPartnerForm = onRequest(
  {
    region: "europe-west3",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 3,
    secrets: [resendApiKey],
    cors: true,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).json({ error: "Method not allowed" });
      return;
    }

    const parsed = partnerFormSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid submission" });
      return;
    }

    const input = parsed.data;
    // Accepted, never delivered: a bot gets the same answer as a person.
    if (input.website) {
      response.status(202).json({ ok: true });
      return;
    }

    if (isThrottled(input.email.toLowerCase(), Date.now())) {
      response.status(429).json({ error: "Too many submissions" });
      return;
    }

    try {
      const resend = new Resend(resendApiKey.value());
      const { error } = await resend.emails.send({
        from: sender,
        to: recipient,
        replyTo: input.email,
        subject: partnerFormSubject(input),
        html: renderPartnerFormEmail(input),
      });
      if (error) throw new Error(error.message);
      response.status(200).json({ ok: true });
    } catch (error) {
      console.error("[partner-form] send failed", error);
      response.status(502).json({ error: "Could not send the message" });
    }
  },
);
