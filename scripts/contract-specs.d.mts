/**
 * The WASM for a crate inside `wasmDir`: `<crate>.wasm`, `<package>.wasm`,
 * or else its one versioned release asset, `<name>_v<version>.wasm`.
 * Throws, with `hint` appended, when the directory or the WASM is missing or
 * the directory holds more than one release of the contract.
 */
export function findWasm(stem: string, wasmDir: string | undefined, hint: string): string;
