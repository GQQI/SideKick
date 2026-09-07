"use strict";

/**
 * Marks the in-app BrowserView so Playwright CDP can attach to it
 * instead of the workbench window.
 */
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("__sidekickGuest", true);
