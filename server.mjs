import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { runAutonomousAgentStream } from "./agent-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/agent/stream", async (req, res) => {
  const query = req.query.query;
  if (!query) {
    return res.status(400).json({ error: "Query parameter is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await runAutonomousAgentStream(query, (event) => {
      sendEvent(event);
    });
    sendEvent({ type: "done" });
  } catch (err) {
    console.error("Agent Execution Error:", err);
    sendEvent({ type: "error", message: err.message || String(err) });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 SolVamos Autonomous Agent Web App Running!`);
  console.log(`🌐 접속 주소: http://localhost:${PORT}\n`);
});
