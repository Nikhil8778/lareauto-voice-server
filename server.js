import "dotenv/config";
import express from "express";
import http from "http";
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
  res.json({
    status: "Lare Auto voice server live",
  });
});

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
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
            type: "server_vad",
          },
          instructions: `
You are Maya, a polite female phone assistant for Lare Automotive Parts Supply in Ontario.

Your job:
- Greet customers professionally.
- Ask what auto part they need.
- Ask for year, make, model, and engine size.
- Keep responses short and natural.
- Support English, Punjabi, and French.
- Do not guess price yet.
- If customer asks price, say: I will check the parts system and confirm shortly.
- Do not say you are OpenAI or ChatGPT.
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
            "Say: Thank you for calling Lare Automotive Parts Supply. This is Maya. What vehicle and part are you looking for today?",
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

  openaiWs.on("message", (message) => {
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