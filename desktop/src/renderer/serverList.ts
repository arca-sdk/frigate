/** The server list page: saved servers, their problems, and the add form. */

import { formatCertificateDate, formatFingerprint } from "../shared/format";
import { strings } from "../shared/strings";
import type {
  AddServerRequest,
  AddServerResult,
  CertificateInfo,
  ServerProblem,
  ServersApi,
  ServerView,
} from "../shared/types";

declare global {
  interface Window {
    servers: ServersApi;
  }
}

const api = window.servers;

const list = byId<HTMLUListElement>("servers");
const empty = byId<HTMLParagraphElement>("empty");
const form = byId<HTMLFormElement>("add-form");
const urlInput = byId<HTMLInputElement>("add-url");
const nameInput = byId<HTMLInputElement>("add-name");
const addError = byId<HTMLParagraphElement>("add-error");
const addCertificate = byId<HTMLDivElement>("add-certificate");
const submit = byId<HTMLButtonElement>("add-submit");

function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (!found) {
    throw new Error(`Missing #${id}`);
  }

  return found as T;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);

  if (className) {
    created.className = className;
  }
  if (text !== undefined) {
    created.textContent = text;
  }

  return created;
}

function button(
  text: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const created = element("button", className, text);
  created.type = "button";
  created.addEventListener("click", onClick);
  return created;
}

function setStaticText(): void {
  document.title = strings.list.title;
  byId("title").textContent = strings.list.title;
  empty.textContent = strings.list.empty;
  byId("add-title").textContent = strings.add.title;
  byId("add-url-label").textContent = strings.add.urlLabel;
  byId("add-url-hint").textContent = strings.add.urlHint;
  byId("add-name-label").textContent = strings.add.nameLabel;
  urlInput.placeholder = strings.add.urlPlaceholder;
  nameInput.placeholder = strings.add.namePlaceholder;
  submit.textContent = strings.add.submit;
}

function renderServers(servers: ServerView[]): void {
  list.replaceChildren(...servers.map(serverItem));
  empty.hidden = servers.length > 0;
}

function serverItem(server: ServerView): HTMLLIElement {
  const item = element("li", "server");
  item.dataset.serverId = server.id;

  const heading = element("div", "server-heading");
  heading.append(element("strong", "server-name", server.name));
  heading.append(element("span", "server-url", server.url));
  item.append(heading);

  const badges = element("div", "badges");

  if (!server.encrypted) {
    badges.append(element("span", "badge warning", strings.list.notEncrypted));
  }
  if (!server.loginRequired) {
    const badge = element("span", "badge warning", strings.list.noLogin);
    badge.title = strings.list.noLoginHint;
    badges.append(badge);
  }
  if (server.certificateFingerprint) {
    badges.append(element("span", "badge", strings.list.trustedCertificate));
  }
  if (badges.childElementCount > 0) {
    item.append(badges);
  }

  if (server.problem) {
    item.append(problemElement(server.id, server.problem));
  }

  const actions = element("div", "actions");
  const open = button(
    server.checking ? strings.list.connecting : strings.list.open,
    "primary",
    () => void api.open(server.id),
  );
  open.disabled = server.checking;
  actions.append(open);
  actions.append(
    button(strings.list.remove, "danger", () => {
      if (window.confirm(strings.list.removeConfirm(server.name))) {
        void api.remove(server.id);
      }
    }),
  );
  item.append(actions);

  return item;
}

function problemElement(serverId: string, problem: ServerProblem): HTMLElement {
  switch (problem.kind) {
    case "untrusted_certificate":
    case "certificate_changed":
      return certificatePanel(
        problem.kind === "certificate_changed" ? "changed" : "untrusted",
        problem.certificate,
        () =>
          void api.trustCertificate(serverId, problem.certificate.fingerprint),
      );
    case "restart_required": {
      const panel = element("div", "problem");
      panel.append(element("p", "error", strings.certificate.restartRequired));
      panel.append(
        button(
          strings.certificate.restart,
          "primary",
          () => void api.restart(),
        ),
      );
      return panel;
    }
    case "rejected":
      return element("p", "error", strings.rejections[problem.reason]);
    case "redirected":
      return element("p", "error", strings.redirected(problem.address));
    case "unreachable":
      return element("p", "error", strings.unreachable(problem.error));
  }
}

function certificatePanel(
  kind: "untrusted" | "changed",
  certificate: CertificateInfo,
  onTrust: () => void,
  onCancel?: () => void,
): HTMLDivElement {
  const panel = element("div", `certificate ${kind}`);
  panel.setAttribute("role", "alert");

  panel.append(
    element(
      "h3",
      undefined,
      kind === "changed"
        ? strings.certificate.changedTitle
        : strings.certificate.untrustedTitle,
    ),
  );
  panel.append(
    element(
      "p",
      undefined,
      kind === "changed"
        ? strings.certificate.changedBody
        : strings.certificate.untrustedBody,
    ),
  );

  const details = element("dl");
  const rows: [string, string, string?][] = [
    [
      strings.certificate.fingerprint,
      formatFingerprint(certificate.fingerprint),
      "fingerprint",
    ],
    [strings.certificate.subject, certificate.subjectName],
    [strings.certificate.issuer, certificate.issuerName],
    [
      strings.certificate.validity,
      strings.certificate.validityRange(
        formatCertificateDate(certificate.validStart),
        formatCertificateDate(certificate.validExpiry),
      ),
    ],
  ];

  for (const [label, value, className] of rows) {
    details.append(element("dt", undefined, label));
    details.append(element("dd", className, value));
  }
  panel.append(details);

  const actions = element("div", "actions");
  actions.append(
    button(
      strings.certificate.trust,
      kind === "changed" ? "danger" : "primary",
      onTrust,
    ),
  );
  if (onCancel) {
    actions.append(button(strings.certificate.cancel, "", onCancel));
  }
  panel.append(actions);

  return panel;
}

function setBusy(busy: boolean): void {
  submit.disabled = busy;
  submit.textContent = busy ? strings.add.checking : strings.add.submit;
}

function clearAddFeedback(): void {
  addError.hidden = true;
  addError.textContent = "";
  addCertificate.replaceChildren();
}

function showAddError(message: string): void {
  addError.textContent = message;
  addError.hidden = false;
}

async function submitAdd(request: AddServerRequest): Promise<void> {
  clearAddFeedback();
  setBusy(true);

  let result: AddServerResult;

  try {
    result = await api.add(request);
  } finally {
    setBusy(false);
  }

  switch (result.kind) {
    case "added":
      form.reset();
      break;
    case "rejected":
      showAddError(strings.rejections[result.reason]);
      break;
    case "redirected":
      showAddError(strings.redirected(result.address));
      break;
    case "unreachable":
      showAddError(strings.unreachable(result.error));
      break;
    case "untrusted_certificate":
      addCertificate.replaceChildren(
        certificatePanel(
          "untrusted",
          result.certificate,
          () =>
            void submitAdd({
              ...request,
              trustedFingerprint: result.certificate.fingerprint,
            }),
          clearAddFeedback,
        ),
      );
      break;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAdd({ url: urlInput.value, name: nameInput.value });
});

// A certificate prompt belongs to the address it was shown for.
urlInput.addEventListener("input", clearAddFeedback);

setStaticText();
api.onChanged(renderServers);
void api.list().then(renderServers);
