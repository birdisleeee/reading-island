// Replace this function with a call into YOUR existing Agent.
// Use payload.session_id as an isolated discussion session, preserving your Agent's identity.
export async function replyWithYourAgent(payload, {readSource}) {
  let quote=payload.source?.exact || '';
  if(!quote && payload.source_link)quote=(await readSource(0,1000)).text;
  return `**Agent 接线示例（模拟回复）**\n\n你正在讨论《${payload.book.title}》。\n\n${quote ? '> '+quote+'\n\n' : ''}你说：${payload.user_message.text}\n\n将 replyWithYourAgent 替换为你的已有 Agent 调用即可开始真实讨论。`;
}
