// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  workers: 2,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'always' }]],
});
