import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

describe('release process', () => {
    it('runs every check that needs only the repository before a publish', () => {
        const steps = packageJson.scripts.prepublishOnly.split(' && ');
        expect(steps).toEqual([
            'npm run typecheck',
            'npm run lint',
            'npm run format:check',
            'npm test',
            'npm run architecture:check',
        ]);
        for (const step of steps) {
            const script = step.replace(/^npm (run )?/, '');
            expect(packageJson.scripts[script], script).toBeTypeOf('string');
        }
    });

    it('keeps the spec check out of the publish, since it reads files outside the repository', () => {
        expect(packageJson.scripts.prepublishOnly).not.toContain('specs:');
        expect(packageJson.scripts['specs:check']).toBeTypeOf('string');
    });

    it('builds before packing', () => {
        expect(packageJson.scripts.prepare).toBe('npm run build');
    });
});
