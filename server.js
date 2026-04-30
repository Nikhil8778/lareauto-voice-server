import "dotenv/config";
import express from "express";
import http from "http";
import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

const app = express();
app.use(express.json());

const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MECHANIC_SIGNUP_URL = "https://lareauto.ca/mechanic-signup";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const wss = new WebSocketServer({ server, path: "/twilio-media" });

app.get("/", (_req, res) => {
  res.json({ status: "Lare Auto voice server live" });
});

app.get("/voice", (_req, res) => {
  res.json({ status: "Lare Auto voice route live" });
});

app.get("/test-whatsapp", async (req, res) => {
  const result = await sendWhatsAppTemplate(
    req.query.to,
    "ABC Auto Repair",
    MECHANIC_SIGNUP_URL
  );

  res.send(result);
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
    const { to, shopName, purpose, workshopLeadId, ivrDigits } = req.body || {};
    const normalizedTo = normalizePhone(to);

    if (!normalizedTo) {
      return res.status(400).json({
        success: false,
        message: "Missing phone number.",
      });
    }

    if (!process.env.TWILIO_PHONE_NUMBER) {
      return res.status(500).json({
        success: false,
        message: "TWILIO_PHONE_NUMBER is not configured.",
      });
    }

    const host = req.headers.host;

    const call = await twilioClient.calls.create({
      to: normalizedTo,
      from: process.env.TWILIO_PHONE_NUMBER,
      sendDigits: ivrDigits || undefined,
      url: `https://${host}/outbound-voice?shopName=${encodeURIComponent(
      shopName || ""
      )}&purpose=${encodeURIComponent(
      purpose || "partnership_intro"
      )}&workshopLeadId=${encodeURIComponent(workshopLeadId || "")}`,
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

  const shopName = String(req.query.shopName || "").replace(/"/g, "");
  const purpose = String(req.query.purpose || "partnership_intro").replace(
    /"/g,
    ""
  );

  const workshopLeadId = String(req.query.workshopLeadId || "").replace(/"/g, "");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media">
      <Parameter name="direction" value="outbound" />
      <Parameter name="shopName" value="${shopName}" />
      <Parameter name="purpose" value="${purpose}" />
      <Parameter name="publicHost" value="${host}" />
      <Parameter name="workshopLeadId" value="${workshopLeadId}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
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
    console.error(
      "Delivery tax API error:",
      error?.response?.data || error.message
    );

    return "Sorry, I could not calculate delivery and tax right now. Our parts team will confirm shortly.";
  }
}

async function saveVoiceLead(data) {
  try {
    const res = await axios.post("https://lareauto.ca/api/voice/lead", data, {
      timeout: 10000,
    });

    return `Lead saved successfully. Lead ID: ${
      res.data?.leadId || "unknown"
    }`;
  } catch (error) {
    console.error(
      "Voice lead save error:",
      error?.response?.data || error.message
    );

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
    console.error(
      "Outbound lead save error:",
      error?.response?.data || error.message
    );

    return "Outbound lead could not be saved.";
  }
}

function cleanDigits(value) {
  return String(value || "").replace(/[^0-9*#wW]/g, "");
}

async function sendDtmfDigit(callSid, digits, publicHost, shopName, purpose, workshopLeadId) {
  try {
    const safeDigits = cleanDigits(digits);

    if (!callSid) return "Unable to press IVR option because call SID is missing.";
    if (!safeDigits) return "Unable to press IVR option because digit is missing.";
    if (!publicHost) return "Unable to press IVR option because public host is missing.";

    await twilioClient.calls(callSid).update({
      twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${safeDigits}" />
  <Pause length="1" />
  <Connect>
    <Stream url="wss://${publicHost}/twilio-media">
      <Parameter name="direction" value="outbound" />
      <Parameter name="shopName" value="${String(shopName || "").replace(/"/g, "")}" />
      <Parameter name="purpose" value="${String(purpose || "").replace(/"/g, "")}" />
      <Parameter name="workshopLeadId" value="${String(workshopLeadId || "").replace(/"/g, "")}" />
      <Parameter name="publicHost" value="${publicHost}" />
    </Stream>
  </Connect>
</Response>`,
    });

    return `Pressed IVR option ${safeDigits}.`;
  } catch (error) {
    console.error("DTMF Error:", error?.message || error);
    return `Unable to press IVR option. ${error?.message || ""}`;
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

function buildMechanicSignupMessage(shopName = "") {
  return `Lare Automotive Parts Supply

Thank you for your time today${shopName ? `, ${shopName}` : ""}.

You can apply for a mechanic/workshop partner account here:
${MECHANIC_SIGNUP_URL}

After admin approval, partner benefits may include:
- Trade pricing
- Quick parts quotes
- WhatsApp/SMS support
- Referral benefits
- Delivery options

Lare Automotive Parts Supply`;
}

async function sendSMS(to, message) {
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

    return "SMS sent successfully.";
  } catch (error) {
    console.error("SMS Error:", error?.message || error);
    return "Unable to send SMS right now.";
  }
}
async function sendWhatsApp(to, message) {
  try {
    const normalizedTo = normalizePhone(to);

    if (!normalizedTo) {
      return "Unable to send WhatsApp because the phone number is missing.";
    }

    if (!process.env.TWILIO_WHATSAPP_NUMBER) {
      return "Unable to send WhatsApp because Twilio WhatsApp number is not configured.";
    }

    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${normalizedTo}`,
    });

    console.log("WhatsApp sent:", result.sid);

    return "WhatsApp sent successfully.";
  } catch (error) {
    console.error("WhatsApp Error full:", {
      message: error?.message,
      code: error?.code,
      status: error?.status,
      moreInfo: error?.moreInfo,
    });

    return `Unable to send WhatsApp right now. ${error?.message || ""}`;
  }
}

async function sendWhatsAppTemplate(to, shopName, signupLink) {
  try {
    const normalizedTo = normalizePhone(to);

    if (!normalizedTo) {
      return "Unable to send WhatsApp because the phone number is missing.";
    }

    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${normalizedTo}`,
      contentSid: "HX8e38952ef1e4768430481c5084263152",
      contentVariables: JSON.stringify({
        "1": shopName || "there",
        "2": signupLink || "https://lareauto.ca/mechanic-signup",
      }),
    });

    console.log("WhatsApp template sent:", result.sid);

    return "WhatsApp sent successfully.";
  } catch (error) {
    console.error("WhatsApp Template Error:", {
      message: error?.message,
      code: error?.code,
      status: error?.status,
      moreInfo: error?.moreInfo,
    });

    return `Unable to send WhatsApp right now. ${error?.message || ""}`;
  }
}

function getInstructions({ direction, callerPhone, shopName, purpose }) {
  if (direction === "outbound") {
    return `
You are Maya, a friendly, soft-spoken female phone assistant for Lare Automotive Parts Supply in Ontario.

This is an OUTBOUND call to a mechanic, garage, body shop, or workshop.

Very important conversation behavior:
- Do not read long scripts.
- Speak in short human sentences.
- Ask only one question, then stop talking and wait.
- After asking a question, do not answer for the customer.
- Give the customer enough time to respond.
- If the customer starts speaking, stop and listen.
- Do not rush to the next question.
- Use natural pauses.
- Sound like a helpful receptionist, not a robot or sales recording.

 Voice Style:
- Sound cheerful, natural, and lightly smiling.
- Add small human phrases like "sure", "absolutely", "no problem", and "I understand".
- Use natural pauses after greetings and questions.
- Never continue to the next question until the customer answers.
- Do not read the script word-for-word. Use the script only as guidance.
- Keep each response under 2 short sentences.

Opening flow:
1. Start based on time:
   “Good morning, how are you doing today?”
   or
   “Good afternoon, how are you doing today?”
   or
   “Good evening, how are you doing today?”

2. Stop and wait.

3. Then say:
   “This is Maya calling from Lare Automotive Parts Supply. Have you got a quick minute?”

4. Stop and wait.

5. If they say yes:
   Briefly explain:
   “We supply auto parts like alternators, starters, brakes, suspension parts, radiators, lights, and more. We support repair shops with quick quotes, competitive pricing, and delivery options.”

6. If they say no / busy:
   Say:
   “No problem at all. I’ll send you our mechanic partner signup link by text so you can review it whenever convenient. Thank you.”
   Then call send_mechanic_signup_sms.

Purpose:
- The purpose is: ${purpose || "partnership_intro"}.
- Ask if they regularly buy replacement auto parts.
- Ask what parts they usually buy most often.
- Ask if they would like quick quotes when needed.
If the customer refuses or says they are busy:
- Do not push the conversation.
- Politely end the call.
- Send mechanic signup details by SMS to the same phone number if available.
- SMS must include:
  Lare Automotive Parts Supply
  Website: https://lareauto.ca
  Mechanic signup: https://lareauto.ca/mechanic-signup
  Benefits: trade pricing after approval, quick quotes, WhatsApp/SMS support, referral benefits, delivery options.
- Ask for preferred contact method: WhatsApp, SMS, email, or phone.
- Do not choose the contact method yourself. Wait for the customer to answer.
- Collect contact person, phone, WhatsApp, email if possible.
- Classify lead as hot, warm, callback, not_interested, or do_not_call.
- Before ending the call, call save_outbound_lead silently with all details collected.
- Do not tell them you are saving it.

Mechanic signup link:
- If the workshop says WhatsApp, SMS, or text is okay, ask permission to send the mechanic/workshop partner signup link.
- If they agree and prefer WhatsApp, call send_mechanic_signup_whatsapp.
- If they agree and prefer SMS/text, call send_mechanic_signup_sms.
- Signup link: ${MECHANIC_SIGNUP_URL}
- Explain that this is where they can apply for a mechanic/workshop account.
- Say partner benefits may apply after admin approval.
- Do not promise instant approval.
- Do not promise a fixed discount.

Pricing and margin handling:
- If they ask about pricing, say:
  "We try to keep pricing competitive for workshops. It depends on the part, brand, availability, and quantity."
- If they ask about mechanic discount, say:
  "For approved workshop partners, our team can confirm trade pricing after reviewing the shop account."
- If they ask about margin, say:
  "The exact margin depends on the part category and supplier cost, but our goal is to give shops room to stay competitive."
- If they ask for a sample price, ask for year, make, model, engine, and part, then say our team can send a quote.
- Do not promise a fixed discount.
- Do not promise approval as a mechanic partner.
- Do not discuss internal markup.

Objection handling:
- If they say they already have suppliers, say:
  "Absolutely, many shops do. We can simply be an additional option when you want to compare price or availability."
- If they say they are busy, say:
  "No problem. What would be a better time for a quick callback?"
- If they say not interested, politely thank them and end.
- If they say do not call again, apologize, mark doNotCall true, and end.

IVR handling:
- If you hear an automated menu such as “Press 1”, “Press 2 for parts”, or “Press 0 for operator”, identify the correct option.
- Prefer parts, purchasing, sales, front desk, or operator.
- Use send_dtmf_digit to press the correct key.
- If unsure, press 0 for operator.
- After pressing the digit, wait quietly for the next person or next menu.
- Do not speak over the IVR recording.

Rules:
- Do not collect payment on outbound calls.
- Do not mention OpenAI, ChatGPT, tools, API, database, or saving lead.
- Support English, Punjabi, and French.
`;
  }

  return `
You are Maya, a friendly, soft-spoken female phone assistant for Lare Automotive Parts Supply in Ontario.

Voice style:
- Sound cheerful, natural, and lightly smiling.
- Add small human phrases like "sure", "absolutely", "no problem", and "I understand".
- Use natural pauses after greetings and questions.
- Never continue to the next question until the customer answers.
- Do not read the script word-for-word. Use the script only as guidance.
- Keep each response under 2 short sentences.
- Use a calm customer-service tone.
- Speak slightly slower than normal.
- Keep replies short and natural.
- Ask only one question at a time.
- After asking a question, stop and wait.

Main job:
- Greet customers nicely, softly, professionally, and friendly.
- Help customers find auto parts.
- Collect year, make, model, engine size, and part needed.
- If the caller already gave a detail, do not ask for it again.
- If engine size is missing, ask for engine size or VIN.
- Once you have year, make, model, engine if available, and part, call get_part_quote.
- After quote or important lead details, call save_voice_lead silently.

Contact sending rules:
- Before sending signup link, quote, or company details by SMS, WhatsApp, or email, confirm the phone number or email.
- Repeat the contact detail back to the customer.
- Ask: "Did I get that right?"
- Only send after customer confirms.
- Never guess the phone number or email if unclear.

Supplier objection:
- If they say they already have suppliers, say:
  "Absolutely, many shops already have suppliers. We’re not asking you to replace them. We can simply be an extra option when you want to compare price, availability, or need something quickly."

Closing:
- End with:
  "Thank you so much for your time. We’d be happy to support your shop whenever you need parts. I’ll send the details over now, and our team will be here whenever you need a quick quote. Have a great day."

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
  let sessionStarted = false;
  let twilioCallSid = null;
  let publicHost = null;
  let workshopLeadId = null;

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
          voice: "coral",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
          type: "server_vad",
          threshold: 0.72,
          prefix_padding_ms: 500,
          silence_duration_ms: 850,
          },
          tools: [
            {
             type: "function",
             name: "send_dtmf_digit",
             description: "Press a keypad digit during IVR menu, such as 1, 2, 0, *, #, or sequences like 2w1.",
             parameters: {
                    type: "object",
                    properties: {
                    digits: {
                        type: "string",
                        description: "DTMF digit or sequence to press. Example: 2, 0, 2w1.",
                    },
                    reason: {
                        type: "string",
                        description: "Why this digit was selected.",
                    },
                    },
                    required: ["digits"],
                },
            },
            
            
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
            {
              type: "function",
              name: "send_mechanic_signup_sms",
              description:
                "Send mechanic/workshop signup link by SMS after permission.",
              parameters: {
                type: "object",
                properties: {
                  phone: { type: "string" },
                  shopName: { type: "string" },
                },
                required: ["phone"],
              },
            },
            {
              type: "function",
              name: "send_mechanic_signup_whatsapp",
              description:
                "Send mechanic/workshop signup link by WhatsApp after permission.",
              parameters: {
                type: "object",
                properties: {
                  phone: { type: "string" },
                  shopName: { type: "string" },
                },
                required: ["phone"],
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

  function startOpenAISessionIfReady() {
    if (sessionStarted) return;
    if (!streamSid) return;
    if (openaiWs.readyState !== WebSocket.OPEN) return;

    sessionStarted = true;

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
                ? "Say warmly and naturally based on the current time: Good morning, good afternoon, or good evening. Then say: how are you doing today? Stop speaking completely and wait for the customer."
                : "Say softly, warmly and naturally with a light smile: Thank you for calling Lare Automotive Parts Supply. This is Maya. What vehicle and part are you looking for today?",      
        }
            })
            );
            }, 1000);
        }

        openaiWs.on("open", () => {
            console.log("Connected to OpenAI Realtime");
            startOpenAISessionIfReady();
        });

        twilioWs.on("message", (message) => {
            let args = {};

        try {
        args = JSON.parse(toolCall.arguments || "{}");
        } catch (err) {
        console.error("❌ Tool args parse error:", toolCall.arguments);
        return;
        }

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
      twilioCallSid = data.start.callSid || null;
      publicHost = data.start.customParameters?.publicHost || null;
      workshopLeadId = data.start.customParameters?.workshopLeadId || null;

      console.log("Twilio stream started:", {
        streamSid,
        callerPhone,
        direction,
        shopName,
        workshopLeadId,
      });

      startOpenAISessionIfReady();
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
    let event;

        try {
        event = JSON.parse(message.toString());
        } catch (error) {
        console.error("OpenAI message JSON parse error:", {
            error: error?.message,
            raw: message.toString(),
        });
        return;
        }

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
                  "Read the quote result softly. Then ask for postal code for delivery, HST, and total. Do not ask for pickup. Ask one question and wait.",
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
                  "Read delivery, HST, and total clearly. Then ask if they want it sent by SMS or WhatsApp. Ask one question and wait.",
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
            workshopLeadId,
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
          const smsResult = await sendSMS(
            args.phone || callerPhone,
            args.message ||
              buildQuoteMessage(lastQuoteMessage, lastDeliveryTaxMessage)
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
          const whatsAppResult = await sendWhatsApp(
            args.phone || callerPhone,
            args.message ||
              buildQuoteMessage(lastQuoteMessage, lastDeliveryTaxMessage)
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

        if (event.name === "send_mechanic_signup_sms") {
          const smsResult = await sendSMS(
            args.phone || callerPhone,
            buildMechanicSignupMessage(args.shopName || shopName)
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
                  "If SMS succeeded, say: I have texted you the mechanic partner signup link. If it failed, apologize and say our team will follow up.",
              },
            })
          );
        }

        if (event.name === "send_mechanic_signup_whatsapp") {
            const whatsAppResult = await sendWhatsAppTemplate(
                args.phone || callerPhone,
                args.shopName || shopName || "Auto Repair Shop",
                MECHANIC_SIGNUP_URL
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
                    "If WhatsApp succeeded, say: I have sent the mechanic partner signup link on WhatsApp. If it failed, offer to send it by text message instead.",
                },
                })
            );
         }

       if (event.name === "send_dtmf_digit") {
            const dtmfResult = await sendDtmfDigit(
                twilioCallSid,
                args.digits,
                publicHost,
                shopName,
                purpose,
                workshopLeadId
            );

            openaiWs.send(
                JSON.stringify({
                type: "conversation.item.create",
                item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: dtmfResult,
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