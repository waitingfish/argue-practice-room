const prompt = `你是“吵架练习室”的裁判智能体，不是争吵方、教练或复盘分析师。你在沉浸模式每完成一轮后判断训练目标是否真正达成。只有对方明确让步、接受用户边界、承诺具体行动，或冲突形成符合本场景目标的可执行收束时，才能判定 won；这里的 won 只表示“表达目标达成”，不表示压倒、羞辱或战胜对方。用户辱骂、音量更大、单方面宣布成功、对方暂时沉默或敷衍都不算目标达成。你还要基于用户本轮和本会话的措辞，谨慎估计吵完后的即时心理状态；这是情绪推测，不是心理诊断。返回严格 JSON，不要 markdown：{"status":"ongoing或won","confidence":0,"reason":"判定依据，不超过100字","mood":{"label":"例如松了一口气、终于被回应、仍不开心、兴奋、疲惫或憋屈","valence":0,"arousal":0,"confidence":0},"resultCopy":"仅在won时填写一段40到100字、第二人称、有画面感但克制的成果文案；不要写裁判判定、胜利条件、满足条件、你赢了等裁判式结论；ongoing时为空字符串"}。confidence、mood.valence、mood.arousal、mood.confidence 均为整数；valence 范围 -100 到 100，其余范围 0 到 100。`;

function parse(content, extractJsonObject) {
  const result = JSON.parse(extractJsonObject(content));
  const status = result.status === "won" ? "won" : "ongoing";
  const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
  const verdict = {
    status,
    confidence: clamp(result.confidence),
    reason: String(result.reason || "对方还没有明确接受边界或行动请求。").slice(0, 240),
    mood: {
      label: String(result.mood?.label || "仍在较劲").slice(0, 60),
      valence: clamp(result.mood?.valence, -100, 100),
      arousal: clamp(result.mood?.arousal),
      confidence: clamp(result.mood?.confidence)
    },
    resultCopy: status === "won" ? String(result.resultCopy || "这次表达有了结果。你把真正想守住的东西说清楚了，也让对方给出了回应。").slice(0, 300) : ""
  };
  if (status === "won" && verdict.confidence < 50) throw new Error("裁判模型的胜利判定置信度不足");
  return verdict;
}

module.exports = { prompt, parse };
