/**
 * @fileoverview Fires scheduled messages at their chosen time.
 * A scheduled message's whole job is to eventually replay as a normal
 * USER_MESSAGE — @mention targeting (a specific agent, or everyone) is
 * resolved fresh at fire time by handleUserMessage/parseResponders, exactly
 * as it would be for a message typed live, so there's no separate
 * "who responds" logic here.
 */

import {
  getAllScheduledMessages,
  deleteScheduledMessageIfExists,
} from '../store/db.js';
import { handleUserMessage, broadcast } from '../ws/handler.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'scheduler' });

/**
 * setTimeout's delay is a signed 32-bit int under the hood — anything past
 * this fires (or overflows) immediately instead of waiting. armTimer chains
 * itself at this cap for anything scheduled further out.
 */
const MAX_DELAY = 2_147_483_647;

/**
 * Currently-armed timers, keyed by scheduled-message id. A no-op cancel
 * (already fired, or never existed) is simply absent from this map.
 * @type {Map<string, NodeJS.Timeout>}
 */
const timers = new Map();

/**
 * Sends a scheduled message's content through the exact same path a live
 * USER_MESSAGE takes. No-ops if the row is already gone — canceled, or
 * already fired by a race with cancelScheduledMessage (see
 * deleteScheduledMessageIfExists's docs for why that's race-free).
 * Exported so the fire-now REST route (routes/chats.js) can trigger the
 * exact same send path for a row that initScheduler left un-armed — see
 * initScheduler's docs below.
 * @param {string} id
 * @param {import('ws').WebSocketServer} wss
 * @returns {Promise<void>}
 */
export async function fireScheduledMessage(id, wss) {
  const existingTimer = timers.get(id);
  if (existingTimer) clearTimeout(existingTimer);
  timers.delete(id);
  const row = await deleteScheduledMessageIfExists(id);
  if (!row) return;

  broadcast(wss, { type: 'SCHEDULED_MESSAGE_FIRED', chatId: row.chatId, id });
  await handleUserMessage(
    {
      type: 'USER_MESSAGE',
      chatId: row.chatId,
      content: row.content,
      attachments: row.attachments,
    },
    wss
  );
}

/**
 * Arms (or re-arms) an in-memory timer for a pending scheduled message.
 * Clears any timer already armed for this id first — without this, calling
 * armTimer a second time for the same id (e.g. rescheduling to a new time)
 * would leave the OLD timeout still live underneath the new one, since
 * setting a new Map entry doesn't cancel the handle the old one held; the
 * stale timer would then fire fireScheduledMessage at the original time
 * with the message's since-edited content. Delays beyond MAX_DELAY chain
 * through an intermediate wakeup instead of overflowing; an already-overdue
 * sendAt (e.g. the server was down past it) fires almost immediately
 * rather than being treated as an error.
 * @param {import('../store/db.js').ScheduledMessage} row
 * @param {import('ws').WebSocketServer} wss
 * @returns {void}
 */
function armTimer(row, wss) {
  const existing = timers.get(row.id);
  if (existing) clearTimeout(existing);

  const delay = new Date(row.sendAt).getTime() - Date.now();
  if (delay > MAX_DELAY) {
    timers.set(row.id, setTimeout(() => armTimer(row, wss), MAX_DELAY));
    return;
  }
  timers.set(row.id, setTimeout(() => fireScheduledMessage(row.id, wss), Math.max(delay, 0)));
}

/**
 * Persists nothing itself — callers create or update the DB row first —
 * this just (re-)arms the in-memory timer for it. Called right after a
 * scheduled message is created or modified via the REST endpoints.
 * @param {import('../store/db.js').ScheduledMessage} row
 * @param {import('ws').WebSocketServer} wss
 * @returns {void}
 */
export function scheduleTimer(row, wss) {
  armTimer(row, wss);
}

/**
 * Cancels a pending scheduled message: clears its in-memory timer (if still
 * armed) and deletes its DB row. Safe to call even if it already fired —
 * deleteScheduledMessageIfExists simply returns null in that case.
 * @param {string} id
 * @returns {Promise<import('../store/db.js').ScheduledMessage | null>}
 */
export async function cancelScheduledMessage(id) {
  const handle = timers.get(id);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id);
  }
  return deleteScheduledMessageIfExists(id);
}

/**
 * Re-arms a timer for every scheduled message still pending in the DB —
 * called once at server startup so schedules survive a restart, since
 * armed timers themselves are purely in-memory and don't.
 *
 * One exception: an auto-continue message (row.isAutoContinue) whose
 * sendAt has already passed is left UN-ARMED here instead of being armed
 * (which would fire it almost immediately — see armTimer's docs) or
 * deleted outright (an earlier version of this function did that). A
 * normal user-scheduled message firing late after downtime is still the
 * right call — the user asked for that content to go out, late or not.
 * But an auto-continue's sendAt targets a specific session-limit reset
 * time; once the server's been down past it, that assumption is stale and
 * unverifiable, and firing it automatically risks waking an agent into a
 * limit that hasn't actually reset, or long after its work moved on. Silently deleting it was the old behaviour,
 * but that took the decision away from the user entirely. Instead, the row
 * is simply left in the DB with no timer: getScheduledMessages still
 * returns it, so the next time the user opens that chat the frontend's
 * stale-auto-continue banner (app.js) surfaces it and lets them fire it
 * now or discard it — see the fire-now and DELETE scheduled-message routes
 * in routes/chats.js. Reported live: exactly 3 rows sat through a ~5-hour
 * outage and would otherwise have fired immediately (or been silently
 * dropped) on the next start.
 * @param {import('ws').WebSocketServer} wss
 * @returns {void}
 */
export function initScheduler(wss) {
  const now = Date.now();
  for (const row of getAllScheduledMessages()) {
    if (row.isAutoContinue && new Date(row.sendAt).getTime() <= now) {
      log.info({ chatId: row.chatId, id: row.id, sendAt: row.sendAt }, 'leaving a stale overdue auto-continue message un-armed for the user to decide on');
      continue;
    }
    armTimer(row, wss);
  }
}
