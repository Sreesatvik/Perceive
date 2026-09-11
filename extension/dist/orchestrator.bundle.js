(() => {
  // src/content/actionExecutor.js
  async function executeAction(action, resolveToken) {
    console.log(`[ActionExecutor] Executing action: ${action.type}`);
    if (action.type === "task_complete" || action.type === "task_failed") {
      return { success: true, domChanged: false };
    }
    if (action.type === "wait") {
      const delay2 = parseInt(action.value, 10) || 1e3;
      await new Promise((r) => setTimeout(r, delay2));
      return { success: true, domChanged: false };
    }
    let targetElement = null;
    if (action.target_element_id) {
      targetElement = document.querySelector(`[data-ext-id="${action.target_element_id}"]`);
      if (!targetElement) {
        targetElement = document.getElementById(action.target_element_id);
      }
    }
    if (!targetElement && ["click", "type", "scroll"].includes(action.type)) {
      return { success: false, error: "target_element_not_found" };
    }
    if (targetElement) {
      const rect = targetElement.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(targetElement).visibility !== "hidden";
      if (!isVisible || targetElement.disabled) {
        return { success: false, error: "element_not_interactable" };
      }
    }
    try {
      switch (action.type) {
        case "click":
          console.log("[ActionExecutor] Clicking element:", targetElement, "tag:", targetElement.tagName, "type:", targetElement.type, "id:", targetElement.id);
          targetElement.click();
          return { success: true, domChanged: true };
        case "type":
          let valueToType = action.value || "";
          if (valueToType.startsWith("[") && valueToType.endsWith("]")) {
            const resolved = resolveToken(valueToType);
            if (!resolved) {
              console.warn("[ActionExecutor] Failed to resolve token:", valueToType, "| target:", action.target_element_id);
              return { success: false, error: "unresolvable_token" };
            }
            valueToType = resolved;
          }
          targetElement.value = valueToType;
          targetElement.dispatchEvent(new Event("input", { bubbles: true }));
          targetElement.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, domChanged: true };
        case "scroll":
          targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
          return { success: true, domChanged: false };
        case "ask_user_confirmation":
          return { success: true, domChanged: false };
        default:
          return { success: false, error: "unknown_action_type" };
      }
    } catch (error) {
      console.error(`[ActionExecutor] Error executing ${action.type}:`, error);
      return { success: false, error: error.message };
    }
  }

  // src/shared/constants.js
  var RISK_TIERS = {
    SAFE: "safe",
    RISKY: "risky"
  };
  var RETRY_CONFIG = {
    MAX_STEPS: 20,
    MAX_RETRIES_PER_STEP: 3,
    STEP_TIMEOUT_MS: 2e4,
    POST_ACTION_DELAY_MS: 800
  };

  // src/content/confirmationUI.js
  var confirmationOverlay = null;
  function createOverlay() {
    if (confirmationOverlay) return confirmationOverlay;
    confirmationOverlay = document.createElement("div");
    Object.assign(confirmationOverlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.5)",
      zIndex: "999999",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      fontFamily: "sans-serif"
    });
    const dialog = document.createElement("div");
    Object.assign(dialog.style, {
      backgroundColor: "white",
      padding: "20px",
      borderRadius: "8px",
      boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
      maxWidth: "400px",
      textAlign: "center"
    });
    const title = document.createElement("h3");
    title.textContent = "\u{1F6E1}\uFE0F Agent wants to execute action";
    title.style.marginTop = "0";
    const targetInfo = document.createElement("p");
    targetInfo.id = "confirmation-target";
    const reasoningInfo = document.createElement("p");
    reasoningInfo.id = "confirmation-reasoning";
    reasoningInfo.style.fontStyle = "italic";
    reasoningInfo.style.color = "#555";
    const buttonContainer = document.createElement("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "space-around";
    buttonContainer.style.marginTop = "20px";
    const allowBtn = document.createElement("button");
    allowBtn.textContent = "Allow";
    allowBtn.id = "confirmation-allow";
    Object.assign(allowBtn.style, {
      padding: "10px 20px",
      backgroundColor: "#28a745",
      color: "white",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer"
    });
    const denyBtn = document.createElement("button");
    denyBtn.textContent = "Deny";
    denyBtn.id = "confirmation-deny";
    Object.assign(denyBtn.style, {
      padding: "10px 20px",
      backgroundColor: "#dc3545",
      color: "white",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer"
    });
    buttonContainer.appendChild(allowBtn);
    buttonContainer.appendChild(denyBtn);
    dialog.appendChild(title);
    dialog.appendChild(targetInfo);
    dialog.appendChild(reasoningInfo);
    dialog.appendChild(buttonContainer);
    confirmationOverlay.appendChild(dialog);
    document.body.appendChild(confirmationOverlay);
    return confirmationOverlay;
  }
  async function requestConfirmation(action) {
    const overlay = createOverlay();
    const targetEl = document.getElementById("confirmation-target");
    const reasoningEl = document.getElementById("confirmation-reasoning");
    targetEl.textContent = `Action: ${action.type}${action.target_element_id ? ` on target '${action.target_element_id}'` : ""}`;
    reasoningEl.textContent = action.reasoning_short || "No reasoning provided.";
    overlay.style.display = "flex";
    return new Promise((resolve) => {
      let timeoutId;
      const cleanup = (result) => {
        clearTimeout(timeoutId);
        overlay.style.display = "none";
        document.getElementById("confirmation-allow").onclick = null;
        document.getElementById("confirmation-deny").onclick = null;
        resolve(result);
      };
      document.getElementById("confirmation-allow").onclick = () => cleanup(true);
      document.getElementById("confirmation-deny").onclick = () => cleanup(false);
      timeoutId = setTimeout(() => {
        console.warn("[ConfirmationUI] Timed out waiting for user confirmation.");
        cleanup(false);
      }, 3e4);
    });
  }
  function requiresConfirmation(action) {
    if (action.risk_tier === RISK_TIERS.RISKY) return true;
    if (action.type === "click" && action.target_element_id) {
      let el = document.querySelector(`[data-element-id="${action.target_element_id}"]`);
      if (!el) el = document.getElementById(action.target_element_id);
      if (el) {
        if (el.type === "submit" || el.textContent && el.textContent.match(/pay|submit|delete|confirm/i)) {
          return true;
        }
      }
    }
    return false;
  }

  // src/shared/schemas.js
  function validateActionResponse(response) {
    if (!response || typeof response !== "object") {
      throw new Error("Invalid response: Not an object");
    }
    if (!response.session_id) {
      throw new Error("Invalid response: Missing session_id");
    }
    if (typeof response.step_number !== "number") {
      throw new Error("Invalid response: Invalid step_number");
    }
    const action = response.action;
    if (!action || typeof action !== "object") {
      throw new Error("Invalid response: Missing action object");
    }
    const validTypes = ["click", "type", "scroll", "wait", "ask_user_confirmation", "task_complete", "task_failed"];
    if (!validTypes.includes(action.type)) {
      throw new Error(`Invalid response: Unknown action type '${action.type}'`);
    }
    if (!["safe", "risky"].includes(action.risk_tier)) {
      throw new Error(`Invalid response: Unknown risk_tier '${action.risk_tier}'`);
    }
    return true;
  }

  // dev2/leakage-auditor.js
  var SEMANTIC_TOKEN_PATTERN = /^\[[A-Z0-9_]+(?:\?|: [^\]]+)?\]$/;
  var SENSITIVE_KEY_PATTERN = /password|pwd|secret|credit_card|cvv|ssn|aadhaar|otp/i;
  function walkStrings(node, path, callback, seen) {
    if (node === null || node === void 0) return;
    if (seen.has(node)) return;
    if (typeof node === "string") {
      callback(node, path);
      return;
    }
    if (typeof node !== "object") return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walkStrings(node[i], path + "[" + i + "]", callback, seen);
      }
      return;
    }
    const keys = Object.keys(node);
    for (const key of keys) {
      const childPath = path ? path + "." + key : key;
      walkStrings(node[key], childPath, callback, seen);
    }
  }
  function auditPayload(payload, piiDetectFn) {
    const violations = [];
    if (!payload || typeof payload !== "object") {
      return { passed: true, violations };
    }
    if (typeof piiDetectFn !== "function") {
      return { passed: true, violations };
    }
    const seen = /* @__PURE__ */ new Set();
    walkStrings(payload, "", function onString(value, path) {
      if (path === "redacted_image_base64") {
        if (typeof value === "string" && value.length < 100) {
          violations.push({
            path,
            reason: "redacted_image_base64 is suspiciously short or malformed",
            matched_type: "IMAGE_DATA_WARNING"
          });
        }
        return;
      }
      if (SEMANTIC_TOKEN_PATTERN.test(value)) {
        return;
      }
      const matches = piiDetectFn(value);
      if (Array.isArray(matches) && matches.length > 0) {
        for (const match of matches) {
          violations.push({
            path,
            reason: "raw PII value found outside semantic token",
            matched_type: match.type || "UNKNOWN"
          });
        }
      }
      if (SENSITIVE_KEY_PATTERN.test(path) && value && !SEMANTIC_TOKEN_PATTERN.test(value)) {
        violations.push({
          path,
          reason: "unredacted password or secret string found in sensitive field",
          matched_type: "PASSWORD"
        });
      }
    }, seen);
    return {
      passed: violations.length === 0,
      violations
    };
  }
  function assertSafeToSend(payload, piiDetectFn) {
    const result = auditPayload(payload, piiDetectFn);
    if (!result.passed) {
      const details = result.violations.map(function(v) {
        return "  - [" + v.matched_type + '] at "' + v.path + '": ' + v.reason;
      }).join("\n");
      throw new Error(
        "Payload safety audit failed with " + result.violations.length + " violation(s). Blocking network request.\n" + details
      );
    }
  }

  // dev2/channel-consistency-check.js
  function checkChannelConsistency(payload, redactedRegions) {
    const mismatches = [];
    const elements = payload && payload.dom_summary && Array.isArray(payload.dom_summary.elements) ? payload.dom_summary.elements : [];
    const regions = Array.isArray(redactedRegions) ? redactedRegions : [];
    const shouldBeRedacted = /* @__PURE__ */ new Set();
    for (const el of elements) {
      if (el && el.is_sensitive === true) {
        if (el.element_id) {
          shouldBeRedacted.add(el.element_id);
        }
      }
    }
    const actuallyRedacted = /* @__PURE__ */ new Set();
    for (const region of regions) {
      if (region && region.element_id) {
        actuallyRedacted.add(region.element_id);
      }
    }
    for (const id of shouldBeRedacted) {
      if (!actuallyRedacted.has(id)) {
        mismatches.push({
          element_id: id,
          issue: "structural redaction claimed but visual redaction missing"
        });
      }
    }
    for (const id of actuallyRedacted) {
      if (!shouldBeRedacted.has(id)) {
        mismatches.push({
          element_id: id,
          issue: "visual redaction present but structural summary shows no sensitivity \u2014 possible over-redaction or stale data"
        });
      }
    }
    return {
      consistent: mismatches.length === 0,
      mismatches
    };
  }
  function assertChannelsConsistent(payload, redactedRegions) {
    const result = checkChannelConsistency(payload, redactedRegions);
    if (!result.consistent) {
      const details = result.mismatches.map((m) => `  - [${m.element_id}]: ${m.issue}`).join("\n");
      throw new Error(
        `Channel consistency check failed with ${result.mismatches.length} mismatch(es):
${details}`
      );
    }
  }

  // dev2/pii-patterns.js
  function detectPII(text) {
    if (typeof text !== "string" || !text) {
      return [];
    }
    const results = [];
    const patterns = [
      { type: "EMAIL", regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
      { type: "PHONE", regex: /(?<!\d)[6-9]\d{9}(?!\d)/g },
      { type: "CARD_NUMBER", regex: /(?<!\d[ -]?)(?:\d[ -]?){15}\d(?![ -]?\d)/g },
      { type: "AADHAAR", regex: /(?<!\d[ -]?)(?:\d[ -]?){11}\d(?![ -]?\d)/g },
      { type: "IFSC", regex: /\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b/g }
    ];
    for (const { type, regex } of patterns) {
      let match2;
      regex.lastIndex = 0;
      while ((match2 = regex.exec(text)) !== null) {
        results.push({
          type,
          match: match2[0],
          startIndex: match2.index,
          endIndex: match2.index + match2[0].length
        });
      }
    }
    const otpRegex = /(?<!\d[ -]?)\d{4,6}(?![ -]?\d)/g;
    const otpContextRegex = /\b(otp|code|verification)\b/i;
    let match;
    while ((match = otpRegex.exec(text)) !== null) {
      const startIndex = match.index;
      const endIndex = startIndex + match[0].length;
      const contextStart = Math.max(0, startIndex - 30);
      const contextEnd = Math.min(text.length, endIndex + 30);
      const context = text.substring(contextStart, contextEnd);
      if (otpContextRegex.test(context)) {
        results.push({
          type: "OTP",
          match: match[0],
          startIndex,
          endIndex
        });
      }
    }
    return results;
  }

  // src/background/transport.js
  console.log("transport.js loaded");
  var BACKEND_URL = "http://localhost:8000";
  var ANALYZE_ENDPOINT = "/analyze";
  var TIMEOUT_MS = 3e4;
  var PayloadLeakageError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "PayloadLeakageError";
    }
  };
  var TransportError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "TransportError";
    }
  };
  async function sendToBackend(payload) {
    try {
      assertSafeToSend(payload, detectPII);
      if (payload.redacted_regions) {
        assertChannelsConsistent(payload, payload.redacted_regions);
      }
    } catch (err) {
      throw new PayloadLeakageError(err.message);
    }
    const jsonString = JSON.stringify(payload);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${BACKEND_URL}${ANALYZE_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: jsonString,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        let errorDetail = "";
        try {
          const errorBody = await response.json();
          errorDetail = JSON.stringify(errorBody);
        } catch (e) {
          errorDetail = await response.text().catch(() => "(could not read error body)");
        }
        console.error("[Transport] Backend rejected request:", response.status, errorDetail);
        throw new TransportError(`Server returned ${response.status}: ${errorDetail}`);
      }
      const actionResponse = await response.json();
      validateActionResponse(actionResponse);
      return actionResponse;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        throw new TransportError("Request timed out");
      }
      throw err;
    }
  }
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "SEND_PAYLOAD") {
        sendToBackend(message.payload).then((action) => {
          sendResponse({ success: true, action });
        }).catch((error) => {
          sendResponse({ success: false, error: error.message, errorType: error.name });
        });
        return true;
      }
    });
  }

  // dev2/token-vault.js
  function createTokenVault() {
    const forwardMap = /* @__PURE__ */ new Map();
    const reverseMap = /* @__PURE__ */ new Map();
    const typeCounters = /* @__PURE__ */ new Map();
    return {
      /**
       * Gets existing token for rawValue or creates a new indexed token [TYPE_N].
       * @param {string} rawValue
       * @param {string} sensitivityType
       * @returns {string}
       */
      getOrCreateToken(rawValue, sensitivityType) {
        if (typeof rawValue !== "string" || !rawValue) {
          return "";
        }
        const typeKey = (sensitivityType || "UNKNOWN").toUpperCase();
        if (forwardMap.has(rawValue)) {
          return forwardMap.get(rawValue);
        }
        const currentCount = (typeCounters.get(typeKey) || 0) + 1;
        typeCounters.set(typeKey, currentCount);
        const token = `[${typeKey}_${currentCount}]`;
        forwardMap.set(rawValue, token);
        reverseMap.set(token, rawValue);
        return token;
      },
      /**
       * Resolves token back to raw value.
       * @param {string} token
       * @returns {string | null}
       */
      resolveToken(token) {
        if (typeof token !== "string" || !token) {
          return null;
        }
        return reverseMap.get(token) || null;
      },
      /**
       * Checks if token exists in the vault.
       * @param {string} token
       * @returns {boolean}
       */
      hasToken(token) {
        if (typeof token !== "string" || !token) {
          return false;
        }
        return reverseMap.has(token);
      },
      /**
       * Clears all mapped tokens and resets state for session teardown.
       */
      clear() {
        forwardMap.clear();
        reverseMap.clear();
        typeCounters.clear();
      },
      /**
       * Returns count statistics without exposing raw values or tokens.
       * @returns {{ totalTokens: number, byType: Record<string, number> }}
       */
      getStats() {
        const byType = {};
        for (const [token] of reverseMap.entries()) {
          const match = token.match(/^\[([A-Z_]+)_\d+\]$/);
          const type = match ? match[1] : "UNKNOWN";
          byType[type] = (byType[type] || 0) + 1;
        }
        return {
          totalTokens: reverseMap.size,
          byType
        };
      }
    };
  }

  // dev2/session-vault-manager.js
  var sessionVaults = /* @__PURE__ */ new Map();
  var MAX_SESSIONS_THRESHOLD = 20;
  var DEFAULT_SESSION_TTL_MS = 30 * 60 * 1e3;
  function getVaultForSession(session_id, ttlMs = DEFAULT_SESSION_TTL_MS) {
    if (!session_id || typeof session_id !== "string") {
      throw new Error("Invalid session_id provided to getVaultForSession");
    }
    const now = Date.now();
    if (sessionVaults.has(session_id)) {
      const record = sessionVaults.get(session_id);
      if (now - record.lastAccessedAt > ttlMs) {
        endSession(session_id);
      } else {
        record.lastAccessedAt = now;
        return record.vault;
      }
    }
    if (sessionVaults.size >= MAX_SESSIONS_THRESHOLD) {
      console.warn(
        `[Privacy Warning] Active session vault count reached ${sessionVaults.size + 1} (> ${MAX_SESSIONS_THRESHOLD}). Potential session leak: ensure endSession() is called upon task completion/error.`
      );
    }
    const newVault = createTokenVault();
    sessionVaults.set(session_id, {
      vault: newVault,
      createdAt: now,
      lastAccessedAt: now
    });
    return newVault;
  }
  function endSession(session_id) {
    if (!session_id || typeof session_id !== "string") return;
    const record = sessionVaults.get(session_id);
    if (record) {
      if (record.vault && typeof record.vault.clear === "function") {
        record.vault.clear();
      }
      sessionVaults.delete(session_id);
    }
  }

  // dev2/dom-heuristics.js
  function getNearbyLabelText(el) {
    if (!el || typeof el.getAttribute !== "function") {
      return null;
    }
    if (el.labels && el.labels.length > 0) {
      for (let i = 0; i < el.labels.length; i++) {
        const text = (el.labels[i].textContent || "").trim();
        if (text) return text;
      }
    }
    if (el.id && el.ownerDocument && typeof el.ownerDocument.querySelector === "function") {
      try {
        const escapeId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id;
        const labelEl = el.ownerDocument.querySelector(`label[for="${escapeId}"]`);
        if (labelEl) {
          const text = (labelEl.textContent || "").trim();
          if (text) return text;
        }
      } catch (e) {
      }
    }
    if (typeof el.closest === "function") {
      const parentLabel = el.closest("label");
      if (parentLabel) {
        const text = (parentLabel.textContent || "").trim();
        if (text) return text;
      }
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) {
      return ariaLabel.trim();
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) {
      return placeholder.trim();
    }
    let curr = el.previousSibling;
    while (curr) {
      const text = (curr.textContent || "").trim();
      if (text) {
        return text;
      }
      curr = curr.previousSibling;
    }
    return null;
  }
  function getDefaultRole(el, tag, typeAttr) {
    if (tag === "button" || typeAttr === "submit" || typeAttr === "button") return "button";
    if (tag === "input" || tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "a") return "link";
    return "generic";
  }
  function classifyElement(el) {
    if (!el || typeof el.getAttribute !== "function") {
      return {
        tag: "",
        role: "generic",
        label_text: null,
        is_sensitive: false,
        sensitivity_type: "UNKNOWN"
      };
    }
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    const typeAttr = (el.getAttribute("type") || "").toLowerCase();
    const autocompleteAttr = (el.getAttribute("autocomplete") || "").toLowerCase();
    const placeholderAttr = (el.getAttribute("placeholder") || "").toLowerCase();
    const role = el.getAttribute("role") || getDefaultRole(el, tag, typeAttr);
    if (tag === "button" || typeAttr === "submit" || typeAttr === "button" || role === "button") {
      return {
        tag: "button",
        role: "button",
        label_text: el.innerText || el.textContent || null,
        is_sensitive: false,
        sensitivity_type: null
      };
    }
    const label_text = getNearbyLabelText(el);
    const elText = (el.innerText || el.textContent || "").trim();
    if (typeAttr === "password") {
      return {
        tag,
        role,
        label_text,
        is_sensitive: true,
        sensitivity_type: "PASSWORD"
      };
    }
    if (autocompleteAttr.includes("cc-number")) {
      return {
        tag,
        role,
        label_text,
        is_sensitive: true,
        sensitivity_type: "CARD_NUMBER"
      };
    }
    if (autocompleteAttr.includes("email") || typeAttr === "email") {
      return {
        tag,
        role,
        label_text,
        is_sensitive: true,
        sensitivity_type: "EMAIL"
      };
    }
    if (label_text && /amount|price|total/i.test(label_text) || placeholderAttr && /amount|price|total/i.test(placeholderAttr) || elText && /amount|price|total|\$\d/i.test(elText)) {
      return {
        tag,
        role,
        label_text: label_text || (elText || null),
        is_sensitive: true,
        sensitivity_type: "AMOUNT"
      };
    }
    if (autocompleteAttr.includes("tel") || typeAttr === "tel" || label_text && /phone|mobile|contact number/i.test(label_text) || placeholderAttr && /phone|mobile|contact number/i.test(placeholderAttr)) {
      return {
        tag,
        role,
        label_text,
        is_sensitive: true,
        sensitivity_type: "PHONE"
      };
    }
    if (autocompleteAttr.includes("name") || label_text && /name/i.test(label_text)) {
      return {
        tag,
        role,
        label_text,
        is_sensitive: true,
        sensitivity_type: "NAME"
      };
    }
    return {
      tag,
      role,
      label_text,
      is_sensitive: false,
      sensitivity_type: "UNKNOWN"
    };
  }
  var elementIdCounter = 0;
  function getElementId(el) {
    if (!el || typeof el.getAttribute !== "function") {
      return "";
    }
    if (el.id && el.id.trim() !== "") {
      return el.id;
    }
    if (typeof el.hasAttribute === "function" && el.hasAttribute("data-ext-id")) {
      return el.getAttribute("data-ext-id");
    }
    const generatedId = `ext-el-${Date.now()}-${++elementIdCounter}`;
    if (typeof el.setAttribute === "function") {
      el.setAttribute("data-ext-id", generatedId);
    }
    return generatedId;
  }

  // dev2/sensitivity-tiers.js
  var TIER_1_TYPES = /* @__PURE__ */ new Set(["PASSWORD", "CARD_NUMBER", "AADHAAR", "OTP"]);
  var TIER_2_TYPES = /* @__PURE__ */ new Set(["NAME", "AMOUNT", "EMAIL", "PHONE", "IFSC"]);
  function getTierNumber(type) {
    if (!type || type === "UNKNOWN") return 3;
    if (TIER_1_TYPES.has(type)) return 1;
    if (TIER_2_TYPES.has(type)) return 2;
    return 3;
  }
  function formatAmountRange(val) {
    if (isNaN(val) || val === null) return "[AMOUNT]";
    if (val < 10) return "[AMOUNT: $<10]";
    if (val >= 10 && val <= 50) return "[AMOUNT: $10-50]";
    if (val > 50 && val <= 100) return "[AMOUNT: $50-100]";
    if (val > 100 && val <= 500) return "[AMOUNT: $100-500]";
    if (val > 500 && val <= 1e3) return "[AMOUNT: $500-1000]";
    return "[AMOUNT: $1000+]";
  }
  function getAmountToken(elementClassification, piiMatches) {
    let numberStr = null;
    if (Array.isArray(piiMatches)) {
      for (const m of piiMatches) {
        if (m && m.match) {
          const numMatch = m.match.match(/\d+(?:\.\d+)?/);
          if (numMatch) {
            numberStr = numMatch[0];
            break;
          }
        }
      }
    }
    if (!numberStr && elementClassification) {
      const textToSearch = [
        elementClassification.label_text,
        elementClassification.value
      ].filter(Boolean).join(" ");
      const numMatch = textToSearch.match(/\d+(?:\.\d+)?/);
      if (numMatch) {
        numberStr = numMatch[0];
      }
    }
    if (numberStr) {
      const val = parseFloat(numberStr);
      if (!isNaN(val)) {
        return formatAmountRange(val);
      }
    }
    return "[AMOUNT]";
  }
  function classifySensitivity(elementClassification, piiMatches = [], rawValue = null, tokenVault = null) {
    const domType = elementClassification && elementClassification.sensitivity_type && elementClassification.sensitivity_type !== "UNKNOWN" ? elementClassification.sensitivity_type : null;
    const validPiiMatches = Array.isArray(piiMatches) ? piiMatches.filter((m) => m && m.type) : [];
    let chosenType = null;
    if (validPiiMatches.length > 0) {
      let bestPiiType = validPiiMatches[0].type;
      let bestPiiTier = getTierNumber(bestPiiType);
      for (let i = 1; i < validPiiMatches.length; i++) {
        const t = validPiiMatches[i].type;
        const tier2 = getTierNumber(t);
        if (tier2 < bestPiiTier) {
          bestPiiType = t;
          bestPiiTier = tier2;
        }
      }
      if (!domType) {
        chosenType = bestPiiType;
      } else if (domType === bestPiiType) {
        chosenType = domType;
      } else {
        const domTier = getTierNumber(domType);
        if (domTier < bestPiiTier) {
          chosenType = domType;
        } else if (bestPiiTier < domTier) {
          chosenType = bestPiiType;
        } else {
          chosenType = bestPiiType;
        }
        console.warn(
          `Sensitivity type mismatch: DOM heuristic detected "${domType}" (Tier ${domTier}) but PII pattern detected "${bestPiiType}" (Tier ${bestPiiTier}). Defaulting to higher sensitivity tier type: "${chosenType}".`
        );
      }
    } else if (domType) {
      chosenType = domType;
    }
    if (!chosenType || chosenType === "UNKNOWN") {
      return {
        sensitivity_tier: 3,
        sensitivity_type: "UNKNOWN",
        semantic_token: null
      };
    }
    const tier = getTierNumber(chosenType);
    let semantic_token = null;
    if (tier === 1 || tier === 2) {
      if (tokenVault && typeof tokenVault.getOrCreateToken === "function" && rawValue !== null && rawValue !== void 0 && rawValue !== "") {
        semantic_token = tokenVault.getOrCreateToken(rawValue, chosenType);
      } else if (chosenType === "AMOUNT" && rawValue) {
        semantic_token = getAmountToken(elementClassification, piiMatches);
      } else {
        semantic_token = null;
      }
    }
    return {
      sensitivity_tier: tier,
      sensitivity_type: chosenType,
      semantic_token
    };
  }

  // dev2/redaction-renderer.js
  var REDACT_TIER_2 = true;
  function redactImage(sourceCanvasOrImage, sensitiveRegions = []) {
    if (!sourceCanvasOrImage) {
      throw new Error("Source canvas or image is required.");
    }
    const width = sourceCanvasOrImage.width || sourceCanvasOrImage.naturalWidth || 0;
    const height = sourceCanvasOrImage.height || sourceCanvasOrImage.naturalHeight || 0;
    let outputCanvas;
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      outputCanvas = document.createElement("canvas");
      outputCanvas.width = width;
      outputCanvas.height = height;
    } else {
      outputCanvas = {
        width,
        height,
        getContext: () => ({
          drawImage: () => {
          },
          fillRect: () => {
          },
          clearRect: () => {
          },
          getImageData: () => ({ data: new Uint8ClampedArray(4) })
        }),
        toDataURL: () => typeof sourceCanvasOrImage.toDataURL === "function" ? sourceCanvasOrImage.toDataURL("image/png") : ""
      };
    }
    const ctx = outputCanvas.getContext("2d");
    if (ctx && typeof ctx.drawImage === "function") {
      ctx.drawImage(sourceCanvasOrImage, 0, 0, width, height);
    }
    if (Array.isArray(sensitiveRegions)) {
      for (const region of sensitiveRegions) {
        if (!region || !region.bounding_box) continue;
        const tier = region.sensitivity_tier;
        if (tier === 1 || tier === 2 && REDACT_TIER_2) {
          const { x, y, w, h } = region.bounding_box;
          let catW = 260;
          let catH = 24;
          if (w <= 80 && h <= 24) {
            catW = 80;
            catH = 24;
          } else if (w <= 160 && h <= 24) {
            catW = 160;
            catH = 24;
          } else {
            catW = 260;
            catH = 24;
          }
          const centerX = x + w / 2;
          const centerY = y + h / 2;
          const drawX = centerX - catW / 2;
          const drawY = centerY - catH / 2;
          if (ctx && typeof ctx.fillRect === "function") {
            ctx.fillStyle = "#000000";
            ctx.fillRect(drawX, drawY, catW, catH);
          }
        }
      }
    }
    return outputCanvas;
  }
  function canvasToBase64(canvas) {
    if (!canvas || typeof canvas.toDataURL !== "function") {
      return "";
    }
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl.replace(/^data:image\/png;base64,/, "");
  }

  // dev2/redaction-engine.js
  function processPageForRedaction(elements = [], sourceCanvasOrImage, tokenVault) {
    const currentUrl = typeof window !== "undefined" && window.location ? window.location.href : "";
    const summaryElements = [];
    const confidenceNotes = [];
    const sensitiveRegions = [];
    const sensitiveRawValues = [];
    const redactedRegionsList = [];
    if (Array.isArray(elements)) {
      for (const el of elements) {
        if (!el) continue;
        const element_id = getElementId(el);
        const elementClassification = classifyElement(el);
        const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 };
        const bounding_box = {
          x: Math.round(rect.x || rect.left || 0),
          y: Math.round(rect.y || rect.top || 0),
          w: Math.round(rect.width || 0),
          h: Math.round(rect.height || 0)
        };
        let rawValue = null;
        if (el.value !== void 0 && el.value !== null && String(el.value).trim() !== "") {
          rawValue = el.value;
        } else if (el.innerText && el.innerText.trim() !== "") {
          rawValue = el.innerText.trim();
        } else {
          rawValue = null;
        }
        const textToScan = rawValue || el.textContent || "";
        const piiMatches = detectPII(textToScan);
        const sensitivity = classifySensitivity(elementClassification, piiMatches, rawValue, tokenVault);
        const { sensitivity_tier, sensitivity_type, semantic_token } = sensitivity;
        const is_sensitive = sensitivity_tier !== 3;
        const has_stable_token = Boolean(
          semantic_token && tokenVault && typeof tokenVault.hasToken === "function" && tokenVault.hasToken(semantic_token)
        );
        summaryElements.push({
          element_id,
          tag: elementClassification.tag,
          role: elementClassification.role,
          label_text: elementClassification.label_text,
          is_sensitive,
          sensitivity_tier,
          sensitivity_type,
          semantic_token,
          has_stable_token,
          bounding_box
        });
        let confidence = 0.92;
        let method = "dom_heuristic";
        if (elementClassification && elementClassification.sensitivity_type !== "UNKNOWN") {
          confidence = 0.92;
          method = "dom_heuristic";
        } else if (piiMatches && piiMatches.length > 0) {
          confidence = 0.6;
          method = "ocr_regex";
        }
        confidenceNotes.push({
          element_id,
          confidence,
          method
        });
        if (sensitivity_tier === 1 || sensitivity_tier === 2) {
          sensitiveRegions.push({
            bounding_box,
            sensitivity_tier
          });
          redactedRegionsList.push({
            element_id,
            bounding_box,
            sensitivity_tier,
            semantic_token
          });
          if (rawValue && String(rawValue).trim()) {
            sensitiveRawValues.push(String(rawValue).trim());
          }
          for (const m of piiMatches) {
            if (m && m.match && m.match.trim()) {
              sensitiveRawValues.push(m.match.trim());
            }
          }
        }
      }
    }
    const redactedCanvas = redactImage(sourceCanvasOrImage, sensitiveRegions);
    const redacted_image_base64 = canvasToBase64(redactedCanvas);
    const output = {
      dom_summary: {
        url: currentUrl,
        elements: summaryElements
      },
      redacted_image_base64,
      detection_confidence_notes: confidenceNotes,
      redacted_regions: redactedRegionsList
    };
    function walkAndAssert(node, path) {
      if (node === null || node === void 0) return;
      if (path === "redacted_image_base64") return;
      if (typeof node === "string") {
        for (const rawVal of sensitiveRawValues) {
          if (!rawVal || rawVal.length < 3) continue;
          if (node.includes(rawVal) && !node.startsWith("[")) {
            throw new Error(`Privacy Assertion Violated: Raw sensitive value "${rawVal}" found in output object at "${path}"`);
          }
        }
        return;
      }
      if (typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          walkAndAssert(node[i], `${path}[${i}]`);
        }
        return;
      }
      for (const key of Object.keys(node)) {
        const childPath = path ? `${path}.${key}` : key;
        walkAndAssert(node[key], childPath);
      }
    }
    walkAndAssert(output, "");
    return output;
  }

  // src/content/orchestrator.js
  var mockDev1 = {
    captureCurrentState: async () => ({ dom: {}, screenshot: "mock_screenshot_data" })
  };
  function tokenizeCredentialsInInstruction(taskInstruction, vault) {
    let sanitizedInstruction = taskInstruction;
    sanitizedInstruction = sanitizedInstruction.replace(
      /username\s+['"]([^'"]+)['"]/i,
      (match, value) => {
        const token = vault.getOrCreateToken(value, "NAME");
        return `username ${token}`;
      }
    );
    sanitizedInstruction = sanitizedInstruction.replace(
      /password\s+['"]([^'"]+)['"]/i,
      (match, value) => {
        const token = vault.getOrCreateToken(value, "PASSWORD");
        return `password ${token}`;
      }
    );
    return sanitizedInstruction;
  }
  async function buildSanitizedPayload(snapshot, sessionId, taskInstruction, stepNumber) {
    const vault = getVaultForSession(sessionId);
    const sanitizedInstruction = tokenizeCredentialsInInstruction(taskInstruction, vault);
    const result = await processPageForRedaction(snapshot.elements, snapshot.canvas, vault);
    return {
      session_id: sessionId,
      task_instruction: sanitizedInstruction,
      step_number: stepNumber,
      ...result
    };
  }
  var BACKEND_URL2 = "http://localhost:8000";
  var delay = (ms) => new Promise((res) => setTimeout(res, ms));
  async function finalizeTask(sessionId, reason) {
    console.log(`[Orchestrator] Finalizing task ${sessionId}. Reason: ${reason}`);
    endSession(sessionId);
    try {
      fetch(`${BACKEND_URL2}/session/${sessionId}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason })
      }).catch(() => {
      });
    } catch (e) {
    }
    window.dispatchEvent(new CustomEvent("agent-session-end", {
      detail: { sessionId, reason }
    }));
  }
  async function runTaskLoop(taskInstruction, captureOverride = null) {
    const sessionId = crypto.randomUUID();
    let stepNumber = 0;
    if (window.__activeVaults === void 0) window.__activeVaults = 0;
    window.__activeVaults++;
    const vault = getVaultForSession(sessionId);
    const resolveToken = vault.resolveToken.bind(vault);
    try {
      while (stepNumber < RETRY_CONFIG.MAX_STEPS) {
        stepNumber++;
        let retriesLeft = RETRY_CONFIG.MAX_RETRIES_PER_STEP;
        let stepSuccess = false;
        while (retriesLeft > 0 && !stepSuccess) {
          try {
            const snapshot = captureOverride ? await captureOverride() : await mockDev1.captureCurrentState();
            const payload = await buildSanitizedPayload(snapshot, sessionId, taskInstruction, stepNumber);
            let actionResponse = null;
            if (window.__mockBackendResponse) {
              actionResponse = window.__mockBackendResponse(stepNumber, payload);
            } else {
              actionResponse = await sendToBackend(payload);
            }
            if (actionResponse.action.type === "task_complete") {
              await finalizeTask(sessionId, "completed");
              return { success: true, steps: stepNumber };
            }
            if (actionResponse.action.type === "task_failed") {
              await finalizeTask(sessionId, "failed_by_server");
              return { success: false, reason: actionResponse.action.reasoning_short, steps: stepNumber };
            }
            if (requiresConfirmation(actionResponse.action)) {
              const approved = await requestConfirmation(actionResponse.action);
              if (!approved) {
                await finalizeTask(sessionId, "denied_by_user");
                return { success: false, reason: "User denied risky action", steps: stepNumber };
              }
            }
            let result;
            if (window.__forceExecuteFailure) {
              result = { success: false, error: "forced_failure" };
            } else {
              result = await executeAction(actionResponse.action, resolveToken);
            }
            if (result.success) {
              stepSuccess = true;
              await delay(RETRY_CONFIG.POST_ACTION_DELAY_MS);
            } else {
              console.warn(`[Orchestrator] Step ${stepNumber} execution failed:`, result.error);
              retriesLeft--;
            }
          } catch (err) {
            console.error(`[Orchestrator] Error during step ${stepNumber}:`, err);
            retriesLeft--;
            if (retriesLeft === 0) {
              await finalizeTask(sessionId, "max_retries_exceeded");
              return { success: false, reason: `Step ${stepNumber} failed after max retries: ${err.message}` };
            }
          }
        }
        if (!stepSuccess) {
          await finalizeTask(sessionId, "max_retries_exceeded");
          return { success: false, reason: "Max retries exceeded" };
        }
      }
      await finalizeTask(sessionId, "max_steps_exceeded");
      return { success: false, reason: "Max steps exceeded" };
    } catch (fatalError) {
      console.error("[Orchestrator] Fatal error:", fatalError);
      await finalizeTask(sessionId, "fatal_error");
      throw fatalError;
    }
  }
  window.__runTaskLoop = runTaskLoop;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "RUN_TASK") {
      const capture = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        return {
          elements: Array.from(document.querySelectorAll("input, button, select, textarea")),
          canvas
        };
      };
      runTaskLoop(message.taskInstruction, capture);
      sendResponse({ started: true });
      return true;
    }
  });
})();
