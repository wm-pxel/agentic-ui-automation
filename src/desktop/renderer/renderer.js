const fields = [
  "firstName",
  "lastName",
  "dateOfBirth",
  "sexOrGender",
  "phone",
  "email",
  "streetAddress",
  "city",
  "state",
  "zip",
  "insurancePayer",
  "insuranceMemberId",
  "insuranceGroupId",
  "reasonForVisit",
  "preferredContactMethod",
  "notes",
];

const state = {
  queue: null,
  activeId: null,
  selectedIds: new Set(),
  lastExportPath: null,
};

const el = {
  sourceLabel: document.getElementById("source-label"),
  totalCount: document.getElementById("total-count"),
  readyCount: document.getElementById("ready-count"),
  exceptionCount: document.getElementById("exception-count"),
  selectedCount: document.getElementById("selected-count"),
  recordList: document.getElementById("record-list"),
  detailName: document.getElementById("detail-name"),
  detailId: document.getElementById("detail-id"),
  detailStatus: document.getElementById("detail-status"),
  fieldGrid: document.getElementById("field-grid"),
  sourceText: document.getElementById("source-text"),
  issuesList: document.getElementById("issues-list"),
  selectAll: document.getElementById("select-all"),
  seedButton: document.getElementById("seed-button"),
  importButton: document.getElementById("import-button"),
  newPatientButton: document.getElementById("new-patient-button"),
  exportButton: document.getElementById("export-button"),
  showExportButton: document.getElementById("show-export-button"),
  handoffLabel: document.getElementById("handoff-label"),
  patientDialog: document.getElementById("patient-dialog"),
  patientForm: document.getElementById("patient-form"),
  cancelPatientButton: document.getElementById("cancel-patient-button"),
  resetPatientButton: document.getElementById("reset-patient-button"),
};

window.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  loadSeed();
});

function bindEvents() {
  el.seedButton.addEventListener("click", loadSeed);
  el.importButton.addEventListener("click", importFile);
  el.newPatientButton.addEventListener("click", openNewPatientDialog);
  el.exportButton.addEventListener("click", exportSelected);
  el.showExportButton.addEventListener("click", () => {
    if (state.lastExportPath) window.intakeApp.showPath(state.lastExportPath);
  });
  el.selectAll.addEventListener("change", () => {
    state.selectedIds = new Set(
      el.selectAll.checked ? state.queue.items.filter((item) => item.exportReady).map((item) => item.sourceRecordId) : [],
    );
    render();
  });
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });
  el.cancelPatientButton.addEventListener("click", () => el.patientDialog.close());
  el.resetPatientButton.addEventListener("click", seedPatientForm);
  el.patientForm.addEventListener("submit", addPatient);
}

async function loadSeed() {
  setBusy("Loading seeded intake records");
  try {
    setQueue(await window.intakeApp.loadSeed());
  } catch (error) {
    showError(error);
  }
}

async function importFile() {
  setBusy("Opening import dialog");
  try {
    const result = await window.intakeApp.importFile();
    if (result.canceled) {
      render();
      return;
    }
    setQueue(result.queue);
  } catch (error) {
    showError(error);
  }
}

async function exportSelected() {
  if (!state.queue) return;
  setBusy("Exporting selected records");
  try {
    const result = await window.intakeApp.exportReady({
      queue: state.queue,
      selectedRecordIds: [...state.selectedIds],
    });
    state.lastExportPath = result.readyPath;
    el.handoffLabel.textContent = `Exported ${result.recordCount} records to ${result.readyPath}`;
    el.showExportButton.disabled = false;
    render();
  } catch (error) {
    showError(error);
  }
}

function openNewPatientDialog() {
  if (!state.queue) return;
  seedPatientForm();
  if (typeof el.patientDialog.showModal === "function") {
    el.patientDialog.showModal();
  } else {
    el.patientDialog.setAttribute("open", "");
  }
}

async function addPatient(event) {
  event.preventDefault();
  if (!state.queue) return;

  setBusy("Adding synthetic intake record");
  try {
    const previousSelectedIds = new Set(state.selectedIds);
    const queue = await window.intakeApp.addPatient({
      queue: state.queue,
      patient: patientFromForm(),
    });
    const created = queue.items[0];
    setQueue(queue, { selectedIds: previousSelectedIds, activeId: created?.sourceRecordId });
    if (created?.exportReady) {
      state.selectedIds.add(created.sourceRecordId);
    }
    el.patientDialog.close();
    el.handoffLabel.textContent = created
      ? `Added ${created.displayName} to the intake queue`
      : "Added synthetic intake record";
    render();
  } catch (error) {
    showError(error);
  }
}

function setQueue(queue, options = {}) {
  state.queue = queue;
  state.activeId = options.activeId ?? queue.items[0]?.sourceRecordId ?? null;
  state.selectedIds =
    options.selectedIds instanceof Set
      ? new Set([...options.selectedIds].filter((id) => queue.items.some((item) => item.sourceRecordId === id && item.exportReady)))
      : new Set(queue.items.filter((item) => item.exportReady).map((item) => item.sourceRecordId));
  state.lastExportPath = null;
  el.showExportButton.disabled = true;
  el.handoffLabel.textContent = "";
  render();
}

function render() {
  if (!state.queue) return;
  const readyItems = state.queue.items.filter((item) => item.exportReady);
  const active = state.queue.items.find((item) => item.sourceRecordId === state.activeId) ?? state.queue.items[0];
  state.activeId = active?.sourceRecordId ?? null;

  el.sourceLabel.textContent = state.queue.sourceName;
  el.totalCount.textContent = String(state.queue.items.length);
  el.readyCount.textContent = String(readyItems.length);
  el.exceptionCount.textContent = String(state.queue.items.length - readyItems.length);
  el.selectedCount.textContent = String(state.selectedIds.size);
  el.exportButton.disabled = state.selectedIds.size === 0;
  el.selectAll.checked = readyItems.length > 0 && readyItems.every((item) => state.selectedIds.has(item.sourceRecordId));

  renderList();
  renderDetail(active);
}

function renderList() {
  el.recordList.replaceChildren();
  for (const item of state.queue.items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `record-row ${item.sourceRecordId === state.activeId ? "active" : ""}`;
    row.addEventListener("click", () => {
      state.activeId = item.sourceRecordId;
      render();
    });

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedIds.has(item.sourceRecordId);
    checkbox.disabled = !item.exportReady;
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
      if (checkbox.checked) {
        state.selectedIds.add(item.sourceRecordId);
      } else {
        state.selectedIds.delete(item.sourceRecordId);
      }
      render();
    });

    const text = document.createElement("span");
    const title = document.createElement("span");
    title.className = "record-title";
    title.textContent = item.displayName;
    const subtitle = document.createElement("span");
    subtitle.className = "record-subtitle";
    subtitle.textContent = item.sourceRecordId;
    text.append(title, subtitle);

    const status = document.createElement("span");
    status.className = `status ${item.exportReady ? "ready" : "review"}`;
    status.textContent = item.exportReady ? "Ready" : "Review";

    row.append(checkbox, text, status);
    el.recordList.append(row);
  }
}

function renderDetail(item) {
  if (!item) return;
  el.detailName.textContent = item.displayName;
  el.detailId.textContent = item.sourceRecordId;
  el.detailStatus.className = `status ${item.exportReady ? "ready" : "review"}`;
  el.detailStatus.textContent = item.exportReady ? "Export ready" : "Needs review";
  el.sourceText.textContent = item.rawSourceExcerpt || JSON.stringify(item.record, null, 2);

  el.fieldGrid.replaceChildren();
  for (const field of fields) {
    const wrapper = document.createElement("div");
    wrapper.className = "field";
    const label = document.createElement("label");
    label.textContent = labelFor(field);
    const value = document.createElement("span");
    value.textContent = stringValue(item.normalizedRecord?.[field] ?? item.record[field]);
    wrapper.append(label, value);
    el.fieldGrid.append(wrapper);
  }

  renderIssues(item);
}

function renderIssues(item) {
  el.issuesList.replaceChildren();
  const issues = [
    ...item.exceptions.map((exception) => ({
      severity: exception.severity,
      field: exception.field,
      message: exception.message,
    })),
    ...item.aiIssues,
  ];
  if (item.lowestConfidence !== undefined && item.lowestConfidence < 0.75) {
    issues.push({
      severity: "warning",
      field: "aiExtraction",
      message: `Lowest extraction confidence is ${Math.round(item.lowestConfidence * 100)}%.`,
    });
  }
  if (issues.length === 0) {
    const empty = document.createElement("div");
    empty.className = "issue";
    empty.textContent = "No review issues";
    el.issuesList.append(empty);
    return;
  }

  for (const issue of issues) {
    const row = document.createElement("div");
    row.className = `issue ${issue.severity}`;
    const title = document.createElement("strong");
    title.textContent = issue.field ? `${issue.field} - ${issue.severity}` : issue.severity;
    const message = document.createElement("span");
    message.textContent = issue.message;
    row.append(title, message);
    el.issuesList.append(row);
  }
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${name}-tab`);
  });
}

function setBusy(message) {
  el.sourceLabel.textContent = message;
  el.exportButton.disabled = true;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  el.handoffLabel.textContent = message;
  render();
}

function seedPatientForm() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = stamp.slice(8);
  const values = {
    firstName: "Taylor",
    lastName: `Morgan ${suffix}`,
    dateOfBirth: "1990-04-18",
    sexOrGender: "female",
    phone: `312555${suffix.slice(-4)}`,
    email: `taylor.morgan.${suffix}@example.test`,
    streetAddress: "500 West Monroe Street",
    city: "Chicago",
    state: "IL",
    zip: "60661",
    insurancePayer: "Aetna",
    insuranceMemberId: `AET${stamp.slice(-8)}`,
    insuranceGroupId: "GRP4",
    reasonForVisit: "New patient wellness visit",
    preferredContactMethod: "email",
    notes: "Created in the Electron intake app.",
  };

  for (const [name, value] of Object.entries(values)) {
    const field = el.patientForm.elements.namedItem(name);
    if (field) field.value = value;
  }
}

function patientFromForm() {
  const data = new FormData(el.patientForm);
  return Object.fromEntries(fields.map((field) => [field, String(data.get(field) ?? "").trim()]));
}

function labelFor(value) {
  return value.replace(/[A-Z]/g, (letter) => ` ${letter}`).replace(/^./, (letter) => letter.toUpperCase());
}

function stringValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}
