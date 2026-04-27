import "dotenv/config";
import express from "express";
import http from "http";
import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const wss = new WebSocketServer({ server, path: "/twilio-media" });

app.get("/", (req, res) => {
  res.json({ status: "Lare Auto voice server live" });
});

app.post("/voice", (req, res) => {
  const host = req.headers.host;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.get("/voice", (req, res) => {
  res.json({ status: "Lare Auto voice route live" });
});

async function getQuote(data) {
  try {
    const res = await axios.post("https://lareauto.ca/api/voice/quote", data, {
      timeout: 10000,
    });

    return res.data?.message || "Our parts team will confirm shortly.";
  } catch (error) {
    console.error("Quote API error:", error?.response?.data || error.message);
    return "Sorry, I could not check inventory right now. Our parts team will get back to you shortly.";
  }
}

async function saveVoiceLead(data) {
  try {
    const res = await axios.post("https://lareauto.ca/api/voice/lead", data, {
      timeout: 10000,
    });

    return `Lead saved successfully. Lead ID: ${res.data?.leadId || "unknown"}`;
  } catch (error) {
    console.error("Voice lead save error:", error?.response?.data || error.message);
    return "Lead could not be saved.";
  }
}

function normalizePhone(phone) {
  if (!phone) return null;

  let cleaned = String(phone).trim().replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) return cleaned;

  const digits = cleaned.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return cleaned;
}

async function sendQuoteSMS(to, message) {
  try {
    const normalizedTo = normalizePhone(to);

    if (!normalizedTo) {
      return "Unable to send SMS because the phone number is missing.";
    }

    if (!process.env.TWILIO_PHONE_NUMBER) {
      return "Unable to send SMS because Twilio phone number is not configured.";
    }

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: normalizedTo,
    });

    return "Quote sent successfully.";
  } catch (error) {
    console.error("SMS Error:", error?.message || error);
    return "Unable to send SMS right now.";
  }
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected to voice server");

  let streamSid = null;
  let callerPhone = null;
  let lastQuoteMessage = null;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime");

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: "shimmer",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          tools: [
            {
              type: "function",
              name: "get_part_quote",
              description:
                "Look up Lare Automotive inventory and price for a requested auto part.",
              parameters: {
                type: "object",
                properties: {
                  year: { type: "string" },
                  make: { type: "string" },
                  model: { type: "string" },
                  engine: { type: "string" },
                  part: { type: "string" },
                },
                required: ["year", "make", "model", "part"],
              },
            },
            {
              type: "function",
              name: "save_voice_lead",
              description:
                "Save the caller's part request and lead details for Lare Automotive follow-up.",
              parameters: {
                type: "object",
                properties: {
                  callerPhone: { type: "string" },
                  customerType: {
                    type: "string",
                    enum: [
                      "retail",
                      "referred_customer",
                      "mechanic",
                      "approved_mechanic",
                      "unknown",
                    ],
                  },
                  customerName: { type: "string" },
                  year: { type: "string" },
                  make: { type: "string" },
                  model: { type: "string" },
                  engine: { type: "string" },
                  part: { type: "string" },
                  postalCode: { type: "string" },
                  mechanicName: { type: "string" },
                  shopName: { type: "string" },
                  callbackPhone: { type: "string" },
                  quoteFound: { type: "boolean" },
                  quoteMessage: { type: "string" },
                  quotePriceCents: { type: "number" },
                  currency: { type: "string" },
                  status: { type: "string" },
                },
                required: ["year", "make", "model", "part"],
              },
            },
            {
              type: "function",
              name: "send_quote_sms",
              description:
                "Send a quote by SMS to the customer phone number after the customer agrees.",
              parameters: {
                type: "object",
                properties: {
                  phone: {
                    type: "string",
                    description:
                      "Customer mobile number. Use caller phone if customer agrees to text the current number.",
                  },
                  message: {
                    type: "string",
                    description:
                      "The SMS quote message including part quote, tax/delivery note, payment link, and e-transfer option.",
                  },
                },
                required: ["phone", "message"],
              },
            },
          ],
          tool_choice: "auto",
          instructions: `
You are Maya, a friendly, soft-spoken female phone assistant for Lare Automotive Parts Supply in Ontario.

Voice style:
- Speak gently, warmly, softly, and professionally.
- Use a calm customer-service tone.
- Speak slightly slower than normal.
- Keep replies short and natural.
- Ask only one question at a time.

Main job:
- Greet customers nicely, softly, professionally, and friendly.
- Help customers find auto parts.
- Collect year, make, model, engine size, and part needed.
- If the caller already gave a detail, do not ask for it again.
- If engine size is missing, ask for engine size or VIN.
- Once you have year, make, model, engine if available, and part, call get_part_quote.
- After quote or important lead details, call save_voice_lead silently. Do not tell caller about saving.

Caller phone:
- The caller phone number may be provided by the system as: ${callerPhone || "unknown"}.
- Use that as callerPhone when saving lead.
- If caller gives a better callback number, save that as callbackPhone.

Direct retail customer flow:
- After giving the part price, do NOT ask for pickup.
- Ask for postal code to calculate delivery charges plus tax.
- Say: "May I have your postal code so I can let you know the total charges including delivery and tax?"
- After quote is given, ask: "Would you like me to text this quote and payment information to your phone?"
- If customer says yes, confirm whether to use the current calling number.
- If customer gives another phone number, use that number.
- Only after customer agrees, call send_quote_sms.
- SMS message must include:
  - Lare Automotive Parts Supply
  - vehicle and part
  - quoted price
  - note: delivery charges and tax will be confirmed after postal code
  - secure payment link: https://lareauto.ca
  - e-transfer option: accounts@lareauto.ca
- If customer is ready to purchase, ask if they are comfortable paying online.
- Say Lare Automotive can send a secure payment link.
- Also mention e-transfer to accounts@lareauto.ca if they prefer.
- Do not collect card numbers on the phone.

Customer referred by mechanic:
- Ask: "May I have the mechanic shop name or mechanic's name, please?"
- Continue with the quote.
- Do not discuss mechanic discounts or partner pricing with the customer.

Mechanic or repair shop caller:
- Ask: "May I have your shop name, please?"
- Use professional trade-counter language.
- If price is available, say: "I found that part. Retail is [price]. I’ll confirm your shop pricing and availability."
- Ask whether they need delivery to the shop.
- Do not promise a discount unless the shop is verified.

Approved mechanic partner:
- Ask for shop name and callback phone number.
- Say: "Thank you. I’ll check your partner account and confirm the mechanic pricing."
- Do not reveal partner pricing unless verified.

General rules:
- If unsure whether caller is retail or mechanic, ask: "Are you calling as a customer or from a repair shop?"
- Support English, Punjabi, and French.
- Reply in the same language the caller uses.
- Do not mention OpenAI, ChatGPT, tools, API, database, or saving lead.
          `,
        },
      })
    );

    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Say softly: Thank you for calling Lare Automotive Parts Supply. This is Maya. What vehicle and part are you looking for today?",
        },
      })
    );
  });

  twilioWs.on("message", (message) => {
    const data = JSON.parse(message.toString());

    if (data.event === "start") {
      streamSid = data.start.streamSid;

      callerPhone =
        data.start.customParameters?.From ||
        data.start.customParameters?.from ||
        data.start.from ||
        data.start.caller ||
        null;

      console.log("Twilio stream started:", streamSid, "Caller:", callerPhone);
    }

    if (data.event === "media" && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload,
        })
      );
    }

    if (data.event === "stop") {
      console.log("Twilio stream stopped");
      openaiWs.close();
    }
  });

  openaiWs.on("message", async (message) => {
    const event = JSON.parse(message.toString());

    if (event.type === "response.audio.delta" && event.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: event.delta },
        })
      );
    }

    if (event.type === "response.function_call_arguments.done") {
      try {
        const args = JSON.parse(event.arguments || "{}");

        if (event.name === "get_part_quote") {
          const quoteMessage = await getQuote(args);
          lastQuoteMessage = quoteMessage;

          openaiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: event.call_id,
                output: quoteMessage,
              },
            })
          );

          openaiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Read the quote result to the caller in a soft, professional tone. If this is a retail customer, ask for their postal code to calculate delivery charges and tax. Do not ask for pickup. Then ask if they would like this quote and payment information sent by text message.",
              },
            })
          );
        }

        if (event.name === "save_voice_lead") {
          const saveResult = await saveVoiceLead({
            ...args,
            callerPhone: args.callerPhone || callerPhone,
            quoteMessage: args.quoteMessage || lastQuoteMessage,
            source: "voice",
          });

          openaiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: event.call_id,
                output: saveResult,
              },
            })
          );
        }

        if (event.name === "send_quote_sms") {
          const phoneToUse = args.phone || callerPhone;

          const messageToSend =
            args.message ||
            `${lastQuoteMessage || "Lare Automotive quote."}\n\nDelivery charges and tax will be confirmed after postal code.\nPay securely: https://lareauto.ca\nE-transfer: accounts@lareauto.ca`;

          const smsResult = await sendQuoteSMS(phoneToUse, messageToSend);

          openaiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: event.call_id,
                output: smsResult,
              },
            })
          );

          openaiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "If SMS was sent successfully, tell the caller politely: I have texted the quote and payment information to you. If SMS failed, apologize and say our team will follow up shortly.",
              },
            })
          );
        }
      } catch (error) {
        console.error("Function call handling error:", error);
      }
    }

    if (event.type === "error") {
      console.error("OpenAI Realtime error:", event.error);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on("close", () => {
    console.log("OpenAI Realtime disconnected");
  });

  openaiWs.on("error", (error) => {
    console.error("OpenAI WebSocket error:", error);
  });
});

server.listen(PORT, () => {
  console.log(`Lare Auto voice server running on port ${PORT}`);
});