// Preload for the trusted chrome UI view only. It runs our normal `window.bro`
// bridge AND injects the extension toolbar (<browser-action-list>) machinery.
//
// injectBrowserAction() needs ipcRenderer + Node require, so the chrome view is
// created with sandbox:false (contextIsolation stays on). Tabs — which load
// untrusted web pages — keep the sandboxed, bridge-less setup.
import './bridge';
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action';

injectBrowserAction();
