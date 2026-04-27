import "dotenv/config";
import express from "express";
import http from "http";
import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const app = express();
app.use(express.json());

const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const wss = new WebSocketServer({ server, path: "/twilio-media" });

app.get("/", (_req, res) => {
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

app.post("/outbound-call", async (req, res) => {
  try {
    const { to, shopName, purpose } = req.body || {};
    const normalizedTo = normalizePhone(to);

    if (!normalizedTo) {
      return res.status(400).json({
        success: false,
        message: "Missing phone number.",
      });
    }

    const host = req.headers.host;

    const call = await twilioClient.calls.create({
      to: normalizedTo,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `https://${host}/outbound-voice?shopName=${encodeURIComponent(
        shopName || ""
      )}&purpose=${encodeURIComponent(purpose || "partnership_intro")}`,
      method: "POST",
    });

    return res.json({
      success: true,
      callSid: call.sid,
      message: "Outbound call started.",
    });
  } catch (error) {
    console.error("Outbound call error:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Could not start outbound call.",
    });
  }
});

app.post("/outbound-voice", (req, res) => {
  const host = req.headers.host;
  const shopName = req.query.shopName || "";
  const purpose = req.query.purpose || "partnership_intro";

  const safeShopName = String(shopName).replace(/"/g, "");
  const safePurpose = String(purpose).replace(/"/g, "");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media">
      <Parameter name="direction" value="outbound" />
      <Parameter name="shopName" value="${safeShopName}" />
      <Parameter name="purpose" value="${safePurpose}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.get("/voice", (_req, res) => {
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

async function getDeliveryTax(data) {
  try {
    const res = await axios.post(
      "https://lareauto.ca/api/voice/delivery-tax",
      data,
      { timeout: 10000 }
    );

    return res.data?.message || "Delivery and tax will be confirmed shortly.";
  } catch (error) {
    console.error("Delivery tax API error:", error?.response?.data || error.message);
    return "Sorry, I could not calculate delivery and tax right now. Our parts team will confirm shortly.";
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

async function saveOutboundLead(data) {
  try {
    const res = await axios.post(
      "https://lareauto.ca/api/voice/outbound-lead",
      data,
      { timeout: 10000 }
    );

    return `Outbound lead saved successfully. Lead ID: ${
      res.data?.leadId || "unknown"
    }`;
  } catch (error) {
    console.error("Outbound lead save error:", error?.response?.data || error.message);
    return "Outbound lead could not be saved.";
  }
}

function normalizePhone(phone) {
  if (!phone) return null;

  const cleaned = String(phone).trim().replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) return cleaned;

  const digits = cleaned.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return cleaned;
}

function buildQuoteMessage(quoteMessage, deliveryTaxMessage) {
  return `Lare Automotive Parts Supply

${quoteMessage || "Quote details will be confirmed shortly."}

${deliveryTaxMessage || "Delivery charges and tax will be confirmed after postal code."}

Pay online:
https://lareauto.ca/quote

E-transfer:
accounts@lareauto.ca`;
}

async function sendQuoteSMS(to, message) {
  try {
    const normalizedTo = normalizePhone(to);

    if (!normalizedTo) return "Unable to send SMS because the phone number is missing.";
    if (!process.env.TWILIO_PHONE_NUMBER)
      return "Unable to send SMS because Twilio phone number is not configured.";

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: normalizedTo,
    });

    return "SMS quote sent successfully.";
  } catch (error) {
    console.error("SMS Error:", error?.message || error);
    return "Unable to send SMS right now.";
  }
}

async function sendQuoteWhatsApp(to, message) {
  try {
    const normalizedTo = normalizePhone(to);

    if (!normalizedTo) return "Unable to send WhatsApp because the phone number is missing.";
    if (!process.env.TWILIO_WHATSAPP_NUMBER)
      return "Unable to send WhatsApp because Twilio WhatsApp number is not configured.";

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${normalizedTo}`,
    });

    return "WhatsApp quote sent successfully.";
  } catch (error) {
    console.error("WhatsApp Error:", error?.message || error);
    return "Unable to send WhatsApp right now.";
  }
}

function getInstructions({ direction, callerPhone, shopName, purpose }) {
  if (direction === "outbound") {
    return `
You are Maya, a friendly, soft-spoken female phone assistant for Lare Automotive Parts Supply in Ontario.

This is an OUTBOUND call to a mechanic, garage, body shop, or workshop.

Voice style:
- Speak gently, warmly, softly, and professionally.
- Be respectful and brief.
- Ask only one question at a time.
- Do not sound robotic or pushy.

Opening:
- Say: "Hi, this is Maya calling from Lare Automotive Parts Supply here in Ontario. How are you today?"
- If shop name is available, say: "Am I speaking with ${shopName}?"
- Say: "We work with local repair shops and auto businesses by supplying quality automotive parts such as alternators, starters, brakes, suspension parts, radiators, lights, and more."
- Ask: "I was hoping to speak with the owner, manager, or the person who looks after parts purchasing. Would they be available?"

Purpose:
- The purpose is: ${purpose || "partnership_intro"}.
- Ask if they regularly buy replacement auto parts.
- Ask what parts they usually buy most often.
- Ask if they would like Lare Automotive to send quick quotes when needed.
- Ask for the best contact person, phone number, WhatsApp number, and email if possible.
- Ask if they prefer SMS, WhatsApp, email, or phone call.
- Classify the lead as hot, warm, callback, not_interested, or do_not_call.
- If they ask to not be called again, apologize and mark doNotCall true.
- Before ending the call, call save_outbound_lead silently with all details you collected.
- Do not tell them you are saving it.

Lead status guide:
- hot: interested and wants quote/account details soon.
- warm: open to receiving information but not urgent.
- callback: asks to call later.
- not_interested: politely declined.
- do_not_call: asked not to be contacted again.

Rules:
- Do not discuss discounts unless verified by the Lare Automotive team.
- Do not promise approval as a mechanic partner.
- Do not collect payment on outbound calls.
- Do not mention OpenAI, ChatGPT, tools, API, database, or saving lead.
- Support English, Punjabi, and French.
`;
  }

  return `
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
- After quote or important lead details, call save_voice_lead silently.

Caller phone:
- Caller phone may be: ${callerPhone || "unknown"}.

Retail flow:
- After giving part price, do NOT ask for pickup.
- Ask postal code for delivery charges plus tax.
- Once postal code is provided, call get_delivery_tax.
- Then ask if they want quote and payment information by SMS or WhatsApp.
- Pay online link: https://lareauto.ca/quote
- E-transfer: accounts@lareauto.ca
- Do not collect card numbers.

Mechanic/shop flow:
- Ask shop name.
- Use professional trade-counter language.
- Say retail price if available, then say shop pricing will be confirmed if applicable.
- Do not promise discounts unless verified.

General rules:
- If unsure whether caller is retail or mechanic, ask: "Are you calling as a customer or from a repair shop?"
- Support English, Punjabi, and French.
- Reply in same language.
- Do not mention OpenAI, ChatGPT, tools, API, database, or saving lead.
`;
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected to voice server");

  let streamSid = null;
  let callerPhone = null;
  let direction = "inbound";
  let shopName = "";
  let purpose = "";
  let lastQuoteMessage = null;
  let lastDeliveryTaxMessage = null;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  function sendSessionUpdate() {
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
              description: "Look up inventory and price for an auto part.",
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
              name: "get_delivery_tax",
              description: "Calculate delivery, HST, and total.",
              parameters: {
                type: "object",
                properties: {
                  subtotalCents: { type: "number" },
                  postalCode: { type: "string" },
                },
                required: ["subtotalCents", "postalCode"],
              },
            },
            {
              type: "function",
              name: "save_voice_lead",
              description: "Save inbound voice lead details.",
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
              name: "save_outbound_lead",
              description: "Save outbound mechanic/workshop call result.",
              parameters: {
                type: "object",
                properties: {
                  shopName: { type: "string" },
                  contactPerson: { type: "string" },
                  phone: { type: "string" },
                  whatsapp: { type: "string" },
                  email: { type: "string" },
                  purpose: { type: "string" },
                  commonParts: { type: "string" },
                  leadStatus: {
                    type: "string",
                    enum: [
                      "new",
                      "hot",
                      "warm",
                      "callback",
                      "not_interested",
                      "do_not_call",
                    ],
                  },
                  notes: { type: "string" },
                  callbackTime: { type: "string" },
                  doNotCall: { type: "boolean" },
                },
                required: ["shopName", "leadStatus"],
              },
            },
            {
              type: "function",
              name: "send_quote_sms",
              description: "Send quote by SMS.",
              parameters: {
                type: "object",
                properties: {
                  phone: { type: "string" },
                  message: { type: "string" },
                },
                required: ["phone", "message"],
              },
            },
            {
              type: "function",
              name: "send_quote_whatsapp",
              description: "Send quote by WhatsApp.",
              parameters: {
                type: "object",
                properties: {
                  phone: { type: "string" },
                  message: { type: "string" },
                },
                required: ["phone", "message"],
              },
            },
          ],
          tool_choice: "auto",
          instructions: getInstructions({
            direction,
            callerPhone,
            shopName,
            purpose,
          }),
        },
      })
    );
  }

openaiWs.on("open", () => {
  console.log("Connected to OpenAI Realtime");

  // We wait for Twilio "start" event before sending session/update and greeting.
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

    direction = data.start.customParameters?.direction || "inbound";
    shopName = data.start.customParameters?.shopName || "";
    purpose = data.start.customParameters?.purpose || "";

    console.log("Twilio stream started:", {
      streamSid,
      callerPhone,
      direction,
      shopName,
    });

    if (openaiWs.readyState === WebSocket.OPEN) {
      sendSessionUpdate();

      setTimeout(() => {
        if (openaiWs.readyState !== WebSocket.OPEN) return;

        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions:
                direction === "outbound"
                  ? "Start speaking immediately. Say exactly: Hi, this is Maya calling from Lare Automotive Parts Supply here in Ontario. How are you today?"
                  : "Say softly: Thank you for calling Lare Automotive Parts Supply. This is Maya. What vehicle and part are you looking for today?",
            },
          })
        );
      }, 1200);
    }
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
                  "Read the quote result softly. Then ask for postal code for delivery, HST, and total. Do not ask for pickup.",
              },
            })
          );
        }

        if (event.name === "get_delivery_tax") {
          const deliveryTaxMessage = await getDeliveryTax(args);
          lastDeliveryTaxMessage = deliveryTaxMessage;

          openaiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: event.call_id,
                output: deliveryTaxMessage,
              },
            })
          );

          openaiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Read delivery, HST, and total clearly. Then ask if they want it sent by SMS or WhatsApp.",
              },
            })
          );
        }

        if (event.name === "save_voice_lead") {
          const saveResult = await saveVoiceLead({
            ...args,
            callerPhone: args.callerPhone || callerPhone,
            quoteMessage: args.quoteMessage || lastQuoteMessage,
            shopName: args.shopName || shopName,
            source: direction === "outbound" ? "outbound_voice" : "voice",
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

        if (event.name === "save_outbound_lead") {
          const saveResult = await saveOutboundLead({
            ...args,
            shopName: args.shopName || shopName,
            phone: args.phone || callerPhone,
            purpose: args.purpose || purpose,
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
          const smsResult = await sendQuoteSMS(
            args.phone || callerPhone,
            args.message || buildQuoteMessage(lastQuoteMessage, lastDeliveryTaxMessage)
          );

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
                  "If SMS succeeded, say the quote was texted. If it failed, apologize and say the team will follow up.",
              },
            })
          );
        }

        if (event.name === "send_quote_whatsapp") {
          const whatsAppResult = await sendQuoteWhatsApp(
            args.phone || callerPhone,
            args.message || buildQuoteMessage(lastQuoteMessage, lastDeliveryTaxMessage)
          );

          openaiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: event.call_id,
                output: whatsAppResult,
              },
            })
          );

          openaiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "If WhatsApp succeeded, say it was sent on WhatsApp. If it failed, offer SMS instead.",
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

  openaiWs.on("close", () => console.log("OpenAI Realtime disconnected"));
  openaiWs.on("error", (error) =>
    console.error("OpenAI WebSocket error:", error)
  );
});

server.listen(PORT, () => {
  console.log(`Lare Auto voice server running on port ${PORT}`);
});