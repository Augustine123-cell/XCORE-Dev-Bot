import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as db from "../src/db.js";
import * as ai from "../src/ai/index.js";
import { REGISTRY } from "../src/whatsapp/commands/index.js";
import { handleMessage } from "../src/whatsapp/handler.js";
import { FakeSession, OWNER, isolate, msg } from "./helpers.js";

isolate();

async function send(text, opts = {}) {
  const s = new FakeSession();
  await handleMessage(s, msg(text, opts));
  return s;
}

describe("XCORE AI", () => {
  it("registers AI commands", () => {
    assert.equal(REGISTRY.has("ai"), true);
    assert.equal(REGISTRY.has("xcoreai"), true);
  });

  it("toggles AI mode per chat", async () => {
    const chat = "2348000000000@s.whatsapp.net";
    assert.equal(db.getAIMode(chat), false);
    const s = await send("@ai on", { chat });
    assert.equal(db.getAIMode(chat), true);
    assert.match(s.last, /XCORE AI → ON/);
    await send("@ai off", { chat });
    assert.equal(db.getAIMode(chat), false);
  });

  it("requires owner for provider switch", async () => {
    const user = "2349000000009";
    const s = await send("@ai provider gemini", { sender: user });
    assert.match(s.last, /Owner-only/);
    const o = await send("@ai provider gemini", { sender: OWNER });
    assert.match(o.last, /GEMINI/);
    assert.equal(db.getAIProvider(), "gemini");
    await send("@ai provider openai", { sender: OWNER });
    assert.equal(db.getAIProvider(), "openai");
  });

  it("auto-response trigger requires AI mode", () => {
    const chat = "2348000000000@s.whatsapp.net";
    assert.equal(ai.shouldAutoRespond({ chat, text: "Who is the governor?", meta: {} }, { number: "2348130300032" }), false);
    db.setAIMode(chat, true);
    assert.equal(ai.shouldAutoRespond({ chat, text: "Who is the governor?", meta: {} }, { number: "2348130300032" }), true);
    assert.equal(ai.shouldAutoRespond({ chat, text: "hello everyone", meta: {} }, { number: "2348130300032" }), false);
  });
});
