/**
 * Agent Client Protocol (ACP) JSON-RPC protocol types.
 */

export interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result: TResult;
}

export interface JsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export interface AcpInitializeParams {
  readonly protocolVersion: string;
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities?: Readonly<Record<string, unknown>>;
}

export interface AcpInitializeResult {
  readonly protocolVersion: string;
  readonly serverInfo?: {
    readonly name: string;
    readonly version?: string;
  };
  readonly capabilities?: Readonly<Record<string, unknown>>;
}

export interface AcpPromptChunkUpdate {
  readonly text?: string;
  readonly thought?: string;
  readonly toolCall?: {
    readonly id: string;
    readonly name: string;
    readonly arguments?: string;
  };
  readonly finishReason?: string;
}

export interface AcpSessionUpdateParams {
  readonly sessionId?: string;
  readonly delta?: AcpPromptChunkUpdate;
}
