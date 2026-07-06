/* ── Tiny API client — thin fetch wrappers around the local backend ── */

/* Local-API auth: every /api call carries the per-launch token from
   backend/auth.js. In Electron the preload bridge provides it
   (window.cadence.apiToken); in browser-based Vite dev, paste the token
   the backend logs at startup into localStorage as `cadence-token`. */
function _apiToken() {
  if (typeof window !== "undefined" && window.cadence?.apiToken) {
    return window.cadence.apiToken;
  }
  try {
    return localStorage.getItem("cadence-token") || "";
  } catch {
    return "";
  }
}

/* fetch() for local /api routes — injects the auth header. There are no
   external fetches in Cadence (the CSP allows no external origins), so
   every fetch in the frontend should go through this wrapper. */
export function apiFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), "X-Cadence-Token": _apiToken() },
  });
}

export const api = {
  /* ── Relationships ── */
  async listRelationships() {
    const r = await apiFetch("/api/relationships");
    if (!r.ok) throw new Error(`GET /api/relationships → ${r.status}`);
    return r.json();
  },
  async createRelationship(body) {
    const r = await apiFetch("/api/relationships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(data?.error || `POST /api/relationships → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  },
  async updateRelationship(id, patch) {
    const r = await apiFetch(`/api/relationships/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(data?.error || `PATCH /api/relationships/${id} → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  },
  async deleteRelationship(id) {
    const r = await apiFetch(`/api/relationships/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) throw new Error(`DELETE /api/relationships/${id} → ${r.status}`);
  },
  async archiveRelationship(id) {
    const r = await apiFetch(`/api/relationships/${id}/archive`, { method: "POST" });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `archive → ${r.status}`);
    return data;
  },
  async unarchiveRelationship(id) {
    const r = await apiFetch(`/api/relationships/${id}/unarchive`, { method: "POST" });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `unarchive → ${r.status}`);
    return data;
  },
  async addRelationshipChat(relationshipId, body) {
    const r = await apiFetch(`/api/relationships/${relationshipId}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `link chat → ${r.status}`);
    return data;
  },
  async removeRelationshipChat(relationshipId, chatRowId) {
    const r = await apiFetch(`/api/relationships/${relationshipId}/chats/${chatRowId}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) {
      const data = await r.json().catch(() => null);
      throw new Error(data?.error || `unlink chat → ${r.status}`);
    }
  },
  async draftReply(relationshipId, body = {}) {
    const r = await apiFetch(`/api/relationships/${relationshipId}/draft-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = data?.error || `POST draft-reply → ${r.status}`;
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return data;
  },
  // chatId (optional) targets a specific chat — the queue item's
  // activeChatId, so a reply owed in a linked DM sends into that DM.
  async sendMessage(relationshipId, text, chatId = null) {
    const r = await apiFetch(`/api/relationships/${relationshipId}/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatId != null ? { text, chatId } : { text }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = data?.error || `POST send-message → ${r.status}`;
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return data;
  },

  /* ── Todos ── */
  async listTodos({ includeCompleted = true } = {}) {
    const url = `/api/todos${includeCompleted ? "" : "?includeCompleted=false"}`;
    const r = await apiFetch(url);
    if (!r.ok) throw new Error(`GET /api/todos → ${r.status}`);
    return r.json();
  },
  async createTodo(body) {
    const r = await apiFetch("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST /api/todos → ${r.status}`);
    return r.json();
  },
  async updateTodo(id, patch) {
    const r = await apiFetch(`/api/todos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`PATCH /api/todos/${id} → ${r.status}`);
    return r.json();
  },
  async deleteTodo(id) {
    const r = await apiFetch(`/api/todos/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) throw new Error(`DELETE /api/todos/${id} → ${r.status}`);
  },
  async reorderTodos(order) {
    const r = await apiFetch("/api/todos/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });
    if (!r.ok) throw new Error(`POST /api/todos/reorder → ${r.status}`);
    return r.json();
  },
  async refreshTodos({ force = false } = {}) {
    const r = await apiFetch("/api/todos/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = data?.error || `POST /api/todos/refresh → ${r.status}`;
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return data;
  },

  /* ── Notes (Granola) ── */
  async listNotes({ relationshipId } = {}) {
    const qs = relationshipId != null ? `?relationshipId=${relationshipId}` : "";
    const r = await apiFetch(`/api/notes${qs}`);
    if (!r.ok) throw new Error(`GET /api/notes → ${r.status}`);
    return r.json();
  },
  async syncNotes() {
    const r = await apiFetch("/api/notes/sync", { method: "POST" });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = data?.error || `POST /api/notes/sync → ${r.status}`;
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return data;
  },

  /* ── Follow-up engine (the Queue) ── */
  // GET, not POST — the backend owns the Telegram cache now (it sweeps on a
  // timer and on demand), so the frontend no longer ships telegramData in the
  // body like PipeWise did. Response includes `sweptAt` for the data-age label.
  async followupsQueue() {
    const r = await apiFetch("/api/followups/queue");
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `followups queue → ${r.status}`);
    return data;
  },
  async followupsSnooze(itemKey, mode = "until", until = null, lastInboundAt = null) {
    const r = await apiFetch("/api/followups/snooze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemKey, mode, until, lastInboundAt }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `followups snooze → ${r.status}`);
    return data;
  },
  async followupsUnsnooze(itemKey) {
    const r = await apiFetch("/api/followups/unsnooze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemKey }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `followups unsnooze → ${r.status}`);
    return data;
  },
  // No body — the backend extracts from its own sweep cache.
  async followupsExtractPromises() {
    const r = await apiFetch("/api/followups/extract-promises", { method: "POST" });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(data?.error || `extract-promises → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  },
  async listPromises({ relationshipId = null, status = "open" } = {}) {
    const q = new URLSearchParams();
    if (relationshipId != null) q.set("relationshipId", String(relationshipId));
    if (status) q.set("status", status);
    const qs = q.toString();
    const r = await apiFetch(`/api/followups/promises${qs ? `?${qs}` : ""}`);
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `list promises → ${r.status}`);
    return data;
  },
  async resolvePromise(id, status = "kept") {
    const r = await apiFetch(`/api/followups/promises/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `resolve promise → ${r.status}`);
    return data;
  },
  async setCadence(relationshipId, days) {
    const r = await apiFetch(`/api/followups/cadence/${relationshipId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `set cadence → ${r.status}`);
    return data;
  },
  async draftRecap(noteId) {
    const r = await apiFetch("/api/followups/draft-recap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(data?.error || `draft-recap → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  },

  /* ── Telegram sweep (backend-owned) ── */
  // Kick off a sweep. Returns 202 { alreadyRunning: true } when one is in
  // flight — either way the caller should poll chatsProgress() and watch
  // chatsLast() for a fresh sweptAt (see App.jsx's polling contract).
  async sweepChats() {
    const r = await apiFetch("/api/chats/sweep", { method: "POST" });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(data?.error || `POST /api/chats/sweep → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  },
  async chatsProgress() {
    const r = await apiFetch("/api/chats/progress");
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `chats progress → ${r.status}`);
    return data;
  },
  // { sweptAt, chats } from the last completed sweep (warm-started from disk).
  async chatsLast() {
    const r = await apiFetch("/api/chats/last");
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `chats last → ${r.status}`);
    return data;
  },

  /* ── New-conversation suggestions ── */
  async listSuggestions(status = "pending") {
    const r = await apiFetch(`/api/suggestions?status=${encodeURIComponent(status)}`);
    if (!r.ok) throw new Error(`GET /api/suggestions → ${r.status}`);
    return r.json();
  },
  // Accept creates a relationship from the suggestion (name, telegram_group,
  // telegram_chat_id) and marks it accepted; returns the new relationship.
  async acceptSuggestion(id) {
    const r = await apiFetch(`/api/suggestions/${id}/accept`, { method: "POST" });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `POST /api/suggestions/${id}/accept → ${r.status}`);
    return data;
  },
  async dismissSuggestion(id) {
    const r = await apiFetch(`/api/suggestions/${id}/dismiss`, { method: "POST" });
    if (!r.ok && r.status !== 204) throw new Error(`POST /api/suggestions/${id}/dismiss → ${r.status}`);
  },

  /* ── Cloud publish (Phase 4 — feeds the iPhone app) ── */
  async cloudStatus() {
    const r = await apiFetch("/api/cloud/status");
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `GET /api/cloud/status → ${r.status}`);
    return data;
  },
  async cloudConfig(url, anonKey) {
    const r = await apiFetch("/api/cloud/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, anonKey }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `cloud config → ${r.status}`);
    return data;
  },
  async cloudSignIn(email, password) {
    const r = await apiFetch("/api/cloud/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `sign in → ${r.status}`);
    return data;
  },
  async cloudSignUp(email, password) {
    const r = await apiFetch("/api/cloud/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `sign up → ${r.status}`);
    return data;
  },
  async cloudSignOut() {
    const r = await apiFetch("/api/cloud/signout", { method: "POST" });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `sign out → ${r.status}`);
    return data;
  },
  async cloudSyncNow() {
    const r = await apiFetch("/api/cloud/sync", { method: "POST" });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `sync → ${r.status}`);
    return data;
  },
  async cloudToggle(enabled) {
    const r = await apiFetch("/api/cloud/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `toggle → ${r.status}`);
    return data;
  },

  /* ── Setup / per-user configuration ── */
  async getSetupStatus() {
    const r = await apiFetch("/api/setup/status");
    if (!r.ok) throw new Error(`GET /api/setup/status → ${r.status}`);
    return r.json();
  },
  async saveSetupKeys(body) {
    const r = await apiFetch("/api/setup/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(data?.error || `POST /api/setup/keys → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  },
  async telegramSendCode(body) {
    const r = await apiFetch("/api/setup/telegram/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(data?.error || `send-code → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  },
  async telegramSignIn(body) {
    const r = await apiFetch("/api/setup/telegram/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const err = new Error(data?.error || `sign-in → ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  },
  async telegramLogout() {
    const r = await apiFetch("/api/setup/telegram/logout", { method: "POST" });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `logout → ${r.status}`);
    return data;
  },
};
