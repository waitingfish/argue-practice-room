function createTranscriptionProvider({ endpointFor, readChatContent, logger = console }) {
  function extension(mimeType) {
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
    return "webm";
  }

  async function transcribe(config, audio, mimeType = "audio/webm", { allowEmpty = false } = {}) {
    const endpoint = endpointFor(config);
    const startedAt = Date.now();
    if (config.transcriptionMode === "mimo") {
      const apiKey = config.transcriptionApiKey || config.apiKey;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.transcriptionModel || "mimo-v2.5-asr",
          messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:${mimeType};base64,${audio.toString("base64")}` } }] }],
          asr_options: { language: "auto" }
        }),
        signal: AbortSignal.timeout(Number(config.transcriptionTimeoutSeconds || 120) * 1000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        logger.warn?.("语音识别调用失败", { endpoint, mode: config.transcriptionMode, model: config.transcriptionModel || "mimo-v2.5-asr", statusCode: response.status, durationMs: Date.now() - startedAt, audioBytes: audio.length, mimeType });
        throw new Error(data?.error?.message || data?.error || data?.message || `MiMo 语音识别返回 ${response.status}`);
      }
      const text = readChatContent(data);
      if (!text && !allowEmpty) throw new Error("MiMo 语音识别没有返回文字，请靠近麦克风再说一次");
      logger.info?.("语音识别调用完成", { endpoint, mode: config.transcriptionMode, model: config.transcriptionModel || "mimo-v2.5-asr", statusCode: response.status, durationMs: Date.now() - startedAt, audioBytes: audio.length, mimeType, textLength: text.length });
      return text;
    }

    const form = new FormData();
    form.append("file", new Blob([audio], { type: mimeType }), `recording.${extension(mimeType)}`);
    form.append("model", config.transcriptionModel || "whisper-1");
    form.append("response_format", "json");
    form.append("temperature", "0");
    form.append("language", "zh");
    const headers = {};
    if (config.transcriptionMode === "openai" && config.transcriptionApiKey) headers.Authorization = `Bearer ${config.transcriptionApiKey}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(Number(config.transcriptionTimeoutSeconds || 120) * 1000)
    });
    const responseType = response.headers.get("content-type") || "";
    const data = responseType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) {
      const detail = typeof data === "string" ? data.trim() : data?.error?.message || data?.error || data?.message;
      logger.warn?.("语音识别调用失败", { endpoint, mode: config.transcriptionMode, model: config.transcriptionModel || "whisper-1", statusCode: response.status, durationMs: Date.now() - startedAt, audioBytes: audio.length, mimeType });
      throw new Error(detail || `语音识别服务返回 ${response.status}`);
    }
    const text = String(typeof data === "string" ? data : data.text || data.transcription || data.result || "").trim();
    if (!text && !allowEmpty) throw new Error("语音识别服务没有返回文字，请靠近麦克风再说一次");
    logger.info?.("语音识别调用完成", { endpoint, mode: config.transcriptionMode, model: config.transcriptionModel || "whisper-1", statusCode: response.status, durationMs: Date.now() - startedAt, audioBytes: audio.length, mimeType, textLength: text.length });
    return text;
  }

  return Object.freeze({ transcribe });
}

module.exports = { createTranscriptionProvider };
