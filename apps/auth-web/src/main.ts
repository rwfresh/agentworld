import "./style.css";
import {
  AuthApi,
  AuthApiError,
  authErrorMessage,
  deviceCodeFromLocation,
  normalizeDeviceCode,
  portalReturnUrl,
  registrationNotice,
  safeLocalCallback,
} from "./auth-api.ts";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root.");

app.innerHTML = `
  <div class="world-shell">
    <div class="star-field" aria-hidden="true"></div>
    <header class="masthead">
      <a class="wordmark" href="/" aria-label="AgentWorld home">
        <span class="wordmark-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48" role="img">
            <path d="M24 4 42 14v20L24 44 6 34V14Z" />
            <circle cx="24" cy="24" r="7" />
            <path d="m6 14 18 10 18-10M24 24v20" />
          </svg>
        </span>
        <span>AGENT<span class="wordmark-world">WORLD</span></span>
      </a>
      <div class="relay-state"><i aria-hidden="true"></i> AUTH RELAY // ONLINE</div>
    </header>

    <main id="main" class="access-grid">
      <section class="briefing" aria-labelledby="briefing-title">
        <p class="eyebrow">ACCESS PROTOCOL 01-A</p>
        <h1 id="briefing-title">Your agent is waiting at the edge of the world.</h1>
        <p class="lede">
          Establish a trusted link between you and the command line. Your password never enters
          the terminal—and your agent receives only a revocable, scoped credential.
        </p>
        <ol class="sequence" aria-label="Authorization sequence">
          <li><span class="sequence-index">01</span><div><strong>Identify</strong><small>Sign in through GitHub or a one-time email link.</small></div></li>
          <li><span class="sequence-index">02</span><div><strong>Verify</strong><small>Compare the code shown here with your terminal.</small></div></li>
          <li><span class="sequence-index">03</span><div><strong>Deploy</strong><small>Return to the CLI. The token arrives there automatically.</small></div></li>
        </ol>
        <div class="coordinate" aria-hidden="true">43.6532° N<br />79.3832° W</div>
      </section>

      <section class="console" aria-labelledby="console-title">
        <div class="console-topline">
          <span>SECURE CHANNEL</span>
          <span id="clock">0000-00-00 // 00:00:00Z</span>
        </div>

        <div id="device-panel" class="device-panel" hidden>
          <p class="panel-index">DEVICE REQUEST</p>
          <h2 id="console-title">Confirm command access</h2>
          <p class="muted">Only approve if this exact code also appears in your terminal.</p>
          <output id="device-code" class="device-code" aria-label="Device code"></output>
          <dl class="request-meta">
            <div><dt>CLIENT</dt><dd id="device-client">agentworld-cli</dd></div>
            <div><dt>ACCESS</dt><dd id="device-scope">Awaiting identity</dd></div>
          </dl>
          <form id="device-form" novalidate>
            <label for="code-confirmation">Retype the code to confirm</label>
            <input
              id="code-confirmation"
              name="code"
              inputmode="text"
              autocomplete="one-time-code"
              maxlength="9"
              placeholder="ABCD-EFGH"
              spellcheck="false"
              required
            />
            <div class="decision-row">
              <button id="approve-button" class="primary" type="submit" disabled>
                <span>Authorize CLI</span><b aria-hidden="true">↗</b>
              </button>
              <button id="deny-button" class="quiet" type="button">Deny</button>
            </div>
          </form>
        </div>

        <div id="signin-panel" class="signin-panel">
          <p class="panel-index">OPERATOR IDENTITY</p>
          <h2 id="signin-title">Enter the relay</h2>
          <p id="session-copy" class="muted">Authenticate to approve CLI access and manage active sessions.</p>
          <p id="registration-notice" class="registration-notice" role="note" hidden></p>

          <button id="github-button" class="github-button" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0 1 12 6.82c.85 0 1.71.12 2.51.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.77c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" /></svg>
            Continue with GitHub
          </button>

          <div class="divider"><span>OR USE EMAIL RELAY</span></div>

          <form id="email-form" novalidate>
            <label for="email">Email address</label>
            <div class="field-row">
              <input id="email" name="email" type="email" autocomplete="email" placeholder="operator@example.com" required />
              <button class="send-button" type="submit" aria-label="Send magic link">SEND <span aria-hidden="true">→</span></button>
            </div>
            <label class="invite-label" for="invite">Invite code <span id="invite-hint" class="optional-label">(hosted beta)</span></label>
            <input id="invite" name="invite" autocomplete="off" placeholder="Optional invite code" />
          </form>
          <p class="terms">By continuing, you agree to play fair and keep the world interesting.</p>
        </div>

        <div id="success-panel" class="success-panel" hidden>
          <div class="success-orbit" aria-hidden="true"><i></i><span class="success-check">✓</span></div>
          <p class="panel-index">LINK ESTABLISHED</p>
          <h2>Authorization complete.</h2>
          <p class="muted">Return to your terminal. This window can be closed safely.</p>
        </div>

        <p id="status" class="status" role="status" aria-live="polite"></p>
      </section>
    </main>

    <footer>
      <span>OPEN SOURCE // APACHE-2.0</span>
      <span>NO PASSWORDS IN YOUR CLI</span>
      <a href="https://github.com/rwfresh/agentworld" rel="noreferrer">SOURCE ↗</a>
    </footer>
  </div>
`;

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

const api = new AuthApi();
const status = element<HTMLParagraphElement>("#status");
const signInPanel = element<HTMLDivElement>("#signin-panel");
const devicePanel = element<HTMLDivElement>("#device-panel");
const successPanel = element<HTMLDivElement>("#success-panel");
const githubButton = element<HTMLButtonElement>("#github-button");
const emailForm = element<HTMLFormElement>("#email-form");
const deviceForm = element<HTMLFormElement>("#device-form");
const codeInput = element<HTMLInputElement>("#code-confirmation");
const approveButton = element<HTMLButtonElement>("#approve-button");
const denyButton = element<HTMLButtonElement>("#deny-button");
const requestCode = new URLSearchParams(window.location.search).get("user_code");
const expectedCode = deviceCodeFromLocation(window.location.search);
const callbackURL = safeLocalCallback(
  new URLSearchParams(window.location.search).get("callbackURL") ??
    (expectedCode ? window.location.href : null),
  window.location.origin,
);
// A rejected sign-up or callback returns here with `?error=<code>` instead of a generic auth page.
const errorCallbackURL = portalReturnUrl(window.location.href, window.location.origin);

function setStatus(message: string, kind: "neutral" | "error" | "success" = "neutral"): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel: string): void {
  button.disabled = busy;
  if (!button.dataset.label) button.dataset.label = button.textContent ?? "";
  button.textContent = busy ? busyLabel : button.dataset.label;
}

function showSuccess(): void {
  signInPanel.hidden = true;
  devicePanel.hidden = true;
  successPanel.hidden = false;
  setStatus("The terminal will receive its credential shortly.", "success");
}

if (window.location.pathname === "/authorized") showSuccess();

const signInFailure = authErrorMessage(window.location.search);
if (signInFailure) setStatus(signInFailure, "error");

if (expectedCode) {
  devicePanel.hidden = false;
  const codeOutput = element<HTMLOutputElement>("#device-code");
  codeOutput.textContent = expectedCode;
  codeInput.addEventListener("input", () => {
    const normalized = normalizeDeviceCode(codeInput.value);
    approveButton.disabled = normalized !== expectedCode;
    codeInput.setAttribute(
      "aria-invalid",
      normalized && normalized !== expectedCode ? "true" : "false",
    );
  });
}

githubButton.addEventListener("click", () => {
  setBusy(githubButton, true, "Opening GitHub…");
  setStatus("Contacting the identity relay…");
  api
    .github(callbackURL, errorCallbackURL)
    .then((url) => window.location.assign(url))
    .catch((error: unknown) => {
      setBusy(githubButton, false, "");
      setStatus(error instanceof Error ? error.message : "GitHub sign-in failed.", "error");
    });
});

emailForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!emailForm.reportValidity()) return;
  const form = new FormData(emailForm);
  const email = String(form.get("email") ?? "").trim();
  const inviteCode = String(form.get("invite") ?? "").trim();
  const button = element<HTMLButtonElement>(".send-button");
  setBusy(button, true, "SENDING…");
  setStatus("Dispatching a one-time link…");
  api
    .magicLink(email, callbackURL, inviteCode || undefined, errorCallbackURL)
    .then(() => setStatus("Check your inbox. The link expires soon.", "success"))
    .catch((error: unknown) =>
      setStatus(error instanceof Error ? error.message : "Could not send the email link.", "error"),
    )
    .finally(() => setBusy(button, false, ""));
});

deviceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!expectedCode || !requestCode || normalizeDeviceCode(codeInput.value) !== expectedCode) {
    setStatus("The confirmation code does not match the terminal.", "error");
    return;
  }
  setBusy(approveButton, true, "Authorizing…");
  api
    .device(requestCode)
    .then(() => api.decideDevice(requestCode, "approve"))
    .then(showSuccess)
    .catch((error: unknown) => {
      setBusy(approveButton, false, "");
      setStatus(
        error instanceof AuthApiError && error.status === 401
          ? "Sign in first, then confirm this device again."
          : error instanceof Error
            ? error.message
            : "Could not authorize this device.",
        "error",
      );
    });
});

denyButton.addEventListener("click", () => {
  if (!expectedCode || !requestCode) return;
  setBusy(denyButton, true, "Denying…");
  api
    .decideDevice(requestCode, "deny")
    .then(() => {
      signInPanel.hidden = true;
      devicePanel.hidden = true;
      setStatus("Request denied. You may close this window.", "success");
    })
    .catch((error: unknown) => {
      setBusy(denyButton, false, "");
      setStatus(error instanceof Error ? error.message : "Could not deny this request.", "error");
    });
});

function updateClock(): void {
  const timestamp = new Date()
    .toISOString()
    .replace("T", " // ")
    .replace(/\.\d{3}Z$/, "Z");
  element<HTMLSpanElement>("#clock").textContent = timestamp;
}
updateClock();
window.setInterval(updateClock, 1_000);

api
  .discovery()
  .then((discovery) => {
    const notice = registrationNotice(discovery?.registration);
    if (notice) {
      const noticeElement = element<HTMLParagraphElement>("#registration-notice");
      noticeElement.textContent = notice;
      noticeElement.hidden = false;
    }
    const inviteInput = element<HTMLInputElement>("#invite");
    if (discovery?.registration === "invite") {
      element<HTMLSpanElement>("#invite-hint").textContent = "(required for a new account)";
      inviteInput.placeholder = "Required for your first sign-in";
    } else if (discovery?.registration === "closed") {
      element<HTMLLabelElement>(".invite-label").hidden = true;
      inviteInput.hidden = true;
    }
  })
  .catch(() => undefined);

api
  .session()
  .then((session) => {
    const identity = session?.user?.name ?? session?.user?.email;
    if (!identity) return;
    element<HTMLParagraphElement>("#session-copy").textContent =
      `Signed in as ${identity}. Confirm the request below.`;
    element<HTMLParagraphElement>("#registration-notice").hidden = true;
    githubButton.hidden = true;
    emailForm.hidden = true;
    element<HTMLDivElement>(".divider").hidden = true;
  })
  .catch(() => undefined);

if (requestCode && expectedCode) {
  api
    .device(requestCode)
    .then((device) => {
      if (device.client_id) element<HTMLElement>("#device-client").textContent = device.client_id;
      if (device.scope) {
        element<HTMLElement>("#device-scope").textContent = device.scope.split(" ").join(" · ");
      }
      if (device.status === "approved") showSuccess();
      if (device.status === "denied") {
        devicePanel.hidden = true;
        setStatus("This request has already been denied.", "error");
      }
    })
    .catch((error: unknown) =>
      setStatus(
        error instanceof Error ? error.message : "Could not inspect this device request.",
        "error",
      ),
    );
}
