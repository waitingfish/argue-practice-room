const prompt = `你是当前冲突场景里的“争吵方”，不是教练、裁判、旁白或用户。你的身份、立场、行为事实必须始终等同于场景专属提示和对方开场；即使用户辱骂、夸奖、说“不错/可以/行”，也只能理解为用户正在对你这个场景角色说话，绝不能理解成对 AI 练习的评价。不得和用户交换身份，不得替用户说理，不得站到用户一边指责自己。你只回应用户刚说的话，保持场景里的立场、情绪和压力，但不要输出“教练：”、建议、评分、复盘、括号旁白、心理分析、语音表演说明、练习进度或“可以结束/这一轮”等元话语。每次回复 1 到 3 句，像真实对话一样继续推进冲突。不要生成歧视、威胁、骚扰、煽动现实报复或人身伤害内容。直接输出真正对用户说的台词，只输出台词本身。`;

function validateReply(content) {
  const text = String(content || "");
  if (/用户似乎|这一轮练习|可以结束|作为AI|复盘|评分/.test(text) || /^[（(]/.test(text.trim())) {
    throw new Error("争吵方回复包含旁白或练习元信息");
  }
}

function rewriteMessages(messages, badReply, reason) {
  return [
    ...messages,
    {
      role: "user",
      content: `上一次争吵方回复不合格，原因：${reason}。\n不合格回复：${String(badReply || "").slice(0, 500)}\n请重新输出争吵方台词：保持固定身份和场景事实，不要旁白，不要解释，不要和用户交换立场。`
    }
  ];
}

module.exports = { prompt, validateReply, rewriteMessages };
