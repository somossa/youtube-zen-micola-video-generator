import { serve } from "bun";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { parseArgs } from "node:util";

const PORT = 9999;
const HOST = "127.0.0.1";

const {
  values: { title },
} = parseArgs({
  options: {
    title: {
      type: "string",
    },
  },
});

if (!title) {
  console.error("Error: --title is required");
  process.exit(1);
}

interface Generation {
  timestamp: string;
  prompt: string;
  shouldIncludePreviousGeneration: boolean;
  shouldIncludeMainCharecterImage: boolean;
}

interface CommandRequest {
  id: string;
  command: string;
  params: Record<string, unknown>;
}

interface CommandResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

function getRandomDelay(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function waitForEnter(message: string) {
  return new Promise<void>((resolve) => {
    rl.question(message, () => resolve());
  });
}

let ws: import("bun").ServerWebSocket<unknown> | null = null;
let isTabReady = false;
let userRequestedStart = false;

const pendingCommands = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: Timer }
>();
let cmdId = 0;

function sendCommand(
  command: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws) {
      reject(new Error("Extension not connected"));
      return;
    }
    const id = `cmd_${++cmdId}`;
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command "${command}" timed out (300s)`));
    }, 300_000);
    pendingCommands.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, command, params } satisfies CommandRequest));
  });
}

serve({
  port: PORT,
  hostname: HOST,
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response("WebSocket server – use ws://", { status: 404 });
  },
  websocket: {
    open(wsInstance) {
      console.log(`\n[server] Extension connected!`);
      ws = wsInstance;
    },
    message(_ws, raw) {
      try {
        const rawMsg = JSON.parse(raw.toString());

        // Handle background-to-server notifications
        if (rawMsg.type === "ready") {
          console.log(
            `[server] Content script detected in tab ${rawMsg.tabId}`,
          );
          isTabReady = true;
          return;
        }

        if (rawMsg.type === "userStart") {
          console.log(
            `[server] USER START SIGNAL RECEIVED from tab ${rawMsg.tabId}`,
          );
          userRequestedStart = true;
          return;
        }

        const res = rawMsg as CommandResponse;
        const pending = pendingCommands.get(res.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCommands.delete(res.id);
          if (res.success) pending.resolve(res.data);
          else pending.reject(new Error(res.error || "Command failed"));
        }
      } catch (e) {
        console.error("[server] parse error:", e);
      }
    },
    close(_ws) {
      console.log("[server] Extension disconnected!");
      ws = null;
      isTabReady = false;
      for (const [id, p] of pendingCommands) {
        clearTimeout(p.timer);
        p.reject(new Error("Extension disconnected"));
      }
      pendingCommands.clear();
    },
  },
});

console.log(`[server] Listening on ws://${HOST}:${PORT}`);
console.log(`[server] Waiting for extension to connect…`);
console.log(
  `[server] Open Chrome, navigate to https://higgsfield.ai/ai/image?model=nano-banana-pro`,
);
console.log(
  `[server] (If already open, please REFRESH the page to ensure the extension is active)\n`,
);

console.log(
  `[server] Waiting for user to click "Start Automation" in the browser...`,
);
await new Promise<void>((resolve) => {
  const poll = () =>
    ws && isTabReady && userRequestedStart ? resolve() : setTimeout(poll, 500);
  poll();
});

process.on("unhandledRejection", (err) => {
  console.error(
    "[server] Unhandled rejection:",
    err instanceof Error ? err.message : err,
  );
});

// -------------------------------------------------
// Main generation logic
// -------------------------------------------------
const generationFile = path.join(
  process.cwd(),
  "videos",
  title,
  "generation.jsonl",
);
if (!fs.existsSync(generationFile)) {
  console.error(`[server] ${generationFile} not found`);
  process.exit(1);
}

const lines = fs.readFileSync(generationFile, "utf-8").trim().split("\n");
const generations: Generation[] = lines
  .map((l) => JSON.parse(l))
  .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

const generationsDir = path.join("videos", title, "images");
if (!fs.existsSync(generationsDir)) fs.mkdirSync(generationsDir, { recursive: true });

// -------- Setup: configure the page --------
try {
  console.log("[server] Configuring page (ratio, quality, unlimited)…");
  await sendCommand("wait", { ms: 3000 });

  await sendCommand("select", {
    selector:
      "#image-form > fieldset > div > div.h-9.flex.items-center.gap-2.min-w-0 > div:nth-child(2) > div > div:nth-child(3) > label > select",
    value: "16:9",
  });
  await sendCommand("wait", { ms: 1000 });

  await sendCommand("select", {
    selector:
      "#image-form > fieldset > div > div.h-9.flex.items-center.gap-2.min-w-0 > fieldset > label > div > div:nth-child(3) > label > select",
    value: "1k",
  });
  await sendCommand("wait", { ms: 1000 });

  await sendCommand("clickIf", {
    selector: "#image-form button[role='switch']",
    attribute: "data-state",
    value: "on",
  });
  await sendCommand("wait", { ms: 2000 });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[server] Setup failed:", msg);
  if (
    msg.includes("Receiving end does not exist") ||
    msg.includes("Could not establish connection")
  ) {
    console.error(
      "\n[server] HINT: The extension could not find the content script. Please REFRESH the higgsfield.ai tab and try again.",
    );
  }
  process.exit(1);
}

// -------- Generation loop --------
let previousTimestamp: string | null = null;

for (let i = 0; i < generations.length; i++) {
  const gen = generations[i]!;
  const {
    timestamp,
    prompt,
    shouldIncludePreviousGeneration,
    shouldIncludeMainCharecterImage,
  } = gen;

  const safeName = timestamp.replace(/:/g, "_");
  const outputPath = path.join(generationsDir, `${safeName}.png`);

  if (fs.existsSync(outputPath)) {
    console.log(
      `[${i + 1}/${generations.length}] Skipping ${timestamp} (exists)`,
    );
    previousTimestamp = timestamp;
    continue;
  }

  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 30_000;
  let lastError: string | null = null;

  for (let generationAttempt = 1; generationAttempt <= MAX_RETRIES; generationAttempt++) {
    const label = generationAttempt > 1 ? ` (attempt ${generationAttempt}/${MAX_RETRIES})` : "";
    console.log(`[${i + 1}/${generations.length}] Generating ${timestamp}${label}…`);

    try {
      await sendCommand("wait", { ms: getRandomDelay(2000, 5000) });

      await sendCommand("setPrompt", { text: prompt });
      await sendCommand("wait", { ms: getRandomDelay(500, 1200) });

      await sendCommand("clearAttachments", {});
      await sendCommand("wait", { ms: getRandomDelay(800, 1500) });

      const filesToUpload: { name: string; data: string }[] = [];
      if (shouldIncludeMainCharecterImage) {
        const p = path.resolve("./assets/main-charecter.png");
        if (fs.existsSync(p)) {
          filesToUpload.push({
            name: "main-charecter.png",
            data: Buffer.from(fs.readFileSync(p)).toString("base64"),
          });
        }
      }
      if (shouldIncludePreviousGeneration && previousTimestamp) {
        const prev = path.resolve(
          generationsDir,
          `${previousTimestamp.replace(/:/g, "_")}.png`,
        );
        if (fs.existsSync(prev)) {
          filesToUpload.push({
            name: `${previousTimestamp}.png`,
            data: Buffer.from(fs.readFileSync(prev)).toString("base64"),
          });
        }
      }

      if (filesToUpload.length > 0) {
        await sendCommand("wait", { ms: getRandomDelay(500, 1200) });
        await sendCommand("uploadFiles", { files: filesToUpload });
        await sendCommand("waitForUploads", { count: filesToUpload.length });
        await sendCommand("wait", { ms: getRandomDelay(1000, 2000) });
      }

      await sendCommand("wait", { ms: getRandomDelay(1000, 3000) });
      await sendCommand("click", {
        selector: "#image-form button[type='submit']",
      });
      await sendCommand("wait", { ms: 10000 });

      const wasVerified = await sendCommand("checkCaptcha", {});
      if (wasVerified) {
        console.log("\n[server] Captcha / verification detected!");
        try {
          execSync("afplay /System/Library/Sounds/Glass.aiff");
        } catch {
          console.log("\x07");
        }
        await waitForEnter("Solve it in the browser, then press Enter…");
        await sendCommand("wait", { ms: 2000 });
        await sendCommand("click", {
          selector: "#image-form button[type='submit']",
        });
      }

      await sendCommand("wait", { ms: 5000 });
      let assetId: string | null = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const id = await sendCommand("getAssetId", {});
          if (id) {
            assetId = id as string;
            break;
          }
        } catch (e) {
          console.error(`[server] getAssetId error:`, e);
        }
        await sendCommand("wait", { ms: 2000 });
      }

      if (!assetId) {
        throw new Error(`Failed to get asset ID for ${timestamp}`);
      }

      console.log(`[server] Asset ID: ${assetId}. Polling for completion…`);

      let assetUrl: string | null = null;
      let pollFailed = false;
      for (let retry = 1; retry <= 120; retry++) {
        try {
          process.stdout.write(`[server] Poll #${retry}... `);
          const out = execSync(
            `higgsfield generate get ${assetId} --json`,
            { timeout: 30000 },
          ).toString();
          const json = JSON.parse(out);

          const status = (json.status || "").toLowerCase();

          if (status === "complete" || status === "completed") {
            console.log("COMPLETE!");
            assetUrl = json.result_url || json.url || json.result;
            if (!assetUrl) {
              console.error(
                `[server] API returned success but NO URL. Response:`,
                JSON.stringify(json),
              );
            }
            break;
          } else if (status === "failed" || status === "error") {
            console.log("FAILED");
            pollFailed = true;
            break;
          } else {
            process.stdout.write(`${status}\r`);
          }
        } catch (e) {
          console.log("ERROR");
          console.error(
            "[server] Status check error:",
            e instanceof Error ? e.message : e,
          );
        }
        await sendCommand("wait", { ms: 5000 });
      }

      if (pollFailed) {
        throw new Error(`Generation failed for ${timestamp}`);
      }

      if (assetUrl) {
        console.log(`[server] Downloading ${timestamp}…`);
        execSync(`curl -s -o "${outputPath}" "${assetUrl}"`);
        console.log(`[server] Saved → ${outputPath}`);
      } else {
        throw new Error(`No result URL for ${timestamp}`);
      }

      previousTimestamp = timestamp;
      lastError = null;
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error(
        `[server] Attempt ${generationAttempt}/${MAX_RETRIES} failed for ${timestamp}: ${lastError}`,
      );
      if (generationAttempt < MAX_RETRIES) {
        console.log(`[server] Retrying in ${RETRY_DELAY_MS / 1000}s…`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  if (lastError) {
    console.error(
      `[server] All ${MAX_RETRIES} attempts failed for ${timestamp}, skipping`,
    );
    previousTimestamp = timestamp;
  }
}

console.log("\n[server] All generations complete!");
rl.close();
process.exit(0);
