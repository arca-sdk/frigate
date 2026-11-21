/**
 * Preload for the local server list page only. Server windows get no preload,
 * so a server's pages can't reach any of this.
 */

import { contextBridge, ipcRenderer } from "electron";

import { IPC, type ServersApi, type ServerView } from "../shared/types";

const api: ServersApi = {
  list: () => ipcRenderer.invoke(IPC.list),
  add: (request) => ipcRenderer.invoke(IPC.add, request),
  open: (id) => ipcRenderer.invoke(IPC.open, id),
  remove: (id) => ipcRenderer.invoke(IPC.remove, id),
  trustCertificate: (id, fingerprint) =>
    ipcRenderer.invoke(IPC.trustCertificate, id, fingerprint),
  restart: () => ipcRenderer.invoke(IPC.restart),
  onChanged: (listener) => {
    ipcRenderer.on(IPC.changed, (_event, servers: ServerView[]) =>
      listener(servers),
    );
  },
};

contextBridge.exposeInMainWorld("servers", api);
