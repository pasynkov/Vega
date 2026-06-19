import { Injectable } from "@nestjs/common";

export type FlushHook = (sessionId: string, initiator: string) => Promise<void> | void;
export type FinalAppendHook = (sessionId: string, text: string) => void | Promise<void>;
export type SessionBeginHook = (
  sessionId: string,
  ctx: { artifactName?: string },
) => void | Promise<void>;

interface OwnerHooks {
  flush?: FlushHook;
  finalAppend?: FinalAppendHook;
  sessionBegin?: SessionBeginHook;
}

@Injectable()
export class FlushHookRegistry {
  private readonly hooks = new Map<string, OwnerHooks>();

  register(ownerName: string, hook: FlushHook): void {
    const cur = this.hooks.get(ownerName) ?? {};
    cur.flush = hook;
    this.hooks.set(ownerName, cur);
  }

  registerFinalAppend(ownerName: string, hook: FinalAppendHook): void {
    const cur = this.hooks.get(ownerName) ?? {};
    cur.finalAppend = hook;
    this.hooks.set(ownerName, cur);
  }

  registerSessionBegin(ownerName: string, hook: SessionBeginHook): void {
    const cur = this.hooks.get(ownerName) ?? {};
    cur.sessionBegin = hook;
    this.hooks.set(ownerName, cur);
  }

  get(ownerName: string): FlushHook | undefined {
    return this.hooks.get(ownerName)?.flush;
  }

  getFinalAppend(ownerName: string): FinalAppendHook | undefined {
    return this.hooks.get(ownerName)?.finalAppend;
  }

  getSessionBegin(ownerName: string): SessionBeginHook | undefined {
    return this.hooks.get(ownerName)?.sessionBegin;
  }
}
