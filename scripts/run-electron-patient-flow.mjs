#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { defaultIntakeInbox } from "../src/handoff/intakeHandoff.ts";
import {
  buildComputerUsePrompt,
  codexOutputShowsComputerUse,
  detectNewReadyFileForPatient,
  readyFileSnapshot,
  syntheticComputerUsePatient,
} from "../src/desktop/patientFlowHarness.ts";

const pollIntervalMs = 1_000;
const requestedTimeoutMs = Number.parseInt(process.env.DESKTOP_PATIENT_FLOW_TIMEOUT_MS ?? "120000", 10);
const pollTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 120_000;
const inbox = defaultIntakeInbox();
const patient = syntheticComputerUsePatient();

await mkdir(inbox, { recursive: true });
const before = await readyFileSnapshot(inbox);
const prompt = buildComputerUsePrompt({ patient, inbox });

const codexResult = await runCodex(prompt).catch((error) => {
  console.error(`Computer Use patient flow failed: could not start codex exec: ${error.message}`);
  return { status: 1, output: "" };
});
if (codexResult.status !== 0) {
  if (codexResult.output.length > 0) {
    process.stderr.write(codexResult.output);
    if (!codexResult.output.endsWith("\n")) process.stderr.write("\n");
  }
  console.error(`Computer Use patient flow failed: codex exec exited with status ${codexResult.status}.`);
  process.exit(codexResult.status ?? 1);
}
if (!codexOutputShowsComputerUse(codexResult.output)) {
  if (codexResult.output.length > 0) {
    process.stderr.write(codexResult.output);
    if (!codexResult.output.endsWith("\n")) process.stderr.write("\n");
  }
  console.error("Computer Use patient flow failed: codex exec did not report Computer Use tool activity.");
  process.exit(1);
}

const readyPath = await waitForNewReadyFile(inbox, before, pollTimeoutMs);
if (!readyPath) {
  console.error(
    `Computer Use patient flow failed: no new single-patient .ready.csv file for ${patient.firstName} ${patient.lastName} appeared in ${inbox} within ${pollTimeoutMs}ms.`,
  );
  process.exit(1);
}

console.log(JSON.stringify({ status: "exported", patient, readyPath }, null, 2));

function runCodex(prompt) {
  return new Promise((resolve, reject) => {
    const outputChunks = [];
    const child = spawn(
      "codex",
      ["exec", "-m", "gpt-5.4", "--json", "--sandbox", "read-only", "-c", 'approval_policy="never"', "-C", process.cwd(), prompt],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => outputChunks.push(chunk));
    child.stderr.on("data", (chunk) => outputChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, output: outputChunks.join("") }));
  });
}

async function waitForNewReadyFile(inboxPath, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const readyPath = await detectNewReadyFileForPatient(inboxPath, before, patient);
    if (readyPath) return readyPath;
    await delay(pollIntervalMs);
  } while (Date.now() < deadline);

  return detectNewReadyFileForPatient(inboxPath, before, patient);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
