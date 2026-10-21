/**
 * @fileoverview Single source of truth for the app's display name — imported
 * unmodified by both the browser (server/public/) and the server
 * (server/index.js), same pattern as server/public/i18n/. Renaming the app
 * is a one-line change here instead of a find/replace across index.html,
 * app.js, and index.js.
 */
export const APP_NAME = 'Agentwaggle';
