// ESLint flat config. Lints the TypeScript sources and tests with the
// typescript-eslint recommended rules.
//
// Formatting is not enforced here: Prettier owns it (`npm run format`,
// `npm run format:check`, configured in .prettierrc.json).
// eslint-config-prettier only switches off the rules that would fight it.
import tseslint from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-config-prettier';

export default [
    { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
    ...tseslint.configs['flat/recommended'].map((config) => ({
        ...config,
        files: ['src/**/*.ts', 'test/**/*.ts'],
    })),
    {
        files: ['src/**/*.ts', 'test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
        },
    },
    prettier,
];
