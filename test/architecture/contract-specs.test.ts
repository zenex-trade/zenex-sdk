import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWasm } from '../../scripts/contract-specs.mjs';

const roots: string[] = [];

async function directory(...files: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'zenex-sdk-specs-'));
    roots.push(root);
    await mkdir(root, { recursive: true });
    for (const file of files) await writeFile(join(root, file), '');
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('contract-specs: locating a WASM', () => {
    it('finds a build output by its crate name', async () => {
        const dir = await directory('strategy_vault.wasm', 'market.wasm');
        expect(findWasm('strategy_vault', dir, '')).toBe(join(dir, 'strategy_vault.wasm'));
        expect(findWasm('market', dir, '')).toBe(join(dir, 'market.wasm'));
    });

    it('finds a release asset by its published name', async () => {
        const dir = await directory(
            'market_v1.0.0.wasm',
            'strategy-vault_v1.0.0.wasm',
            'release.sha256',
        );
        expect(findWasm('market', dir, '')).toBe(join(dir, 'market_v1.0.0.wasm'));
        expect(findWasm('strategy_vault', dir, '')).toBe(join(dir, 'strategy-vault_v1.0.0.wasm'));
    });

    it('does not take another contract that shares a name prefix', async () => {
        const dir = await directory('market_router_v0.0.2.wasm', 'market_v1.0.0.wasm');
        expect(findWasm('market', dir, '')).toBe(join(dir, 'market_v1.0.0.wasm'));
        expect(findWasm('market_router', dir, '')).toBe(join(dir, 'market_router_v0.0.2.wasm'));
    });

    it('prefers the plain name over a versioned asset', async () => {
        const dir = await directory('oracle.wasm', 'oracle_v1.0.0.wasm');
        expect(findWasm('oracle', dir, '')).toBe(join(dir, 'oracle.wasm'));
    });

    it('refuses a directory that holds two releases of one contract', async () => {
        const dir = await directory('oracle_v1.0.0.wasm', 'oracle_v1.1.0.wasm');
        expect(() => findWasm('oracle', dir, '')).toThrow(/more than one release of oracle/);
    });

    it('names what it looked for, and the hint, when nothing matches', async () => {
        const dir = await directory('treasury_v1.0.0.wasm');
        expect(() => findWasm('factory', dir, 'HINT')).toThrow(
            /no WASM for factory.*factory_v<version>\.wasm.*HINT/,
        );
        expect(() => findWasm('factory', undefined, 'HINT')).toThrow(
            /no directory configured.*HINT/,
        );
        expect(() => findWasm('factory', join(dir, 'absent'), 'HINT')).toThrow(
            /no directory .*HINT/,
        );
    });
});
