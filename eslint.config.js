// @ts-check
import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import jsdoc from "eslint-plugin-jsdoc";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "runs", "server", "src/observability/dashboard/public"] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Flags every Vec3 that Mineflayer returns (positions, offsets) because it was not built by this
      // package's own constructor; the vec3 package is shared, so the instances are identical.
      "@typescript-eslint/no-unsafe-class-instance-assignment": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: { jsdoc },
    rules: {
      // Public classes, their public methods and exported functions carry a doc comment (TSDoc style).
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: { ClassDeclaration: true, FunctionDeclaration: true, MethodDefinition: true },
          checkConstructors: false,
          checkGetters: false,
        },
      ],
    },
  },
  { files: ["eslint.config.js"], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
