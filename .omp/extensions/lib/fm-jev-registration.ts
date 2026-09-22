// OMP gives each extension factory a distinct API but shares events within a
// session. Children rebind those factories with a fresh event bus. A global
// boolean would suppress the child's tool; a per-session weak set does not.
export function registrations(name: string): WeakSet<object> {
  const key = Symbol.for(`firstmate.${name}.registered`);
  const globals = globalThis as typeof globalThis & { [key: symbol]: WeakSet<object> | undefined };
  return globals[key] ??= new WeakSet<object>();
}
