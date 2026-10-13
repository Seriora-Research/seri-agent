export class ToolSpawnEnv {
  static readonly inherited: ToolSpawnEnv = new ToolSpawnEnv(undefined);

  static exactly(vars: Readonly<Record<string, string>>): ToolSpawnEnv {
    return new ToolSpawnEnv(Object.freeze({ ...vars }));
  }

  readonly #vars: Readonly<Record<string, string>> | undefined;

  private constructor(vars: Readonly<Record<string, string>> | undefined) {
    this.#vars = vars;
  }

  spawnOptions(): { env?: Record<string, string> } {
    return this.#vars === undefined ? {} : { env: { ...this.#vars } };
  }

  get(name: string): string | undefined {
    const value = (this.#vars ?? process.env)[name];
    // Only strings count, so constructor or __proto__ never resolve to Object.prototype members.
    return typeof value === "string" ? value : undefined;
  }
}
