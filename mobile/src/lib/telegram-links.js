/* Telegram deep links from a queue item's active chat.
 *
 * The Mac stores GramJS "marked" ids (sign convention intact):
 *   -100XXXXXXXXXX → supergroup/channel: https://t.me/c/XXXXXXXXXX[/msgId]
 *                    opens right in the Telegram iOS app for members.
 *   positive        → a user DM: tg://openmessage?user_id=<id>, with
 *                    tg://user?id=<id> as a second candidate (client
 *                    support varies — the caller tries in order).
 *   other negatives → basic groups have no reliable public deep link;
 *                    fall back to just opening Telegram.
 *
 * Returns candidates best-first; the caller opens the first the OS
 * accepts. Pure module — unit-tested off-device.
 */

export function telegramLinkCandidates(chatId, messageId = null) {
  const id = String(chatId ?? "").trim();
  if (!id) return ["tg://"];

  if (id.startsWith("-100")) {
    const internal = id.slice(4);
    const base = `https://t.me/c/${internal}`;
    return messageId ? [`${base}/${messageId}`, base, "tg://"] : [base, "tg://"];
  }
  if (!id.startsWith("-")) {
    return [`tg://openmessage?user_id=${id}`, `tg://user?id=${id}`, "tg://"];
  }
  return ["tg://"];
}

/* Newest inbound message date from a queue item's cached messages
   (newest-first) — the after_reply snooze snapshot. */
export function lastInboundDate(item) {
  for (const m of item.messages || []) {
    if (m && !m.is_me && m.date) return m.date;
  }
  return item.lastActivity || null;
}

export function snoozeUntil(option) {
  const d = new Date();
  if (option === "tonight") {
    d.setHours(18, 0, 0, 0);
    if (d.getTime() < Date.now()) d.setHours(21, 0, 0, 0);
  } else if (option === "tomorrow") {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  } else if (option === "nextweek") {
    d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
    d.setHours(9, 0, 0, 0);
  }
  return d.toISOString();
}
