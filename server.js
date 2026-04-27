import "dotenv/config";
import express from "express";
import http from "http";
import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const wss = new WebSocketServer({
  server,
  path: "/twilio-media",
});

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

  res.type("text/xml");
  res.send(twiml);
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

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected to voice server");

  let streamSid = null;

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
          turn_detection: {
            type: "server_vad",
          },
          tools: [
            {
              type: "function",
              name: "get_part_quote",
              description:
                "Look up Lare Automotive inventory and price for a requested auto part.",
              parameters: {
                type: "object",
                properties: {
                  year: {
                    type: "string",
                    description: "Vehicle year, for example 2017",
                  },
                  make: {
                    type: "string",
                    description: "Vehicle make, for example Hyundai",
                  },
                  model: {
                    type: "string",
                    description: "Vehicle model, for example Tucson",
                  },
                  engine: {
                    type: "string",
                    description: "Engine size, for example 2.0L",
                  },
                  part: {
                    type: "string",
                    description: "Part needed, for example alternator",
                  },
                },
                required: ["year", "make", "model", "part"],
              },
            },
          ],
          tool_choice: "auto",
          instructions: `
You are Maya, a friendly, soft-spoken female phone assistant for Lare Automotive Parts Supply in Ontario.

Voice style:
- Speak gently, warmly, and professionally.
- Use a calm customer-service tone.
- Do not sound robotic.
- Speak slightly slower than normal.
- Keep replies short and natural.
- Ask only one question at a time.

Your job:
- Help customers find auto parts.
- Collect year, make, model, engine size, and part needed.
- If the customer already gave a detail, do not ask for it again.
- If engine size is missing, ask for engine size or VIN.
- Once you have year, make, model, engine if available, and part, call get_part_quote.
- If get_part_quote returns a price, read it to the customer.
- Then ask: Would you like pickup or delivery?
- Support English, Punjabi, and French.
- Reply in the same language the customer uses.
- Do not mention OpenAI, ChatGPT, tools, API, or database.
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
      console.log("Twilio stream started:", streamSid);
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
          media: {
            payload: event.delta,
          },
        })
      );
    }

    if (event.type === "response.function_call_arguments.done") {
      try {
        if (event.name === "get_part_quote") {
          const args = JSON.parse(event.arguments || "{}");
          console.log("Quote lookup args:", args);

          const quoteMessage = await getQuote(args);
          console.log("Quote result:", quoteMessage);

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
                  "Read the quote result to the customer in a soft, professional tone. Then ask if they want pickup or delivery.",
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
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
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