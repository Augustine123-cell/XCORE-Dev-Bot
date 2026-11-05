/** Persistent storage across redeploys (Railway volume etc.). */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as clans from "../src/clans.js";
import * as config from "../src/config.js";
import * as db from "../src/db.js";
import * as paths from "../src/paths.js";
import { isolate } from "./helpers.js";

const state = isolate();

function freshProcess() {
  config.reset();
  db.resetCache();
  clans.resetCache();
}
const noExplicitDirs = () => { delete process.env.DATA_DIR; delete process.env.SESSION_DIR; };
const real = (p) => fs.realpathSync(p);

describe("path resolution", () => {
  it("volume mount is used for data and sessions", () => {
    noExplicitDirs();
    const vol = path.join(state.tmp, "vol");
    process.env.RAILWAY_VOLUME_MOUNT_PATH = vol;
    assert.equal(paths.dataDir(), path.join(real(vol), "data"));
    assert.equal(paths.sessionDir(), path.join(real(vol), "sessions"));
  });

  it("explicit dirs beat the volume", () => {
    process.env.RAILWAY_VOLUME_MOUNT_PATH = path.join(state.tmp, "vol");
    assert.equal(paths.dataDir(), path.join(state.tmp, "data"));
  });

  it("PERSIST_DIR override", () => {
    noExplicitDirs();
    process.env.PERSIST_DIR = path.join(state.tmp, "p");
    assert.equal(paths.dataDir(), path.join(real(path.join(state.tmp, "p")), "data"));
  });

  it("warns on Railway without a volume", () => {
    noExplicitDirs();
    process.env.RAILWAY_ENVIRONMENT = "production";
    const st = paths.status(path.join(state.tmp, "d"), path.join(state.tmp, "s"));
    assert.equal(st.persistent, false);
    assert.match(st.warnings[0].toLowerCase(), /volume/);
  });

  it("ok on Railway with a volume", () => {
    noExplicitDirs();
    const vol = path.join(state.tmp, "vol");
    Object.assign(process.env, { RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: vol });
    config.reset();
    const st = paths.bootstrap(config.get().paths.data, config.get().paths.sessions);
    assert.equal(st.persistent, true, st.warnings.join());
    assert.ok(fs.statSync(path.join(vol, "data")).isDirectory() && fs.statSync(path.join(vol, "sessions")).isDirectory());
  });

  it("warns when dirs are outside the volume", () => {
    Object.assign(process.env, { RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: path.join(state.tmp, "vol") });
    assert.equal(paths.status().persistent, false);
  });
});

describe("seed", () => {
  it("bootstrap seeds clans once and never overwrites", () => {
    const data = config.get().paths.data;
    const st = paths.bootstrap(data, config.get().paths.sessions);
    assert.deepEqual(st.seeded, ["clans.json"]);
    assert.ok(JSON.parse(fs.readFileSync(path.join(data, "clans.json"), "utf8")).clans.length);
    fs.writeFileSync(path.join(data, "clans.json"), JSON.stringify({ clans: [{ name: "Mine", tag: "M" }] }));
    assert.deepEqual(paths.bootstrap(data, config.get().paths.sessions).seeded, []);
    clans.resetCache();
    assert.deepEqual(clans.listClans().map((c) => c.name), ["Mine"]); // owner edits survive
  });
});

describe("redeploy", () => {
  it("everything survives a redeploy", () => {
    const vol = path.join(state.tmp, "vol");
    noExplicitDirs();
    process.env.RAILWAY_VOLUME_MOUNT_PATH = vol;

    freshProcess(); // deploy #1
    paths.bootstrap(config.get().paths.data, config.get().paths.sessions);
    db.addSudo("111");
    db.addPremium("222", 0);
    db.banUser("333", 0, "spam");
    db.setMode("stealth");
    clans.addClan({ name: "Raven", tag: "RVN" });
    const sessFile = path.join(config.get().paths.sessions, "2348130300032", "creds.json");
    fs.mkdirSync(path.dirname(sessFile), { recursive: true });
    fs.writeFileSync(sessFile, "whatsapp-keys");

    freshProcess(); // container replaced: only the volume remains
    assert.equal(config.get().paths.data, path.join(real(vol), "data"));
    paths.bootstrap(config.get().paths.data, config.get().paths.sessions);
    assert.deepEqual(db.listSudo(), ["111"]);
    assert.equal(db.isPremium("222"), true);
    assert.equal(db.isBanned("333"), true);
    assert.equal(db.getMode(), "stealth");
    assert.ok(clans.listClans().map((c) => c.tag).includes("RVN"));
    assert.equal(fs.readFileSync(sessFile, "utf8"), "whatsapp-keys"); // no re-pairing needed
  });
});

describe("db resilience", () => {
  it("corrupt db is quarantined and restored from backup", () => {
    db.addSudo("111");
    db.addSudo("222"); // second save leaves a .bak holding the first state
    const f = config.get().paths.dbFile;
    assert.ok(fs.existsSync(`${f}.bak`));
    fs.writeFileSync(f, "{ not json");
    db.resetCache();
    assert.deepEqual(db.listSudo(), ["111"]); // restored from .bak
    assert.ok(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith("db.json.corrupt-"))); // bad file kept
  });

  it("corrupt db without backup starts empty but keeps the file", () => {
    const f = config.get().paths.dbFile;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "garbage");
    db.resetCache();
    assert.deepEqual(db.listSudo(), []);
    assert.ok(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith("db.json.corrupt-")));
  });

  it("no temp files left behind", () => {
    db.addSudo("1");
    assert.deepEqual(fs.readdirSync(config.get().paths.data).filter((n) => n.endsWith(".tmp")), []);
  });
});
