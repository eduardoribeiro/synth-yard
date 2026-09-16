/** @type {import('jest').Config} */
module.exports = {
  testMatch: ["<rootDir>/server/tests/**/*.test.[jt]s"],
  transform: {
    "^.+\\.[jt]sx?$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
};
