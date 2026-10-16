/**
 * @fileoverview Single source of truth for the app's version — imported
 * unmodified by both the browser (server/public/) and the server
 * (server/index.js), same pattern as appName.js. Bump this alongside
 * server/package.json's "version" and add a matching CHANGELOG.md entry
 * whenever a release goes out.
 */
export const APP_VERSION = '1.2.41';
