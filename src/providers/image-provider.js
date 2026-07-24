function createImageProvider({ endpointFor, detectFormat }) {
  async function readResponse(response, timeoutMs) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `图片模型返回 ${response.status}`);
    const item = data.data?.[0];
    if (!item) throw new Error("图片模型没有返回图像");
    let buffer;
    if (item.b64_json) {
      buffer = Buffer.from(item.b64_json, "base64");
    } else if (item.url) {
      const image = await fetch(item.url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 60000)) });
      if (!image.ok) throw new Error("无法下载图片模型生成的图像");
      if (Number(image.headers.get("content-length") || 0) > 25 * 1024 * 1024) throw new Error("图片模型返回的文件过大");
      buffer = Buffer.from(await image.arrayBuffer());
    } else {
      throw new Error("图片模型返回格式不受支持");
    }
    if (buffer.length > 25 * 1024 * 1024) throw new Error("图片模型返回的文件过大");
    return { buffer, ...detectFormat(buffer) };
  }

  async function generate(config, prompt, size = "1536x1024") {
    const apiKey = config.imageApiKey || config.apiKey;
    if (!apiKey) throw new Error("未配置图片模型 API Key");
    const timeoutMs = Number(config.imageTimeoutSeconds || 180) * 1000;
    const response = await fetch(endpointFor(config, "generations"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: config.imageModel || "gpt-image-1", prompt, size, response_format: "b64_json" }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return readResponse(response, timeoutMs);
  }

  async function edit(config, prompt, referenceImage, size = "1536x1024") {
    const apiKey = config.imageApiKey || config.apiKey;
    if (!apiKey) throw new Error("未配置图片模型 API Key");
    const timeoutMs = Number(config.imageTimeoutSeconds || 180) * 1000;
    const format = detectFormat(referenceImage);
    const form = new FormData();
    form.append("model", config.imageModel || "gpt-image-1");
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("response_format", "b64_json");
    form.append("image", new Blob([referenceImage], { type: format.mime }), `reference.${format.extension}`);
    const response = await fetch(endpointFor(config, "edits"), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    });
    return readResponse(response, timeoutMs);
  }

  return Object.freeze({ generate, edit });
}

module.exports = { createImageProvider };
