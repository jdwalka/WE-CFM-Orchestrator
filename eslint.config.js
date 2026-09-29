export default [
    {
        ignores: ["node_modules/**", "wecrypto-audit-site/**", "dist/**"]
    },
    {
        files: ["**/*.js", "**/*.mjs"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            "no-prototype-builtins": "warn",
            "no-unused-vars": "warn"
        }
    }
];
