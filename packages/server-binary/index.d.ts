export interface StartServerOptions {
  /** gateway（rendezvous/healthz/services.json）监听地址，默认 127.0.0.1:8787 */
  gatewayBind?: string;
  /** gatewayBind 的兼容别名（同时给出时 gatewayBind 优先） */
  httpBind?: string;
  /** relay HTTP 监听地址，默认 127.0.0.1:3340 */
  relayBind?: string;
  /** 默认 true */
  relayEnabled?: boolean;
  /** true 时向子进程设置 DWEB_TRUST_PROXY=1（采信 X-Forwarded-Proto）；缺省继承父进程环境 */
  trustProxy?: boolean;
}

export interface ServerHandle {
  pid: number;
  /** gateway 基地址 */
  gatewayUrl: string;
  /** 旧字段名保留（值同 gatewayUrl） */
  httpUrl: string;
  /** relay HTTP 基地址 */
  relayHttpUrl: string;
  /** 服务清单地址（GET /services.json） */
  servicesUrl: string;
  /** 发送 SIGINT 并等待退出（5s 后 SIGKILL 兜底），幂等 */
  stop(): Promise<void>;
  /** 进程退出码 future */
  exited: Promise<number>;
}

export declare function startServer(options?: StartServerOptions): Promise<ServerHandle>;
