// ESLint flat config. Lints the TypeScript sources and tests with the
// typescript-eslint recommended rules.
//
// Formatting is not enforced here: the code base predates a formatter
// config, so a Prettier rule would rewrite most files. eslint-config-prettier
// only switches off the rules that would fight a formatter.
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
