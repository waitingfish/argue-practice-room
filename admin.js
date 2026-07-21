const loginPanel = document.querySelector("#loginPanel");
const settingsPanel = document.querySelector("#settingsPanel");
const loginForm = document.querySelector("#loginForm");
const settingsForm = document.querySelector("#settingsForm");
const accessCodeInput = document.querySelector("#adminPassword");
const saveStatus = document.querySelector("#saveStatus");
const connectionBadge = document.querySelector("#connectionBadge");
const testChatConnectionButton = document.querySelector("#testChatConnection");
const testImageConnectionButton = document.querySelector("#testImageConnection");
let accessCode = "";

const fields = ["baseUrl", "model", "temperature", "systemPrompt", "imageBaseUrl", "imageModel", "imageTimeoutSeconds"];

function authHeaders() {
  return { "Content-Type": "application/json", "x-admin-password": accessCode };
}

function setStatus(message, tone = "") {
  saveStatus.textContent = message;
  saveStatus.dataset.tone = tone;
}

function formPayload() {
  return Object.fromEntries(new FormData(settingsForm));
}

async function loadConfig() {
  const response = await fetch("/api/admin/config", { headers: authHeaders() });
  if (!response.ok) throw new Error("访问码不正确");
  const config = await response.json();
  fields.forEach((field) => {
    document.querySelector(`#${field}`).value = config[field] ?? "";
  });
  document.querySelector("#apiKey").placeholder = config.hasApiKey ? "已保存密钥，留空则不修改" : "请输入 API Key";
  document.querySelector("#imageApiKey").placeholder = config.hasImageApiKey ? "已保存或复用文案密钥，留空则不修改" : "留空则复用文案 API Key";
  connectionBadge.textContent = config.hasApiKey ? "已配置密钥" : "未配置密钥";
  connectionBadge.dataset.ready = String(config.hasApiKey);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  accessCode = accessCodeInput.value;
  try {
    await loadConfig();
    loginPanel.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
  } catch (error) {
    accessCodeInput.setCustomValidity(error.message);
    accessCodeInput.reportValidity();
    accessCodeInput.setCustomValidity("");
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("正在保存...");
  const payload = formPayload();
  try {
    const response = await fetch("/api/admin/config", {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败");
    if (payload.newAdminPassword) accessCode = payload.newAdminPassword;
    document.querySelector("#apiKey").value = "";
    document.querySelector("#imageApiKey").value = "";
    document.querySelector("#newAdminPassword").value = "";
    await loadConfig();
    setStatus("已保存", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

async function testConnection(button, endpoint, label) {
  if (!settingsForm.reportValidity()) return;
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "测试中...";
  setStatus(`正在测试${label}...`);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(formPayload())
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "连接失败");
    setStatus(`${label}测试成功：${result.message}`, "success");
  } catch (error) {
    setStatus(`${label}测试失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

testChatConnectionButton.addEventListener("click", () => {
  testConnection(testChatConnectionButton, "/api/admin/test/chat", "对话");
});

testImageConnectionButton.addEventListener("click", () => {
  testConnection(testImageConnectionButton, "/api/admin/test/image", "图片");
});
