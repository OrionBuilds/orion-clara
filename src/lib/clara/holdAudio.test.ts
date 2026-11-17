// The owner's hold audio (holdAudio.ts): where it's looked for, and what's served.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clara-holdaudio-"));
process.env.CLARA_CONFIG = path.join(tmp, "clara.config.json");
await fs.writeFile(process.env.CLARA_CONFIG, JSON.stringify({ dataDir: tmp, vaultRoot: tmp }), "utf8");

const { holdAudioCandidates, holdAudioPath, holdAudioFile, hasHoldAudioFile, contentTypeFor } = await import("./holdAudio");

test("an explicit file comes first, then hold.mp3/.wav/.m4a in the data folder", () => {
  const c = holdAudioCandidates({ CLARA_HOLD_AUDIO_FILE: "/x/mine.wav" }, "/data");
  assert.deepEqual(c, ["/x/mine.wav", path.join("/data/audio", "hold.mp3"), path.join("/data/audio", "hold.wav"), path.join("/data/audio", "hold.m4a")]);
  assert.equal(contentTypeFor("a.wav"), "audio/wav");
  assert.equal(contentTypeFor("a.mp3"), "audio/mpeg");
});

test("nothing on disk → no file (Twilio's sample plays); a dropped-in file is served as-is", async () => {
  assert.equal(await holdAudioPath({}), null);
  assert.equal(await hasHoldAudioFile({}), false);
  await fs.mkdir(path.join(tmp, "audio"), { recursive: true });
  await fs.writeFile(path.join(tmp, "audio", "hold.mp3"), Buffer.from([0x49, 0x44, 0x33, 0x04]));
  assert.equal(await hasHoldAudioFile({}), true);
  const f = await holdAudioFile({});
  assert.equal(f?.contentType, "audio/mpeg");
  assert.equal(f?.bytes.length, 4);
  // An external URL means Clara serves nothing herself.
  assert.equal(await hasHoldAudioFile({ CLARA_HOLD_AUDIO_URL: "https://cdn/hold.mp3" }), false);
});
