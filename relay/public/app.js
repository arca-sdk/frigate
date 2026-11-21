// The relay's account and link pages. Every value from the API is rendered
// with textContent: instance names come from the Frigate that asked to link.

const main = document.querySelector("main");
const page = document.body.dataset.page;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") {
      node.className = value;
    } else if (key.startsWith("on")) {
      node.addEventListener(key.slice(2), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// The sign-in form currently mounted in main, if any.
let signInContainer = null;

function show(...nodes) {
  if (signInContainer !== null) {
    window.Clerk.unmountSignIn(signInContainer);
    signInContainer = null;
  }
  main.replaceChildren(...nodes);
}

async function getInfo() {
  const response = await fetch("/v1/info");
  if (!response.ok) {
    throw new Error("This relay is not set up yet.");
  }
  return response.json();
}

function loadClerk(info) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://${info.clerk_frontend_api}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;
    script.crossOrigin = "anonymous";
    script.dataset.clerkPublishableKey = info.clerk_publishable_key;
    script.onload = () => window.Clerk.load().then(() => resolve(window.Clerk), reject);
    script.onerror = () => reject(new Error("Could not load the sign-in service."));
    document.head.append(script);
  });
}

async function api(clerk, method, path) {
  const token = await clerk.session?.getToken();
  const response = await fetch(path, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.message ?? `Request failed (HTTP ${response.status})`);
    error.code = body?.error;
    throw error;
  }
  return body;
}

function here() {
  return `${location.origin}${location.pathname}${location.search}`;
}

function showSignIn(clerk, message) {
  const container = el("div");
  show(el("p", {}, message), container);
  signInContainer = container;
  clerk.mountSignIn(container, {
    routing: "hash",
    forceRedirectUrl: here(),
    signUpForceRedirectUrl: here(),
  });
}

function showError(error) {
  show(el("p", { class: "error" }, error.message));
}

const STATUS_LABELS = {
  online: "Online",
  offline: "Offline",
  setting_up: "Setting up",
  removing: "Removing",
  unknown: "Status unavailable",
};

async function showDashboard(clerk) {
  if (!clerk.user) {
    showSignIn(clerk, "Sign in to see the Frigate servers linked to your account.");
    return;
  }
  const { instances } = await api(clerk, "GET", "/v1/me/instances");
  const heading = el("h1", {}, "Your Frigate servers");
  if (instances.length === 0) {
    show(
      heading,
      el(
        "p",
        { class: "muted" },
        "No Frigate servers are linked yet. In Frigate, open Settings, then Remote access, and choose Set up.",
      ),
    );
    return;
  }
  const list = el("ul", { class: "instances" });
  for (const instance of instances) {
    const remove = el("button", { class: "danger" }, "Remove");
    remove.addEventListener("click", async () => {
      const confirmed = confirm(
        `Remove ${instance.name}? It stops being reachable at ${instance.hostname} until you link it again.`,
      );
      if (!confirmed) {
        return;
      }
      remove.disabled = true;
      try {
        await api(clerk, "DELETE", `/v1/me/instances/${encodeURIComponent(instance.instance_id)}`);
        await showDashboard(clerk);
      } catch (error) {
        remove.disabled = false;
        alert(error.message);
      }
    });
    list.append(
      el(
        "li",
        {},
        el(
          "div",
          {},
          el("div", { class: "instance-name" }, instance.name),
          el("a", { class: "instance-url", href: instance.url, target: "_blank", rel: "noopener" }, instance.hostname),
          el("div", { class: `status ${instance.status}` }, STATUS_LABELS[instance.status] ?? instance.status),
        ),
        remove,
      ),
    );
  }
  show(heading, el("div", { class: "card" }, list));
}

function showCodeForm(message) {
  const input = el("input", { name: "code", autocomplete: "off", placeholder: "XXXX-XXXX", maxlength: "12" });
  const form = el(
    "form",
    {
      onsubmit: (event) => {
        event.preventDefault();
        location.search = `?code=${encodeURIComponent(input.value.trim())}`;
      },
    },
    input,
    el("div", { class: "actions" }, el("button", { class: "primary", type: "submit" }, "Continue")),
  );
  show(
    el("h1", {}, "Link a Frigate server"),
    ...(message ? [el("p", { class: "error" }, message)] : []),
    el("p", {}, "Enter the code shown in Frigate under Settings, then Remote access."),
    el("div", { class: "card" }, form),
  );
}

async function showLink(clerk) {
  const code = new URLSearchParams(location.search).get("code");
  if (!clerk.user) {
    showSignIn(clerk, "Sign in to link your Frigate server to your account.");
    return;
  }
  if (!code) {
    showCodeForm();
    return;
  }
  let request;
  try {
    request = await api(clerk, "GET", `/v1/link-requests/${encodeURIComponent(code)}`);
  } catch (error) {
    if (error.code === "unknown_code") {
      showCodeForm("That code is not valid or has expired. Start again in Frigate to get a new one.");
      return;
    }
    throw error;
  }
  const dashboardLink = el("a", { href: "/" }, "See your Frigate servers");
  if (request.status === "approved") {
    show(el("h1", {}, "Already linked"), el("p", {}, "This code was already approved."), dashboardLink);
    return;
  }
  if (request.status === "denied") {
    show(el("h1", {}, "Declined"), el("p", {}, "This request was declined. Start again in Frigate to link it."));
    return;
  }

  const approve = el("button", { class: "primary" }, "Link");
  const decline = el("button", {}, "Decline");
  const status = el("p", { class: "error" });
  const decide = async (action) => {
    approve.disabled = true;
    decline.disabled = true;
    try {
      await api(clerk, "POST", `/v1/link-requests/${encodeURIComponent(request.user_code)}/${action}`);
    } catch (error) {
      status.textContent = error.message;
      approve.disabled = false;
      decline.disabled = false;
      return;
    }
    if (action === "approve") {
      show(
        el("h1", {}, "Linked"),
        el("p", {}, `Go back to Frigate. ${request.name} finishes setting up on its own within a few seconds.`),
        dashboardLink,
      );
    } else {
      show(el("h1", {}, "Declined"), el("p", {}, "Nothing was linked."));
    }
  };
  approve.addEventListener("click", () => decide("approve"));
  decline.addEventListener("click", () => decide("deny"));

  show(
    el("h1", {}, `Link ${request.name}?`),
    el(
      "div",
      { class: "card" },
      el("p", {}, "Check that Frigate shows this code:"),
      el("div", { class: "code" }, request.user_code),
      el(
        "p",
        { class: "muted" },
        "Linking gives this Frigate server a private web address that works from anywhere. " +
          "Anyone who opens it still has to sign in to Frigate.",
      ),
      status,
      el("div", { class: "actions" }, approve, decline),
    ),
  );
}

async function start() {
  const info = await getInfo();
  for (const node of document.querySelectorAll("[data-service-name]")) {
    node.textContent = info.service_name;
  }
  document.title = page === "link" ? `Link a Frigate server · ${info.service_name}` : info.service_name;

  const clerk = await loadClerk(info);
  const render = page === "link" ? showLink : showDashboard;
  let userId = clerk.user?.id ?? null;
  clerk.addListener(({ user }) => {
    if ((user?.id ?? null) !== userId) {
      userId = user?.id ?? null;
      void refresh();
    }
  });

  const userButton = document.getElementById("user-button");
  let userButtonMounted = false;
  async function refresh() {
    if (clerk.user && !userButtonMounted) {
      clerk.mountUserButton(userButton);
      userButtonMounted = true;
    } else if (!clerk.user && userButtonMounted) {
      clerk.unmountUserButton(userButton);
      userButtonMounted = false;
    }
    try {
      await render(clerk);
    } catch (error) {
      showError(error);
    }
  }
  await refresh();
}

start().catch(showError);
