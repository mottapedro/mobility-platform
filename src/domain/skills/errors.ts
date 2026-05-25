export class SkillCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCatalogError";
  }
}

export class DriverSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverSkillError";
  }
}
