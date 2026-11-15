// Regenerate the committed contract specs from the release contract WASMs.
//
//   node scripts/contract-specs.mjs generate   # write
//   node scripts/contract-specs.mjs check      # fail on drift
//
// The SDK binds what is deployed, so the specs come from release artifacts:
//
// - The core contracts (market, strategy vault, factory, oracle, treasury,
//   governance) are the release assets of
//   https://github.com/zenex-trade/zenex-contracts. Download the assets of
//   the bound release into one directory and point ZENEX_CONTRACTS_WASM_DIR
//   at it.
// - The market router and fee forwarder are the Zenex utility contracts.
//   Point ZENEX_UTIL_CONTRACTS_WASM_DIR at a directory holding their
//   release WASMs, or ZENEX_UTIL_CONTRACTS_ROOT at a source checkout built
//   at the bound tag (its `target/wasm32v1-none/release` is read).
//
// A WASM is found in its directory under any of these names, tried in order
// for the crate name `strategy_vault`:
//
//   strategy_vault.wasm            the crate name, as cargo builds it
//   strategy-vault.wasm            the package name
//   strategy-vault_v1.0.0.wasm     a published release asset
//   strategy_vault_v1.0.0.wasm
//
// A directory that holds release assets of more than one version for the
// same contract is ambiguous and fails.
//
// Without ZENEX_CONTRACTS_WASM_DIR the core contracts are read from the
// build output of a source checkout: ZENEX_CONTRACTS_ROOT, or the sibling
// `../zenex-contracts`, under `target/wasm32v1-none/release`.
//
// A contract's spec is a custom section inside its own WASM, so `Spec.fromWasm`
// reads it directly: no Stellar CLI, no temp dirs, no TypeScript AST parsing.
//
// This script does not verify provenance. It pins no source commit and no
// per-WASM hashes. Check a downloaded asset against the checksums and the
// build attestation published with its release.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contract } from '@stellar/stellar-sdk';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_OUTPUT = 'target/wasm32v1-none/release';

const coreWasmDir = resolve(
    process.env.ZENEX_CONTRACTS_WASM_DIR
        ?? resolve(
            process.env.ZENEX_CONTRACTS_ROOT ?? resolve(sdkRoot, '../zenex-contracts'),
            BUILD_OUTPUT,
        ),
);
// The utility contracts have no default location: one of the two variables
// names it.
const utilWasmDir = process.env.ZENEX_UTIL_CONTRACTS_WASM_DIR
    ? resolve(process.env.ZENEX_UTIL_CONTRACTS_WASM_DIR)
    : process.env.ZENEX_UTIL_CONTRACTS_ROOT
        ? resolve(process.env.ZENEX_UTIL_CONTRACTS_ROOT, BUILD_OUTPUT)
        : undefined;

const CORE_HINT = 'Download the release assets of '
    + 'https://github.com/zenex-trade/zenex-contracts into one directory and '
    + 'point ZENEX_CONTRACTS_WASM_DIR at it.';
const UTIL_HINT = 'Point ZENEX_UTIL_CONTRACTS_WASM_DIR at the utility contracts\' '
    + 'release WASMs, or ZENEX_UTIL_CONTRACTS_ROOT at a source checkout built '
    + 'at the bound tag.';

// Keyed by crate name (also the fixture filename), with the directory the
// WASM is read from. Order fixes the layout of the generated module.
const CONTRACTS = [
    ['market', 'marketSpec', coreWasmDir, CORE_HINT],
    ['market_router', 'marketRouterSpec', utilWasmDir, UTIL_HINT],
    ['fee_forwarder', 'feeForwarderSpec', utilWasmDir, UTIL_HINT],
    ['factory', 'factorySpec', coreWasmDir, CORE_HINT],
    ['strategy_vault', 'strategyVaultSpec', coreWasmDir, CORE_HINT],
    ['oracle', 'oracleSpec', coreWasmDir, CORE_HINT],
    ['treasury', 'treasurySpec', coreWasmDir, CORE_HINT],
    ['governance', 'governanceSpec', coreWasmDir, CORE_HINT],
];

function fail(message) {
    throw new Error(`Contract spec generation failed: ${message}`);
}

// A published release asset: `<name>_v<semver>.wasm`.
const RELEASE_SUFFIX = /^_v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\.wasm$/;

/**
 * The WASM for a crate inside `wasmDir`: the plain crate or package name, or
 * else its one versioned release asset.
 */
export function findWasm(stem, wasmDir, hint) {
    if (wasmDir === undefined) fail(`no directory configured for ${stem}. ${hint}`);
    if (!existsSync(wasmDir)) fail(`no directory ${wasmDir} for ${stem}. ${hint}`);
    const names = [stem, stem.replaceAll('_', '-')];
    for (const name of names) {
        const path = resolve(wasmDir, `${name}.wasm`);
        if (existsSync(path)) return path;
    }
    const released = readdirSync(wasmDir).filter((file) =>
        names.some(
            (name) => file.startsWith(name) && RELEASE_SUFFIX.test(file.slice(name.length)),
        ),
    );
    if (released.length === 1) return resolve(wasmDir, released[0]);
    if (released.length > 1) {
        fail(
            `${wasmDir} holds more than one release of ${stem} `
            + `(${released.sort().join(', ')}). Keep one version per directory.`,
        );
    }
    return fail(
        `no WASM for ${stem} in ${wasmDir} (looked for ${names[0]}.wasm, `
        + `${names[1]}.wasm and ${names[1]}_v<version>.wasm). ${hint}`,
    );
}

async function specEntries(stem, wasmDir, hint) {
    const wasmPath = findWasm(stem, wasmDir, hint);
    const spec = await contract.Spec.fromWasm(readFileSync(wasmPath));
    return { wasmPath, entries: spec.entries.map((entry) => entry.toXDR('base64')) };
}

function renderGeneratedModule(generated) {
    const lines = [
        '// Generated by scripts/contract-specs.mjs from the release contract WASMs.',
        '// Do not edit these base64 XDR arrays by hand.',
        '',
    ];

    for (const [stem, exportName] of CONTRACTS) {
        lines.push(`export const ${exportName}: string[] = [`);
        for (const entry of generated.get(stem)) lines.push(`    '${entry}',`);
        lines.push('];', '');
    }

    return `${lines.join('\n').trimEnd()}\n`;
}

function writeOrCheck(path, expected, mode) {
    const bytes = Buffer.from(expected);
    if (mode === 'generate') {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        return;
    }
    if (!existsSync(path) || !readFileSync(path).equals(bytes)) {
        fail(
            `${relative(sdkRoot, path)} is out of date. `
            + 'Run `npm run specs:generate` and commit the result.',
        );
    }
}

async function run(mode) {
    if (mode !== 'generate' && mode !== 'check') {
        throw new Error('Usage: node scripts/contract-specs.mjs <generate|check>');
    }

    const generated = new Map();
    const sources = [];
    for (const [stem, , wasmDir, hint] of CONTRACTS) {
        const { wasmPath, entries } = await specEntries(stem, wasmDir, hint);
        generated.set(stem, entries);
        sources.push(`  ${stem.padEnd(15)} ${wasmPath}`);
    }

    writeOrCheck(
        resolve(sdkRoot, 'src/contracts/contract_specs.ts'),
        renderGeneratedModule(generated),
        mode,
    );
    for (const [stem] of CONTRACTS) {
        writeOrCheck(
            resolve(sdkRoot, `test/fixtures/specs/${stem}.json`),
            `${JSON.stringify(generated.get(stem), null, 4)}\n`,
            mode,
        );
    }

    process.stdout.write(
        `Contract specs ${mode === 'generate' ? 'generated' : 'verified'} from:\n`
        + `${sources.join('\n')}\n`,
    );
}

// Run only as a script, so a test can import `findWasm`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await run(process.argv[2]);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
