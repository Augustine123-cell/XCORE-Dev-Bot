/** Live WhatsApp sessions (number → session). Shared by the socket adapter, commands, app and Telegram bot. */
export const sessions = new Map();
export const listSessions = () => [...sessions.keys()];
