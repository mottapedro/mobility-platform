export class ReferralFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralFlowError";
  }
}

export class ReferralRelationshipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralRelationshipError";
  }
}

export class DriverRootResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverRootResolutionError";
  }
}
