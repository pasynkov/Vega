export class ToolUsedOutsideSessionError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" requires an active Ear session on its context`);
    this.name = "ToolUsedOutsideSessionError";
  }
}

export class EarSessionReservationConflictError extends Error {
  constructor(public readonly deviceId: string) {
    super(`An ear-session reservation is already active for device ${deviceId}`);
    this.name = "EarSessionReservationConflictError";
  }
}
