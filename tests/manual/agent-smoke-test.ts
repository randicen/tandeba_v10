import { createSession, stepSession, addMessage } from "./agent.js";

async function run() {
  try {
    const s = await createSession("test");
    await addMessage(s.id, "Hello world", "user");
    console.log("Stepping...");
    const res = await stepSession(s.id);
    console.log(res);
  } catch (e: any) {
    console.error("FAILED:", e);
  }
}

run();
