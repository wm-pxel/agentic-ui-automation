#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { defaultIntakeInbox } from "../dist/src/handoff/intakeHandoff.js";
import {
  buildComputerUsePrompt,
  detectNewReadyFile,
  readyFileSnapshot,
  syntheticComputerUsePatient,
} from "../dist/src/desktop/patientFlowHarness.js";

const pollIntervalMs = 1_000;
const requestedTimeoutMs = Number.parseInt(process.env.DESKTOP_PATIENT_FLOW_TIMEOUT_MS ?? "120000", 10);
const pollTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 120_000;
const inbox = defaultIntakeInbox();
const patient = syntheticComputerUsePatient();

await mkdir(inbox, { recursive: true });
const before = await readyFileSnapshot(inbox);
const prompt = buildComputerUsePrompt({ patient, inbox });

const codexStatus = await runCodex(prompt).catch((error) => {
  console.error(`Computer Use patient flow failed: could not start codex exec: ${error.message}`);
  return 1;
});
if (codexStatus !== 0) {
  console.error(`Computer Use patient flow failed: codex exec exited with status ${codexStatus}.`);
  process.exit(codexStatus ?? 1);
}

const readyPath = await waitForNewReadyFile(inbox, before, pollTimeoutMs);
if (!readyPath) {
  console.error(`Computer Use patient flow failed: no new .ready.csv file appeared in ${inbox} within ${pollTimeoutMs}ms.`);
  process.exit(1);
}

console.log(JSON.stringify({ status: "exported", patient, readyPath }, null, 2));

function runCodex(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      ["exec", "--sandbox", "danger-full-access", "-c", 'approval_policy="never"', "-C", process.cwd(), prompt],
      {
        cwd: process.cwd(),
        stdio: "inherit",
      },
    );

    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

async function waitForNewReadyFile(inboxPath, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const readyPath = await detectNewReadyFile(inboxPath, before);
    if (readyPath) return readyPath;
    await delay(pollIntervalMs);
  } while (Date.now() < deadline);

  return detectNewReadyFile(inboxPath, before);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
