function createSpeechProvider({ endpointFor, voiceFor, logger = console }) {
  const mimoHeaders = (apiKey) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "api-key": apiKey
  });
  const mimoMessages = (input) => [{ role: "assistant", content: String(input).slice(0, 4096) }];

  async function synthesize(config, input, { scene } = {}) {
    const apiKey = config.speechApiKey || config.apiKey;
    const voice = voiceFor(config, scene);
    const endpoint = endpointFor(config);
    const startedAt = Date.now();
    if (config.speechMode === "mimo") {
      const format = config.speechFormat || "wav";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: mimoHeaders(apiKey),
        body: JSON.stringify({
          model: config.speechModel || "mimo-v2.5-tts",
          messages: mimoMessages(input),
          audio: { format, voice }
        }),
        signal: AbortSignal.timeout(Number(config.speechTimeoutSeconds || 120) * 1000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        logger.warn?.("语音合成调用失败", { endpoint, mode: config.speechMode, model: config.speechModel || "mimo-v2.5-tts", voice, statusCode: response.status, durationMs: Date.now() - startedAt, inputLength: String(input).length });
        throw new Error(data?.error?.message || data?.error || data?.message || `MiMo 语音合成返回 ${response.status}`);
      }
      const base64Audio = data?.choices?.[0]?.message?.audio?.data;
      if (!base64Audio) throw new Error("MiMo 语音合成没有返回 choices[0].message.audio.data");
      const buffer = Buffer.from(base64Audio, "base64");
      if (!buffer.length) throw new Error("MiMo 语音合成返回了空音频");
      logger.info?.("语音合成调用完成", { endpoint, mode: config.speechMode, model: config.speechModel || "mimo-v2.5-tts", voice, statusCode: response.status, durationMs: Date.now() - startedAt, inputLength: String(input).length, bytes: buffer.length });
      return { buffer, contentType: format === "mp3" ? "audio/mpeg" : `audio/${format}` };
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.speechModel,
        voice,
        input: String(input).slice(0, 4096),
        response_format: config.speechFormat
      }),
      signal: AbortSignal.timeout(Number(config.speechTimeoutSeconds || 120) * 1000)
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      logger.warn?.("语音合成调用失败", { endpoint, mode: config.speechMode, model: config.speechModel, voice, statusCode: response.status, durationMs: Date.now() - startedAt, inputLength: String(input).length });
      throw new Error(data.error?.message || `语音合成服务返回 ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error("语音合成服务返回了空音频");
    logger.info?.("语音合成调用完成", { endpoint, mode: config.speechMode, model: config.speechModel, voice, statusCode: response.status, durationMs: Date.now() - startedAt, inputLength: String(input).length, bytes: buffer.length });
    return { buffer, contentType: response.headers.get("content-type") || `audio/${config.speechFormat || "mpeg"}` };
  }

  async function stream(config, input, response, { scene } = {}) {
    if (config.speechMode !== "mimo") throw new Error("当前语音服务不支持流式合成");
    const apiKey = config.speechApiKey || config.apiKey;
    const endpoint = endpointFor(config);
    const startedAt = Date.now();
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: mimoHeaders(apiKey),
      body: JSON.stringify({
        model: config.speechModel || "mimo-v2.5-tts",
        messages: mimoMessages(input),
        audio: { format: "pcm16", voice: voiceFor(config, scene) },
        stream: true
      }),
      signal: AbortSignal.timeout(Number(config.speechTimeoutSeconds || 120) * 1000)
    });
    if (!upstream.ok) {
      const data = await upstream.json().catch(() => ({}));
      logger.warn?.("流式语音合成调用失败", { endpoint, mode: config.speechMode, model: config.speechModel || "mimo-v2.5-tts", voice: voiceFor(config, scene), statusCode: upstream.status, durationMs: Date.now() - startedAt, inputLength: String(input).length });
      throw new Error(data?.error?.message || data?.error || data?.message || `MiMo 流式语音合成返回 ${upstream.status}`);
    }
    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Audio-Format": "pcm16",
      "X-Audio-Sample-Rate": "24000"
    });
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkCount = 0;
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          response.write(`${JSON.stringify({ done: true, chunks: chunkCount })}\n`);
          logger.info?.("流式语音合成调用完成", { endpoint, mode: config.speechMode, model: config.speechModel || "mimo-v2.5-tts", voice: voiceFor(config, scene), statusCode: upstream.status, durationMs: Date.now() - startedAt, inputLength: String(input).length, chunks: chunkCount });
          return response.end();
        }
        try {
          const audio = JSON.parse(payload)?.choices?.[0]?.delta?.audio?.data;
          if (audio) {
            chunkCount += 1;
            response.write(`${JSON.stringify({ audio })}\n`);
          }
        } catch {
          // 忽略单个不完整 SSE 片段。
        }
      }
    }
    response.write(`${JSON.stringify({ done: true, chunks: chunkCount })}\n`);
    logger.info?.("流式语音合成连接结束", { endpoint, mode: config.speechMode, model: config.speechModel || "mimo-v2.5-tts", voice: voiceFor(config, scene), statusCode: upstream.status, durationMs: Date.now() - startedAt, inputLength: String(input).length, chunks: chunkCount });
    return response.end();
  }

  return Object.freeze({ synthesize, stream });
}

module.exports = { createSpeechProvider };
