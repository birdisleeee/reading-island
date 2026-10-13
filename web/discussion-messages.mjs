// Rendering only: preserve every stored message and its quote, author and order.
export function groupDiscussionMessages(messages) {
  const groups = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (message.author === 'assistant' && message.turn_id && previous?.author === 'assistant' && previous.turn_id === message.turn_id) {
      previous.parts.push(message);
    } else {
      groups.push({author:message.author, turn_id:message.turn_id, parts:[message]});
    }
  }
  return groups;
}
