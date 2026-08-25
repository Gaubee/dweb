export interface StartServerOptions {
  /** rendezvous/healthz 监听地址，默认 127.0.0.1:8787 */
  httpBind?: string;
  /** relay HTTP 监听地址，默认 127.0.0.1:3340 */
  relayBind?: string;
  /** 默认 true */
  relayEnabled?: boolean;
}

export interface ServerHandle {
  pid: number;
  httpUrl: string;
  relayHttpUrl: string;
  /** 发送 SIGINT 并等待退出（5s 后 SIGKILL 兜底），幂等 */
  stop(): Promise<void>;
  /** 进程退出码 future */
  exited: Promise<number>;
}

export declare function startServer(options?: StartServerOptions): Promise<ServerHandle>;
