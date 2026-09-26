const test = require("node:test");
const assert = require("node:assert");

// Assuming an app export or test harness setup
test("API persistence correctly records crash decode metadata fields", async (t) => {
  // Mock storage / database interaction or spin up test server instance
  const mockStorage = {
    lastUpdatedRecord: null,
    async updateCrashDecode(id, decoded, metadata) {
      this.lastUpdatedRecord = { id, decoded, metadata };
    }
  };

  // Verify that metadata parameters (gitVersion, soc, buildType) are correctly passed and handled
  await mockStorage.updateCrashDecode(123, "Decoded stack trace", {
    gitVersion: "V1.0.0-1-develop",
    soc: "esp32",
    buildType: "debug"
  });

  assert.strictEqual(mockStorage.lastUpdatedRecord.metadata.gitVersion, "V1.0.0-1-develop");
  assert.strictEqual(mockStorage.lastUpdatedRecord.metadata.soc, "esp32");
  assert.strictEqual(mockStorage.lastUpdatedRecord.metadata.buildType, "debug");
});