#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { defaultIntakeInbox } from "../src/handoff/intakeHandoff.ts";
import {
  buildCodexExecArgs,
  buildComputerUsePrompt,
  codexOutputShowsComputerUseDenied,
  codexOutputShowsComputerUse,
  detectNewReadyFileForPatient,
  handoffCsvSnapshot,
  resolveComputerUseMcpCommand,
  syntheticComputerUsePatient,
} from "../src/desktop/patientFlowHarness.ts";

const pollIntervalMs = 1_000;
const requestedTimeoutMs = Number.parseInt(process.env.DESKTOP_PATIENT_FLOW_TIMEOUT_MS ?? "120000", 10);
const pollTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 120_000;
const inbox = defaultIntakeInbox();
const patient = syntheticComputerUsePatient();

await mkdir(inbox, { recursive: true });
const before = await handoffCsvSnapshot(inbox);
const prompt = buildComputerUsePrompt({ patient, inbox });
const computerUseMcpCommand = await resolveComputerUseMcpCommand().catch((error) => {
  console.error(`Computer Use patient flow failed: ${error.message}`);
  process.exit(1);
});

const codexResult = await runCodex(prompt, computerUseMcpCommand, pollTimeoutMs).catch((error) => {
  console.error(`Computer Use patient flow failed: could not start codex exec: ${error.message}`);
  return { status: 1, output: "" };
});
if (codexResult.timedOut) {
  writeCodexTranscript(codexResult.output);
  console.error(`Computer Use patient flow failed: codex exec did not finish within ${pollTimeoutMs}ms.`);
  process.exit(124);
}
if (codexResult.status !== 0) {
  writeCodexTranscript(codexResult.output);
  console.error(`Computer Use patient flow failed: codex exec exited with status ${codexResult.status}.`);
  process.exit(codexResult.status ?? 1);
}
if (codexOutputShowsComputerUseDenied(codexResult.output)) {
  writeCodexTranscript(codexResult.output);
  console.error("Computer Use patient flow failed: Computer Use app access was denied by MCP elicitation.");
  process.exit(1);
}
if (!codexOutputShowsComputerUse(codexResult.output)) {
  writeCodexTranscript(codexResult.output);
  console.error("Computer Use patient flow failed: codex exec did not report Computer Use tool activity.");
  process.exit(1);
}

const readyPath = await waitForNewReadyFile(inbox, before, pollTimeoutMs);
if (!readyPath) {
  writeCodexTranscript(codexResult.output);
  console.error(
    `Computer Use patient flow failed: no new single-patient .ready.csv file for ${patient.firstName} ${patient.lastName} appeared in ${inbox} within ${pollTimeoutMs}ms.`,
  );
  process.exit(1);
}

console.log(JSON.stringify({ status: "exported", patient, readyPath }, null, 2));

function runCodex(prompt, computerUseMcpCommandPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const outputChunks = [];
    let timedOut = false;
    const args = buildCodexExecArgs({
      prompt,
      computerUseMcpCommand: computerUseMcpCommandPath,
      cwd: process.cwd(),
    });
    const child = spawn("codex", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => outputChunks.push(chunk));
    child.stderr.on("data", (chunk) => outputChunks.push(chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ status: timedOut ? 124 : code, output: outputChunks.join(""), timedOut });
    });
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

function writeCodexTranscript(output) {
  if (output.length === 0) return;
  process.stderr.write("codex exec transcript:\n");
  process.stderr.write(output);
  if (!output.endsWith("\n")) process.stderr.write("\n");
}
