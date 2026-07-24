function createImageProvider({ endpointFor, detectFormat, logger = console }) {
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
    const endpoint = endpointFor(config, "generations");
    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: config.imageModel || "gpt-image-1", prompt, size, response_format: "b64_json" }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    try {
      const image = await readResponse(response, timeoutMs);
      logger.info?.("图片生成调用完成", { endpoint, model: config.imageModel || "gpt-image-1", size, statusCode: response.status, durationMs: Date.now() - startedAt, bytes: image.buffer.length, extension: image.extension });
      return image;
    } catch (error) {
      logger.warn?.("图片生成调用失败", { endpoint, model: config.imageModel || "gpt-image-1", size, statusCode: response.status, durationMs: Date.now() - startedAt, message: error.message });
      throw error;
    }
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
    const endpoint = endpointFor(config, "edits");
    const startedAt = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    });
    try {
      const image = await readResponse(response, timeoutMs);
      logger.info?.("图片编辑调用完成", { endpoint, model: config.imageModel || "gpt-image-1", size, statusCode: response.status, durationMs: Date.now() - startedAt, bytes: image.buffer.length, extension: image.extension, referenceBytes: referenceImage.length });
      return image;
    } catch (error) {
      logger.warn?.("图片编辑调用失败", { endpoint, model: config.imageModel || "gpt-image-1", size, statusCode: response.status, durationMs: Date.now() - startedAt, message: error.message, referenceBytes: referenceImage.length });
      throw error;
    }
  }

  return Object.freeze({ generate, edit });
}

module.exports = { createImageProvider };
