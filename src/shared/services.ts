// Services plugins share through MainContext.provide/lookup (main process only).
// Types live here, not in the providing plugin, so a consumer never imports a
// plugin that may be left out of the build.

/** Provided as 'proxy' by the proxy plugin. */
export interface ProxyService {
  readonly running: boolean;
  readonly port: number;
  /** PEM of the MITM root CA, so a client sending through the proxy can trust it. */
  caPem(): Promise<string>;
}
